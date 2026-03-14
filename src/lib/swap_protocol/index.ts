/**
 * swap_protocol — Non-interactive token swap protocol for Ark (Arkade).
 *
 * This module implements trustless token↔BTC swaps on the Ark protocol using:
 *   - 3-leaf taproot scripts (swap, cancel, forfeit)
 *   - Arkade introspection opcodes for output validation
 *   - The Arkade Introspector co-signer service
 *   - Raw BIP-174 PSBT manipulation for multi-party signing
 *
 * Architecture overview:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │                        Swap VTXO                               │
 *   │  3-leaf taproot:                                               │
 *   │    Leaf 0 (swap):    MultisigClosure(introspectorTweaked, ASP) │
 *   │    Leaf 1 (cancel):  CSV + maker CHECKSIG                     │
 *   │    Leaf 2 (forfeit): MultisigClosure(maker, ASP)              │
 *   │                                                                │
 *   │  Arkade Script (PSBT custom field, NOT in tapscript):          │
 *   │    OP_INSPECTOUTPUTVALUE >= satAmount                          │
 *   │    OP_INSPECTOUTPUTSCRIPTPUBKEY == makerPkScript               │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 *   FILL FLOW (taker buys tokens) — light path via submitTx/finalizeTx:
 *     1. Taker calls lightFillSwapOffer() with the offer + their wallet
 *     2. Builds offchain ark tx + checkpoints directly (no round participation)
 *     3. Injects arkade script PSBT field on swap VTXO input
 *     4. Signs taker's funding VTXO inputs (identity.sign skips swap input)
 *     5. Sends to introspector POST /v1/tx → validates conditions, co-signs swap input + checkpoint
 *     6. Merges introspector + taker signatures (BIP-174 Combiner)
 *     7. Submits to ASP via submitTx → ASP co-signs, returns signed checkpoints
 *     8. Signs returned checkpoints with taker identity (skips swap checkpoint — not taker's key)
 *     9. Finalizes via finalizeTx → done
 *
 *   CANCEL FLOW (maker reclaims tokens) — light path via submitTx/finalizeTx:
 *     1. Maker calls cancelSwapOffer() with their wallet + offer
 *     2. Builds offchain ark tx using cancel forfeit leaf (MultisigClosure maker + ASP)
 *     3. Signs with maker identity → submitTx → ASP co-signs
 *     4. Signs returned checkpoints → finalizeTx → done
 *     No introspector needed — standard collaborative closure.
 *
 * Module structure:
 *   opcodes.ts              — Arkade opcode constants + @scure/btc-signer registration
 *   script.ts               — Swap script construction + decoding (taproot tree, arkade script)
 *   offers.ts               — Offer lifecycle (create, cancel via light path)
 *   light-fill.ts           — Light fill via submitTx/finalizeTx (no rounds, no forfeits)
 *   introspector-client.ts  — REST client for the Arkade Introspector service
 *   psbt-combiner.ts        — Raw BIP-174 PSBT utilities (combine signatures)
 */

// Opcodes
export { registerArkadeOpcodes, encodeLE64 } from "./opcodes";
export {
  OP_INSPECTOUTPUTVALUE,
  OP_INSPECTOUTPUTSCRIPTPUBKEY,
  OP_INSPECTOUTASSETLOOKUP,
  OP_GREATERTHANOREQUAL64,
  OP_SCRIPTNUMTOLE64,
} from "./opcodes";

// Script construction
export { buildSwapScript, buildBuySwapScript, decodeSwapScript, buildArkadeScript, buildBuyArkadeScript, computeIntrospectorTweakedPubkey } from "./script";
export type { SwapScriptParams, BuySwapScriptParams, SwapScriptResult, TapLeafScript } from "./script";

// Offer lifecycle
export { createSwapOffer, cancelSwapOffer, createBuyOffer, cancelBuyOffer } from "./offers";
export type { SwapOfferParams, SwapOffer, BuyOfferParams, BuyOffer } from "./offers";

// Light fill (replaces heavy settle-based fillSwapOffer)
export { lightFillSwapOffer, lightFillBuyOffer } from "./light-fill";

// Introspector client
export {
  getIntrospectorInfo,
  submitIntent,
  submitFinalization,
} from "./introspector-client";
export type {
  IntrospectorInfo,
  SubmitIntentRequest,
  SubmitIntentResponse,
  SubmitFinalizationRequest,
  SubmitFinalizationResponse,
  TxTreeNode,
} from "./introspector-client";

// PSBT utilities
export { Psbt } from "./psbt-combiner";
