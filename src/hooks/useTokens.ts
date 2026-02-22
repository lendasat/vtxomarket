"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { subscribeToTokenListings } from "@/lib/nostr-market";
import type { NDKSubscription } from "@nostr-dev-kit/ndk";

export function useTokens() {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const tokens = useAppStore((s) => s.tokens);
  const tokensLoading = useAppStore((s) => s.tokensLoading);
  const tokensLoaded = useAppStore((s) => s.tokensLoaded);
  const upsertToken = useAppStore((s) => s.upsertToken);
  const setTokensLoading = useAppStore((s) => s.setTokensLoading);
  const setTokensLoaded = useAppStore((s) => s.setTokensLoaded);

  const subRef = useRef<NDKSubscription | null>(null);

  useEffect(() => {
    if (!nostrReady || tokensLoaded) return;

    setTokensLoading(true);

    const sub = subscribeToTokenListings({
      onToken: (token) => {
        upsertToken(token);
      },
      onEose: () => {
        setTokensLoading(false);
        setTokensLoaded(true);
      },
    });

    subRef.current = sub;

    return () => {
      if (subRef.current) {
        subRef.current.stop();
        subRef.current = null;
      }
    };
  }, [nostrReady, tokensLoaded, upsertToken, setTokensLoading, setTokensLoaded]);

  return { tokens, loading: tokensLoading };
}
