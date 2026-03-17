/**
 * Raw BIP-174 PSBT utilities for operations @scure/btc-signer cannot do.
 *
 * Why this file exists:
 *   @scure/btc-signer's Transaction.updateInput() has two limitations that
 *   block our introspector integration:
 *
 *   1. Setting `{ tapScriptSig: [] }` is a no-op — it doesn't clear existing
 *      TaprootScriptSpendSig entries from an input.
 *
 *   2. Setting `{ tapScriptSig: [...] }` replaces rather than merges entries,
 *      making it impossible to add a co-signer's signature alongside existing ones.
 *
 *   Both operations are needed for non-interactive swaps with the Arkade
 *   Introspector. The introspector's getSignedInputs() (finalization.go)
 *   iterates ALL inputs with TaprootScriptSpendSig and requires each to have
 *   an "arkadescript" PSBT field. In multi-input intent proofs (swap VTXO +
 *   taker's funding VTXOs), only the swap input (index 1) has arkadescript.
 *   Taker's inputs (index 2+) must have their tapScriptSig stripped before
 *   sending to the introspector, or finalization fails with:
 *     "input does not specify any ArkadeScript"
 *
 *   Note: The Arkade team is working on an IntrospectorPacket-based approach
 *   (feat/introspector-packet branch) that explicitly lists which inputs have
 *   arkade scripts, eliminating the need for stripping. Until that lands and
 *   the SDK supports it, this raw-byte approach is necessary.
 *
 * Exports:
 *   Psbt.combine()           — BIP-174 merge (union of KV pairs per input)
 *   Psbt.stripTapScriptSig() — Remove TaprootScriptSpendSig from specific inputs
 */

import { base64 } from "@scure/base";

type KVPair = [key: Uint8Array, value: Uint8Array];

interface PsbtData {
  global: KVPair[];
  inputs: KVPair[][];
  outputs: KVPair[][];
}

// ── CompactSize encoding ────────────────────────────────────────────────

function readCompactSize(data: Uint8Array, offset: number): [size: number, newOffset: number] {
  const first = data[offset];
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd) {
    return [data[offset + 1] | (data[offset + 2] << 8), offset + 3];
  }
  if (first === 0xfe) {
    // Use multiplication for high byte to avoid sign issues with << 24
    const val =
      data[offset + 1] |
      (data[offset + 2] << 8) |
      (data[offset + 3] << 16) |
      (data[offset + 4] * 0x1000000);
    return [val, offset + 5];
  }
  throw new Error("psbt-combiner: 8-byte CompactSize not supported");
}

function writeCompactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  throw new Error("psbt-combiner: value too large for CompactSize");
}

// ── PSBT parsing ────────────────────────────────────────────────────────

/** Parse one key-value map section, stopping at the 0x00 separator. */
function parseSection(data: Uint8Array, offset: number): [KVPair[], number] {
  const pairs: KVPair[] = [];
  while (offset < data.length) {
    const [keyLen, o1] = readCompactSize(data, offset);
    offset = o1;
    if (keyLen === 0) break; // separator
    const key = data.slice(offset, offset + keyLen);
    offset += keyLen;
    const [valLen, o2] = readCompactSize(data, offset);
    offset = o2;
    const value = data.slice(offset, offset + valLen);
    offset += valLen;
    pairs.push([key, value]);
  }
  return [pairs, offset];
}

/**
 * Count inputs and outputs from the unsigned transaction
 * (PSBT v0 global key type 0x00). The unsigned tx is always
 * in non-witness serialization format per BIP-174.
 */
function countTxIO(txBytes: Uint8Array): {
  inputCount: number;
  outputCount: number;
} {
  let offset = 4; // skip version (4 bytes LE)

  const [inputCount, o1] = readCompactSize(txBytes, offset);
  offset = o1;

  // Skip past all inputs
  for (let i = 0; i < inputCount; i++) {
    offset += 36; // prevTxid (32) + prevVout (4)
    const [scriptLen, o2] = readCompactSize(txBytes, offset);
    offset = o2 + scriptLen + 4; // scriptSig + sequence
  }

  const [outputCount] = readCompactSize(txBytes, offset);
  return { inputCount, outputCount };
}

function parsePsbt(data: Uint8Array): PsbtData {
  // Verify magic: "psbt" + 0xff
  if (
    data[0] !== 0x70 ||
    data[1] !== 0x73 ||
    data[2] !== 0x62 ||
    data[3] !== 0x74 ||
    data[4] !== 0xff
  ) {
    throw new Error("psbt-combiner: invalid PSBT magic bytes");
  }

  let offset = 5;

  // Parse global section
  const [global, o1] = parseSection(data, offset);
  offset = o1;

  // Find unsigned tx (key = [0x00]) to determine input/output counts
  const unsignedTxKV = global.find((kv) => kv[0].length === 1 && kv[0][0] === 0x00);
  if (!unsignedTxKV) {
    throw new Error("psbt-combiner: missing unsigned tx (only PSBT v0 is supported)");
  }
  const { inputCount, outputCount } = countTxIO(unsignedTxKV[1]);

  // Parse input sections
  const inputs: KVPair[][] = [];
  for (let i = 0; i < inputCount; i++) {
    const [section, o] = parseSection(data, offset);
    offset = o;
    inputs.push(section);
  }

  // Parse output sections
  const outputs: KVPair[][] = [];
  for (let i = 0; i < outputCount; i++) {
    const [section, o] = parseSection(data, offset);
    offset = o;
    outputs.push(section);
  }

  return { global, inputs, outputs };
}

// ── PSBT serialization ──────────────────────────────────────────────────

function serializePsbt(psbt: PsbtData): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff])); // magic

  function writeSection(pairs: KVPair[]) {
    for (const [key, value] of pairs) {
      parts.push(writeCompactSize(key.length));
      parts.push(key);
      parts.push(writeCompactSize(value.length));
      parts.push(value);
    }
    parts.push(new Uint8Array([0x00])); // separator
  }

  writeSection(psbt.global);
  for (const input of psbt.inputs) writeSection(input);
  for (const output of psbt.outputs) writeSection(output);

  // Concatenate all parts
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

// ── Key-value merging ───────────────────────────────────────────────────

/** Hex-encode a key for Map lookup. */
function keyHex(key: Uint8Array): string {
  let s = "";
  for (let i = 0; i < key.length; i++) {
    s += key[i].toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * Merge two KV pair lists (BIP-174 Combiner logic).
 * Primary takes priority for duplicate keys.
 * Keys from secondary that don't exist in primary are added.
 */
function mergeKVPairs(primary: KVPair[], secondary: KVPair[]): KVPair[] {
  const map = new Map<string, KVPair>();
  // Add secondary first so primary overwrites duplicates
  for (const kv of secondary) map.set(keyHex(kv[0]), kv);
  for (const kv of primary) map.set(keyHex(kv[0]), kv);
  return Array.from(map.values());
}

// ── PSBT key types (BIP-371) ────────────────────────────────────────────

/** PSBT_IN_TAP_SCRIPT_SIG — key: 0x14 || x-only pubkey (32) || leaf hash (32) */
const PSBT_IN_TAP_SCRIPT_SIG = 0x14;

// ── Public API ──────────────────────────────────────────────────────────

export const Psbt = {
  /**
   * BIP-174 PSBT Combiner: merge two PSBTs.
   *
   * For each input section, takes the union of key-value pairs.
   * Primary PSBT's values win for duplicate keys.
   * Global and output sections are taken from the primary.
   *
   * This correctly merges tapScriptSig entries from different signers
   * because each signer's entry has a unique key (type 0x14 + pubkey + leafHash).
   * It also preserves unknown/proprietary fields (type 0xDE) from the primary.
   *
   * @param primaryBase64 - Primary PSBT (values take priority, has unknown fields)
   * @param secondaryBase64 - Secondary PSBT (provides additional signatures)
   * @returns Combined PSBT as base64
   */
  combine(primaryBase64: string, secondaryBase64: string): string {
    const primary = parsePsbt(base64.decode(primaryBase64));
    const secondary = parsePsbt(base64.decode(secondaryBase64));

    if (primary.inputs.length !== secondary.inputs.length) {
      throw new Error(
        `psbt-combiner: input count mismatch ` +
          `(primary=${primary.inputs.length}, secondary=${secondary.inputs.length})`
      );
    }

    const combined: PsbtData = {
      global: primary.global,
      inputs: primary.inputs.map((inp, i) => mergeKVPairs(inp, secondary.inputs[i])),
      outputs: primary.outputs,
    };

    return base64.encode(serializePsbt(combined));
  },

  /**
   * Remove PSBT_IN_TAP_SCRIPT_SIG (0x14) entries from specific inputs.
   *
   * Why this is needed:
   *   The Arkade Introspector's getSignedInputs() (finalization.go:124)
   *   iterates every PSBT input that has a TaprootScriptSpendSig and calls
   *   readArkadeScript() on it. readArkadeScript() requires the "arkadescript"
   *   PSBT custom field (0xDE). In a multi-input intent proof:
   *
   *     Input 0 = BIP322 message (no tapScriptSig — skipped)
   *     Input 1 = swap VTXO     (has tapScriptSig + arkadescript — OK)
   *     Input 2+ = taker funding (has tapScriptSig but NO arkadescript — CRASH)
   *
   *   @scure/btc-signer's updateInput({ tapScriptSig: [] }) is a no-op and
   *   does NOT clear existing entries. This function works at the raw PSBT
   *   byte level to actually remove the key-value pairs.
   *
   * @param psbtBase64 - The PSBT to modify
   * @param inputIndices - Which input indices to strip tapScriptSig from
   * @returns New PSBT as base64 with the specified entries removed
   */
  stripTapScriptSig(psbtBase64: string, inputIndices: number[]): string {
    const psbt = parsePsbt(base64.decode(psbtBase64));
    const indexSet = new Set(inputIndices);

    for (let i = 0; i < psbt.inputs.length; i++) {
      if (!indexSet.has(i)) continue;
      psbt.inputs[i] = psbt.inputs[i].filter(([key]) => key[0] !== PSBT_IN_TAP_SCRIPT_SIG);
    }

    return base64.encode(serializePsbt(psbt));
  },
};
