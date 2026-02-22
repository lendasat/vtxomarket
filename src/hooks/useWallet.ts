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

  // Auto-refresh balance + auto-settle confirmed boarding UTXOs
  const refreshData = useCallback(async () => {
    const w = useAppStore.getState().arkWallet;
    if (!w) return;
    try {
      const { getBalance, getReceivingAddresses, settleVtxos } = await import("@/lib/ark-wallet");
      const [bal, addrs] = await Promise.all([
        getBalance(w),
        getReceivingAddresses(w),
      ]);
      useAppStore.getState().setBalance(bal);
      useAppStore.getState().setAddresses(addrs);

      // Auto-settle confirmed on-chain funds into off-chain Arkade balance
      if (bal.onchainConfirmed > 0 && !settlingRef.current) {
        settlingRef.current = true;
        console.log(`[wallet] Auto-settling ${bal.onchainConfirmed} confirmed boarding sats...`);
        try {
          const txid = await settleVtxos(w);
          console.log("[wallet] Auto-settle complete, txid:", txid);
          // Refresh balance after settling
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
