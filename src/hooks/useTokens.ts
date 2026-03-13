"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import type { Token } from "@/lib/store";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL_MS = 15_000; // 15s

export function useTokens() {
  const tokens = useAppStore((s) => s.tokens);
  const tokensLoading = useAppStore((s) => s.tokensLoading);
  const tokensLoaded = useAppStore((s) => s.tokensLoaded);
  const setTokens = useAppStore((s) => s.setTokens);
  const setTokensLoading = useAppStore((s) => s.setTokensLoading);
  const setTokensLoaded = useAppStore((s) => s.setTokensLoaded);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTokens() {
      try {
        const resp = await fetch(`${INDEXER_URL}/assets`);
        if (!resp.ok) return;
        const { assets } = await resp.json();
        if (cancelled) return;

        // Map indexer AssetRow to Token
        const mapped: Token[] = assets
          .filter((a: Record<string, unknown>) => a.name || a.ticker)
          .map((a: Record<string, unknown>) => ({
            id: a.assetId as string,
            assetId: a.assetId as string,
            name: (a.name as string) || "",
            ticker: (a.ticker as string) || "",
            description: (a.description as string) || "",
            image: (a.image as string) || undefined,
            creator: (a.creator as string) || "",
            creatorArkAddress: (a.creatorArkAddress as string) || "",
            createdAt: (a.createdAt as number) ?? (a.updatedAt as number) ?? 0,
            supply: Number(a.supply) || 0,
            decimals: (a.decimals as number) || undefined,
            controlAssetId: (a.controlAssetId as string) || undefined,
            replies: 0,
            tradeCount: 0,
            website: (a.website as string) || undefined,
            twitter: (a.twitter as string) || undefined,
            telegram: (a.telegram as string) || undefined,
          }));

        setTokens(mapped);
        if (!tokensLoaded) {
          setTokensLoaded(true);
          setTokensLoading(false);
        }
      } catch {
        // Network error — keep existing tokens, retry on next interval
      }
    }

    setTokensLoading(true);
    fetchTokens();

    timerRef.current = setInterval(fetchTokens, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [setTokens, setTokensLoading, setTokensLoaded, tokensLoaded]);

  return { tokens, loading: tokensLoading };
}
