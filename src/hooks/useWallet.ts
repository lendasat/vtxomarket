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
      useAppStore.getState().setMnemonic(mnemonic);

      // 2. Derive keys
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

  // Auto-refresh balance + auto-settle confirmed boarding UTXOs + finalize pending txs
  const refreshData = useCallback(async () => {
    const w = useAppStore.getState().arkWallet;
    if (!w) return;
    try {
      const { getBalance, getReceivingAddresses, settleVtxos, finalizePending, settleAll, getAssets } = await import("@/lib/ark-wallet");
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

      // Auto-settle: roll preconfirmed VTXOs and/or boarding UTXOs into an on-chain round
      // settle() with no params grabs everything and joins the next Ark server round
      const shouldSettle =
        (bal.onchainConfirmed >= 1000 || bal.preconfirmed > 0) &&
        !settlingRef.current;

      if (shouldSettle) {
        settlingRef.current = true;
        const label = bal.onchainConfirmed >= 1000
          ? `${bal.onchainConfirmed} boarding sats + ${bal.preconfirmed} preconfirmed`
          : `${bal.preconfirmed} preconfirmed sats`;
        console.log(`[wallet] Auto-settling ${label}...`);
        try {
          const txid = await settleAll(w);
          console.log("[wallet] Auto-settle complete, txid:", txid);
          const newBal = await getBalance(w);
          useAppStore.getState().setBalance(newBal);
        } catch (e) {
          console.warn("[wallet] Auto-settle failed:", e instanceof Error ? e.message : e);
        } finally {
          settlingRef.current = false;
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
