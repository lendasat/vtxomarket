"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { subscribeToTradesForToken } from "@/lib/nostr-market";
import type { TradeReceiptData } from "@/lib/nostr-market";
import type { NDKSubscription } from "@nostr-dev-kit/ndk";

export function useTrades(ticker: string | null) {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const [trades, setTrades] = useState<TradeReceiptData[]>([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef<NDKSubscription | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!nostrReady || !ticker) return;

    setLoading(true);
    seenRef.current.clear();

    const sub = subscribeToTradesForToken(ticker, {
      onTrade: (trade) => {
        if (seenRef.current.has(trade.arkTxId)) return;
        seenRef.current.add(trade.arkTxId);
        setTrades((prev) =>
          [...prev, trade].sort((a, b) => b.timestamp - a.timestamp)
        );
      },
      onEose: () => {
        setLoading(false);
      },
    });

    subRef.current = sub;

    return () => {
      if (subRef.current) {
        subRef.current.stop();
        subRef.current = null;
      }
    };
  }, [nostrReady, ticker]);

  return { trades, loading };
}
