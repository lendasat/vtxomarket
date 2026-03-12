"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { subscribeToAllTrades } from "@/lib/nostr-market";
import type { TradeReceiptData } from "@/lib/nostr-market";
import type { NDKSubscription } from "@nostr-dev-kit/ndk";

const MAX_TRADES = 20;

export function useGlobalTrades() {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const [trades, setTrades] = useState<TradeReceiptData[]>([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef<NDKSubscription | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!nostrReady) return;

    setLoading(true);
    seenRef.current.clear();

    const sub = subscribeToAllTrades({
      onTrade: (trade) => {
        const dedupeKey = trade.arkTxId || `${trade.ticker}-${trade.timestamp}`;
        if (seenRef.current.has(dedupeKey)) return;
        seenRef.current.add(dedupeKey);

        setTrades((prev) => {
          const next = [...prev, trade]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, MAX_TRADES);
          return next;
        });
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
  }, [nostrReady]);

  return { trades, loading };
}
