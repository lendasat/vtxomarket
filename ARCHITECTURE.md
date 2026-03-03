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
│   ├── token/[id]/       # Token detail — chart, thread, trades, manage tab
│   ├── wallet/           # Holdings, balance, deposit/withdraw
│   ├── settings/         # Profile, keys, about, ToS
│   └── dev/              # Debug panel (temporary)
├── lib/
│   ├── ark-wallet.ts     # Arkade SDK wrapper (issue, reissue, send, balance)
│   ├── nostr-market.ts   # Nostr event publish/subscribe (listings, trades)
│   ├── nostr.ts          # NDK singleton + NIP-98 auth
│   ├── image-upload.ts   # NIP-96 image upload → nostr.build
│   └── store.ts          # Zustand global state
├── hooks/
│   ├── useWallet.ts      # Ark wallet lifecycle + auto-renewal
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
| Order (legacy) | `vtxomarket/order/{arkTxId}` | Pending order (pre-swap, to be replaced) |
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
        │              VTXO metadata from arkd, upserts into SQLite
        ▼
   db.ts (SQLite)
   ├── assets          assetId, name, ticker, decimals, supply
   ├── vtxos           outpoint, assetId, amount, script, isSpent
   └── processed_txs   deduplication log
        │
        ▼
   api.ts (Hono HTTP)
   ├── GET /health
   ├── GET /assets                      → all known assets
   ├── GET /assets/:id                  → single asset
   ├── GET /assets/:id/vtxos            → all VTXOs for asset (?spendable=true)
   └── GET /assets/:id/holders          → balances grouped by script
```

**Current limitation:** The indexer only sees *settled* VTXOs (transactions that
have been committed). Pending intents in the Ark virtual mempool are not yet visible.

---

## What's Missing — The Order Book

### How non-interactive swaps work on Arkade

A maker creates a signed **Intent Proof** — a specially crafted transaction that
commits to: "I will give X tokens, I want Y sats, send to address Z, expires at T."

This Intent is submitted to the Ark server and sits in the **virtual mempool** as a
pending transaction. It doesn't require the taker to be online or coordinated.

A taker finds the intent, constructs a settlement that spends both sides
(their sats VTXO + the maker's token VTXO), and submits it. The Ark batch
settlement then executes both atomically — either the full swap completes or
both sides keep their original funds.

```
Maker                    Ark Server               Taker
  │                          │                      │
  ├─ Intent.create() ────────▶                      │
  │  (sign: give 100 THUNA,  │                      │
  │   want 5000 sats)        │                      │
  │                          │◀── SSE stream ───────┤
  │                      [virtual                   │
  │                       mempool]                  │
  │                          │                      │
  │                          ├─── indexer picks ────▶
  │                          │    up intent          │
  │                          │                   order book
  │                          │                   shows offer
  │                          │                      │
  │                          │◀── fill intent ───────┤
  │                          │    (settle sats       │
  │                          │     + take tokens)    │
  │                          │                      │
  │◀──── batch round ────────┤──────────────────────▶
         atomic swap committed on Bitcoin
```

---

### What needs to be built

#### Phase 1 — Extend the indexer to track swap intents

The Ark SSE stream (`/v1/txs`) also emits pending intents before they are settled.
The indexer needs to:

- Detect `arkTx` events that are swap intents (OP_RETURN asset packet with
  non-zero `assetId` + a BTC output to a non-self address)
- Parse the offer terms: `assetId`, `assetAmount`, `satAmount`, `makerScript`,
  `expiresAt`
- Store them in a new `offers` table in SQLite
- Mark offers as `filled` when the corresponding VTXO is seen as spent in a later tx
- Mark offers as `expired` when `expiresAt` passes

New API endpoints:
```
GET /offers                         → all open offers
GET /offers?assetId=:id             → open offers for a specific token
GET /offers/:offerId                → single offer detail
```

#### Phase 2 — Maker side (create offer)

New flow in the frontend:

```
User picks: token + amount + price (sats per token)
      │
      ▼
ark-wallet.ts: createSwapOffer()
  - select token VTXO (assetAmount)
  - construct Intent.RegisterMessage { expire_at, outputs }
  - Intent.create(message, [tokenVtxo], [satOutput])
  - identity.sign(proof)
  - arkProvider.registerIntent(signedProof)
      │
      ▼
nostr-market.ts: publishOfferListing()
  - kind 30078, d: vtxomarket/offer/{intentId}
  - tags: assetId, amount, satAmount, expiry
  (Nostr is secondary discovery; Ark mempool is primary)
```

#### Phase 3 — Order book UI

Per-token order book view (on the token detail page):

```
┌─────────────────────────────────┐
│  THUNA / BTC Order Book         │
├─────────────────────────────────┤
│  ASKS (selling THUNA)           │
│  100 THUNA  @  55 sat/token     │
│  500 THUNA  @  52 sat/token     │
│  200 THUNA  @  50 sat/token     │
├──────────── spread ─────────────┤
│  BIDS (buying THUNA)            │
│  300 THUNA  @  48 sat/token     │
│  150 THUNA  @  45 sat/token     │
└─────────────────────────────────┘
```

Data comes from `GET /offers?assetId=:id` on the indexer.

#### Phase 4 — Taker side (fill offer)

```
User clicks "Buy" on an offer
      │
      ▼
ark-wallet.ts: fillSwapOffer(offer)
  - verify offer not expired
  - select sats VTXO (>= offer.satAmount)
  - construct settlement:
      inputs:  [satVtxo, offerVtxo (token)]
      outputs: [tokenOutput → user, satOutput → maker]
  - wallet.settle(inputs, outputs)
  - wait for batch finalization event
      │
      ▼
nostr-market.ts: publishTradeReceipt()
  - records completed trade for chart + feed
```

---

## Full Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Bitcoin                               │
│                    (settlement layer)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ batch rounds (~1min)
┌──────────────────────────▼──────────────────────────────────┐
│                    Ark Server (arkd)                         │
│                  mutinynet.arkade.sh                         │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────────────────┐    │
│  │  Virtual VTXO   │   │  Virtual Mempool             │    │
│  │  tree (settled) │   │  (pending intents / offers)  │    │
│  └────────┬────────┘   └──────────────┬───────────────┘    │
│           │  SSE /v1/txs              │                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
┌───────────────────────────────────────────────────────────────┐
│              vtxo.market Interim Indexer                       │
│              (Bun + SQLite + Hono, port 3001)                  │
│                                                                │
│  Now:   assets, VTXOs, holder balances                        │
│  Next:  swap intents / open offers                            │
│                                                                │
│  GET /assets                 GET /assets/:id/holders          │
│  GET /assets/:id/vtxos       GET /offers?assetId=:id  (soon) │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTP (localhost:3001)
┌──────────────────────────▼────────────────────────────────────┐
│                     vtxo.market Frontend                       │
│                     (Next.js, port 3000)                       │
│                                                                │
│  Marketplace  →  Token Detail  →  Order Book  →  Trade        │
│  Create Token    Chart (trades)   Offers list    Fill offer   │
│  Wallet          Thread           Make offer     Receipt      │
└──────────────────────────┬────────────────────────────────────┘
                           │ Nostr (NDK, kind 30078)
┌──────────────────────────▼────────────────────────────────────┐
│                       Nostr Relays                             │
│         relay.damus.io, relay.nostr.band, nos.lol             │
│                                                                │
│  Token listings    Trade receipts    Comments                  │
│  (vtxomarket/token/{TICKER})         (secondary offer hints)  │
└───────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Role |
|---|---|---|
| Settlement | Bitcoin (via Ark) | Final settlement, atomicity |
| Offchain execution | Arkade SDK (`@arkade-os/sdk`) | VTXO management, issuance, swaps |
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
- **The indexer is temporary.** Once arkd ships native asset filtering and intent
  querying, most of it becomes redundant.
- **Non-interactive swaps are marked experimental** in Arkade docs. The SDK has
  the low-level `Intent` primitives but no high-level `wallet.swap()` yet.
  We will build thin wrappers over `Intent.create()` + `wallet.settle()`.
