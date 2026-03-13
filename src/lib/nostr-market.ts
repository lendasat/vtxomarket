/**
 * Nostr marketplace operations for vtxo.market.
 *
 * Token metadata is stored in the indexer (SQLite). Nostr is used for:
 *   - Trade receipts (kind 30078, d-tag: vtxomarket/trade/{arkTxId})
 *   - Comments (kind 1, threaded by #t tag)
 */

import { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { ensureNostrReady, getNDK, VTXO_TOKEN_KIND } from "./nostr";
import { ARK_SERVER_URL } from "./ark-wallet";

// ── Network identifier ───────────────────────────────────────────────
// Derived from Ark server URL so Nostr events are scoped per network.

function getNetworkId(): string {
  try {
    return new URL(ARK_SERVER_URL).hostname;
  } catch {
    return "unknown";
  }
}

// ── Label tags ────────────────────────────────────────────────────────

const LABEL_NAMESPACE = "vtxomarket";
function labelTags(type: string): string[][] {
  return [
    ["L", LABEL_NAMESPACE],
    ["l", type, LABEL_NAMESPACE],
  ];
}

// ── Trade receipts ───────────────────────────────────────────────────

export interface TradeReceiptData {
  ticker: string;
  arkTxId: string;
  type: "buy" | "sell";
  sats: number;
  tokens: number;
  buyer: string;   // pubkey hex
  seller: string;  // pubkey hex
  price: number;
  timestamp: number;
}

// ── Comments (kind 1) ───────────────────────────────────────────────

export async function publishComment(
  ticker: string,
  text: string
): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = 1;
  event.content = text;
  event.tags = [
    ["t", `vtxomarket-${ticker.toLowerCase()}`],
    ...labelTags("comment"),
  ];
  await event.publish();
  return event;
}

// ── Subscriptions ───────────────────────────────────────────────────

/** Subscribe to trade receipts for a specific token */
export function subscribeToTradesForToken(
  ticker: string,
  callbacks: {
    onTrade: (trade: TradeReceiptData) => void;
    onEose?: () => void;
  }
): NDKSubscription | null {
  const ndk = getNDK();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#ticker": [ticker],
    "#l": ["trade"],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    try {
      const trade = JSON.parse(event.content) as TradeReceiptData;
      callbacks.onTrade(trade);
    } catch { /* ignore */ }
  });

  if (callbacks.onEose) {
    sub.on("eose", callbacks.onEose);
  }

  return sub;
}

/** Subscribe to ALL trade receipt events across all tokens */
export function subscribeToAllTrades(callbacks: {
  onTrade: (trade: TradeReceiptData) => void;
  onEose?: () => void;
}): NDKSubscription | null {
  const ndk = getNDK();
  const networkId = getNetworkId();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#l": ["trade"],
    "#t": ["vtxomarket-token"],
    limit: 20,
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    // Filter by network
    const eventNetwork = event.tags.find((t) => t[0] === "network")?.[1];
    if (eventNetwork && eventNetwork !== networkId) return;

    try {
      const trade = JSON.parse(event.content) as TradeReceiptData;
      callbacks.onTrade(trade);
    } catch { /* ignore malformed */ }
  });

  if (callbacks.onEose) {
    sub.on("eose", callbacks.onEose);
  }

  return sub;
}

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
