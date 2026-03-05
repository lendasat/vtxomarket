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

export const OP_INSPECTOUTPUTVALUE        = 0xCF;
export const OP_INSPECTOUTPUTSCRIPTPUBKEY = 0xD1;
export const OP_GREATERTHANOREQUAL64      = 0xDF;
export const OP_VERIFY                    = 0x69;
export const OP_EQUAL                     = 0x87;
export const OP_EQUALVERIFY               = 0x88;
export const OP_CHECKSIG                  = 0xAC;
export const OP_1                         = 0x51;

// ── Full opcode registry ──────────────────────────────────────────────────────

/** All Arkade opcodes — hex values from introspector/pkg/arkade/opcode.go */
const ARKADE_OPCODES: Record<string, number> = {
  // Streaming hash opcodes (0xC4-0xC6)
  OP_SHA256INITIALIZE:           0xC4,
  OP_SHA256UPDATE:               0xC5,
  OP_SHA256FINALIZE:             0xC6,
  // Input introspection (0xC7-0xCD)
  OP_INSPECTINPUTOUTPOINT:       0xC7,
  // 0xC8 reserved (OP_UNKNOWN200)
  OP_INSPECTINPUTVALUE:          0xC9,
  OP_INSPECTINPUTSCRIPTPUBKEY:   0xCA,
  OP_INSPECTINPUTSEQUENCE:       0xCB,
  OP_CHECKSIGFROMSTACK:          0xCC,
  OP_PUSHCURRENTINPUTINDEX:      0xCD,
  // Output introspection (0xCF, 0xD1)
  // 0xCE reserved (OP_UNKNOWN206)
  OP_INSPECTOUTPUTVALUE:         0xCF,
  // 0xD0 reserved (OP_UNKNOWN208)
  OP_INSPECTOUTPUTSCRIPTPUBKEY:  0xD1,
  // Transaction introspection (0xD2-0xD6)
  OP_INSPECTVERSION:             0xD2,
  OP_INSPECTLOCKTIME:            0xD3,
  OP_INSPECTNUMINPUTS:           0xD4,
  OP_INSPECTNUMOUTPUTS:          0xD5,
  OP_TXWEIGHT:                   0xD6,
  // 64-bit arithmetic (0xD7-0xDF)
  OP_ADD64:                      0xD7,
  OP_SUB64:                      0xD8,
  OP_MUL64:                      0xD9,
  OP_DIV64:                      0xDA,
  OP_NEG64:                      0xDB,
  OP_LESSTHAN64:                 0xDC,
  OP_LESSTHANOREQUAL64:          0xDD,
  OP_GREATERTHAN64:              0xDE,
  OP_GREATERTHANOREQUAL64:       0xDF,
  // Conversion opcodes (0xE0-0xE2)
  OP_SCRIPTNUMTOLE64:            0xE0,
  OP_LE64TOSCRIPTNUM:            0xE1,
  OP_LE32TOLE64:                 0xE2,
  // Crypto opcodes (0xE3-0xE4)
  OP_ECMULSCALARVERIFY:          0xE3,
  OP_TWEAKVERIFY:                0xE4,
  // Asset group introspection (0xE5-0xF2)
  OP_INSPECTNUMASSETGROUPS:      0xE5,
  OP_INSPECTASSETGROUPASSETID:   0xE6,
  OP_INSPECTASSETGROUPCTRL:      0xE7,
  // 0xE8 reserved
  OP_INSPECTASSETGROUPMETADATAHASH: 0xE9,
  OP_INSPECTASSETGROUPNUM:       0xEA,
  OP_INSPECTASSETGROUP:          0xEB,
  OP_INSPECTASSETGROUPSUM:       0xEC,
  OP_INSPECTOUTASSETCOUNT:       0xED,
  OP_INSPECTOUTASSETAT:          0xEE,
  OP_INSPECTOUTASSETLOOKUP:      0xEF,
  OP_INSPECTINASSETCOUNT:        0xF0,
  OP_INSPECTINASSETAT:           0xF1,
  OP_INSPECTINASSETLOOKUP:       0xF2,
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
