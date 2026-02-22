"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { subscribeToComments, publishComment } from "@/lib/nostr-market";
import type { NDKSubscription } from "@nostr-dev-kit/ndk";

export interface Comment {
  id: string;
  pubkey: string;
  text: string;
  time: number;
}

export function useComments(tokenEventId: string | null, ticker: string) {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef<NDKSubscription | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!nostrReady || !tokenEventId) return;

    setLoading(true);
    seenRef.current.clear();

    const sub = subscribeToComments(tokenEventId, {
      onComment: (comment) => {
        if (seenRef.current.has(comment.id)) return;
        seenRef.current.add(comment.id);
        setComments((prev) =>
          [...prev, comment].sort((a, b) => b.time - a.time)
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
  }, [nostrReady, tokenEventId]);

  const postComment = useCallback(
    async (text: string) => {
      if (!tokenEventId || !text.trim()) return;
      await publishComment(tokenEventId, ticker, text);
    },
    [tokenEventId, ticker]
  );

  return { comments, loading, postComment };
}
