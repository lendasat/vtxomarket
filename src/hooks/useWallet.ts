"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { getMnemonic, getNostrKeyOverride } from "@/lib/wallet-storage";
import { mnemonicToArkPrivateKeyHex, mnemonicToNostrPrivateKeyHex } from "@/lib/wallet-crypto";
import { loadWalletCache, saveWalletCache } from "@/lib/wallet-cache";

const REFRESH_INTERVAL = 30_000;

export function useWallet() {
  const store = useAppStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    // Hydrate from cache immediately (synchronous) so the UI has data on first render
    const cached = loadWalletCache();
    if (cached) {
      const s = useAppStore.getState();
      s.setBalance(cached.balance);
      s.setAddresses(cached.addresses);
      s.setHeldAssets(cached.heldAssets);
      if (cached.profile) s.setProfile(cached.profile);
      s.setHasCachedData(true);
      console.log(
        "[wallet] Hydrated from cache (age: %ds)",
        Math.round((Date.now() - cached.savedAt) / 1000)
      );
    }

    async function init() {
      // 1. Mnemonic: load from storage (saved by AuthGate)
      let mnemonic: string;
      try {
        const stored = await getMnemonic();
        if (!stored) {
          console.error("[wallet] No mnemonic available");
          return;
        }
        mnemonic = stored;
        console.log("[wallet] Mnemonic ready");
      } catch (e) {
        console.error("[wallet] Mnemonic load failed:", e);
        return;
      }
      // 2. Derive keys (mnemonic stays in local variable only — never stored in global state)
      let arkKeyHex: string;
      let nostrKeyHex: string;
      try {
        arkKeyHex = mnemonicToArkPrivateKeyHex(mnemonic);
        nostrKeyHex = mnemonicToNostrPrivateKeyHex(mnemonic);
        console.log("[wallet] Keys derived");
      } catch (e) {
        console.error("[wallet] Key derivation failed:", e);
        return;
      }

      // 3. Nostr signer (fire-and-forget, don't block Ark)
      //    Check for an imported nsec override first
      import("@/lib/nostr").then(async ({ loginWithPrivateKey, connectNDK, fetchMyProfile }) => {
        try {
          const override = await getNostrKeyOverride();
          const key = override || nostrKeyHex;
          // Connect first, then set signer (avoids user-relay lookup before connection)
          await connectNDK();
          const ndk = await loginWithPrivateKey(key);
          console.log("[wallet] Nostr connected", override ? "(nsec override)" : "(derived)");

          // Extract user from signer and update store
          if (ndk.signer) {
            const ndkUser = await ndk.signer.user();
            useAppStore.getState().setUser(ndkUser);
            useAppStore.getState().setConnected(true);
          }
          useAppStore.getState().setNostrReady(true);

          // Fetch profile from relays (non-blocking)
          try {
            const profile = await fetchMyProfile();
            if (profile) {
              useAppStore.getState().setProfile(profile);
              console.log(
                "[wallet] Profile loaded:",
                profile.name || profile.displayName || "(no name)"
              );
            }
          } catch (e) {
            console.warn("[wallet] Profile fetch failed:", e);
          }
        } catch (e) {
          console.error("[wallet] Nostr init failed:", e);
        }
      });

      // 4. Ark wallet
      console.log("[wallet] Connecting to Ark server...");
      try {
        const { initArkWallet } = await import("@/lib/ark-wallet");
        const arkWallet = await initArkWallet(arkKeyHex);
        useAppStore.getState().setArkWallet(arkWallet);
        useAppStore.getState().setWalletReady(true);
        useAppStore.getState().setHasCachedData(false);
        console.log("[wallet] Ark wallet ready");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Ark wallet init failed";
        console.error("[wallet] Ark wallet init failed:", msg);
        useAppStore.getState().setWalletError(msg);
        useAppStore.getState().setHasCachedData(false);
      }
    }

    init();
  }, []);

  // Track whether we're already settling to avoid concurrent settle calls
  const settlingRef = useRef(false);
  // Cooldown after settle failure — avoid spamming every 30s
  const settleCooldownUntil = useRef(0);
  // Cached renewal threshold (recomputed periodically)
  const renewalThresholdRef = useRef<number | null>(null);
  const renewalThresholdComputedAt = useRef(0);
  // Separate flag for renewal vs regular settle
  const renewingRef = useRef(false);

  // Auto-refresh balance + auto-settle confirmed boarding UTXOs + finalize pending txs
  const refreshData = useCallback(async () => {
    const w = useAppStore.getState().arkWallet;
    if (!w) return;
    try {
      const {
        getBalance,
        getReceivingAddresses,
        settleVtxos,
        finalizePending,
        getAssets,
        renewVtxos,
        computeRenewalThreshold,
        reloadWalletState,
      } = await import("@/lib/ark-wallet");

      // Force the service worker to re-sync from the network before reading state
      try {
        await reloadWalletState(w);
      } catch {
        // Non-fatal — continue with potentially stale data
      }

      const [bal, addrs] = await Promise.all([getBalance(w), getReceivingAddresses(w)]);
      useAppStore.getState().setBalance(bal);
      useAppStore.getState().setAddresses(addrs);

      // Fetch held assets
      let latestAssets = useAppStore.getState().heldAssets;
      try {
        const assets = await getAssets(w);
        latestAssets = assets.map((a) => ({ assetId: a.assetId, amount: a.amount }));
        useAppStore.getState().setHeldAssets(latestAssets);
      } catch (e) {
        console.warn("[wallet] Asset fetch failed:", e instanceof Error ? e.message : e);
      }

      // Persist snapshot to localStorage for instant hydration on next load
      saveWalletCache({
        balance: bal,
        addresses: addrs,
        heldAssets: latestAssets,
        profile: useAppStore.getState().profile,
      });

      // Finalize any pending checkpoint signatures (non-blocking)
      try {
        const { finalized } = await finalizePending(w);
        if (finalized.length > 0) {
          console.log("[wallet] Finalized pending txs:", finalized);
          const newBal = await getBalance(w);
          useAppStore.getState().setBalance(newBal);
        }
      } catch (e) {
        console.warn("[wallet] Finalize pending failed:", e instanceof Error ? e.message : e);
      }

      // Auto-settle: roll confirmed boarding UTXOs into the Ark round.
      // Only boarding UTXOs are settled here — preconfirmed VTXOs are included
      // in the next round automatically by the ASP (every ~60s sessionDuration).
      // We NEVER mix boarding with existing VTXOs to avoid minExpiryGap rejections.
      const hasBoarding = bal.onchainConfirmed >= 1000;
      const shouldSettle =
        hasBoarding && !settlingRef.current && Date.now() > settleCooldownUntil.current;

      if (shouldSettle) {
        settlingRef.current = true;
        try {
          console.log(`[wallet] Auto-settling ${bal.onchainConfirmed} boarding sats...`);
          const txid = await settleVtxos(w);
          console.log("[wallet] Boarding settle complete, txid:", txid);
          settleCooldownUntil.current = 0;
          const newBal = await getBalance(w);
          useAppStore.getState().setBalance(newBal);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/minExpiryGap|expires after|no vtxos|nothing to settle/i.test(msg)) {
            console.debug("[wallet] Auto-settle skipped:", msg.slice(0, 80));
            settleCooldownUntil.current = Date.now() + 5 * 60 * 1000;
          } else if (/timed out/i.test(msg)) {
            // Timeout just means we missed this round — retry soon
            console.warn("[wallet] Auto-settle timed out, will retry next cycle");
            settleCooldownUntil.current = Date.now() + 30_000;
          } else {
            console.warn("[wallet] Auto-settle failed:", msg);
            settleCooldownUntil.current = Date.now() + 5 * 60 * 1000;
          }
        } finally {
          settlingRef.current = false;
        }
      }
      // VTXO auto-renewal: renew VTXOs approaching expiry (separate from regular settle)
      if (
        !renewingRef.current &&
        !settlingRef.current &&
        Date.now() > settleCooldownUntil.current
      ) {
        // Recompute threshold every 30 minutes (not on every refresh)
        const THRESHOLD_TTL = 30 * 60 * 1000;
        if (
          !renewalThresholdRef.current ||
          Date.now() - renewalThresholdComputedAt.current > THRESHOLD_TTL
        ) {
          try {
            renewalThresholdRef.current = await computeRenewalThreshold(w);
            renewalThresholdComputedAt.current = Date.now();
          } catch (err) {
            console.warn(
              "[wallet] Renewal threshold computation failed, using default:",
              err instanceof Error ? err.message : err
            );
          }
        }

        try {
          const { getVtxosNeedingRenewal } = await import("@/lib/ark-wallet");
          const expiring = await getVtxosNeedingRenewal(
            w,
            renewalThresholdRef.current ?? undefined
          );
          if (expiring.length > 0) {
            renewingRef.current = true;
            console.log("[wallet] %d VTXOs need renewal, starting...", expiring.length);
            try {
              const txid = await renewVtxos(w, renewalThresholdRef.current ?? undefined);
              if (txid) {
                console.log("[wallet] VTXO renewal complete, txid:", txid);
                const newBal = await getBalance(w);
                useAppStore.getState().setBalance(newBal);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (/minExpiryGap|expires after|no vtxos|nothing to settle/i.test(msg)) {
                console.debug("[wallet] Renewal skipped:", msg.slice(0, 80));
              } else {
                console.warn("[wallet] VTXO renewal failed:", msg);
                settleCooldownUntil.current = Date.now() + 5 * 60 * 1000;
              }
            } finally {
              renewingRef.current = false;
            }
          }
        } catch (e) {
          console.warn("[wallet] Renewal check failed:", e);
        }
      }
    } catch (e) {
      console.error("[wallet] Refresh failed:", e);
    }
  }, []);

  // Poll service worker status — detect if the browser killed the idle SW
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!store.walletReady) return;
    if (statusPollRef.current) clearInterval(statusPollRef.current);

    statusPollRef.current = setInterval(async () => {
      const w = useAppStore.getState().arkWallet;
      if (!w) return;
      try {
        const { getWalletStatus } = await import("@/lib/ark-wallet");
        const initialized = await getWalletStatus(w);
        if (!initialized) {
          console.warn("[wallet] Service worker lost wallet state — marking not ready");
          useAppStore.getState().setWalletReady(false);
          useAppStore.getState().setWalletError("Wallet disconnected — please refresh");
        }
      } catch {
        // getStatus call itself failed — SW may be dead
      }
    }, 5_000);

    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
  }, [store.walletReady]);

  // Listen for service worker VTXO_UPDATE / UTXO_UPDATE messages (real-time balance updates)
  const swListenerRef = useRef(false);
  useEffect(() => {
    if (!store.walletReady || swListenerRef.current) return;
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;

    swListenerRef.current = true;
    const handler = (event: MessageEvent) => {
      const type = event.data?.type;
      if (type === "VTXO_UPDATE" || type === "UTXO_UPDATE") {
        console.log("[wallet] SW event: %s — reloading", type);
        refreshData();
        // Reload again after delay to let the indexer catch up
        setTimeout(() => refreshData(), 5000);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handler);
      swListenerRef.current = false;
    };
  }, [store.walletReady, refreshData]);

  useEffect(() => {
    if (store.walletReady) {
      refreshData();
      intervalRef.current = setInterval(refreshData, REFRESH_INTERVAL);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [store.walletReady, refreshData]);

  return {
    ready: store.walletReady,
    balance: store.balance,
    addresses: store.addresses,
    user: store.user,
    refreshData,
  };
}
