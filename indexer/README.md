# Interim Asset Indexer

> **This is a temporary service.**
>
> The Arkade team ([arkade-os/arkd](https://github.com/arkade-os/arkd)) has confirmed they plan to ship a native asset filter on `ListVtxos` and the subscription stream — at which point this indexer becomes redundant and should be retired in favour of the official endpoints.
>
> Track the upstream work: [arkade-os/arkd](https://github.com/arkade-os/arkd)

---

## Why this exists

The `arkd` indexer currently exposes:

```
GET /v1/indexer/asset/{id}   → supply + metadata only
GET /v1/indexer/vtxos        → VTXOs filtered by script/address, NOT by assetId
GET /v1/txs                  → SSE stream of every transaction on the network
```

There is no endpoint to answer: *"which VTXOs currently hold asset X?"*

That query is essential for a marketplace — you need it to show token holders and, once non-interactive swaps land, to discover open swap-offer VTXOs for a given asset.

Since arkd already has the data internally (it comes back on individual VTXOs via `assets[]`), this indexer replicates that inverted index by consuming the `GET /v1/txs` SSE stream and maintaining its own asset → VTXO mapping.

## What it does

- Subscribes to `GET /v1/txs` SSE from the Arkade server
- Parses the OP_RETURN asset packet in each virtual transaction
- Maintains a local SQLite database: `assetId → [VTXOs]`
- Exposes a minimal REST API for the vtxofun frontend

## API

```
GET /assets                          → all known assets (assetId, name, ticker, supply)
GET /assets/:id/vtxos                → all VTXOs holding this asset (spendable + spent)
GET /assets/:id/vtxos?spendable=true → spendable VTXOs only (current holders)
GET /assets/:id/holders              → balances grouped by script/address
GET /health                          → service health check
```

## Tech stack

- **Runtime**: Bun
- **Database**: SQLite via `bun:sqlite`
- **HTTP**: Hono
- **Data source**: `GET /v1/txs` SSE from `arkd`

## Migration path

When `arkd` ships native asset VTXO filtering, the migration is:

1. Replace `GET /assets/:id/vtxos` calls in the frontend with `GET /v1/indexer/vtxos?assetId=...`
2. Replace `GET /assets/:id/holders` with the equivalent indexer call
3. Shut this service down

The asset packet parsing logic in `src/parser.ts` may still be useful if the team adds a subscription stream filter — that would be an `assetId` filter on `POST /v1/indexer/script/subscribe`.

## Running

```bash
bun install
bun run dev       # development with hot reload
bun run start     # production
```

## Environment

```env
ARK_SERVER_URL=https://arkade.computer
PORT=3001
DATABASE_PATH=./data/indexer.db
```

## Context

This came out of a conversation with the Arkade team:

> **kukks (Andrew Camilleri):** "We didn't plan for this just yet [...] we can potentially ship a filter on listvtxos + subscription stream"

> **tiero:** "the virtual mempool becomes the de-facto place to monitor trade offers [...] anyone could run a monitoring node and relay orders"

This indexer is that monitoring node, built to unblock marketplace development until the official endpoints ship.
