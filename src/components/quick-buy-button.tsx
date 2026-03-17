"use client";

import { useState, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { fillSwapOffer } from "@/lib/ark-wallet";
import { formatTokenAmount, formatSats } from "@/lib/format";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";

interface QuickBuyButtonProps {
  assetId: string;
  ticker: string;
  decimals?: number;
  onSuccess?: () => void;
}

export function QuickBuyButton({ assetId, ticker, decimals, onSuccess }: QuickBuyButtonProps) {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const walletReady = useAppStore((s) => s.walletReady);

  const [state, setState] = useState<
    "idle" | "loading" | "confirm" | "filling" | "success" | "error"
  >("idle");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [offer, setOffer] = useState<any>(null);
  const [error, setError] = useState("");

  const fetchCheapest = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const res = await fetch(`${INDEXER_URL}/offers?assetId=${assetId}`);
      if (!res.ok) throw new Error("Failed to fetch offers");
      const data = await res.json();
      const offers = data.offers ?? [];
      if (offers.length === 0) {
        setError("No offers available");
        setState("error");
        return;
      }
      // Offers already sorted by price ascending from the indexer
      const cheapest = {
        ...offers[0],
        tokenAmount: Number(offers[0].tokenAmount),
        satAmount: Number(offers[0].satAmount),
        vtxoSatsValue: Number(offers[0].vtxoSatsValue || 330),
      };
      setOffer(cheapest);
      setState("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
      setState("error");
    }
  }, [assetId]);

  const handleFill = useCallback(async () => {
    if (!arkWallet || !offer) return;
    setState("filling");
    try {
      await fillSwapOffer(arkWallet, offer);
      setState("success");
      onSuccess?.();
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fill failed");
      setState("error");
    }
  }, [arkWallet, offer, onSuccess]);

  const reset = () => {
    setState("idle");
    setOffer(null);
    setError("");
  };

  if (!walletReady) return null;

  if (state === "success") {
    return <span className="text-[10px] font-semibold text-emerald-400/80 px-2 py-1">Filled!</span>;
  }

  if (state === "error") {
    return (
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          reset();
        }}
        className="text-[10px] text-red-400/80 px-2 py-1 hover:text-red-400 transition-colors"
        title={error}
      >
        {error.length > 20 ? "Failed" : error} — retry
      </button>
    );
  }

  if (state === "confirm" && offer) {
    return (
      <div
        className="flex gap-1"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <button
          onClick={handleFill}
          className="px-2 py-1 rounded-lg bg-emerald-500/30 border border-emerald-500/40 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/40 transition-colors"
          title={`Buy ${formatTokenAmount(offer.tokenAmount, decimals)} ${ticker} for ${offer.satAmount.toLocaleString()} sats`}
        >
          {formatSats(offer.satAmount)} sat
        </button>
        <button
          onClick={reset}
          className="px-2 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[10px] font-semibold text-muted-foreground hover:bg-white/[0.1] transition-colors"
        >
          No
        </button>
      </div>
    );
  }

  if (state === "loading" || state === "filling") {
    return (
      <span
        className="px-2 py-1 flex items-center"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span className="h-2.5 w-2.5 animate-spin rounded-full border border-emerald-400/50 border-t-transparent" />
      </span>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        fetchCheapest();
      }}
      className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-[10px] font-semibold text-emerald-400/80 hover:bg-emerald-500/25 hover:text-emerald-400 transition-colors"
    >
      Buy
    </button>
  );
}
