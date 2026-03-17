/**
 * Arkade introspection opcodes and registration for @scure/btc-signer.
 *
 * @scure/btc-signer's Script.decode() throws "Unknown opcode=cf" on Arkade
 * custom opcodes. registerArkadeOpcodes() patches the OP and OPNames maps
 * at runtime so VtxoScript.decode() / p2tr() work with custom opcodes.
 *
 * Called once on SDK initialization via getSDK() in ark-wallet.ts.
 *
 * Opcode values sourced from: introspector/pkg/arkade/opcode.go
 */

// ── Opcode constants used in buildArkadeScript ────────────────────────────────

export const OP_INSPECTOUTPUTVALUE = 0xcf;
export const OP_INSPECTOUTPUTSCRIPTPUBKEY = 0xd1;
export const OP_INSPECTOUTASSETLOOKUP = 0xef;
export const OP_GREATERTHANOREQUAL64 = 0xdf;
export const OP_SCRIPTNUMTOLE64 = 0xe0;
export const OP_VERIFY = 0x69;
export const OP_EQUAL = 0x87;
export const OP_EQUALVERIFY = 0x88;
export const OP_CHECKSIG = 0xac;
export const OP_1 = 0x51;

// ── Full opcode registry ──────────────────────────────────────────────────────

/** All Arkade opcodes — hex values from introspector/pkg/arkade/opcode.go */
const ARKADE_OPCODES: Record<string, number> = {
  // Streaming hash opcodes (0xC4-0xC6)
  OP_SHA256INITIALIZE: 0xc4,
  OP_SHA256UPDATE: 0xc5,
  OP_SHA256FINALIZE: 0xc6,
  // Input introspection (0xC7-0xCD)
  OP_INSPECTINPUTOUTPOINT: 0xc7,
  // 0xC8 reserved (OP_UNKNOWN200)
  OP_INSPECTINPUTVALUE: 0xc9,
  OP_INSPECTINPUTSCRIPTPUBKEY: 0xca,
  OP_INSPECTINPUTSEQUENCE: 0xcb,
  OP_CHECKSIGFROMSTACK: 0xcc,
  OP_PUSHCURRENTINPUTINDEX: 0xcd,
  // Output introspection (0xCF, 0xD1)
  // 0xCE reserved (OP_UNKNOWN206)
  OP_INSPECTOUTPUTVALUE: 0xcf,
  // 0xD0 reserved (OP_UNKNOWN208)
  OP_INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  // Transaction introspection (0xD2-0xD6)
  OP_INSPECTVERSION: 0xd2,
  OP_INSPECTLOCKTIME: 0xd3,
  OP_INSPECTNUMINPUTS: 0xd4,
  OP_INSPECTNUMOUTPUTS: 0xd5,
  OP_TXWEIGHT: 0xd6,
  // 64-bit arithmetic (0xD7-0xDF)
  OP_ADD64: 0xd7,
  OP_SUB64: 0xd8,
  OP_MUL64: 0xd9,
  OP_DIV64: 0xda,
  OP_NEG64: 0xdb,
  OP_LESSTHAN64: 0xdc,
  OP_LESSTHANOREQUAL64: 0xdd,
  OP_GREATERTHAN64: 0xde,
  OP_GREATERTHANOREQUAL64: 0xdf,
  // Conversion opcodes (0xE0-0xE2)
  OP_SCRIPTNUMTOLE64: 0xe0,
  OP_LE64TOSCRIPTNUM: 0xe1,
  OP_LE32TOLE64: 0xe2,
  // Crypto opcodes (0xE3-0xE4)
  OP_ECMULSCALARVERIFY: 0xe3,
  OP_TWEAKVERIFY: 0xe4,
  // Asset group introspection (0xE5-0xF2)
  OP_INSPECTNUMASSETGROUPS: 0xe5,
  OP_INSPECTASSETGROUPASSETID: 0xe6,
  OP_INSPECTASSETGROUPCTRL: 0xe7,
  // 0xE8 reserved
  OP_INSPECTASSETGROUPMETADATAHASH: 0xe9,
  OP_INSPECTASSETGROUPNUM: 0xea,
  OP_INSPECTASSETGROUP: 0xeb,
  OP_INSPECTASSETGROUPSUM: 0xec,
  OP_INSPECTOUTASSETCOUNT: 0xed,
  OP_INSPECTOUTASSETAT: 0xee,
  OP_INSPECTOUTASSETLOOKUP: 0xef,
  OP_INSPECTINASSETCOUNT: 0xf0,
  OP_INSPECTINASSETAT: 0xf1,
  OP_INSPECTINASSETLOOKUP: 0xf2,
};

// ── Registration ──────────────────────────────────────────────────────────────

let _registered = false;

/**
 * Register Arkade opcodes with @scure/btc-signer's OP/OPNames maps.
 * Must be called before any VtxoScript.decode() or Script.decode() on
 * scripts containing Arkade opcodes.
 *
 * Why this is needed: @scure/btc-signer only knows standard Bitcoin opcodes.
 * Arkade's introspection opcodes (OP_INSPECTOUTPUTVALUE, etc.) use OP_SUCCESS
 * slots (0xCF, 0xD1, 0xDF, ...) that the library doesn't recognize. Without
 * this registration, Script.decode() throws "Unknown opcode=cf". The Arkade
 * SDK (@arkade-os/sdk) also doesn't register these — it has no Arkade Script
 * awareness yet.
 *
 * Remove when the SDK natively handles Arkade Script opcodes.
 */
export async function registerArkadeOpcodes(): Promise<void> {
  if (_registered) return;
  const { OP: btcOP, OPNames: btcOPNames } = await import("@scure/btc-signer/script.js");
  for (const [name, byte] of Object.entries(ARKADE_OPCODES)) {
    (btcOP as Record<string, number>)[name] = byte;
    (btcOPNames as Record<number, string>)[byte] = name;
  }
  _registered = true;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Encode a number as 8-byte little-endian (LE64).
 * Used in buildArkadeScript() for OP_INSPECTOUTPUTVALUE comparisons.
 * The introspector pushes output values as 8-byte LE64, so we must
 * encode the comparison amount in the same format.
 *
 * Remove when the Arkade Script compiler (arkadec) has a TypeScript API.
 * See: https://github.com/ArkLabsHQ/arkade
 */
export function encodeLE64(n: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}
