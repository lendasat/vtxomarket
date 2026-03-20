"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL = 10_000;

export interface Trade {
  offerOutpoint: string;
  offerType: string; // "sell" | "buy"
  tokenAmount: number;
  satAmount: number;
  price: number; // satAmount / tokenAmount
  makerArkAddress: string;
  filledInTxid: string;
  timestamp: number; // unix seconds
}

export function useTrades(assetId: string | null): {
  trades: Trade[];
  loading: boolean;
} {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTrades = useCallback(async () => {
    if (!assetId) {
      setTrades([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${INDEXER_URL}/assets/${encodeURIComponent(assetId)}/trades`);
      if (!res.ok) return;
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: Trade[] = (data.trades ?? []).map((t: any) => ({
        offerOutpoint: t.offerOutpoint,
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
      console.warn("[trades] Fetch failed:", err instanceof Error ? err.message : err);
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    if (!assetId) {
      setTrades([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchTrades();

    intervalRef.current = setInterval(fetchTrades, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [assetId, fetchTrades]);

  return { trades, loading };
}
