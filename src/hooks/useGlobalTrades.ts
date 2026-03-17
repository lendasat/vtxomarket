"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL = 30_000;

export interface GlobalTrade {
  offerOutpoint: string;
  assetId: string;
  offerType: string; // "sell" | "buy"
  tokenAmount: number;
  satAmount: number;
  price: number;
  makerArkAddress: string;
  filledInTxid: string;
  timestamp: number;
}

export function useGlobalTrades() {
  const [trades, setTrades] = useState<GlobalTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch(`${INDEXER_URL}/trades?limit=20`);
      if (!res.ok) return;
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: GlobalTrade[] = (data.trades ?? []).map((t: any) => ({
        offerOutpoint: t.offerOutpoint,
        assetId: t.assetId,
        offerType: t.offerType ?? "sell",
        tokenAmount: Number(t.tokenAmount),
        satAmount: Number(t.satAmount),
        price: Number(t.price),
        makerArkAddress: t.makerArkAddress ?? "",
        filledInTxid: t.filledInTxid ?? "",
        timestamp: t.timestamp,
      }));
      setTrades(mapped);
    } catch (err) {
      console.warn("[globalTrades] Fetch failed:", err instanceof Error ? err.message : err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTrades();
    intervalRef.current = setInterval(fetchTrades, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchTrades]);

  return { trades, loading };
}
