/**
 * Nostr marketplace operations for vtxo.fun.
 *
 * All token data is stored as replaceable kind 30078 events on Nostr relays.
 * D-tag conventions:
 *   - Token listing:  vtxofun/token/{TICKER}
 *   - Curve state:    vtxofun/curve/{TICKER}
 *   - Trade receipt:  vtxofun/trade/{arkTxId}
 *   - Order:          vtxofun/order/{arkTxId}
 */

import { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { ensureNostrReady, getNDK, VTXO_TOKEN_KIND } from "./nostr";
import { ARK_SERVER_URL } from "./ark-wallet";
import type { CurveState } from "./bonding-curve";
import {
  getPrice,
  getMarketCap,
  getCurveProgress,
  initialCurveState,
  TOKEN_TOTAL_SUPPLY,
} from "./bonding-curve";
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

const LABEL_NAMESPACE = "vtxofun";
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
}

export async function publishTokenListing(params: PublishTokenListingParams): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const { name, ticker, description, image, assetId, arkTxId, creatorArkAddress, website, twitter, telegram } = params;
  const curve = initialCurveState();

  const event = new NDKEvent(ndk);
  event.kind = VTXO_TOKEN_KIND;
  event.content = JSON.stringify({
    name,
    ticker,
    description,
    image: image || "",
    assetId,
    arkTxId,
    supply: TOKEN_TOTAL_SUPPLY,
    creatorArkAddress,
    virtualTokenReserves: curve.virtualTokenReserves,
    virtualSatReserves: curve.virtualSatReserves,
    realTokenReserves: curve.realTokenReserves,
    ...(website && { website }),
    ...(twitter && { twitter }),
    ...(telegram && { telegram }),
  });
  event.tags = [
    ["d", `vtxofun/token/${ticker}`],
    ...labelTags("token"),
    ["t", "vtxofun-token"],
    ["network", getNetworkId()],
    ["name", name],
    ["ticker", ticker],
    ["assetId", assetId],
    ["supply", String(TOKEN_TOTAL_SUPPLY)],
  ];

  await event.publish();
  return event;
}

// ── Publish curve state ──────────────────────────────────────────────

export async function publishCurveState(ticker: string, state: CurveState): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = VTXO_TOKEN_KIND;
  event.content = JSON.stringify({
    virtualTokenReserves: state.virtualTokenReserves,
    virtualSatReserves: state.virtualSatReserves,
    realTokenReserves: state.realTokenReserves,
  });
  event.tags = [
    ["d", `vtxofun/curve/${ticker}`],
    ...labelTags("curve"),
    ["ticker", ticker],
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

export async function publishTradeReceipt(trade: TradeReceiptData): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = VTXO_TOKEN_KIND;
  event.content = JSON.stringify(trade);
  event.tags = [
    ["d", `vtxofun/trade/${trade.arkTxId}`],
    ...labelTags("trade"),
    ["ticker", trade.ticker],
  ];
  await event.publish();
  return event;
}

// ── Order events ────────────────────────────────────────────────────

export interface OrderData {
  ticker: string;
  arkTxId: string;
  type: "buy" | "sell";
  sats: number;
  expectedTokens: number;
  buyerPubkey: string;
  buyerArkAddress: string;
  timestamp: number;
}

export async function publishOrderEvent(order: OrderData): Promise<NDKEvent> {
  const ndk = ensureNostrReady();
  const event = new NDKEvent(ndk);
  event.kind = VTXO_TOKEN_KIND;
  event.content = JSON.stringify(order);
  event.tags = [
    ["d", `vtxofun/order/${order.arkTxId}`],
    ...labelTags("order"),
    ["ticker", order.ticker],
    ["p", order.buyerPubkey],
  ];
  await event.publish();
  return event;
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
    ["t", `vtxofun-${ticker.toLowerCase()}`],
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
    const curve: CurveState = {
      virtualTokenReserves: data.virtualTokenReserves ?? initialCurveState().virtualTokenReserves,
      virtualSatReserves: data.virtualSatReserves ?? initialCurveState().virtualSatReserves,
      realTokenReserves: data.realTokenReserves ?? initialCurveState().realTokenReserves,
    };

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
      supply: data.supply ?? TOKEN_TOTAL_SUPPLY,
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSatReserves: curve.virtualSatReserves,
      realTokenReserves: curve.realTokenReserves,
      price: getPrice(curve),
      marketCap: getMarketCap(curve),
      curveProgress: getCurveProgress(curve),
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

/** Subscribe to all vtxo.fun token listing events for the current network */
export function subscribeToTokenListings(callbacks: {
  onToken: (token: Token) => void;
  onEose?: () => void;
}): NDKSubscription | null {
  const ndk = getNDK();
  const networkId = getNetworkId();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#t": ["vtxofun-token"],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    // Only process token listing events (not curve/trade/order)
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
    if (!dTag.startsWith("vtxofun/token/")) return;

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

/** Subscribe to curve state updates for a specific token */
export function subscribeToCurveState(
  ticker: string,
  callback: (state: CurveState) => void
): NDKSubscription | null {
  const ndk = getNDK();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#d": [`vtxofun/curve/${ticker}`],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    try {
      const data = JSON.parse(event.content);
      callback({
        virtualTokenReserves: data.virtualTokenReserves,
        virtualSatReserves: data.virtualSatReserves,
        realTokenReserves: data.realTokenReserves,
      });
    } catch { /* ignore malformed */ }
  });

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

/** Subscribe to order events for a specific creator (for CMM) */
export function subscribeToOrdersForCreator(
  pubkey: string,
  callbacks: {
    onOrder: (order: OrderData, event: NDKEvent) => void;
    onEose?: () => void;
  }
): NDKSubscription | null {
  const ndk = getNDK();
  const filter: NDKFilter = {
    kinds: [VTXO_TOKEN_KIND as number],
    "#l": ["order"],
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on("event", (event: NDKEvent) => {
    try {
      const order = JSON.parse(event.content) as OrderData;
      // Only process orders for tokens created by this pubkey
      // The creator checks if the order is for their token
      callbacks.onOrder(order, event);
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
    "#d": [`vtxofun/token/${ticker}`],
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
