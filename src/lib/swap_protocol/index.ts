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
 *   FILL FLOW (taker buys tokens):
 *     1. Taker calls fillSwapOffer() with the offer + their wallet
 *     2. wallet.settle() creates intent PSBT with swap VTXO + taker's funding VTXOs
 *     3. IntrospectorArkProvider intercepts registerIntent():
 *        a. Injects taptree + arkadescript PSBT fields (SDK bug workaround)
 *        b. Strips non-swap input signatures (introspector requires arkadescript per signed input)
 *        c. Sends stripped PSBT to introspector /v1/intent → gets co-signature
 *        d. Merges co-signature back into full PSBT (BIP-174 Combiner)
 *        e. Forwards merged PSBT to ASP
 *     4. IntrospectorArkProvider intercepts submitSignedForfeitTxs():
 *        a. Builds missing swap VTXO forfeit (SDK skips it — wrong key)
 *        b. Sends all forfeits to introspector /v1/finalization → gets co-signed
 *        c. Merges commitment tx signatures
 *        d. Forwards to ASP
 *     5. ASP validates asset conservation and finalizes the round
 *
 *   CANCEL FLOW (maker reclaims tokens):
 *     1. After CSV timelock expires, maker calls cancelSwapOffer()
 *     2. Uses cancel leaf (CSV + maker CHECKSIG) — no introspector needed
 *     3. Forfeit uses cancel forfeit leaf (MultisigClosure maker + ASP)
 *
 * Module structure:
 *   opcodes.ts              — Arkade opcode constants + @scure/btc-signer registration
 *   script.ts               — Swap script construction + decoding (taproot tree, arkade script)
 *   offers.ts               — Offer lifecycle (create, fill, cancel)
 *   introspector-client.ts  — REST client for the Arkade Introspector service
 *   introspector-provider.ts — ArkProvider wrapper (PSBT injection, sig merging, forfeit construction)
 *   psbt-combiner.ts        — Raw BIP-174 PSBT utilities (combine, strip tapScriptSig)
 */

// Opcodes
export { registerArkadeOpcodes, encodeLE64 } from "./opcodes";
export {
  OP_INSPECTOUTPUTVALUE,
  OP_INSPECTOUTPUTSCRIPTPUBKEY,
  OP_GREATERTHANOREQUAL64,
} from "./opcodes";

// Script construction
export { buildSwapScript, decodeSwapScript, buildArkadeScript, computeIntrospectorTweakedPubkey } from "./script";
export type { SwapScriptParams, SwapScriptResult, TapLeafScript } from "./script";

// Offer lifecycle
export { createSwapOffer, fillSwapOffer, cancelSwapOffer } from "./offers";
export type { SwapOfferParams, SwapOffer } from "./offers";

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

// Introspector ArkProvider wrapper
export { IntrospectorArkProvider } from "./introspector-provider";

// PSBT utilities
export { Psbt } from "./psbt-combiner";
