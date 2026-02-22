"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { subscribeToOrdersForCreator } from "@/lib/nostr-market";
import { fillBuyOrder, fillSellOrder } from "@/lib/trade-engine";
import type { OrderData } from "@/lib/nostr-market";
import type { CurveState } from "@/lib/bonding-curve";
import type { NDKSubscription, NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Creator-as-Market-Maker hook.
 *
 * Runs on the creator's browser. Subscribes to order events and
 * auto-fills valid buy/sell orders for tokens the user created.
 *
 * Uses refs for tokens/wallet to avoid re-subscribing on every
 * store update (which would cause a subscribe→fill→upsert→re-subscribe loop).
 */
export function useCreatorMarketMaker() {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const walletReady = useAppStore((s) => s.walletReady);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const user = useAppStore((s) => s.user);
  const tokens = useAppStore((s) => s.tokens);

  // Keep refs so the subscription callback always has fresh data
  // without re-subscribing on every token/wallet update
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const walletRef = useRef(arkWallet);
  walletRef.current = arkWallet;

  const subRef = useRef<NDKSubscription | null>(null);
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!nostrReady || !walletReady || !user?.pubkey) return;

    const sub = subscribeToOrdersForCreator(user.pubkey, {
      onOrder: async (order: OrderData, _event: NDKEvent) => {
        const wallet = walletRef.current;
        if (!wallet) return;

        // Skip if already processing this order
        if (processingRef.current.has(order.arkTxId)) return;

        // Look up token from latest store state (via ref)
        const myTokens = tokensRef.current.filter((t) => t.creator === user.pubkey);
        const token = myTokens.find((t) => t.ticker === order.ticker);
        if (!token) return;

        // Skip orders older than 60 seconds
        const age = Math.floor(Date.now() / 1000) - order.timestamp;
        if (age > 60) return;

        processingRef.current.add(order.arkTxId);

        try {
          const curveState: CurveState = {
            virtualTokenReserves: token.virtualTokenReserves,
            virtualSatReserves: token.virtualSatReserves,
            realTokenReserves: token.realTokenReserves,
          };

          if (order.type === "buy") {
            console.log(`[CMM] Filling buy order: ${order.sats} sats for ${order.ticker}`);
            const result = await fillBuyOrder(wallet, order, curveState, token.assetId);

            // Update local token state with new curve
            useAppStore.getState().upsertToken({
              ...token,
              virtualTokenReserves: result.newCurveState.virtualTokenReserves,
              virtualSatReserves: result.newCurveState.virtualSatReserves,
              realTokenReserves: result.newCurveState.realTokenReserves,
              price: result.newCurveState.virtualSatReserves / result.newCurveState.virtualTokenReserves,
              tradeCount: token.tradeCount + 1,
            });
            console.log(`[CMM] Buy order filled: ${result.fillTxId}`);
          } else if (order.type === "sell") {
            console.log(`[CMM] Filling sell order: ${order.expectedTokens} tokens for ${order.ticker}`);
            const result = await fillSellOrder(wallet, order, curveState);

            useAppStore.getState().upsertToken({
              ...token,
              virtualTokenReserves: result.newCurveState.virtualTokenReserves,
              virtualSatReserves: result.newCurveState.virtualSatReserves,
              realTokenReserves: result.newCurveState.realTokenReserves,
              price: result.newCurveState.virtualSatReserves / result.newCurveState.virtualTokenReserves,
              tradeCount: token.tradeCount + 1,
            });
            console.log(`[CMM] Sell order filled: ${result.fillTxId}`);
          }
        } catch (err) {
          console.error(`[CMM] Failed to fill order:`, err);
        } finally {
          // Remove from processing after a delay to avoid re-processing
          setTimeout(() => {
            processingRef.current.delete(order.arkTxId);
          }, 10_000);
        }
      },
    });

    subRef.current = sub;

    return () => {
      if (subRef.current) {
        subRef.current.stop();
        subRef.current = null;
      }
    };
    // Only re-subscribe when connection state or identity changes,
    // NOT when tokens update (refs handle fresh data)
  }, [nostrReady, walletReady, user?.pubkey]);
}
