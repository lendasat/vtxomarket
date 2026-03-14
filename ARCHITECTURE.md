# vtxo.market — Architecture

## Vision

A permissionless, non-custodial token marketplace on Bitcoin. Tokens are issued as
Arkade Assets (VTXOs on the Ark protocol), discovered and social-layered via Nostr,
and traded via non-interactive atomic swaps settling on Bitcoin.

No order book server. No custody. No fees taken by the platform.

---

## Current State (Implemented)

### 1. Frontend — `vtxo.market` (Next.js)

```
src/
├── app/
│   ├── page.tsx          # Marketplace home — token grid, search, sort
│   ├── create/           # Token issuance form
│   ├── token/[id]/       # Token detail — chart, thread, trades, trade, manage tabs
│   ├── wallet/           # Holdings, balance, deposit/withdraw
│   ├── lab/              # Swap script lab — opcode reference, builder, live testing
│   ├── settings/         # Profile, keys, about, ToS
│   └── dev/              # Debug panel
├── lib/
│   ├── ark-wallet.ts     # Arkade SDK wrapper (issue, reissue, send, swap)
│   ├── swap_protocol/    # Non-interactive swap implementation
│   │   ├── opcodes.ts    # Arkade opcode constants + runtime registration
│   │   ├── script.ts     # 3-leaf taproot + arkade script construction
│   │   ├── offers.ts     # Create + cancel offers (light path)
│   │   ├── light-fill.ts # Fill offers (light path, submitTx/finalizeTx)
│   │   ├── introspector-client.ts  # REST client for Introspector API
│   │   └── psbt-combiner.ts       # BIP-174 PSBT signature merging
│   ├── nostr-market.ts   # Nostr event publish/subscribe (listings, trades)
│   ├── nostr.ts          # NDK singleton + NIP-98 auth
│   ├── image-upload.ts   # NIP-96 image upload → nostr.build
│   └── store.ts          # Zustand global state
├── hooks/
│   ├── useWallet.ts      # Ark wallet lifecycle + auto-renewal
│   ├── useOffers.ts      # Polls indexer for open swap offers every 30s
│   ├── useTokens.ts      # Subscribes to Nostr token listings
│   ├── useTrades.ts      # Subscribes to Nostr trade receipts
│   └── useComments.ts    # Subscribes to Nostr comments
└── components/
    ├── app-sidebar.tsx   # Nav (desktop sidebar + mobile bottom bar)
    ├── token-card.tsx    # Token grid card
    └── token-chart.tsx   # Lightweight-charts OHLCV (built from trade receipts)
```

**Key design decisions:**
- Every user has a self-custodied wallet derived from a 12-word seed phrase
  - Ark key: `m/44'/1237'/0'/0/0` (BIP86 Taproot)
  - Nostr key: `m/44'/0'/0'/0/0`
- Wallet state encrypted + persisted in IndexedDB via `@arkade-os/sdk`
- All social data (listings, comments, trades) on Nostr — no backend database

---

### 2. Nostr Event Schema (kind 30078 — replaceable)

All marketplace data lives on public Nostr relays. The `d`-tag namespaces events
by type and the `L`/`l` tags label by network (mutinynet / mainnet).

| Event type | d-tag | Description |
|---|---|---|
| Token listing | `vtxomarket/token/{TICKER}` | Full token metadata, supply, assetId |
| Trade receipt | `vtxomarket/trade/{arkTxId}` | Completed trade (price, amount, buyer/seller) |
| Comment | reply to listing event | Thread post on a token page |

**Image hosting:** Token images are uploaded to nostr.build via NIP-96 with a
NIP-98 HTTP Auth header signed by the user's Nostr key. The returned HTTPS URL is
stored in the Arkade token metadata `icon` field (a few bytes vs. a base64 blob
that would cause TX_TOO_LARGE on issuance).

---

### 3. Asset Indexer (`indexer/`)

A lightweight Bun + SQLite + Hono service that bridges the gap until arkd ships
native asset filtering on its VTXO query API.

```
Ark server /v1/txs (SSE)
        │
        ▼
   stream.ts          Consumes SSE, fires handler per tx
        │
        ▼
   indexer.ts         For each tx: marks spent VTXOs, fetches spendable
        │              VTXO metadata from arkd, upserts into SQLite.
        │              On commitmentTx: checks spentVtxos against open offers
        │              to detect fills automatically.
        ▼
   db.ts (SQLite)
   ├── assets          assetId, name, ticker, decimals, supply
   ├── vtxos           outpoint, assetId, amount, script, isSpent
   ├── processed_txs   deduplication log
   └── offers          offerOutpoint (PK), assetId, tokenAmount, satAmount,
                       makerArkAddress, makerPkScript, makerXOnlyPubkey,
                       swapScriptHex, arkadeScriptHex, expiresAt, status,
                       filledInTxid
        │
        ▼
   api.ts (Hono HTTP)
   ├── GET  /health
   ├── GET  /assets                      → all known assets
   ├── GET  /assets/:id                  → single asset
   ├── GET  /assets/:id/vtxos            → all VTXOs for asset (?spendable=true)
   ├── GET  /assets/:id/holders          → balances grouped by script
   ├── POST /offers                      → maker self-reports new offer
   ├── GET  /offers?assetId=:id          → open offers for a token
   ├── GET  /offers/:outpoint            → single offer
   └── DEL  /offers/:outpoint            → maker cancels offer
```

---

## How Buying and Selling Works

### Overview

vtxo.market uses **non-interactive script-based swaps** with the
**Arkade Introspector** — a standalone co-signer service that validates
transaction introspection conditions and co-signs PSBTs. The maker locks tokens
in a VTXO whose taproot tree contains MultisigClosure leaves. The swap conditions
(output amount and destination checks) live in a **separate PSBT custom field**
called the "arkade script", NOT inside the tapscript leaves themselves. The
Introspector reads this field, executes the conditions against the spending
transaction, and co-signs if they pass.

Both fill and cancel use the **light offchain tx path** — `buildOffchainTx` to
construct the ark tx + checkpoints directly, then `submitTx`/`finalizeTx` to
send to the ASP. No round participation, no forfeits, no connector trees.

```
Maker                  Introspector        ASP (arkd)           Taker
  │                         │                  │                   │
  ├─ GET /v1/info ─────────▶│                  │                   │
  │◀─ signerPubkey ─────────┤                  │                   │
  │                         │                  │                   │
  ├─ buildSwapScript() ─────────────────────────────────────────▶ │
  │  (3-leaf taproot tree   │                  │                   │
  │   + standalone arkade   │                  │                   │
  │   script for PSBT field)│                  │                   │
  │                         │                  │                   │
  ├─ wallet.send(tokens) ──────────────────────▶                   │
  │                         │     [swap VTXO now live]             │
  │                         │                  │                   │
  ├─ POST /offers ──────────────────────────────────────────────▶ indexer
  │  (includes arkadeScriptHex)                           shows offer in UI
  │                         │                  │                   │
  │                    lightFillSwapOffer():                        │
  │                         │                  │                   │
  │            ┌────────────┤                  │◀── buildOffchain ─┤
  │            │  1. validate arkade script    │    Tx + sign      │
  │            │     POST /v1/tx              │                   │
  │            │  2. co-sign swap input       │                   │
  │            └────────────┤                  │                   │
  │                         │                  │◀── submitTx ──────┤
  │                         │                  │    (merged sigs)  │
  │                         │                  │──▶ signed CPs ───▶│
  │                         │                  │◀── finalizeTx ────┤
  │                         │                  │                   │
  │◀── satAmount ───────────────────────────────────── tokens ───▶│
                    atomic via offchain tx
```

---

### Selling Tokens (Maker)

1. **Pick terms** — enter `tokenAmount`, `satAmount`, expiry in the Trade tab
2. **`createSwapOffer(wallet, params)`** in `src/lib/swap_protocol/offers.ts`:
   - Fetches Introspector base pubkey from `GET /v1/info`
   - Derives `makerPkScript`, `makerXOnlyPubkey` from wallet identity
   - Calls `buildArkadeScript()` — creates standalone introspection conditions
   - Calls `buildSwapScript()` — produces a 3-leaf taproot tree:
     - Leaf 0: MultisigClosure(introspectorTweaked, ASP) — for taker fills
     - Leaf 1: CSV + maker CHECKSIG — for maker cancellation (on-chain)
     - Leaf 2: MultisigClosure(maker, ASP) — cooperative cancel + forfeit
   - Derives the swap script's Ark address
   - Calls `wallet.send({ address: swapArkAddress, amount: 0, assets: [...] })`
   - Returns `SwapOffer` including `arkadeScriptHex` and `swapScriptHex`
3. **Self-report** — frontend POSTs the full `SwapOffer` to `POST /offers` on the indexer
   (includes `arkadeScriptHex` so takers can reconstruct and verify the script)
4. **Offer appears** in the order book (polled every 30s via `useOffers`)

The maker's tokens are now locked in the swap VTXO. The maker cannot spend them
unilaterally until the CSV timelock expires (enforced by the cancel leaf's CHECKSEQUENCEVERIFY).

---

### Buying Tokens (Taker) — Light Fill

1. **Browse order book** — open offers sorted by price (sat/token) in the Trade tab
2. **Click "Buy"** — calls `lightFillSwapOffer(wallet, offer)` in `light-fill.ts`:
   - Decodes swap script, verifies 3 leaves
   - Prepares swap VTXO input with leaf 0 (MultisigClosure) as collaborative closure
   - Coin-selects taker's funding VTXOs to cover `satAmount`
   - Builds outputs: maker payment (output 0), taker change (output 1), OP_RETURN asset extension (output 2)
   - Calls `buildOffchainTx(inputs, outputs, serverUnrollScript)` — produces ark tx + checkpoints
   - Injects arkade script PSBT custom field on swap VTXO's ark tx input
   - Signs taker's funding inputs (`identity.sign` — skips swap input, not taker's key)
   - Sends to introspector `POST /v1/tx` → validates arkade script conditions, co-signs swap input + checkpoint[0]
   - Merges introspector + taker signatures via `Psbt.combine()` (BIP-174 Combiner)
   - Sends merged ark tx + checkpoints to ASP via `submitTx` → ASP co-signs
   - Merges introspector sigs back into ASP-returned checkpoints (ASP strips pre-existing sigs)
   - Signs checkpoints with taker identity
   - `finalizeTx` → done

3. **Result** — the swap settles atomically:
   - Maker receives `satAmount` sats (validated by introspection conditions)
   - Taker receives `tokenAmount` tokens (asset conservation enforced by ASP)
4. **Indexer detects fill** — `commitmentTx` event sees the swap VTXO's outpoint in
   `spentVtxos` → marks offer as `filled` → disappears from order book

---

### Cancelling an Offer (Maker) — Light Cancel

The maker can reclaim their tokens at any time via cooperative cancel:

1. Own offers show a **"Cancel"** button (detected by `offer.makerArkAddress === userArkAddress`)
2. `cancelSwapOffer(wallet, offer)` in `offers.ts` — no Introspector needed:
   - Uses leaf 2 (MultisigClosure: maker + ASP) as collaborative closure
   - Builds offchain tx: swap VTXO → maker output (tokens returned)
   - Signs with maker identity → `submitTx` → ASP co-signs
   - Signs returned checkpoints → `finalizeTx` → done
3. If the ASP is offline, the maker can exit unilaterally on-chain via leaf 1
   (CSV + maker CHECKSIG) after the relative timelock expires

---

## Swap Script — Architecture & Security

### Two Layers: On-Chain Tapscript + Off-Chain Arkade Script

The swap VTXO uses a **dual-layer** design:

**Layer 1 — Tapscript leaves (on-chain enforceable):**
Only standard Bitcoin opcodes (CHECKSIG, CHECKSIGVERIFY, CHECKSEQUENCEVERIFY).
These leaves are MultisigClosure patterns that the ASP and Introspector co-sign.

**Layer 2 — Arkade script (off-chain, PSBT custom field):**
Introspection opcodes (OP_INSPECTOUTPUTVALUE, OP_INSPECTOUTPUTSCRIPTPUBKEY) that
validate transaction outputs. These are embedded in the PSBT under key `0xDE` +
`"arkadescript"`. The Introspector reads this field, executes the conditions against
the spending transaction, and co-signs the MultisigClosure if conditions pass.

**Why this separation?** Arkade's introspection opcodes map to Bitcoin's `OP_SUCCESS`
range — on-chain, they make the script succeed immediately regardless of what follows.
They only have meaning inside Arkade's off-chain execution engine. The Introspector
provides that engine as a standalone service. By keeping introspection opcodes out of
the tapscript, the on-chain security relies only on standard MultisigClosure signatures.

### The Three-Leaf Taproot Structure

```
               TAPROOT_UNSPENDABLE_KEY (internal key)
                      ← keypath provably unspendable →

                          ┌──────┴──────┐
                       branch01        leaf2
                       ┌──┴──┐      (cancel forfeit)
                    leaf0  leaf1     <maker> CHECKSIGVERIFY
                   (swap) (cancel)   <ASP> CHECKSIG
                    │        │
                    │      <csvSequence>
                    │      CHECKSEQUENCEVERIFY
                    │      DROP
                    │      <maker> CHECKSIG
                    │
              <introspectorTweaked>
              CHECKSIGVERIFY
              <ASP> CHECKSIG
```

**Leaf 0 — Swap (MultisigClosure: introspectorTweaked + ASP)**
Used by takers to fill offers. The Introspector validates the arkade script
conditions (amount + destination) and co-signs. The ASP co-signs via submitTx.
2-of-2 multisig — no taker key in the leaf (see design rationale below).

**Leaf 1 — Cancel (CSV + maker single-sig)**
Used by makers to reclaim tokens unilaterally on-chain after CSV timelock expiry.
Standard Bitcoin relative timelock, no Introspector involvement.

**Leaf 2 — Cancel Forfeit (MultisigClosure: maker + ASP)**
The collaborative closure leaf for the cancel path. Used cooperatively offchain
via `submitTx`/`finalizeTx` — maker signs, ASP co-signs. Also serves as the
forfeit leaf if needed.

### Introspector Key Tweaking

The Introspector's base public key is tweaked per-script so the on-chain
MultisigClosure is cryptographically bound to specific introspection conditions:

```
scriptHash = TaggedHash("ArkScriptHash", arkadeScriptBytes)
tweakedKey = basePubkey + scriptHash * G
```

BIP-340 tagged hash + EC point addition (NOT BIP-341 taptweak). If someone changes
the arkade script, the tweaked key changes, the MultisigClosure no longer matches,
and the VTXO can't be spent via the swap leaf.

### Arkade Script — Condition-by-Condition Analysis

The arkade script validates two conditions against the spending transaction:

**1. Output value check** — maker receives at least the requested sats:
```
OP_0 (0x00)                         # output index 0
OP_INSPECTOUTPUTVALUE (0xCF)        # push output[0].value as 8-byte LE64
PUSH8 <satAmountLE64>               # push required amount (8 bytes)
OP_GREATERTHANOREQUAL64 (0xDF)      # compare: value >= required?
OP_VERIFY (0x69)                    # abort if false
```

**2. Output destination check** — payment goes to the maker's P2TR address:
```
OP_0 (0x00)                         # output index 0
OP_INSPECTOUTPUTSCRIPTPUBKEY (0xD1) # pushes [witnessProgram, version] to stack
OP_1 (0x51)                         # push 1 (P2TR = segwit v1)
OP_EQUALVERIFY (0x88)               # check version == P2TR
PUSH32 <makerXOnlyPubkey>           # push expected 32-byte x-only pubkey
OP_EQUAL (0x87)                     # check witness program matches
```

Stack behavior of `OP_INSPECTOUTPUTSCRIPTPUBKEY` (confirmed from
`introspector/pkg/arkade/opcode.go:pushScriptPubKey`): pushes the witness program
FIRST then the version ON TOP. For P2TR, the witness program is the 32-byte x-only
pubkey (without `0x5120` prefix). Version 1 = P2TR.

### Opcode Byte Values

All hex values from `introspector/pkg/arkade/opcode.go` (authoritative source).

| Opcode | Hex | Used in | Stack effect |
|---|---|---|---|
| `OP_INSPECTOUTPUTVALUE` | `0xCF` | Arkade script | `[... idx] → [... valueLE64]` |
| `OP_INSPECTOUTPUTSCRIPTPUBKEY` | `0xD1` | Arkade script | `[... idx] → [... program version]` |
| `OP_GREATERTHANOREQUAL64` | `0xDF` | Arkade script | `[... a b] → [... bool]` (a >= b) |
| `OP_CHECKSIG` | `0xAC` | Leaf 0, 1 | Schnorr signature verification |
| `OP_CHECKSIGVERIFY` | `0xAD` | Leaf 0, 2 | CHECKSIG + VERIFY |
| `CHECKSEQUENCEVERIFY` | `0xB2` | Leaf 1 | Relative timelock enforcement |

Note: the docs at `docs.arkadeos.com/experimental/arkade-script` use the Liquid/Elements
numbering for some opcodes. The Introspector remapped several (e.g., `OP_ADD64` is `0xD7`
in the Introspector but the docs list it as `0xC4+offset`). Our `registerArkadeOpcodes()`
table uses the Introspector's authoritative hex values.

---

### Design Rationale

**Why 2-key MultisigClosure (not 3)?**
The Introspector's canonical test uses 3 keys: `(spender, ASP, introspectorTweaked)`.
This works for interactive spending where the spender is known upfront. For a
non-interactive order book, the maker doesn't know who the taker will be — so the
taker's key can't be in the MultisigClosure. Instead, the introspection conditions
serve as the authorization: anyone who constructs valid outputs (paying the maker
correctly) gets the Introspector to co-sign.

**Why no taker signature (OP_CHECKSIGFROMSTACK)?**
The docs describe a `checkSig(takerSig, taker)` pattern where the taker provides their
pubkey at execution time. This prevents frontrunning but makes fills more interactive.
For an open order book, permissionless filling is preferred. The Ark mechanism
(ASP arbitration) handles concurrent fill attempts — only one submitTx per VTXO can succeed.

**Why >= instead of == for the amount check?**
`OP_GREATERTHANOREQUAL64` allows overpayment, which benefits the maker and is more robust
to dust/fee adjustments. The official Arkade docs also use `>=`.

**Why not verify asset type (OP_INSPECTOUTPUTASSET)?**
Our swap is token-for-sats. The arkade script validates the sats payment. Token transfer
is handled by ASP asset conservation (OP_RETURN extension). The old `OP_INSPECTOUTPUTASSET`
(0xCE) doesn't exist in the Introspector — asset inspection moved to new asset group
opcodes (0xE5-0xF2).

**Why submitTx/finalizeTx instead of settle (rounds)?**
The light path builds offchain transactions directly and submits them without
participating in ASP rounds. This eliminates the need for: forfeit construction,
connector tree parsing, event stream interception, and complex PSBT field injection
workarounds. Same trust assumptions — the ASP still co-signs and enforces asset
conservation — but dramatically less code and no SDK workarounds.

---

### Security Properties

**Maker receives exactly what was agreed**
The arkade script's `OP_INSPECTOUTPUTVALUE` + `OP_GREATERTHANOREQUAL64` ensures
output[0] carries at least `satAmount` sats. `OP_INSPECTOUTPUTSCRIPTPUBKEY` ensures
it goes to the maker's P2TR address. The Introspector only co-signs if both pass.

**Conditions cryptographically bound to the MultisigClosure**
The Introspector's tweaked key = `basePubkey + TaggedHash("ArkScriptHash", arkadeScript) * G`.
Changing the arkade script changes the tweaked key, which breaks the MultisigClosure.
A malicious taker cannot substitute different conditions.

**Maker can always reclaim**
Cooperatively: cancel via leaf 2 (maker + ASP MultisigClosure) at any time.
Unilaterally: leaf 1's `CHECKSEQUENCEVERIFY` enforces relative timelock, then maker
can exit on-chain using only their own key. Even if the ASP and Introspector go
offline, the maker can exit unilaterally.

**Keypath unspendable**
`TAPROOT_UNSPENDABLE_KEY` as internal key means the VTXO cannot be spent via the
keypath by anyone. Only the three named script leaves can spend.

**Non-custodial**
Neither the ASP nor the Introspector can unilaterally spend the VTXO. The swap leaf
requires BOTH signatures (introspectorTweaked + ASP). The Introspector only signs
when conditions pass. The ASP only signs during valid transactions.

---

### Known Risks

**OP_SUCCESS semantics on mainnet Bitcoin**
Introspection opcodes (0xCF, 0xD1, 0xDF) are `OP_SUCCESS` in standard Bitcoin
Tapscript — they make the script succeed immediately. **On mainnet, anyone could
steal the VTXO by broadcasting a spend with an OP_SUCCESS leaf.**
This is mitigated by design: the swap leaf is a MultisigClosure (standard opcodes
only), not the introspection script. The introspection conditions live in the PSBT
field and are validated off-chain by the Introspector. On-chain security relies
only on the MultisigClosure signatures. For the unilateral exit path, only the
cancel leaf (standard opcodes) is used.

**Output index 0 hardcoded**
The arkade script checks `output[0]`. The taker must ensure the maker's payment is
at index 0 in the output list. `buildOffchainTx` preserves output order from the
`outputs` array parameter.

**Introspector availability**
The swap leaf requires the Introspector to co-sign. If the Introspector is offline,
takers cannot fill offers. Makers can still cancel (leaf 2 doesn't need the
Introspector). This is an availability risk, not a security risk.

**tokenAmount self-reported by maker**
The indexer stores `tokenAmount` as reported by the maker. A dishonest maker could
advertise more tokens than locked. Mitigation: takers should verify the VTXO's
actual balance via `GET ${ASP}/v1/indexer/vtxos?outpoints=...` before filling.

---

## Full Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Bitcoin                               │
│                    (settlement layer)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ batch rounds (~1min)
┌──────────────────────────▼──────────────────────────────────┐
│                    Ark Server (arkd)                         │
│                 mutinynet.arkade.sh                          │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────────────────┐    │
│  │  Virtual VTXO   │   │  Swap VTXOs                   │    │
│  │  tree (settled) │   │  (MultisigClosure + arkade    │    │
│  │                 │   │   script conditions)           │    │
│  └────────┬────────┘   └──────────────┬───────────────┘    │
│           │  SSE /v1/txs              │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           │
┌───────────────────────┐               │
│   Asset Indexer     │               │
│   (Bun + SQLite +     │               │
│    Hono, port 3001)   │               │
│                       │               │
│   assets, VTXOs,      │               │
│   holders, offers     │               │
│   (+ arkadeScriptHex) │               │
└───────────┬───────────┘               │
            │ HTTP                      │
            ▼                           ▼
┌───────────────────────────────────────────────────────────────┐
│                     vtxo.market Frontend                       │
│                     (Next.js, port 3000)                       │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  src/lib/swap_protocol/                               │     │
│  │  ├── light-fill.ts     Fill offers (submitTx/finalize)│     │
│  │  ├── offers.ts         Create + cancel (light path)   │     │
│  │  ├── script.ts         Taproot tree + arkade script   │     │
│  │  └── introspector-client.ts  REST client for /v1/*    │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  Home   Create   Wallet   Token Detail   Lab   Settings        │
│                            ├── Thread                          │
│                            ├── Trades                          │
│                            ├── Trade (order book)              │
│                            └── Manage                          │
└────────────────┬──────────────────────┬───────────────────────┘
                 │                      │
                 │ Nostr                │ HTTP (port 7073)
                 ▼                      ▼
┌────────────────────────┐  ┌────────────────────────────────┐
│     Nostr Relays       │  │  Arkade Introspector            │
│ relay.damus.io         │  │  (Go gRPC + REST gateway)       │
│ relay.nostr.band       │  │                                  │
│ nos.lol                │  │  GET  /v1/info → signerPubkey    │
│                        │  │  POST /v1/tx   → validate +      │
│ Token listings         │  │    co-sign offchain tx            │
│ Trade receipts         │  │                                  │
│ Comments               │  │  Validates arkade script         │
└────────────────────────┘  │  conditions off-chain, co-signs  │
                            │  MultisigClosure if they pass    │
                            └────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Role |
|---|---|---|
| Settlement | Bitcoin (via Ark) | Final settlement, atomicity |
| Offchain execution | Arkade SDK (`@arkade-os/sdk`) | VTXO management, issuance, offchain txs |
| Condition enforcement | Arkade Introspector (Go gRPC) | Validates arkade script, co-signs PSBTs |
| Swap scripts | Arkade Script (experimental) | Non-interactive swap conditions |
| Social / metadata | Nostr (NDK v3) | Token listings, trades, comments |
| Image hosting | nostr.build (NIP-96) | Token icons, profile pictures |
| Indexer | Bun + SQLite + Hono | VTXO state, asset metadata, offers |
| Frontend | Next.js 16 + Tailwind v4 | UI |
| State | Zustand | Client state |
| Key storage | IndexedDB (encrypted) | Wallet persistence |
| Network | Mutinynet (testnet) → Mainnet | Bitcoin test network |

---

## Key Files

| File | Purpose |
|---|---|
| `src/lib/ark-wallet.ts` | Wallet init, `createSwapOffer()`, `fillSwapOffer()` (alias for lightFillSwapOffer), `cancelSwapOffer()`, opcode registration |
| `src/lib/swap_protocol/light-fill.ts` | Light fill — builds offchain tx, introspector co-signing, 3-way sig merging, submitTx/finalizeTx |
| `src/lib/swap_protocol/offers.ts` | Offer lifecycle: create (maker sends tokens to swap script), cancel (light path via submitTx/finalizeTx) |
| `src/lib/swap_protocol/script.ts` | 3-leaf taproot tree construction, arkade script assembly, decoding |
| `src/lib/swap_protocol/introspector-client.ts` | REST client for Introspector API (`/v1/info`, `/v1/tx`) |
| `src/lib/swap_protocol/psbt-combiner.ts` | Raw BIP-174 PSBT utilities: `Psbt.combine()` for merging multi-party signatures |
| `indexer/src/db.ts` | SQLite schema + queries (offers include `arkadeScriptHex`) |
| `indexer/src/api.ts` | REST API for assets, VTXOs, offers |
| `introspector/` | Cloned from `github.com/ArkLabsHQ/introspector` (standalone, not a submodule) |

---

## Notes

- **No backend database.** The indexer is the only server-side component and it
  reads from Ark. All user data is local (IndexedDB) or on Nostr.
- **Non-custodial.** Neither the platform, the ASP, nor the Introspector can
  unilaterally access user funds.
- **The indexer is temporary.** Once arkd ships native asset filtering, most of
  it becomes redundant.
- **`psbt-combiner.ts` exists because `@scure/btc-signer` can't merge signatures.**
  `updateInput({ tapScriptSig: [...] })` replaces rather than merges entries. We
  need proper BIP-174 Combiner behavior for the 3-way signing in light-fill (taker +
  introspector + ASP). The file does raw BIP-174 byte-level parsing/serialization.
- **Arkade Script is experimental.** The introspection opcodes (0xCF, 0xD1, 0xDF)
  are `OP_SUCCESS` extensions — they have defined semantics in the Introspector's
  off-chain engine but would succeed unconditionally on standard Bitcoin. The
  on-chain tapscript leaves use only standard opcodes (CHECKSIG, CSV). Security
  relies on the MultisigClosure signatures, not on-chain script evaluation.
- **Introspector not yet publicly hosted.** Must run locally for development.
  Ark Labs plans to run one per network. `NEXT_PUBLIC_INTROSPECTOR_URL` env var.

## Future Considerations

- **Partial fills**: `partialSwap` using `OP_MUL64` (0xD9) / `OP_DIV64` (0xDA) for
  proportional calculations. Requires change outputs with updated swap contracts.
- **Market pricing**: Oracle-signed price feeds via `OP_CHECKSIGFROMSTACK` (0xCC).
- **Asset group verification**: Once asset group opcodes (0xE5-0xF2) stabilize, could
  add explicit token routing checks in the arkade script for defense-in-depth.
- **arkadec compiler**: Replace hand-assembled arkade script bytes with compiled output
  when the Arkade Script TypeScript compiler is available.
