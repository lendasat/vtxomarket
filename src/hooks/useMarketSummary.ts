"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL = 30_000;

export interface TokenMarketData {
  openOfferCount: number;
  bestOfferPrice: number | null; // sat/token (raw units)
  lastTradePrice: number | null; // sat/token (raw units)
  lastTradeAt: number | null;
}

export function useMarketSummary(): {
  data: Map<string, TokenMarketData>;
  loading: boolean;
} {
  const [data, setData] = useState<Map<string, TokenMarketData>>(new Map());
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(`${INDEXER_URL}/market-summary`);
      if (!res.ok) return;
      const json = await res.json();
      const map = new Map<string, TokenMarketData>();
       
      for (const item of json.summary ?? []) {
        map.set(item.assetId, {
          openOfferCount: Number(item.openOfferCount) || 0,
          bestOfferPrice: item.bestOfferPrice != null ? Number(item.bestOfferPrice) : null,
          lastTradePrice: item.lastFilledPrice != null ? Number(item.lastFilledPrice) : null,
          lastTradeAt: item.lastFilledAt != null ? Number(item.lastFilledAt) : null,
        });
      }
      setData(map);
    } catch (err) {
      console.warn("[useMarketSummary] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchSummary();

    intervalRef.current = setInterval(fetchSummary, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchSummary]);

  return { data, loading };
}
