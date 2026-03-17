"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import type { Token } from "@/lib/store";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
const POLL_INTERVAL_MS = 15_000; // 15s

// Track asset IDs we've already tried to discover to avoid repeated requests
const discoveredIds = new Set<string>();

export function useTokens() {
  const tokens = useAppStore((s) => s.tokens);
  const heldAssets = useAppStore((s) => s.heldAssets);
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
        const mapped: Token[] = assets.map((a: Record<string, unknown>) => ({
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

        // Merge with existing local tokens so locally upserted tokens
        // (e.g. just-created tokens the indexer hasn't seen yet) aren't wiped.
        const existingTokens = useAppStore.getState().tokens;
        const indexerIds = new Set(mapped.map((t) => t.assetId));
        const localOnly = existingTokens.filter((t) => t.assetId && !indexerIds.has(t.assetId));
        setTokens([...mapped, ...localOnly]);
        if (!tokensLoaded) {
          setTokensLoaded(true);
          setTokensLoading(false);
        }
      } catch (err) {
        console.warn("[tokens] Fetch failed:", err instanceof Error ? err.message : err);
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

  // Discover held assets missing from the token list
  useEffect(() => {
    if (!tokensLoaded || heldAssets.length === 0) return;
    const tokenIds = new Set(tokens.map((t) => t.assetId));
    const missing = heldAssets.filter(
      (a) => a.amount > 0 && a.assetId && !tokenIds.has(a.assetId) && !discoveredIds.has(a.assetId)
    );

    if (missing.length === 0) return;

    for (const asset of missing) {
      discoveredIds.add(asset.assetId);
      fetch(`${INDEXER_URL}/assets/${encodeURIComponent(asset.assetId)}/discover`, {
        method: "POST",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data?.asset) return;
          const a = data.asset;
          const newToken: Token = {
            id: a.assetId,
            assetId: a.assetId,
            name: a.name || "",
            ticker: a.ticker || "",
            description: a.description || "",
            image: a.image || undefined,
            creator: a.creator || "",
            creatorArkAddress: a.creatorArkAddress || "",
            createdAt: a.createdAt ?? a.updatedAt ?? 0,
            supply: Number(a.supply) || 0,
            decimals: a.decimals || undefined,
            controlAssetId: a.controlAssetId || undefined,
            replies: 0,
            tradeCount: 0,
          };
          const current = useAppStore.getState().tokens;
          if (!current.find((t) => t.assetId === newToken.assetId)) {
            setTokens([...current, newToken]);
          }
        })
        .catch(() => {}); // silent — will retry next cycle
    }
  }, [tokensLoaded, heldAssets, tokens, setTokens]);

  return { tokens, loading: tokensLoading };
}
