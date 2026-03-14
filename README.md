# vtxo.market

A permissionless, non-custodial token marketplace on Bitcoin. Tokens are issued as [Arkade](https://arkade.sh) assets (VTXOs on the Ark protocol) and traded via non-interactive atomic swaps that settle on Bitcoin.

No custody. No platform fees. Self-custodied wallets from a 12-word seed phrase.

## How it works

- **Tokens** are issued as Arkade Assets (off-chain Bitcoin VTXOs with asset extensions)
- **Trading** uses non-interactive script-based swaps with the [Arkade Introspector](https://github.com/ArkLabsHQ/introspector) as a co-signer
- **Settlement** is atomic — maker receives sats, taker receives tokens, or nothing happens
- **Cancellation** is always possible — cooperatively via ASP, or unilaterally on-chain after CSV timelock

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full swap protocol design, security properties, and opcode-level analysis.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Bun](https://bun.sh/) v1.1+ (for the indexer)
- [Docker](https://www.docker.com/) (for the Introspector)

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/lendasat/vtxofun.git
cd vtxofun
npm install
cp .env.example .env
```

### 2. Start the Asset Indexer

The indexer tracks Arkade asset metadata, VTXO state, and swap offers in a local SQLite database. It subscribes to the Ark server's SSE stream and exposes a REST API on port 3001.

```bash
cd indexer
cp .env.example .env
bun install
bun run src/index.ts
```

The indexer will connect to the Ark server (mutinynet by default) and start indexing assets.

### 3. Set up the Introspector

The Introspector is required for swap fills (not needed for token issuance, sending, or offer cancellation). It validates Arkade Script introspection conditions and co-signs PSBTs.

```bash
# Clone the Introspector repo
git clone https://github.com/ArkLabsHQ/introspector.git

# Run with Docker
cd introspector
docker build -t introspector .
docker run -d --name introspector \
  -p 7073:7073 \
  -e INTROSPECTOR_SECRET_KEY=$(openssl rand -hex 32) \
  introspector
```

Verify it's running:

```bash
curl http://localhost:7073/v1/info
# Should return: {"signerPubkey": "..."}
```

The `signerPubkey` is the Introspector's base public key. It gets tweaked per-swap-script to cryptographically bind it to specific swap conditions.

### 4. Start the frontend

```bash
# From the project root
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | Ark server URL |
| `NEXT_PUBLIC_ESPLORA_URL` | `https://mutinynet.com/api` | Bitcoin block explorer API |
| `NEXT_PUBLIC_BOLTZ_URL` | `https://api.boltz.mutinynet.arkade.sh` | Boltz API for Lightning swaps |
| `NEXT_PUBLIC_INDEXER_URL` | `http://localhost:3001` | Asset indexer URL |
| `NEXT_PUBLIC_INTROSPECTOR_URL` | `http://localhost:7073` | Introspector URL |
| `NEXT_PUBLIC_LENDASWAP_API_URL` | `https://api.lendaswap.com/` | LendaSwap API (stablecoin swaps) |
| `NEXT_PUBLIC_LENDASWAP_API_KEY` | | LendaSwap API key |

For mainnet, uncomment the mainnet URLs in `.env.example`.

## Project structure

```
vtxo.market/
├── src/
│   ├── app/                    # Next.js pages
│   │   ├── page.tsx            # Marketplace home
│   │   ├── create/             # Token issuance
│   │   ├── token/[id]/         # Token detail (thread, trades, order book)
│   │   ├── wallet/             # Holdings, send/receive, Lightning, stablecoins
│   │   ├── lab/                # Swap script lab (dev tool)
│   │   └── settings/           # Profile, keys
│   ├── lib/
│   │   ├── ark-wallet.ts       # Arkade SDK wrapper
│   │   ├── swap_protocol/      # Non-interactive swap implementation
│   │   │   ├── light-fill.ts   # Fill offers (submitTx/finalizeTx)
│   │   │   ├── offers.ts       # Create + cancel offers
│   │   │   ├── script.ts       # 3-leaf taproot tree + arkade script
│   │   │   ├── introspector-client.ts
│   │   │   └── psbt-combiner.ts
│   │   ├── nostr-market.ts     # Nostr events (comments, trade receipts)
│   │   └── store.ts            # Zustand state
│   └── hooks/                  # React hooks (useWallet, useOffers, useTokens, etc.)
├── indexer/                    # Asset indexer (Bun + SQLite + Hono)
│   ├── src/
│   │   ├── index.ts            # Entry point
│   │   ├── stream.ts           # SSE consumer (arkd /v1/txs)
│   │   ├── indexer.ts          # Core indexing logic
│   │   ├── db.ts               # SQLite schema + queries
│   │   ├── api.ts              # REST API (Hono)
│   │   └── ark-client.ts       # arkd HTTP client
│   └── .env.example
├── ARCHITECTURE.md             # Detailed swap protocol documentation
└── .env.example
```

## Tech stack

| Layer | Technology |
|---|---|
| Settlement | Bitcoin (via [Ark](https://ark-protocol.org)) |
| Offchain execution | [@arkade-os/sdk](https://github.com/arkade-os/wallet) |
| Swap co-signing | [Arkade Introspector](https://github.com/ArkLabsHQ/introspector) |
| Social layer | [Nostr](https://nostr.com) (NDK) |
| Indexer | Bun + SQLite + Hono |
| Frontend | Next.js 16 + Tailwind v4 |
| State | Zustand |
| Lightning | [Boltz](https://boltz.exchange) atomic swaps |

## Network support

- **Mutinynet** (default) — Bitcoin testnet with 30s blocks. Free faucet at [faucet.mutinynet.com](https://faucet.mutinynet.com).
- **Mainnet** — Change the env vars to mainnet URLs.

## Contributing

Contributions welcome. Please read [ARCHITECTURE.md](./ARCHITECTURE.md) before diving into the swap protocol code.

## License

MIT
