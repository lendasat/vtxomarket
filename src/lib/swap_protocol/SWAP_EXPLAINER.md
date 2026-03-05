# Swap Protocol Overview for Reviewers

The code in `src/lib/swap_protocol/` implements non-interactive token-for-BTC swaps on Ark using the Arkade Introspector co-signer. Here's how it works, why it's trust-minimized, and where we had to write unusual code to work around SDK limitations.

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
- **Leaf 2 (cancel forfeit):** `<maker> CHECKSIGVERIFY <ASP> CHECKSIG` — standard MultisigClosure for the maker+ASP forfeit path during cancellation.

## Where the trust minimization comes from

The introspection conditions (the actual swap terms) are **not** in the tapscript leaves. They live in a separate **Arkade Script** that gets embedded in a PSBT custom field (key type `0xDE`, field name `"arkadescript"`). The introspector reads this field, executes the conditions against the spending transaction's outputs, and only co-signs if they pass.

The Arkade Script we build (`script.ts:127-154`) checks two things:

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

**This means:** the introspector will only co-sign a transaction that pays at least `satAmount` sats to the maker's exact Ark address. A taker can't steal the tokens — any PSBT that doesn't pay the maker correctly will be rejected by the introspector before it ever signs.

The introspector's key is **per-script tweaked**: `tweakedKey = basePubkey + TaggedHash("ArkScriptHash", arkadeScript) * G`. This binds the introspector's signing authority to these specific conditions. Even a compromised introspector can't repurpose its key for a different arkade script — the tweaked key in leaf 0 won't match.

The maker can always cancel after the CSV timelock via leaf 1 (no introspector needed). The ASP enforces asset conservation across the round. So the trust assumptions are:
1. The introspector honestly evaluates the arkade script conditions (it's a deterministic verifier, not a custodian)
2. The ASP is online and processing rounds (standard Ark assumption)
3. The maker can cancel if the offer isn't filled before timelock expiry

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

### 1. `opcodes.ts:96-104` — Runtime opcode registration

`@scure/btc-signer` doesn't know about Arkade's custom opcodes. If you try to decode a script containing `0xCF`, it throws `"Unknown opcode=cf"`. We monkey-patch the `OP` and `OPNames` maps at runtime so `Script.decode()` and `VtxoScript.decode()` work. This runs once on SDK init. Marked `@deprecated` — should be removed when the SDK handles this natively.

### 2. `script.ts:139-167` — Hand-assembled arkade script (raw byte array)

The arkade script is assembled as a raw `Uint8Array` with opcode bytes and push data. In the Arkade Script high-level syntax ([docs](https://docs.arkadeos.com/experimental/non-interactive-swaps)), this would be:

```
contract NonInteractiveSwap(makerPkScript, amount) {
  swap(takerSig) {
    verify(inspectOutputValue(0) >= amount)
    verify(inspectOutputScriptPubKey(0) == makerPkScript)
    verify(checkSig(takerSig))
  }
}
```

We hand-assemble the equivalent opcode bytes because the Arkade Script compiler ([arkadec](https://github.com/ArkLabsHQ/arkade)) is a Go CLI tool with no TypeScript/JavaScript API. Our script is parametric — the maker's address and sat amount change per offer, so we need runtime generation. For this 2-condition script (~15 bytes of opcodes + 40 bytes of parameters) hand-assembly is straightforward. For complex contracts (partial fills, oracle pricing) the compiler would be the right tool.

### 3. `script.ts:227-290` — Manual taproot tree construction

We build the 3-leaf taproot tree manually using `@scure/btc-signer`'s primitives (`tapLeafHash`, `tagSchnorr("TapBranch", ...)`, `taprootTweakPubkey`) rather than using higher-level APIs. This is because the SDK's `VtxoScript` builder doesn't support our leaf structure (MultisigClosure with a tweaked introspector key + CSV cancel + separate forfeit). We compute Merkle paths for each leaf ourselves. The internal key is `TAPROOT_UNSPENDABLE_KEY` (nothing-up-my-sleeve point) since all spending goes through script paths.

### 4. `script.ts:204-205` — bip68 import dance

```typescript
const bip68Module = await import("bip68");
const bip68Encode = bip68Module.encode ?? bip68Module.default?.encode ?? bip68Module.default;
```

The `bip68` package has inconsistent ESM/CJS exports. This triple-fallback handles all module resolution variants. Not pretty, but necessary.

### 5. `introspector-provider.ts:301-330` — SDK bug workaround (PSBT field injection)

The SDK's `craftToSignTx` (intent/index.js) creates `new Transaction({ version, lockTime })` **without** `allowUnknown: true`. When it later calls `tx.updateInput(i, { unknown: [...] })`, `@scure/btc-signer`'s `mergeKeyMap` silently drops the unknown fields. This means the taptree and arkadescript PSBT custom fields that `prepareCoinAsIntentProofInput` correctly sets are lost by the time the PSBT is serialized. We re-inject them post-SDK into input 1 (the swap VTXO).

### 6. `introspector-provider.ts:355-368` — Stripping tapScriptSig from non-swap inputs

The introspector's `getSignedInputs()` iterates every PSBT input that has a `TaprootScriptSpendSig` and requires an `arkadescript` field on each. In a multi-input PSBT (swap VTXO + taker's funding VTXOs), only the swap input has arkadescript. We strip tapScriptSig from inputs 2+ before sending to the introspector, then merge the co-signature back into the full PSBT afterward.

### 7. `psbt-combiner.ts` — Raw BIP-174 byte manipulation

`@scure/btc-signer`'s `Transaction.updateInput({ tapScriptSig: [] })` is a no-op — it doesn't clear existing entries. And setting `tapScriptSig` replaces rather than merges, so you can't add a co-signer's signature alongside existing ones. We wrote a raw BIP-174 parser/serializer to do two things:
- `Psbt.combine()` — union of KV pairs per input (proper BIP-174 Combiner)
- `Psbt.stripTapScriptSig()` — actually remove key type `0x14` entries from specific inputs

### 8. `introspector-provider.ts:382-460` — Building the missing swap VTXO forfeit

The SDK's forfeit builder skips the swap VTXO because it's not in the taker's `getVirtualCoins()` — the SDK sees it as a "boarding input." But the ASP knows it's a VTXO and requires a forfeit. We manually construct a forfeit PSBT (input 0 = swap VTXO with forfeit tapLeafScript, input 1 = connector from the tree, outputs = ASP forfeit address + P2A anchor) and send it to the introspector for co-signing via `/v1/finalization`.

### 9. `introspector-provider.ts:202-247` — Event stream interception

We wrap the ASP's SSE event stream to capture connector tree chunks (`tree_tx` events with `batchIndex === 1`) and the commitment tx (`batch_finalization` event). The SDK may not pass these to `submitSignedForfeitTxs`, but the introspector needs the connector tree and commitment tx for finalization. We collect them during the round and inject them into the finalization request.

## File structure

| File | Lines | What it does |
|------|-------|-------------|
| `opcodes.ts` | 123 | Opcode constants + runtime registration for @scure/btc-signer |
| `script.ts` | 365 | Swap script construction (3-leaf taproot + arkade script) and decoding |
| `offers.ts` | 275 | Offer lifecycle: create (maker), fill (taker), cancel (maker) |
| `introspector-client.ts` | 123 | REST client for the Arkade Introspector (`/v1/info`, `/v1/intent`, `/v1/finalization`) |
| `introspector-provider.ts` | 539 | ArkProvider wrapper — PSBT injection, sig stripping/merging, forfeit construction |
| `psbt-combiner.ts` | 313 | Raw BIP-174 PSBT parser/serializer for combine + strip operations |
| `index.ts` | 90 | Barrel file with architecture docs + re-exports |

The most critical file for review is `introspector-provider.ts` — it has the most complex logic and the most SDK workarounds. The script construction in `script.ts` is where the cryptographic guarantees live. `psbt-combiner.ts` is byte-level PSBT manipulation that should be replaced if/when `@scure/btc-signer` adds proper combine/clear support.
