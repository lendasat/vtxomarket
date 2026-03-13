"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { saveMnemonic, getMnemonic, getNostrKeyOverride } from "@/lib/wallet-storage";
import {
  generateMnemonic,
  mnemonicToArkPrivateKeyHex,
  mnemonicToNostrPrivateKeyHex,
} from "@/lib/wallet-crypto";

const REFRESH_INTERVAL = 30_000;

export function useWallet() {
  const store = useAppStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      // 1. Mnemonic: load or create
      let mnemonic: string;
      try {
        const stored = await getMnemonic();
        if (stored) {
          mnemonic = stored;
        } else {
          mnemonic = generateMnemonic();
          await saveMnemonic(mnemonic);
        }
        console.log("[wallet] Mnemonic ready");
      } catch (e) {
        console.error("[wallet] Mnemonic storage failed, using ephemeral:", e);
        mnemonic = generateMnemonic();
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
              console.log("[wallet] Profile loaded:", profile.name || profile.displayName || "(no name)");
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
        console.log("[wallet] Ark wallet ready");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Ark wallet init failed";
        console.error("[wallet] Ark wallet init failed:", msg);
        useAppStore.getState().setWalletError(msg);
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
      const { getBalance, getReceivingAddresses, settleVtxos, finalizePending, getAssets, renewVtxos, computeRenewalThreshold } = await import("@/lib/ark-wallet");
      const [bal, addrs] = await Promise.all([
        getBalance(w),
        getReceivingAddresses(w),
      ]);
      useAppStore.getState().setBalance(bal);
      useAppStore.getState().setAddresses(addrs);

      // Fetch held assets
      try {
        const assets = await getAssets(w);
        useAppStore.getState().setHeldAssets(
          assets.map((a) => ({ assetId: a.assetId, amount: a.amount }))
        );
      } catch (e) {
        console.warn("[wallet] Asset fetch failed:", e instanceof Error ? e.message : e);
      }

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
        hasBoarding &&
        !settlingRef.current &&
        Date.now() > settleCooldownUntil.current;

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
      if (!renewingRef.current && !settlingRef.current && Date.now() > settleCooldownUntil.current) {
        // Recompute threshold every 30 minutes (not on every refresh)
        const THRESHOLD_TTL = 30 * 60 * 1000;
        if (!renewalThresholdRef.current || Date.now() - renewalThresholdComputedAt.current > THRESHOLD_TTL) {
          try {
            renewalThresholdRef.current = await computeRenewalThreshold(w);
            renewalThresholdComputedAt.current = Date.now();
          } catch (err) {
            console.warn("[wallet] Renewal threshold computation failed, using default:", err instanceof Error ? err.message : err);
          }
        }

        try {
          const { getVtxosNeedingRenewal } = await import("@/lib/ark-wallet");
          const expiring = await getVtxosNeedingRenewal(w, renewalThresholdRef.current ?? undefined);
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
