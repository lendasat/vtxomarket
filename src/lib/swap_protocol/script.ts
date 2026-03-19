/**
 * Swap script construction and decoding for non-interactive Arkade swaps.
 *
 * ARCHITECTURE:
 *
 * The swap uses the Arkade Introspector — a standalone co-signer service that validates
 * introspection opcode conditions (output value, output scriptPubKey) and co-signs PSBTs.
 *
 * The swap VTXO has a 3-leaf taproot tree:
 *   Leaf 0 (swap):    MultisigClosure(introspectorTweaked, ASP)
 *                      — the introspector co-signs after validating arkade script conditions
 *   Leaf 1 (cancel):  CSV + maker CHECKSIG
 *                      — maker reclaims after relative timelock (seconds-based)
 *   Leaf 2 (forfeit): MultisigClosure(maker, ASP)
 *                      — standard forfeit for cancel path (no introspector needed)
 *
 * The introspection conditions (OP_INSPECTOUTPUTVALUE, OP_INSPECTOUTPUTSCRIPTPUBKEY)
 * are NOT in the tapscript leaf — they are a standalone "arkade script" embedded in a
 * PSBT custom field (key type 0xDE, field name "arkadescript"). The introspector reads
 * this field, executes the conditions against the spending transaction, and co-signs
 * the MultisigClosure leaf if conditions pass.
 *
 * The introspector's tweaked key is per-script:
 *   scriptHash = TaggedHash("ArkScriptHash", arkadeScriptBytes)
 *   tweakedKey = introspectorBasePubKey + scriptHash * G
 */

import { hex as scureHex } from "@scure/base";
import {
  OP_INSPECTOUTPUTVALUE,
  OP_INSPECTOUTPUTSCRIPTPUBKEY,
  OP_INSPECTOUTASSETLOOKUP,
  OP_GREATERTHANOREQUAL64,
  OP_SCRIPTNUMTOLE64,
  OP_VERIFY,
  OP_EQUAL,
  OP_EQUALVERIFY,
  OP_1,
  encodeLE64,
} from "./opcodes";

const hexToBytes = scureHex.decode;
const bytesToHex = scureHex.encode;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwapScriptParams {
  makerPkScript: Uint8Array; // 34-byte P2TR scriptPubKey (from ArkAddress.decode().pkScript)
  makerXOnlyPubkey: Uint8Array; // 32-byte x-only pubkey for cancel leaf + cancel forfeit
  satAmount: number | bigint;
  cancelSeconds: number; // CSV sequence value (raw, from ASP unilateralExitDelay)
  introspectorPubkey: Uint8Array; // 32-byte x-only pubkey from introspector /v1/info
  aspPubkey: Uint8Array; // 32-byte x-only ASP signer pubkey
}

export interface BuySwapScriptParams {
  buyerPkScript: Uint8Array; // 34-byte P2TR scriptPubKey — buyer (maker) receives tokens here
  buyerXOnlyPubkey: Uint8Array; // 32-byte x-only pubkey for cancel leaf + cancel forfeit
  assetTxidBytes: Uint8Array; // 32-byte asset ID (txid bytes for OP_INSPECTOUTASSETLOOKUP)
  tokenAmount: number | bigint; // required token amount
  cancelSeconds: number; // CSV sequence value (raw, from ASP unilateralExitDelay)
  introspectorPubkey: Uint8Array; // 32-byte x-only pubkey from introspector /v1/info
  aspPubkey: Uint8Array; // 32-byte x-only ASP signer pubkey
}

export type TapLeafScript = [
  { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] },
  Uint8Array,
];

type ArkAddress = { encode(): string };

export interface SwapScriptResult {
  leaves: [TapLeafScript, TapLeafScript, TapLeafScript]; // [swap, cancel, cancelForfeit]
  tweakedPublicKey: Uint8Array;
  scripts: [Uint8Array, Uint8Array, Uint8Array];
  arkadeScript: Uint8Array; // standalone introspection conditions (PSBT custom field)
  arkadeScriptHash: Uint8Array; // TaggedHash("ArkScriptHash", arkadeScript)
  introspectorTweakedPubkey: Uint8Array; // base + scriptHash * G
  encode(): Uint8Array;
  address(prefix: string, serverPubKey: Uint8Array): ArkAddress;
}

// ── Introspector key tweaking ─────────────────────────────────────────────────

/**
 * Compute the introspector's tweaked public key for a given arkade script.
 *
 * tweakedKey = basePubkey + TaggedHash("ArkScriptHash", arkadeScript) * G
 *
 * This matches the Go implementation in introspector/pkg/arkade/tweak.go.
 */
export async function computeIntrospectorTweakedPubkey(
  basePubkeyXOnly: Uint8Array,
  arkadeScriptBytes: Uint8Array
): Promise<{ tweakedPubkey: Uint8Array; scriptHash: Uint8Array }> {
  const { sha256 } = await import("@noble/hashes/sha2");
  const { secp256k1 } = await import("@noble/curves/secp256k1");

  // BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg)
  const tagBytes = new TextEncoder().encode("ArkScriptHash");
  const tagHash = sha256(tagBytes);
  const combined = new Uint8Array(tagHash.length * 2 + arkadeScriptBytes.length);
  combined.set(tagHash, 0);
  combined.set(tagHash, tagHash.length);
  combined.set(arkadeScriptBytes, tagHash.length * 2);
  const scriptHash = sha256(combined);

  // EC point addition: P' = P + scriptHash * G
  // The introspector normalizes the base key to x-only (even Y) before tweaking
  // fromHex expects 33-byte compressed key, so prepend 0x02 (even Y) to the 32-byte x-only key
  const compressedBase = new Uint8Array(33);
  compressedBase[0] = 0x02;
  compressedBase.set(basePubkeyXOnly, 1);
  const basePoint = secp256k1.ProjectivePoint.fromHex(compressedBase);
  const tweakScalar = BigInt("0x" + bytesToHex(scriptHash));
  const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(tweakScalar);
  const resultPoint = basePoint.add(tweakPoint);

  // Return as 32-byte x-only
  const compressedHex = resultPoint.toHex(true); // 33-byte compressed
  const tweakedPubkey = hexToBytes(compressedHex.slice(2)); // strip prefix byte

  return { tweakedPubkey, scriptHash };
}

// ── Arkade script construction ────────────────────────────────────────────────

/**
 * Build the standalone arkade script — introspection conditions validated by the introspector.
 * This is embedded as a PSBT custom field (key 0xDE + "arkadescript"), NOT as a tapscript leaf.
 *
 * Conditions: output[0].value >= satAmount AND output[0].scriptPubKey == makerPkScript
 *
 * In Arkade Script (high-level syntax), this would be:
 *
 *   contract NonInteractiveSwap(makerPkScript, amount) {
 *     swap(takerSig) {
 *       verify(inspectOutputValue(0) >= amount)
 *       verify(inspectOutputScriptPubKey(0) == makerPkScript)
 *       verify(checkSig(takerSig))
 *     }
 *   }
 *
 * See: https://docs.arkadeos.com/experimental/non-interactive-swaps
 *
 * We hand-assemble the opcode bytes below because the Arkade Script compiler (arkadec)
 * is a Go CLI tool with no TypeScript/JavaScript API. Our script is parametric — the
 * maker's address and sat amount change per offer, requiring runtime compilation.
 * For our 2-condition script this is straightforward; for complex contracts (partial fills,
 * oracle pricing) the compiler would be the right tool.
 *
 * Compiler repo: https://github.com/ArkLabsHQ/arkade (arkadec CLI)
 *
 * The introspector's OP_INSPECTOUTPUTSCRIPTPUBKEY pushes [scriptType, scriptBody] separately:
 *   - scriptType: 1 for P2TR (segwit v1)
 *   - scriptBody: 32-byte witness program (without 0x5120 prefix)
 */
export function buildArkadeScript(
  makerPkScript: Uint8Array,
  satAmount: number | bigint
): Uint8Array {
  const satAmountLE64 = encodeLE64(satAmount);

  // Extract the 32-byte witness program from the P2TR pkScript (OP_1 <32-byte-key>).
  // This is the tweaked key that appears in the output's scriptPubKey,
  // NOT the raw x-only pubkey. The introspector's OP_INSPECTOUTPUTSCRIPTPUBKEY
  // pushes the witness program, so we must match it.
  if (makerPkScript.length !== 34 || makerPkScript[0] !== 0x51) {
    throw new Error(
      `Expected 34-byte P2TR pkScript (OP_1 + 32 bytes), got ${makerPkScript.length} bytes`
    );
  }
  const makerWitnessProgram = makerPkScript.slice(2); // skip OP_1 (0x51) + push length (0x20)

  return new Uint8Array([
    // Check: output[0].value >= satAmount
    0x00, // OP_0 — output index 0
    OP_INSPECTOUTPUTVALUE, // push output[0].value as 8-byte LE64
    0x08,
    ...satAmountLE64, // push required sat amount (8 bytes)
    OP_GREATERTHANOREQUAL64, // compare: output value >= required
    OP_VERIFY, // abort if false

    // Check: output[0].scriptPubKey == maker's Ark address (P2TR tweaked key)
    0x00, // OP_0 — output index 0
    OP_INSPECTOUTPUTSCRIPTPUBKEY, // pushes [program(32 bytes), version(int)]
    OP_1, // push 1 (P2TR script type / segwit v1)
    OP_EQUALVERIFY, // check version == 1, pop both
    0x20,
    ...makerWitnessProgram, // push 32-byte expected witness program
    OP_EQUAL, // check program matches — leaves true on stack
  ]);
}

// ── Buy offer arkade script ──────────────────────────────────────────────────

/**
 * Build the arkade script for a buy offer — introspection conditions validated by the introspector.
 * Embedded in the OP_RETURN as an IntrospectorPacket (type 0x01), NOT as a tapscript leaf.
 *
 * Conditions:
 *   output[0].scriptPubKey == buyerPkScript (P2TR)
 *   output[0] has >= tokenAmount of the specified asset
 *
 * The buyer locks SATS into the swap VTXO. The arkade script verifies the taker
 * delivers TOKENS to the buyer's address at output[0].
 */
export function buildBuyArkadeScript(
  buyerPkScript: Uint8Array,
  assetTxidBytes: Uint8Array,
  tokenAmount: number | bigint
): Uint8Array {
  const tokenAmountLE64 = encodeLE64(tokenAmount);

  // Extract 32-byte witness program from P2TR pkScript
  if (buyerPkScript.length !== 34 || buyerPkScript[0] !== 0x51) {
    throw new Error(
      `Expected 34-byte P2TR pkScript (OP_1 + 32 bytes), got ${buyerPkScript.length} bytes`
    );
  }
  const buyerWitnessProgram = buyerPkScript.slice(2); // skip OP_1 (0x51) + push length (0x20)

  if (assetTxidBytes.length !== 32) {
    throw new Error(`Expected 32-byte asset txid, got ${assetTxidBytes.length} bytes`);
  }

  return new Uint8Array([
    // 1. Verify output[0].scriptPubKey == buyer's Ark address (P2TR)
    0x00, // OP_0 — output index 0
    OP_INSPECTOUTPUTSCRIPTPUBKEY, // pushes [program(32 bytes), version(int)]
    OP_1, // push 1 (P2TR script type / segwit v1)
    OP_EQUALVERIFY, // check version == 1
    0x20,
    ...buyerWitnessProgram, // push 32-byte expected witness program
    OP_EQUALVERIFY, // check program matches

    // 2. Verify output[0] has >= tokenAmount of the specified asset
    0x00, // OP_0 — output index 0
    0x20,
    ...assetTxidBytes, // push 32-byte asset ID txid
    0x00, // OP_0 — group index 0
    OP_INSPECTOUTASSETLOOKUP, // pushes token amount (scriptNum) or -1 if not found
    OP_SCRIPTNUMTOLE64, // convert to 8-byte LE64
    0x08,
    ...tokenAmountLE64, // push required amount (8 bytes LE64)
    OP_GREATERTHANOREQUAL64, // amount >= required — leaves bool on stack
  ]);
}

// ── 3-leaf taproot swap script ────────────────────────────────────────────────

// SDK loader — cached to avoid duplicate imports
let _sdkPromise: Promise<typeof import("@arkade-os/sdk")> | null = null;
function getSDK() {
  if (!_sdkPromise) {
    _sdkPromise = import("@arkade-os/sdk");
  }
  return _sdkPromise;
}

/**
 * Build a 3-leaf taproot script for non-interactive swap with introspector co-signing.
 *
 * Leaf 0 (swap):    MultisigClosure(introspectorTweaked, ASP) — introspector validates & co-signs
 * Leaf 1 (cancel):  CSV + maker CHECKSIG — maker reclaims after timeout
 * Leaf 2 (forfeit): MultisigClosure(maker, ASP) — standard forfeit for cancel path
 *
 * The introspection conditions are in a separate arkadeScript (not in any leaf).
 */
export async function buildSwapScript(params: SwapScriptParams): Promise<SwapScriptResult> {
  const sdk = await getSDK();
  const { ArkAddress: ArkAddr, TapTreeCoder } = sdk;
  const btc = await import("@scure/btc-signer");
  const { tapLeafHash, TAP_LEAF_VERSION } = await import("@scure/btc-signer/payment.js");
  const { taprootTweakPubkey, TAPROOT_UNSPENDABLE_KEY, concatBytes, tagSchnorr, compareBytes } =
    await import("@scure/btc-signer/utils.js");
  const {
    makerPkScript,
    makerXOnlyPubkey,
    satAmount,
    cancelSeconds,
    introspectorPubkey,
    aspPubkey,
  } = params;

  // Build standalone arkade script (PSBT custom field for introspector validation)
  // Uses makerPkScript (P2TR with tweaked key) — the introspector inspects the actual output scriptPubKey
  const arkadeScript = buildArkadeScript(makerPkScript, satAmount);

  // Compute introspector's tweaked pubkey for this specific arkade script
  const { tweakedPubkey: introspectorTweakedPubkey, scriptHash: arkadeScriptHash } =
    await computeIntrospectorTweakedPubkey(introspectorPubkey, arkadeScript);

  // ── Leaf 0: Swap (MultisigClosure — introspector validates, then both sign) ──
  // <introspectorTweaked> CHECKSIGVERIFY <ASP> CHECKSIG
  const swapLeafBytes = btc.Script.encode([
    introspectorTweakedPubkey,
    "CHECKSIGVERIFY",
    aspPubkey,
    "CHECKSIG",
  ]);

  // ── Leaf 1: Cancel exit (CSV — relative timelock + maker CHECKSIG) ──
  // cancelSeconds is seconds from ASP's unilateralExitDelay.
  // Must be BIP68 time-encoded: set bit 22 (type flag), value = ceil(seconds/512).
  const BIP68_TIME_FLAG = 0x400000;
  const bip68Value = BIP68_TIME_FLAG | Math.ceil(cancelSeconds / 512);
  const { ScriptNum } = btc;
  const MinimalScriptNum = ScriptNum(undefined, true);
  const sequenceBytes = MinimalScriptNum.encode(BigInt(bip68Value));
  const cancelLeafBytes = btc.Script.encode([
    sequenceBytes.length === 1 ? sequenceBytes[0] : sequenceBytes,
    "CHECKSEQUENCEVERIFY",
    "DROP",
    makerXOnlyPubkey,
    "CHECKSIG",
  ]);

  // ── Leaf 2: Cancel Forfeit (MultisigClosure — maker + ASP, no introspector) ──
  const cancelForfeitLeafBytes = btc.Script.encode([
    makerXOnlyPubkey,
    "CHECKSIGVERIFY",
    aspPubkey,
    "CHECKSIG",
  ]);

  const scripts: [Uint8Array, Uint8Array, Uint8Array] = [
    swapLeafBytes,
    cancelLeafBytes,
    cancelForfeitLeafBytes,
  ];
  const version = TAP_LEAF_VERSION;
  const internalKey = TAPROOT_UNSPENDABLE_KEY;

  const leafHash0 = tapLeafHash(scripts[0], version);
  const leafHash1 = tapLeafHash(scripts[1], version);
  const leafHash2 = tapLeafHash(scripts[2], version);

  // Inner branch: sort(leaf0, leaf1)
  let [l0, l1] = [leafHash0, leafHash1];
  if (compareBytes(l1, l0) === -1) [l0, l1] = [l1, l0];
  const innerBranch = tagSchnorr("TapBranch", l0, l1);

  // Root: sort(innerBranch, leaf2)
  let [lB, lR] = [innerBranch, leafHash2];
  if (compareBytes(lR, lB) === -1) [lB, lR] = [lR, lB];
  const rootHash = tagSchnorr("TapBranch", lB, lR);

  const [tweakedPubkey, parity] = taprootTweakPubkey(internalKey, rootHash);

  // Merkle paths for each leaf
  // leaf0: sibling=leafHash1, then sibling=leafHash2
  // leaf1: sibling=leafHash0, then sibling=leafHash2
  // leaf2: sibling=innerBranch
  const leaf0: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash1, leafHash2] },
    concatBytes(scripts[0], new Uint8Array([version])),
  ];
  const leaf1: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash0, leafHash2] },
    concatBytes(scripts[1], new Uint8Array([version])),
  ];
  const leaf2: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [innerBranch] },
    concatBytes(scripts[2], new Uint8Array([version])),
  ];

  return {
    leaves: [leaf0, leaf1, leaf2],
    tweakedPublicKey: tweakedPubkey,
    scripts,
    arkadeScript,
    arkadeScriptHash,
    introspectorTweakedPubkey,
    encode(): Uint8Array {
      // Encode as 3-leaf TapTree: leaf0 and leaf1 at depth 2, leaf2 at depth 1
      return TapTreeCoder.encode([
        { depth: 2, version, script: scripts[0] },
        { depth: 2, version, script: scripts[1] },
        { depth: 1, version, script: scripts[2] },
      ]);
    },
    address(prefix: string, serverPubKey: Uint8Array): ArkAddress {
      return new ArkAddr(serverPubKey, tweakedPubkey, prefix);
    },
  };
}

/**
 * Build a 3-leaf taproot script for a buy offer with introspector co-signing.
 * Same tree structure as sell offers, but with buy arkade script (asset introspection).
 *
 * Leaf 0 (swap):    MultisigClosure(introspectorTweaked, ASP) — introspector validates & co-signs
 * Leaf 1 (cancel):  CSV + buyer CHECKSIG — buyer reclaims sats after timeout
 * Leaf 2 (forfeit): MultisigClosure(buyer, ASP) — standard forfeit for cancel path
 */
export async function buildBuySwapScript(params: BuySwapScriptParams): Promise<SwapScriptResult> {
  const sdk = await getSDK();
  const { ArkAddress: ArkAddr, TapTreeCoder } = sdk;
  const btc = await import("@scure/btc-signer");
  const { tapLeafHash, TAP_LEAF_VERSION } = await import("@scure/btc-signer/payment.js");
  const { taprootTweakPubkey, TAPROOT_UNSPENDABLE_KEY, concatBytes, tagSchnorr, compareBytes } =
    await import("@scure/btc-signer/utils.js");
  const {
    buyerPkScript,
    buyerXOnlyPubkey,
    assetTxidBytes,
    tokenAmount,
    cancelSeconds,
    introspectorPubkey,
    aspPubkey,
  } = params;

  // Build standalone buy arkade script
  const arkadeScript = buildBuyArkadeScript(buyerPkScript, assetTxidBytes, tokenAmount);

  // Compute introspector's tweaked pubkey for this specific arkade script
  const { tweakedPubkey: introspectorTweakedPubkey, scriptHash: arkadeScriptHash } =
    await computeIntrospectorTweakedPubkey(introspectorPubkey, arkadeScript);

  // Leaf 0: Swap (MultisigClosure — introspector validates, then both sign)
  const swapLeafBytes = btc.Script.encode([
    introspectorTweakedPubkey,
    "CHECKSIGVERIFY",
    aspPubkey,
    "CHECKSIG",
  ]);

  // Leaf 1: Cancel exit (CSV — relative timelock + buyer CHECKSIG)
  // BIP68 time-encoded: set bit 22 (type flag), value = ceil(seconds/512).
  const BIP68_TIME_FLAG = 0x400000;
  const bip68Value = BIP68_TIME_FLAG | Math.ceil(cancelSeconds / 512);
  const { ScriptNum } = btc;
  const MinimalScriptNum = ScriptNum(undefined, true);
  const sequenceBytes = MinimalScriptNum.encode(BigInt(bip68Value));
  const cancelLeafBytes = btc.Script.encode([
    sequenceBytes.length === 1 ? sequenceBytes[0] : sequenceBytes,
    "CHECKSEQUENCEVERIFY",
    "DROP",
    buyerXOnlyPubkey,
    "CHECKSIG",
  ]);

  // Leaf 2: Cancel Forfeit (MultisigClosure — buyer + ASP)
  const cancelForfeitLeafBytes = btc.Script.encode([
    buyerXOnlyPubkey,
    "CHECKSIGVERIFY",
    aspPubkey,
    "CHECKSIG",
  ]);

  // Manual 3-leaf taproot tree (same structure as sell offers)
  const scripts: [Uint8Array, Uint8Array, Uint8Array] = [
    swapLeafBytes,
    cancelLeafBytes,
    cancelForfeitLeafBytes,
  ];
  const version = TAP_LEAF_VERSION;
  const internalKey = TAPROOT_UNSPENDABLE_KEY;

  const leafHash0 = tapLeafHash(scripts[0], version);
  const leafHash1 = tapLeafHash(scripts[1], version);
  const leafHash2 = tapLeafHash(scripts[2], version);

  let [l0, l1] = [leafHash0, leafHash1];
  if (compareBytes(l1, l0) === -1) [l0, l1] = [l1, l0];
  const innerBranch = tagSchnorr("TapBranch", l0, l1);

  let [lB, lR] = [innerBranch, leafHash2];
  if (compareBytes(lR, lB) === -1) [lB, lR] = [lR, lB];
  const rootHash = tagSchnorr("TapBranch", lB, lR);

  const [tweakedPubkey, parity] = taprootTweakPubkey(internalKey, rootHash);

  const leaf0: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash1, leafHash2] },
    concatBytes(scripts[0], new Uint8Array([version])),
  ];
  const leaf1: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash0, leafHash2] },
    concatBytes(scripts[1], new Uint8Array([version])),
  ];
  const leaf2: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [innerBranch] },
    concatBytes(scripts[2], new Uint8Array([version])),
  ];

  return {
    leaves: [leaf0, leaf1, leaf2],
    tweakedPublicKey: tweakedPubkey,
    scripts,
    arkadeScript,
    arkadeScriptHash,
    introspectorTweakedPubkey,
    encode(): Uint8Array {
      return TapTreeCoder.encode([
        { depth: 2, version, script: scripts[0] },
        { depth: 2, version, script: scripts[1] },
        { depth: 1, version, script: scripts[2] },
      ]);
    },
    address(prefix: string, serverPubKey: Uint8Array): ArkAddress {
      return new ArkAddr(serverPubKey, tweakedPubkey, prefix);
    },
  };
}

/**
 * Decode a serialized TapTree (from offer.swapScriptHex) back into leaf scripts.
 * Returns the 3 leaves as TapLeafScripts for use in wallet.settle().
 */
export async function decodeSwapScript(
  tapTreeBytes: Uint8Array,
  arkadeScriptBytes: Uint8Array,
  introspectorPubkey: Uint8Array
): Promise<SwapScriptResult> {
  const sdk = await getSDK();
  const { ArkAddress: ArkAddr, TapTreeCoder } = sdk;
  const { tapLeafHash, TAP_LEAF_VERSION } = await import("@scure/btc-signer/payment.js");
  const { taprootTweakPubkey, TAPROOT_UNSPENDABLE_KEY, concatBytes, tagSchnorr, compareBytes } =
    await import("@scure/btc-signer/utils.js");

  const leaves = TapTreeCoder.decode(tapTreeBytes);
  if (leaves.length !== 3) throw new Error(`Expected 3 leaves, got ${leaves.length}`);

  const scripts: [Uint8Array, Uint8Array, Uint8Array] = [
    leaves[0].script,
    leaves[1].script,
    leaves[2].script,
  ];
  const version = TAP_LEAF_VERSION;
  const internalKey = TAPROOT_UNSPENDABLE_KEY;

  const leafHash0 = tapLeafHash(scripts[0], version);
  const leafHash1 = tapLeafHash(scripts[1], version);
  const leafHash2 = tapLeafHash(scripts[2], version);

  // Reconstruct the tree (same structure as buildSwapScript)
  let [l0, l1] = [leafHash0, leafHash1];
  if (compareBytes(l1, l0) === -1) [l0, l1] = [l1, l0];
  const innerBranch = tagSchnorr("TapBranch", l0, l1);

  let [lB, lR] = [innerBranch, leafHash2];
  if (compareBytes(lR, lB) === -1) [lB, lR] = [lR, lB];
  const rootHash = tagSchnorr("TapBranch", lB, lR);

  const [tweakedPubkey, parity] = taprootTweakPubkey(internalKey, rootHash);

  const leaf0: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash1, leafHash2] },
    concatBytes(scripts[0], new Uint8Array([version])),
  ];
  const leaf1: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash0, leafHash2] },
    concatBytes(scripts[1], new Uint8Array([version])),
  ];
  const leaf2: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [innerBranch] },
    concatBytes(scripts[2], new Uint8Array([version])),
  ];

  // Compute introspector tweaked pubkey for verification
  const { tweakedPubkey: introspectorTweakedPubkey, scriptHash: arkadeScriptHash } =
    await computeIntrospectorTweakedPubkey(introspectorPubkey, arkadeScriptBytes);

  return {
    leaves: [leaf0, leaf1, leaf2],
    tweakedPublicKey: tweakedPubkey,
    scripts,
    arkadeScript: arkadeScriptBytes,
    arkadeScriptHash,
    introspectorTweakedPubkey,
    encode(): Uint8Array {
      return TapTreeCoder.encode([
        { depth: 2, version, script: scripts[0] },
        { depth: 2, version, script: scripts[1] },
        { depth: 1, version, script: scripts[2] },
      ]);
    },
    address(prefix: string, serverPubKey: Uint8Array): ArkAddress {
      return new ArkAddr(serverPubKey, tweakedPubkey, prefix);
    },
  };
}
