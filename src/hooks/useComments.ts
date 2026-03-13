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

export function useComments(ticker: string | null) {
  const nostrReady = useAppStore((s) => s.nostrReady);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef<NDKSubscription | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!nostrReady || !ticker) return;

    setLoading(true);
    seenRef.current.clear();

    const sub = subscribeToComments(ticker, {
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
  }, [nostrReady, ticker]);

  const postComment = useCallback(
    async (text: string) => {
      if (!ticker || !text.trim()) return;
      await publishComment(ticker, text);
    },
    [ticker]
  );

  return { comments, loading, postComment };
}
