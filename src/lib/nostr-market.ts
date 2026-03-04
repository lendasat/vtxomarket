/**
 * Nostr marketplace operations for vtxo.market.
 *
 * All token data is stored as replaceable kind 30078 events on Nostr relays.
 * D-tag conventions:
 *   - Token listing:  vtxomarket/token/{TICKER}
 *   - Trade receipt:  vtxomarket/trade/{arkTxId}
 */

import { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { ensureNostrReady, getNDK, VTXO_TOKEN_KIND } from "./nostr";
import { ARK_SERVER_URL } from "./ark-wallet";
import type { Token } from "./store";

// ── Network identifier ───────────────────────────────────────────────
// Derived from Ark server URL so Nostr events are scoped per network.
// e.g. "mutinynet.arkade.sh" or "arkade.computer"

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

// ── Publish token listing ─────────────────────────────────────────────

export interface PublishTokenListingParams {
  name: string;
  ticker: string;
  description: string;
  image?: string;
  assetId: string;
  arkTxId: string;
  creatorArkAddress: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  controlAssetId?: string; // present when token is reissuable
  supply: number;
}

export async function publishTokenListing(params: PublishTokenListingParams): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const { name, ticker, description, image, assetId, arkTxId, creatorArkAddress, website, twitter, telegram, controlAssetId, supply } = params;

  const event = new NDKEvent(ndk);
  event.kind = VTXO_TOKEN_KIND;
  event.content = JSON.stringify({
    name,
    ticker,
    description,
    image: image || "",
    assetId,
    arkTxId,
    supply,
    creatorArkAddress,
    ...(website && { website }),
    ...(twitter && { twitter }),
    ...(telegram && { telegram }),
    ...(controlAssetId && { controlAssetId }),
  });
  event.tags = [
    ["d", `vtxomarket/token/${ticker}`],
    ...labelTags("token"),
    ["t", "vtxomarket-token"],
    ["network", getNetworkId()],
    ["name", name],
    ["ticker", ticker],
    ["assetId", assetId],
    ["supply", String(supply)],
    ...(controlAssetId ? [["controlAssetId", controlAssetId]] : []),
  ];

  await event.publish();
  return event;
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
  tokenEventId: string,
  ticker: string,
  text: string
): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = 1;
  event.content = text;
  event.tags = [
    ["e", tokenEventId, "", "root"],
    ["t", `vtxomarket-${ticker.toLowerCase()}`],
    ...labelTags("comment"),
  ];
  await event.publish();
  return event;
}

// ── Subscriptions ───────────────────────────────────────────────────

/** Parse a token listing event into a Token object */
function parseTokenEvent(event: NDKEvent): Token | null {
  try {
    const data = JSON.parse(event.content);
    return {
      id: event.id,
      assetId: data.assetId || "",
      name: data.name || "",
      ticker: data.ticker || "",
      description: data.description || "",
      image: data.image || undefined,
      creator: event.pubkey,
      creatorArkAddress: data.creatorArkAddress || "",
      createdAt: event.created_at ?? Math.floor(Date.now() / 1000),
      supply: data.supply ?? 0,
      controlAssetId: data.controlAssetId || undefined,
      replies: 0,
      tradeCount: 0,
      website: data.website,
      twitter: data.twitter,
      telegram: data.telegram,
    };
  } catch {
    return null;
  }
}

/** Subscribe to all vtxo.market token listing events for the current network */
export function subscribeToTokenListings(callbacks: {
  onToken: (token: Token) => void;
  onEose?: () => void;
}): NDKSubscription | null {
  const ndk = getNDK();
  const networkId = getNetworkId();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#t": ["vtxomarket-token"],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    // Only process token listing events (not curve/trade/order)
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
    if (!dTag.startsWith("vtxomarket/token/")) return;

    // Filter by network — skip tokens from other networks
    const eventNetwork = event.tags.find((t) => t[0] === "network")?.[1];
    if (eventNetwork && eventNetwork !== networkId) return;

    const token = parseTokenEvent(event);
    if (token) callbacks.onToken(token);
  });

  if (callbacks.onEose) {
    sub.on("eose", callbacks.onEose);
  }

  return sub;
}

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

/** Subscribe to comments (kind 1) for a token event */
export function subscribeToComments(
  tokenEventId: string,
  callbacks: {
    onComment: (comment: { id: string; pubkey: string; text: string; time: number }) => void;
    onEose?: () => void;
  }
): NDKSubscription | null {
  const ndk = getNDK();
  const filter: NDKFilter = {
    kinds: [1],
    "#e": [tokenEventId],
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

/** One-shot fetch a token listing by ticker (current network only) */
export async function fetchTokenByTicker(ticker: string): Promise<Token | null> {
  const ndk = getNDK();
  const networkId = getNetworkId();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#d": [`vtxomarket/token/${ticker}`],
    limit: 1,
  };

  const events = await ndk.fetchEvents(filter);
  for (const event of events) {
    // Skip tokens from other networks
    const eventNetwork = event.tags.find((t) => t[0] === "network")?.[1];
    if (eventNetwork && eventNetwork !== networkId) continue;

    const token = parseTokenEvent(event);
    if (token) return token;
  }
  return null;
}
