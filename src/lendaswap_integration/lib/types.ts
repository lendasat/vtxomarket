/**
 * Shared types for the Lendaswap integration layer.
 *
 * These types model the swap lifecycle as a state machine that the UI
 * components consume. They are intentionally decoupled from the SDK's
 * internal types to keep the component API stable.
 */

import type { EvmChainKey, StablecoinKey } from "./constants";

// ── Swap direction ──────────────────────────────────────────────────────────

/** Which way the atomic swap goes from the user's perspective. */
export type SwapDirection =
  /** User sends sats (Arkade) → recipient gets stablecoins (EVM) */
  | "send"
  /** User sends stablecoins (EVM) → wallet receives sats (Arkade) */
  | "receive";

// ── Swap step state machine ─────────────────────────────────────────────────

/**
 * Wizard steps visible in the UI. Each step is a discrete screen.
 *
 * SEND flow:    idle → quoting → confirming → funding → processing → success | error
 * RECEIVE flow: idle → quoting → confirming → awaiting_deposit → processing → success | error
 */
export type SwapStep =
  | "idle"
  | "quoting"
  | "confirming"
  | "funding" // send: user's Ark wallet is sending to VHTLC
  | "awaiting_deposit" // receive: waiting for user's EVM deposit
  | "processing" // HTLC locked, waiting for counterparty
  | "claiming" // auto-claim in progress
  | "success"
  | "error";

// ── Quote ───────────────────────────────────────────────────────────────────

export interface QuoteInfo {
  /** Exchange rate: tokens per BTC (e.g. "67432.50") */
  exchangeRate: string;
  /** Total protocol fee in sats */
  protocolFeeSats: number;
  /** Network (gas) fee in sats */
  networkFeeSats: number;
  /** Source amount in its smallest unit */
  sourceAmount: string;
  /** Target amount in its smallest unit */
  targetAmount: string;
  /** Min swap amount in sats */
  minAmountSats: number;
  /** Max swap amount in sats */
  maxAmountSats: number;
}

// ── Active swap ─────────────────────────────────────────────────────────────

export interface ActiveSwap {
  /** Swap UUID from Lendaswap backend */
  id: string;
  direction: SwapDirection;
  coin: StablecoinKey;
  chain: EvmChainKey;

  /** For SEND: the VHTLC address user sends BTC to */
  vhtlcAddress?: string;
  /** For SEND: amount in sats the user must send */
  satsRequired?: number;
  /** For SEND: destination EVM address for gasless claim */
  destinationEvmAddress?: string;

  /** For RECEIVE: SDK-derived EVM address where stablecoins should be sent */
  evmDepositAddress?: string;
  /** For RECEIVE: amount of stablecoins to deposit (smallest unit) */
  evmDepositAmount?: string;

  /** Human-readable source amount */
  sourceDisplay: string;
  /** Human-readable target amount */
  targetDisplay: string;

  /** Backend swap status (raw string from API) */
  backendStatus: string;

  /** Claim transaction hash (EVM or Ark) */
  claimTxHash?: string;
  /** Timestamp of swap creation */
  createdAt: number;
}

// ── Full swap state (consumed by hook) ──────────────────────────────────────

export interface SwapState {
  step: SwapStep;
  quote: QuoteInfo | null;
  swap: ActiveSwap | null;
  error: string | null;
}

export const INITIAL_SWAP_STATE: SwapState = {
  step: "idle",
  quote: null,
  swap: null,
  error: null,
};

// ── Stablecoin transaction (for unified history) ────────────────────────────

export interface StablecoinTxItem {
  swapId: string;
  direction: "send" | "receive";
  coin: StablecoinKey;
  chain: EvmChainKey;
  /** Human-readable stablecoin amount (e.g. "50.25 USDC") */
  stablecoinDisplay: string;
  satsAmount: number;
  destinationAddress: string;
  status: "pending" | "processing" | "claiming" | "complete" | "failed";
  backendStatus: string;
  claimTxHash?: string;
  createdAt: number;
}

// ── Backend status mapping (shared by hooks) ─────────────────────────────────

/** Statuses where polling should stop (swap is finalized). */
export const TERMINAL_STATUSES = new Set([
  "serverredeemed",
  "clientredeemed",
  "expired",
  "clientrefunded",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "clientinvalidfunded",
  "clientfundedtoolate",
  "clientredeemedandclientrefunded",
]);

/** Statuses that represent a successful swap outcome. */
export const SUCCESS_STATUSES = new Set(["serverredeemed", "clientredeemed", "clientredeeming"]);

/** Map raw backend status to a coarse UI status for display. */
export function mapBackendStatus(raw: string): StablecoinTxItem["status"] {
  if (SUCCESS_STATUSES.has(raw)) return "complete";
  if (raw === "serverfunded") return "claiming";
  if (TERMINAL_STATUSES.has(raw) && !SUCCESS_STATUSES.has(raw)) return "failed";
  if (raw === "pending") return "pending";
  return "processing";
}
