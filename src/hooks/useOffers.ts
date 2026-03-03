"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL = 30_000;

export interface OpenOffer {
  offerOutpoint: string;    // "txid:vout" — primary identifier
  assetId: string;
  tokenAmount: number;
  satAmount: number;
  vtxoSatsValue: number;    // sats value of the swap VTXO (dust, e.g. 330)
  price: number;            // satAmount / tokenAmount
  makerArkAddress: string;
  makerPkScript: string;
  makerXOnlyPubkey: string;
  swapScriptHex: string;
  expiresAt: number;
  status: string;
}

export function useOffers(assetId: string | null): {
  offers: OpenOffer[];
  loading: boolean;
  refetch: () => void;
} {
  const [offers, setOffers] = useState<OpenOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOffers = useCallback(async () => {
    if (!assetId) {
      setOffers([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${INDEXER_URL}/offers?assetId=${encodeURIComponent(assetId)}`);
      if (!res.ok) return;
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: OpenOffer[] = (data.offers ?? []).map((o: any) => ({
        offerOutpoint: o.offerOutpoint,
        assetId: o.assetId,
        tokenAmount: Number(o.tokenAmount),
        satAmount: Number(o.satAmount),
        vtxoSatsValue: Number(o.vtxoSatsValue) || 330,
        price: Number(o.satAmount) / Number(o.tokenAmount),
        makerArkAddress: o.makerArkAddress ?? "",
        makerPkScript: o.makerPkScript ?? "",
        makerXOnlyPubkey: o.makerXOnlyPubkey ?? "",
        swapScriptHex: o.swapScriptHex ?? "",
        expiresAt: o.expiresAt,
        status: o.status,
      }));
      // Sort by price asc (cheapest first)
      mapped.sort((a, b) => a.price - b.price);
      setOffers(mapped);
    } catch {
      // Network error — keep previous state
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    if (!assetId) {
      setOffers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchOffers();

    intervalRef.current = setInterval(fetchOffers, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [assetId, fetchOffers]);

  return { offers, loading, refetch: fetchOffers };
}
