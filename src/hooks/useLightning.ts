"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import {
  initLightning,
  getLightningFees,
  calcSendFee as calcSendFeeFn,
  calcReceiveFee as calcReceiveFeeFn,
  getSwapHistory as getSwapHistoryFn,
  refundSwap as refundSwapFn,
  restoreSwaps,
  type FeesResponse,
  type PendingReverseSwap,
  type SwapHistoryItem,
} from "@/lib/lightning";

export function useLightning() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lightningRef = useRef<any>(null);
  const [fees, setFees] = useState<FeesResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!arkWallet) {
      lightningRef.current = null;
      setFees(null);
      setReady(false);
      setInitError(null);
      return;
    }

    let disposed = false;
    setInitError(null);

    initLightning(arkWallet)
      .then(async (ln) => {
        if (disposed) return;
        lightningRef.current = ln;
        const f = await getLightningFees(ln);
        if (!disposed) {
          setFees(f);
          setReady(true);
        }
        // Restore any pending swaps from Boltz API (non-blocking)
        restoreSwaps(ln).catch((err: unknown) => {
          console.warn(
            "[lightning] Failed to restore pending swaps:",
            err instanceof Error ? err.message : err
          );
        });
      })
      .catch((err) => {
        console.error("[lightning] init failed:", err);
        if (!disposed) {
          setInitError(
            "Could not connect to Boltz swap service. Switch to Mutinynet for local development, or check your network connection."
          );
        }
      });

    return () => {
      disposed = true;
      if (lightningRef.current) {
        lightningRef.current.dispose().catch((err: unknown) => {
          console.warn("[lightning] Dispose failed:", err instanceof Error ? err.message : err);
        });
        lightningRef.current = null;
        setReady(false);
      }
    };
  }, [arkWallet]);

  const calcSendFee = useCallback((sats: number) => (fees ? calcSendFeeFn(fees, sats) : 0), [fees]);

  const calcReceiveFee = useCallback(
    (sats: number) => (fees ? calcReceiveFeeFn(fees, sats) : 0),
    [fees]
  );

  const sendLightning = useCallback(async (invoice: string): Promise<{ txid: string }> => {
    const ln = lightningRef.current;
    if (!ln) throw new Error("Lightning not ready");
    const result = await ln.sendLightningPayment({ invoice });
    return { txid: result.txid };
  }, []);

  const receiveLightning = useCallback(
    async (sats: number): Promise<{ invoice: string; swap: PendingReverseSwap }> => {
      const ln = lightningRef.current;
      if (!ln) throw new Error("Lightning not ready");
      const result = await ln.createLightningInvoice({ amount: sats });
      return { invoice: result.invoice, swap: result.pendingSwap };
    },
    []
  );

  const waitForReceive = useCallback(async (swap: PendingReverseSwap): Promise<void> => {
    const ln = lightningRef.current;
    if (!ln) throw new Error("Lightning not ready");
    await ln.waitAndClaim(swap);
  }, []);

  const getSwapHistory = useCallback(async (): Promise<SwapHistoryItem[]> => {
    const ln = lightningRef.current;
    if (!ln) return [];
    return getSwapHistoryFn(ln);
  }, []);

  const refundSwap = useCallback(async (swapId: string): Promise<void> => {
    const ln = lightningRef.current;
    if (!ln) throw new Error("Lightning not ready");
    await refundSwapFn(ln, swapId);
  }, []);

  return {
    ready,
    initError,
    fees,
    calcSendFee,
    calcReceiveFee,
    sendLightning,
    receiveLightning,
    waitForReceive,
    getSwapHistory,
    refundSwap,
  };
}
