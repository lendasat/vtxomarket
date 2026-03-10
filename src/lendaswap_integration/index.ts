/**
 * @lendasat/lendaswap — Reference Integration for vtxo.market
 *
 * This module provides a complete, production-ready integration of the
 * Lendaswap atomic swap protocol into an Arkade-based Bitcoin wallet.
 *
 * Architecture:
 *   lib/client.ts        — Singleton SDK client (lazy-init, IndexedDB persistence)
 *   lib/constants.ts     — EVM chain configs, token addresses, chain IDs
 *   lib/types.ts         — Shared TypeScript types for the integration
 *   hooks/useLendaswap.ts — React hook: init, quote, create, poll, claim, refund
 *   components/          — Drop-in UI components for send & receive flows
 *
 * Usage in wallet/page.tsx:
 *   Replace <StablecoinSend /> and <StablecoinReceive /> with the components
 *   exported from this module. See README comments in each component file.
 */

// ── Client ──────────────────────────────────────────────────────────────────
export { getLendaswapClient, resetLendaswapClient } from "./lib/client";

// ── Constants ───────────────────────────────────────────────────────────────
export {
  EVM_CHAINS,
  SUPPORTED_STABLECOINS,
  getTokenAddress,
  getChainId,
  getChainName,
  type EvmChainKey,
  type StablecoinKey,
} from "./lib/constants";

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  SwapDirection,
  SwapStep,
  SwapState,
  QuoteInfo,
  ActiveSwap,
} from "./lib/types";

// ── Hook ────────────────────────────────────────────────────────────────────
export { useLendaswap } from "./hooks/useLendaswap";

// ── Components ──────────────────────────────────────────────────────────────
export { StablecoinReceive } from "./components/StablecoinReceive";
export { StablecoinSend } from "./components/StablecoinSend";
export { CoinChainSelectors } from "./components/CoinChainSelectors";
export { SwapStatusTracker } from "./components/SwapStatusTracker";
export { QuoteDisplay } from "./components/QuoteDisplay";
