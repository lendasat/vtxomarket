"use client";

/**
 * useLendaswapHistory — Loads stored LendaSwap swaps into the Zustand store.
 *
 * This hook should be called at the wallet page level so that swap history
 * is available in the transaction list regardless of which tab is active.
 * It only loads once (no polling).
 */

import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { getLendaswapClient } from "../lib/client";
import { fromSmallestUnit, chainIdToKey, type StablecoinKey } from "../lib/constants";
import { mapBackendStatus } from "../lib/types";

export function useLendaswapHistory() {
  const upsertStablecoinTx = useAppStore((s) => s.upsertStablecoinTx);

  useEffect(() => {
    let cancelled = false;

    getLendaswapClient()
      .then(async (client) => {
        if (cancelled) return;

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stored: any[] = await client.listAllSwaps();
          console.log(`[lendaswap] Loaded ${stored.length} stored swaps`);

          for (const s of stored) {
            const resp = s.response;
            if (!resp) continue;
            const dir = resp.direction;
            const isSend = dir === "arkade_to_evm";
            const isReceive = dir === "evm_to_arkade";
            if (!isSend && !isReceive) continue;

            const chain = chainIdToKey(resp.evm_chain_id);

            const targetToken = resp.target_token;
            const sourceToken = resp.source_token;
            const tokenSymbol = isSend
              ? targetToken?.symbol || "USDC"
              : sourceToken?.symbol || "USDC";
            const coin: StablecoinKey = tokenSymbol === "USDT" ? "USDT" : "USDC";

            const stablecoinAmt = isSend ? resp.target_amount : resp.source_amount;
            const satsAmt = isSend ? resp.source_amount : resp.target_amount;
            const status = (resp.status as string) || "pending";

            upsertStablecoinTx({
              swapId: s.swapId,
              direction: isSend ? "send" : "receive",
              coin,
              chain,
              stablecoinDisplay: `${fromSmallestUnit(stablecoinAmt || "0", coin)} ${coin}`,
              satsAmount: parseInt(satsAmt || "0", 10),
              destinationAddress:
                s.targetAddress || resp.target_evm_address || resp.target_arkade_address || "",
              status: mapBackendStatus(status),
              backendStatus: status,
              claimTxHash: resp.evm_claim_txid || resp.btc_claim_txid,
              createdAt: (() => {
                if (resp.created_at) {
                  const parsed = new Date(resp.created_at as string).getTime();
                  if (!isNaN(parsed) && parsed > 0) return parsed;
                }
                return s.storedAt || Date.now();
              })(),
            });
          }
        } catch (err) {
          console.warn("[lendaswap] Failed to load stored swaps:", err);
        }
      })
      .catch((err) => {
        console.error("[lendaswap] Client init failed:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [upsertStablecoinTx]);
}
