# Swap Protocol Overview for Reviewers

The code in `src/lib/swap_protocol/` implements non-interactive token-for-BTC swaps on Ark using the Arkade Introspector co-signer. Here's how it works, why it's trust-minimized, and where we had to write unusual code.

## How the swap works

A maker wants to sell tokens for BTC. They create a **swap VTXO** — an Ark virtual UTXO locked to a 3-leaf taproot script:

```
         root
        /    \
    branch    leaf2 (cancel forfeit)
    /    \
 leaf0    leaf1
```

- **Leaf 0 (swap):** `<introspectorTweaked> CHECKSIGVERIFY <ASP> CHECKSIG` — a MultisigClosure between the introspector's tweaked key and the ASP. This is how a taker fills the offer.
- **Leaf 1 (cancel):** `<csvSequence> CHECKSEQUENCEVERIFY DROP <maker> CHECKSIG` — the maker reclaims their tokens after a relative timelock expires. No introspector needed.
- **Leaf 2 (cancel forfeit):** `<maker> CHECKSIGVERIFY <ASP> CHECKSIG` — MultisigClosure for the maker+ASP collaborative closure path (used for both cancel and forfeit).

## Light path — submitTx/finalizeTx

Both fill and cancel use the **light offchain tx path** — `buildOffchainTx` to construct the ark tx + checkpoints directly, then `submitTx`/`finalizeTx` to send to the ASP. No round participation, no forfeits, no connector trees.

**Fill flow (taker buys tokens):**
1. Decode swap script, prepare swap VTXO input (leaf 0 as collaborative closure)
2. Coin-select taker's funding VTXOs for the sat payment
3. Build outputs: maker payment + taker change + OP_RETURN asset extension
4. `buildOffchainTx(inputs, outputs, serverUnrollScript)`
5. Inject arkade script PSBT field on the swap VTXO's ark tx input
6. Sign taker's funding inputs (`identity.sign` skips swap input — not taker's key)
7. Send to introspector `POST /v1/tx` → validates conditions, co-signs swap input + checkpoint
8. Merge introspector + taker signatures (BIP-174 Combiner)
9. `submitTx` to ASP → ASP co-signs, returns signed checkpoints
10. Merge introspector sigs back into ASP checkpoints, sign with taker identity
11. `finalizeTx` → done

**Cancel flow (maker reclaims tokens):**
1. Decode swap script, use leaf 2 (MultisigClosure maker + ASP) as collaborative closure
2. Build output: maker receives tokens back + OP_RETURN asset extension
3. `buildOffchainTx([cancelInput], outputs, serverUnrollScript)`
4. Sign with maker identity
5. `submitTx` to ASP → ASP co-signs, returns signed checkpoints
6. Sign checkpoints with maker identity
7. `finalizeTx` → done

No introspector needed for cancel — it's a standard collaborative closure.

## Where the trust minimization comes from

The introspection conditions (the actual swap terms) are **not** in the tapscript leaves. They live in a separate **Arkade Script** that gets embedded in a PSBT custom field (key type `0xDE`, field name `"arkadescript"`). The introspector reads this field, executes the conditions against the spending transaction's outputs, and only co-signs if they pass.

The Arkade Script we build (`script.ts`) checks two things:

```
OP_0 OP_INSPECTOUTPUTVALUE           → push output[0].value (8-byte LE64)
<satAmount as LE64>                  → push required amount
OP_GREATERTHANOREQUAL64              → value >= required?
OP_VERIFY                            → abort if false

OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY    → push [witnessProgram, version]
OP_1 OP_EQUALVERIFY                  → check version == 1 (P2TR)
<32-byte maker witness program>      → push expected key
OP_EQUAL                             → check it matches
```

**This means:** the introspector will only co-sign a transaction that pays at least `satAmount` sats to the maker's exact Ark address. A taker can't steal the tokens — any tx that doesn't pay the maker correctly will be rejected by the introspector before it signs.

The introspector's key is **per-script tweaked**: `tweakedKey = basePubkey + TaggedHash("ArkScriptHash", arkadeScript) * G`. This binds the introspector's signing authority to these specific conditions.

The maker can always cancel via the collaborative closure (leaf 2, maker + ASP) or unilaterally via leaf 1 (CSV timelock, on-chain). The trust assumptions are:
1. The introspector honestly evaluates the arkade script conditions (it's a deterministic verifier, not a custodian)
2. The ASP is online and processing transactions (standard Ark assumption)
3. The maker can cancel at any time cooperatively, or after CSV expiry unilaterally

## Opcodes used

From `opcodes.ts` — these are Arkade-specific opcodes (not standard Bitcoin):

| Opcode | Byte | Purpose |
|--------|------|---------|
| `OP_INSPECTOUTPUTVALUE` | `0xCF` | Push a transaction output's value as 8-byte LE64 |
| `OP_INSPECTOUTPUTSCRIPTPUBKEY` | `0xD1` | Push a transaction output's witness program + version |
| `OP_GREATERTHANOREQUAL64` | `0xDF` | 64-bit comparison for sat amounts |

Standard opcodes used in the arkade script: `OP_VERIFY` (`0x69`), `OP_EQUAL` (`0x87`), `OP_EQUALVERIFY` (`0x88`), `OP_1` (`0x51`).

Standard opcodes in tapscript leaves: `CHECKSIG`, `CHECKSIGVERIFY`, `CHECKSEQUENCEVERIFY`, `DROP`.

## Manual code / workarounds that may look unusual

### 1. `opcodes.ts` — Runtime opcode registration

`@scure/btc-signer` doesn't know about Arkade's custom opcodes. If you try to decode a script containing `0xCF`, it throws `"Unknown opcode=cf"`. We monkey-patch the `OP` and `OPNames` maps at runtime so `Script.decode()` and `VtxoScript.decode()` work. This runs once on SDK init.

### 2. `script.ts` — Hand-assembled arkade script (raw byte array)

The arkade script is assembled as a raw `Uint8Array` with opcode bytes and push data. We hand-assemble because the Arkade Script compiler ([arkadec](https://github.com/ArkLabsHQ/arkade)) is a Go CLI tool with no TypeScript API. Our script is parametric — the maker's address and sat amount change per offer, so we need runtime generation. For this 2-condition script (~15 bytes of opcodes + 40 bytes of parameters) hand-assembly is straightforward.

### 3. `script.ts` — Manual taproot tree construction

We build the 3-leaf taproot tree manually using `@scure/btc-signer`'s primitives (`tapLeafHash`, `tagSchnorr("TapBranch", ...)`, `taprootTweakPubkey`) rather than using higher-level APIs. This is because the SDK's `VtxoScript` builder doesn't support our leaf structure (MultisigClosure with a tweaked introspector key + CSV cancel + separate forfeit).

### 4. `script.ts` — bip68 import dance

```typescript
const bip68Module = await import("bip68");
const bip68Encode = bip68Module.encode ?? bip68Module.default?.encode ?? bip68Module.default;
```

The `bip68` package has inconsistent ESM/CJS exports. This triple-fallback handles all module resolution variants.

### 5. `light-fill.ts` + `offers.ts` — Asset extension (OP_RETURN) construction

The ASP requires an OP_RETURN output with the ARK asset extension describing how tokens move between inputs and outputs. Format: `OP_RETURN | <push> | "ARK" | type(0x00) | LEB128_len | packet_bytes`. We use the SDK's `asset` namespace (`AssetGroup`, `AssetInput`, `AssetOutput`, `Packet`) to build the packet, then construct the OP_RETURN script manually to avoid `@scure/btc-signer`'s 520-byte push limit. The length prefix uses **LEB128 varint** (not Bitcoin compact size) to match the SDK's `encodeVarUint`.

### 6. `light-fill.ts` — 3-way signature merging

The fill path involves 3 signers: taker, introspector, and ASP. Each signs different inputs/checkpoints. We use `Psbt.combine()` (BIP-174 Combiner) to merge signatures at two points: (a) after the introspector returns, merge with taker's signatures before sending to ASP; (b) after ASP returns checkpoints, merge introspector's checkpoint signatures back in (ASP strips pre-existing sigs).

### 7. `psbt-combiner.ts` — Raw BIP-174 byte manipulation

`@scure/btc-signer`'s `Transaction.updateInput({ tapScriptSig: [...] })` replaces rather than merges entries. We wrote a raw BIP-174 parser/serializer for `Psbt.combine()` — union of KV pairs per input (proper BIP-174 Combiner role).

## File structure

| File | What it does |
|------|-------------|
| `opcodes.ts` | Opcode constants + runtime registration for @scure/btc-signer |
| `script.ts` | Swap script construction (3-leaf taproot + arkade script) and decoding |
| `offers.ts` | Offer lifecycle: create (maker), cancel (maker) via light path |
| `light-fill.ts` | Light fill via submitTx/finalizeTx (taker buys tokens) |
| `introspector-client.ts` | REST client for the Arkade Introspector |
| `psbt-combiner.ts` | Raw BIP-174 PSBT parser/serializer for signature combining |
| `index.ts` | Barrel file with architecture docs + re-exports |

The most critical file for review is `light-fill.ts` — it orchestrates the multi-party signing flow. The script construction in `script.ts` is where the cryptographic guarantees live. `psbt-combiner.ts` is byte-level PSBT manipulation that should be replaced if/when `@scure/btc-signer` adds proper combine support.
