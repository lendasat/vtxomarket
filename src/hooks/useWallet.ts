"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { saveMnemonic, getMnemonic } from "@/lib/wallet-storage";
import {
  generateMnemonic,
  mnemonicToArkPrivateKeyHex,
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

      // 2. Derive Ark key
      let arkKeyHex: string;
      try {
        arkKeyHex = mnemonicToArkPrivateKeyHex(mnemonic);
        console.log("[wallet] Ark key derived");
      } catch (e) {
        console.error("[wallet] Key derivation failed:", e);
        return;
      }

      // 3. Ark wallet - go straight to it, no Nostr blocking
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

  // Auto-refresh balance
  const refreshData = useCallback(async () => {
    const w = useAppStore.getState().arkWallet;
    if (!w) return;
    try {
      const { getBalance, getReceivingAddresses } = await import("@/lib/ark-wallet");
      const [bal, addrs] = await Promise.all([
        getBalance(w),
        getReceivingAddresses(w),
      ]);
      useAppStore.getState().setBalance(bal);
      useAppStore.getState().setAddresses(addrs);
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
