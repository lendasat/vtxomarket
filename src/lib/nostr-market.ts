/**
 * Nostr marketplace operations for vtxo.market.
 *
 * Token metadata is stored in the indexer (SQLite). Nostr is used for:
 *   - Comments (kind 1, threaded by #t tag)
 *
 * Trade history is sourced from the indexer (filled offers), not Nostr.
 */

import { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { ensureNostrReady, getNDK } from "./nostr";

// ── Label tags ────────────────────────────────────────────────────────

const LABEL_NAMESPACE = "vtxomarket";
function labelTags(type: string): string[][] {
  return [
    ["L", LABEL_NAMESPACE],
    ["l", type, LABEL_NAMESPACE],
  ];
}

// ── Comments (kind 1) ───────────────────────────────────────────────

export async function publishComment(ticker: string, text: string): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = 1;
  event.content = text;
  event.tags = [["t", `vtxomarket-${ticker.toLowerCase()}`], ...labelTags("comment")];
  await event.publish();
  return event;
}

// ── Subscriptions ───────────────────────────────────────────────────

/** Subscribe to comments for a token (filtered by ticker tag) */
export function subscribeToComments(
  ticker: string,
  callbacks: {
    onComment: (comment: { id: string; pubkey: string; text: string; time: number }) => void;
    onEose?: () => void;
  }
): NDKSubscription | null {
  const ndk = getNDK();
  const filter: NDKFilter = {
    kinds: [1],
    "#t": [`vtxomarket-${ticker.toLowerCase()}`],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    callbacks.onComment({
      id: event.id,
      pubkey: event.pubkey,
      text: event.content,
      time: event.created_at ?? Math.floor(Date.now() / 1000),
    });
  });

  if (callbacks.onEose) {
    sub.on("eose", callbacks.onEose);
  }

  return sub;
}
