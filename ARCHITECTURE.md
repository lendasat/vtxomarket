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
│   ├── ark-wallet.ts     # Arkade SDK wrapper (issue, reissue, send, swap, settle)
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

### 3. Interim Asset Indexer (`interim_asset_indexer/`)

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
                       swapScriptHex, expiresAt, status, filledInTxid
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

vtxo.market uses **non-interactive script-based swaps** using Arkade Script —
a set of experimental Tapscript opcode extensions that enable transaction
introspection inside Bitcoin Script. The key property: the maker locks tokens in
a VTXO whose locking script encodes the swap terms. Any taker fills by building a
transaction that satisfies those conditions. **The ASP validates the script,
not coordinates intent matching.**

```
Maker                     Ark Server (ASP)              Taker
  │                             │                          │
  ├─ buildSwapScript() ─────────────────────────────────▶ │
  │  (script encodes:           │                          │
  │   output[0].value >= sats   │                          │
  │   output[0].pkScript == me  │                          │
  │   + taker CHECKSIG)         │                          │
  │                             │                          │
  ├─ wallet.send(tokens ──────▶ │                          │
  │       → swapAddress)        │                          │
  │                             │  [swap VTXO now live]    │
  │                             │                          │
  ├─ POST /offers ──────────────────────────────────────▶ indexer
  │  (self-report metadata)     │                 shows offer in UI
  │                             │                          │
  │                      ASP validates                     │
  │                      script on fill                    │
  │                             │◀── wallet.settle() ──────┤
  │                             │    (spend swapVtxo via   │
  │                             │     swap leaf: output[0] │
  │                             │     >= satAmt to maker)  │
  │◀── satAmount ───────────────┤──────── tokens ─────────▶│
          atomic in one round
```

---

### Selling Tokens (Maker)

1. **Pick terms** — enter `tokenAmount`, `satAmount`, expiry in the Trade tab
2. **`createSwapOffer(wallet, params)`** in `src/lib/ark-wallet.ts`:
   - Derives `makerPkScript` from the maker's Ark address (`ArkAddress.decode().pkScript`)
   - Extracts `makerXOnlyPubkey` from `wallet.identity`
   - Calls `buildSwapScript()` to produce a 2-leaf `VtxoScript`
   - Derives the swap script's Ark address via `vtxoScript.address(network, aspPubkey)`
   - Calls `wallet.send({ address: swapArkAddress, amount: 0, assets: [{ assetId, amount: tokenAmount }] })`
   - Returns `offerOutpoint = arkTxId:0` — the swap VTXO is now live on Ark
3. **Self-report** — frontend POSTs the full `SwapOffer` to `POST /offers` on the indexer
4. **Offer appears** in the order book (polled every 30s via `useOffers`)

The maker's tokens are now locked in the swap VTXO. The maker cannot spend them
unilaterally until `expiresAt` (enforced by the cancel leaf's CLTV).

---

### Buying Tokens (Taker)

1. **Browse order book** — open offers sorted by price (sat/token) in the Trade tab
2. **Click "Buy"** — calls `fillSwapOffer(wallet, offer)`:
   - Reconstructs `vtxoScript` from `offer.swapScriptHex` using `VtxoScript.decode()`
   - Fetches the actual sats value of the swap VTXO from the ASP (`GET /v1/indexer/vtxos`)
   - Builds a manual `ExtendedCoin` (the swap VTXO) with:
     - `intentTapLeafScript = vtxoScript.leaves[0]` (swap leaf)
     - `forfeitTapLeafScript = vtxoScript.leaves[1]` (cancel leaf)
   - Calls `wallet.settle({ inputs: [swapVtxo], outputs: [{ address: makerArkAddress, amount: satAmount }] })`
3. **ASP validates the script** — checks:
   - `output[0].value >= satAmount` (taker paid enough)
   - `output[0].scriptPubKey == makerPkScript` (payment goes to maker)
   - Taker's `CHECKSIG` is valid (signature covers entire transaction)
4. **Round completes** — in the next batch round, the swap settles atomically:
   - Maker receives `satAmount` sats
   - Taker receives `tokenAmount` tokens
5. **Indexer detects fill** — `commitmentTx` event sees the swap VTXO's outpoint in
   `spentVtxos` → marks offer as `filled` → disappears from order book

---

### Cancelling an Offer (Maker)

After `expiresAt`, the maker can reclaim their tokens:

1. Own offers show a **"Cancel"** button (detected by `offer.makerArkAddress === userArkAddress`)
2. `cancelSwapOffer(wallet, offer)` spends via the cancel leaf:
   - `intentTapLeafScript = vtxoScript.leaves[1]` (cancel leaf: CLTV + maker sig)
   - `wallet.settle({ inputs: [swapVtxo], outputs: [{ address: makerArkAddress, amount: vtxoSatsValue }] })`
3. CLTV enforces that the transaction `locktime >= expiresAt` — early cancellation fails

---

## Swap Script — Security Analysis

### The Two-Leaf Taproot Structure

Every swap VTXO has exactly two spend paths:

```
                    TAPROOT_UNSPENDABLE_KEY (internal key)
                           ← keypath provably unspendable →

              ┌────────────────────┬────────────────────┐
              │    Leaf 0 (swap)   │   Leaf 1 (cancel)  │
              │                    │                     │
              │ OP_INSPECTOUTPUT   │ <expiresAt>         │
              │   VALUE            │ CHECKLOCKTIMEVERIFY │
              │ <satAmount LE64>   │ DROP                │
              │ OP_GEQ64           │ <makerXOnlyPubkey>  │
              │ OP_VERIFY          │ CHECKSIG            │
              │ OP_INSPECTOUTPUT   │                     │
              │   SCRIPTPUBKEY     │                     │
              │ <makerPkScript>    │                     │
              │ OP_EQUAL           │                     │
              │ OP_VERIFY          │                     │
              │ OP_CHECKSIG        │                     │
              └────────────────────┴────────────────────┘
```

The internal key is `TAPROOT_UNSPENDABLE_KEY` (confirmed in `VtxoScript/base.ts`).
**Keypath spend is provably impossible.** Only the two script leaves can spend.

---

### Opcode Byte Values (confirmed from docs.arkadeos.com/experimental/arkade-script)

| Opcode | OP_SUCCESS# | Byte | Used in |
|---|---|---|---|
| `OP_INSPECTOUTPUTVALUE` | 207 | `0xCF` | Swap leaf: verify sats paid |
| `OP_INSPECTOUTPUTSCRIPTPUBKEY` | 209 | `0xD1` | Swap leaf: verify maker destination |
| `OP_GREATERTHANOREQUAL64` | 223 | `0xDF` | Swap leaf: value comparison |
| `OP_CHECKSIG` | — | `0xAC` | Both leaves: signature verification |
| `CHECKLOCKTIMEVERIFY` | — | `0xB1` | Cancel leaf: expiry enforcement |

---

### Swap Leaf — Condition-by-Condition Analysis

**Raw bytes:**
```
00 CF 08 <satAmount 8B LE64> DF 69 00 D1 22 <makerPkScript 34B> 87 69 AC
```

**Annotated execution:**

```
Stack entry (taker provides): [takerSig, takerPubkey]

00          → OP_0: push 0 (output index)
CF          → OP_INSPECTOUTPUTVALUE: pop index 0 → push output[0].value (8-byte LE64)
08 <8B>     → push satAmount as 8-byte LE64
DF          → OP_GREATERTHANOREQUAL64: b >= a → push 1 if output.value >= satAmount
69          → OP_VERIFY: abort if 0; stack now clean
00          → OP_0: push 0 (output index again)
D1          → OP_INSPECTOUTPUTSCRIPTPUBKEY: pop index → push output[0].scriptPubKey
22 <34B>    → push makerPkScript (34 bytes: OP_1 <tweakedKey>)
87          → OP_EQUAL: push 1 if scriptPubKeys match
69          → OP_VERIFY: abort if 0
AC          → OP_CHECKSIG: pop takerPubkey, pop takerSig → verify Schnorr sig
              (sig covers full transaction via BIP341 sighash)
```

---

### Security Properties

**✅ Maker receives exactly what was agreed**
`OP_INSPECTOUTPUTVALUE` + `OP_GREATERTHANOREQUAL64` ensures output[0] carries
at least `satAmount` sats. `OP_INSPECTOUTPUTSCRIPTPUBKEY` + `OP_EQUAL` ensures
it goes to the maker's address. Both checked atomically.

**✅ Front-running prevented by CHECKSIG**
`OP_CHECKSIG` requires the taker to sign the transaction with their key.
The BIP341 sighash commits to all inputs and outputs — any modification
(e.g. rerouting the payment) invalidates the signature. Miners/validators
cannot substitute different outputs.

**✅ Maker can always reclaim after expiry**
The cancel leaf's `CHECKLOCKTIMEVERIFY` enforces `tx.locktime >= expiresAt`.
Even if the ASP goes offline, the maker can exit unilaterally on-chain after expiry
using the cancel leaf + maker signature.

**✅ Keypath unspendable**
`TAPROOT_UNSPENDABLE_KEY` as internal key means the VTXO cannot be spent
via the keypath by anyone, including the ASP. Only the two named script paths
can spend the VTXO.

**✅ Non-custodial**
The ASP never controls the swap VTXO. The ASP only validates the script during
cooperative settlement. Keys for the swap leaf belong to the taker; keys for the
cancel leaf belong to the maker.

---

### Known Risks and Open Questions

**⚠️ OP_SUCCESS semantics on mainnet Bitcoin**
`OP_INSPECTOUTPUTVALUE` (0xCF) and peers are OP_SUCCESS opcodes in standard
Bitcoin Tapscript — encountering them makes the script succeed *immediately*
regardless of what follows. **On mainnet Bitcoin, anyone could steal the
tokens by simply broadcasting a transaction spending the swap VTXO.**

This is by design for the Ark off-chain model: the ASP runs a custom Arkade
Script interpreter that gives these opcodes their defined introspection semantics.
Security relies on the ASP correctly implementing and enforcing Arkade Script.
For the unilateral exit path, only the cancel leaf (using only standard opcodes)
is used.

**⚠️ Output index 0 hardcoded**
The swap leaf only checks `output[0]`. If `wallet.settle()` places the maker's
payment at a different output index, the script evaluation fails. The taker
constructs the transaction and must ensure the maker's payment is at index 0.

**⚠️ `OP_INSPECTOUTPUTSCRIPTPUBKEY` stack behavior unknown until tested**
The docs say it "examines the scriptPubKey of an output." Whether it pushes
ONE item (34-byte P2TR script) or TWO items (type byte + script, as in the
Elements introspection spec) is unconfirmed. If it pushes two items, the
`OP_EQUAL` comparison would compare `makerPkScript` against the wrong stack
element. This is the most important thing to verify with a test transaction.

**⚠️ tokenAmount self-reported by maker**
The indexer stores `tokenAmount` as reported in the maker's POST to `/offers`.
It does not verify against the swap VTXO's actual token balance. A dishonest
maker could advertise 100 tokens but lock only 1. Mitigation: takers should
verify the VTXO's actual balance via `GET ${ASP}/v1/indexer/vtxos?outpoints=...`
before filling. The lab page includes this check.

**⚠️ `VtxoScript.decode()` + `wallet.settle()` with custom VTXO untested**
The SDK's `VtxoScript.decode(tapTree)` method exists but reconstructing an
`ExtendedCoin` manually (the swap VTXO is not in the taker's own wallet state)
and passing it to `wallet.settle()` has not been tested against the live ASP.
The fallback is `wallet.buildAndSubmitOffchainTx([swapVtxo], outputs)` directly.

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
│                    arkade.computer                           │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────────────────┐    │
│  │  Virtual VTXO   │   │  Script-based swap VTXOs      │    │
│  │  tree (settled) │   │  (Arkade Script introspection)│    │
│  └────────┬────────┘   └──────────────┬───────────────┘    │
│           │  SSE /v1/txs              │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌───────────────────────────────────────────────────────────────┐
│              vtxo.market Interim Indexer                       │
│              (Bun + SQLite + Hono, port 3001)                  │
│                                                                │
│  assets, VTXOs, holders, swap offers                          │
│                                                                │
│  GET /assets            GET /assets/:id/holders               │
│  GET /assets/:id/vtxos  GET /offers?assetId=:id               │
│  POST /offers           DEL /offers/:outpoint                 │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTP (localhost:3001)
┌──────────────────────────▼────────────────────────────────────┐
│                     vtxo.market Frontend                       │
│                     (Next.js, port 3000)                       │
│                                                                │
│  Home        Create       Wallet      Lab        Settings      │
│  token grid  issuance     holdings    script     profile       │
│              reissue      balance     builder    keys          │
│                           deposit/    opcode                   │
│  Token Detail page:       withdraw    ref                      │
│  ├── Thread (comments)                live test               │
│  ├── Trades (chart)                                           │
│  ├── Trade (order book, buy/sell, cancel)                     │
│  └── Manage (reissue — creator only)                          │
└──────────────────────────┬────────────────────────────────────┘
                           │ Nostr (NDK, kind 30078)
┌──────────────────────────▼────────────────────────────────────┐
│                       Nostr Relays                             │
│         relay.damus.io, relay.nostr.band, nos.lol             │
│                                                                │
│  Token listings    Trade receipts    Comments                  │
└───────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Role |
|---|---|---|
| Settlement | Bitcoin (via Ark) | Final settlement, atomicity |
| Offchain execution | Arkade SDK (`@arkade-os/sdk`) | VTXO management, issuance, swaps |
| Swap scripts | Arkade Script (experimental) | Non-interactive swap conditions |
| Social / metadata | Nostr (NDK v3) | Token listings, trades, comments |
| Image hosting | nostr.build (NIP-96) | Token icons, profile pictures |
| Indexer | Bun + SQLite + Hono | VTXO state, asset metadata, offers |
| Frontend | Next.js 16 + Tailwind v4 | UI |
| State | Zustand | Client state |
| Key storage | IndexedDB (encrypted) | Wallet persistence |
| Network | Mutinynet (testnet) → Mainnet | Bitcoin test network |

---

## Notes

- **No backend database.** The indexer is the only server-side component and it
  reads from Ark. All user data is local (IndexedDB) or on Nostr.
- **Non-custodial.** The platform never holds user keys or funds.
- **The indexer is temporary.** Once arkd ships native asset filtering, most of
  it becomes redundant.
- **Arkade Script is experimental.** The swap script opcodes (0xCF, 0xD1, 0xDF)
  are OP_SUCCESS extensions. They have defined semantics on Arkade-enabled ASPs
  but would succeed unconditionally on standard Bitcoin mainnet. The security
  model is cooperative with the ASP.
