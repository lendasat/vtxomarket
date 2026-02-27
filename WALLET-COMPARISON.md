# Wallet Comparison: vtxo.fun vs Arkade Wallet

> **Date:** 2026-02-27
> **Purpose:** Feature gap analysis to bring vtxo.fun to production parity with the official Arkade wallet.

## Sources

| Source | URL / Path | What we looked at |
|--------|-----------|-------------------|
| Arkade Wallet App (PWA) | [github.com/arkade-os/wallet](https://github.com/arkade-os/wallet) | React/Ionic PWA, ~690 commits, MIT license |
| Arkade TypeScript SDK | [github.com/arkade-os/ts-sdk](https://github.com/arkade-os/ts-sdk) | `@arkade-os/sdk` v0.3.13 on npm |
| SDK Documentation | [arkade-os.github.io/ts-sdk](https://arkade-os.github.io/ts-sdk/) | API reference |
| Arkade Docs | [docs.arkadeos.com](https://docs.arkadeos.com/) | Protocol & integration guides |
| Arkade Blog | [blog.arklabs.xyz](https://blog.arklabs.xyz/introducing-the-ark-wallet-sdk-d1c77ce61cfc/) | SDK introduction post |
| Our codebase | `/home/weltitob/lendasat/vtxofun/src/` | Local wallet implementation |

### Key files examined in the Arkade wallet repo

- `src/app/` — Ionic page components (send, receive, settings, swap, vtxos)
- `src/providers/` — WalletProvider, SwapManager, BackupProvider, BiometricProvider
- `src/utils/` — BIP21, LNURL, ArkNote encoding, fee estimation
- `src/components/` — QR scanner, amount input, swap cards

### Key files examined in our codebase

- `src/lib/ark-wallet.ts` — Core Ark operations (send, settle, balance, tokens)
- `src/lib/lightning.ts` — Lightning init & fee calculation
- `src/lib/lnurl.ts` — LNURL-pay & Lightning Address resolution
- `src/lib/wallet-crypto.ts` — BIP39/BIP32 key derivation
- `src/lib/wallet-storage.ts` — IndexedDB persistence
- `src/lib/trade-engine.ts` — Token bonding curve trading
- `src/hooks/useWallet.ts` — Wallet lifecycle & auto-settle
- `src/hooks/useLightning.ts` — Lightning send/receive hook
- `src/app/wallet/page.tsx` — Main wallet UI (send/receive tabs)
- `src/app/settings/page.tsx` — Settings & key management

---

## What We Already Match

These features are at parity — no work needed.

| Feature | Our implementation | Notes |
|---------|-------------------|-------|
| Boarding (on-chain deposit) | `getReceivingAddresses().boardingAddr` + auto-settle at 1000 sats | Works |
| Send Ark VTXOs | `wallet.sendBitcoin(arkAddr, amount)` | Single-recipient |
| Collaborative exit | `wallet.settle()` to BTC address | Works |
| Send BOLT11 Lightning | Boltz submarine swap via `sendLightningPayment()` | Works |
| Receive Lightning | Reverse swap via `createLightningInvoice()` + `waitAndClaim()` | Works |
| LNURL-pay | Full decode → fetchParams → requestInvoice flow | Works |
| Lightning Address | `user@domain.com` → `.well-known/lnurlp/` | Works |
| BIP39 seed generation | 12-word mnemonic | Works |
| Token issuance | Custom dust-aware implementation | Works (better than SDK default for mainnet) |
| Token transfers | `assetManager.send()` | Works |
| Coin selection | Sort by batch expiry (asc) → value (desc) | Works |

---

## Features Only We Have (Advantages)

| Feature | Details |
|---------|---------|
| Token marketplace | Bonding curve trading (buy/sell) via `trade-engine.ts` |
| Nostr order book | Orders published as Nostr events, creators fill trades |
| Token creation UI | Full flow: name, ticker, image upload, supply config |
| Social features | Reply counts, trade counts, community engagement |
| Pump.fun mechanics | Graduated bonding curve with virtual reserves |

---

## Gap Analysis — What We Need to Implement

### Priority 1: Critical for Production Safety

#### 1.1 Unilateral Exit (Emergency Escape Hatch)
- **Risk:** If the ASP (arkade.computer) goes offline, users CANNOT exit with their funds
- **Arkade impl:** `Unroll.Session` class — async iterator state machine with WAIT/UNROLL/DONE steps, 1C1P fee packaging, timelock evaluation
- **SDK surface:** The `@arkade-os/sdk` already has this built in. We need to expose it in UI
- **Work required:**
  - [ ] Add "Emergency Exit" button in settings or wallet page
  - [ ] Call SDK's unilateral exit when ASP is unreachable
  - [ ] Show progress (multiple on-chain txs needed for tree unrolling)
  - [ ] Handle the wait periods between confirmations
- **Files to modify:** `src/lib/ark-wallet.ts`, `src/app/settings/page.tsx` or new modal

#### 1.2 VTXO Auto-Renewal
- **Risk:** VTXOs expire after ~28 days. If not renewed, funds become "swept" and harder to recover
- **Arkade impl:** `VtxoManager` monitors expiry, auto-renews 3 days before expiry by joining a settlement round
- **Work required:**
  - [ ] Add expiry monitoring in `useWallet.ts` (check on each balance refresh)
  - [ ] When any VTXO is within 3 days of expiry, trigger `settleAll()`
  - [ ] Show "Renewing VTXOs..." status in UI
  - [ ] Notify user if renewal fails (so they can manually act)
- **Files to modify:** `src/hooks/useWallet.ts`, `src/lib/ark-wallet.ts`

#### 1.3 Swap Refund & Recovery
- **Risk:** If a Lightning swap fails mid-way (e.g. network drop), funds are stuck with no recovery
- **Arkade impl:** Persistent swap records in IndexedDB, `restoreSwaps()` on startup, refund UI for stuck swaps
- **Work required:**
  - [ ] Persist swap state (id, status, amounts, timeouts) in IndexedDB
  - [ ] On app startup, check for pending swaps and attempt restoration
  - [ ] Add refund flow for expired/failed submarine swaps
  - [ ] Show swap history somewhere (settings or wallet history)
- **Files to modify:** `src/lib/lightning.ts`, `src/hooks/useLightning.ts`, new `src/lib/swap-storage.ts`

#### 1.4 Wallet Encryption
- **Risk:** Private keys stored in plain text in IndexedDB — any XSS or browser extension can steal funds
- **Arkade impl:** AES-GCM encryption with PBKDF2 (100k iterations, SHA-256), password required to decrypt
- **Work required:**
  - [ ] Add password prompt on first wallet creation
  - [ ] Encrypt mnemonic before storing in IndexedDB
  - [ ] Decrypt on app load (password prompt)
  - [ ] Consider adding lock/unlock screen
- **Files to modify:** `src/lib/wallet-storage.ts`, `src/lib/wallet-crypto.ts`, `src/app/` (new lock screen)

### Priority 2: Important for User Experience

#### 2.1 Dynamic Fee Estimation (On-Chain Sends)
- **Current:** Hardcoded 200 sats fee in `ark-wallet.ts` (`ONCHAIN_FEE_SATS = 200`)
- **Arkade impl:** Iterative fee estimation (up to 10 rounds) accounting for tx size and mempool conditions
- **Work required:**
  - [ ] Fetch fee rate from Esplora (`/api/fee-estimates`)
  - [ ] Estimate tx size based on number of inputs/outputs
  - [ ] Calculate fee = feeRate * vbytes
  - [ ] Replace `ONCHAIN_FEE_SATS` constant with dynamic calculation
- **Files to modify:** `src/lib/ark-wallet.ts`

#### 2.2 BIP21 Unified Receive QR
- **Current:** Three separate tabs (Onchain / Lightning / Arkade) each with their own QR
- **Arkade impl:** Single QR encodes `bitcoin:<boardingAddr>?ark=<arkAddr>&lightning=<bolt11>`
- **Work required:**
  - [ ] Generate BIP21 URI combining all three addresses
  - [ ] Show single QR by default with option to expand individual addresses
  - [ ] Auto-create Lightning invoice when amount is entered
- **Files to modify:** `src/app/wallet/page.tsx`

#### 2.3 Subdust VTXO Consolidation
- **Current:** Small VTXOs below dust threshold are effectively stuck
- **Arkade impl:** Detects sub-dust VTXOs, consolidates when combined total exceeds dust
- **Work required:**
  - [ ] Detect VTXOs below dust threshold
  - [ ] When sum of sub-dust VTXOs > dust, consolidate via settlement round
  - [ ] Can piggyback on auto-settlement logic
- **Files to modify:** `src/lib/ark-wallet.ts`, `src/hooks/useWallet.ts`

#### 2.4 VTXO Management Screen
- **Current:** No visibility into individual VTXOs
- **Arkade impl:** Settings screen lists each VTXO with status tags (settled, swept, expiring soon, subdust, unconfirmed)
- **Work required:**
  - [ ] New page or modal listing all VTXOs from `getVtxoDetails()`
  - [ ] Show: value, type, status, expiry countdown
  - [ ] Manual rollover button
- **Files to modify:** New `src/app/vtxos/page.tsx` or modal in settings

### Priority 3: Nice to Have

#### 3.1 ArkNotes (Bearer Instruments)
- **What:** 36-byte bearer tokens (32-byte preimage + 4-byte value), base58-encoded with "arknote" prefix
- **Use case:** Offline payments, gift cards, physical bearer instruments
- **Arkade impl:** Create → encode → QR. Redeem → decode → settle into wallet
- **Work required:**
  - [ ] ArkNote encoding/decoding functions
  - [ ] Create ArkNote UI (amount → generate → show QR/text)
  - [ ] Redeem ArkNote UI (scan/paste → claim funds)
  - [ ] Detect ArkNote format in send input field
- **Files to modify:** New `src/lib/arknotes.ts`, wallet page modifications

#### 3.2 Token Reissue & Burn
- **Current:** Can issue and send tokens, but not reissue or burn
- **Arkade impl:** `AssetManager.reissue()` (mint more via control asset), `AssetManager.burn()` (destroy units)
- **Work required:**
  - [ ] Add reissue function to `ark-wallet.ts`
  - [ ] Add burn function to `ark-wallet.ts`
  - [ ] UI controls on token detail page (only for token creator)
- **Files to modify:** `src/lib/ark-wallet.ts`, token detail page

#### 3.3 Fiat Price Display
- **Current:** Sats only
- **Arkade impl:** Fetches from `blockchain.info/ticker`, shows USD/EUR/CHF
- **Work required:**
  - [ ] Fetch BTC price from public API
  - [ ] Convert sats → fiat throughout UI
  - [ ] Currency selector in settings
- **Files to modify:** New `src/lib/price.ts`, wallet page, settings

#### 3.4 Balance Privacy Toggle
- **Current:** Balance always visible
- **Arkade impl:** Eye icon to show/hide balance
- **Work required:**
  - [ ] Add eye toggle icon next to balance display
  - [ ] Replace digits with dots/stars when hidden
  - [ ] Persist preference in localStorage
- **Files to modify:** `src/app/wallet/page.tsx`

#### 3.5 Send-All Button
- **Current:** Manual amount entry only
- **Arkade impl:** "Max" button that fills amount minus estimated fees
- **Work required:**
  - [ ] Calculate max sendable = available balance - estimated fee
  - [ ] Add "Max" button next to amount input
- **Files to modify:** `src/app/wallet/page.tsx`

#### 3.6 Self-Send Detection
- **Current:** No warning if sending to own address
- **Arkade impl:** Detects self-send, suggests VTXO rollover instead
- **Work required:**
  - [ ] Compare recipient with own addresses
  - [ ] Show warning: "This is your own address. Did you mean to rollover?"
  - [ ] Offer rollover action instead
- **Files to modify:** `src/app/wallet/page.tsx`

#### 3.7 QR Scanner (Camera)
- **Current:** Paste only
- **Arkade impl:** Camera-based QR scanning
- **Work required:**
  - [ ] Add QR scanner library (e.g. `html5-qrcode` or `@yudiel/react-qr-scanner`)
  - [ ] Camera permission request
  - [ ] Scan → auto-fill send input
- **Files to modify:** `src/app/wallet/page.tsx`, new scanner component

#### 3.8 Nostr Cloud Backup
- **Current:** Download seed as .txt
- **Arkade impl:** NIP-44 encrypted backup published to Nostr relays, restorable from any device
- **Work required:**
  - [ ] Encrypt wallet config with NIP-44
  - [ ] Publish encrypted backup to user's Nostr relays
  - [ ] Add "Restore from Nostr" option on login
- **Files to modify:** `src/lib/wallet-storage.ts`, settings, login page

---

## Implementation Progress

### Phase 1 — Production Safety (DONE)
- [x] **VTXO auto-renewal** — `ark-wallet.ts`: `renewVtxos()`, `getVtxosNeedingRenewal()`, `computeRenewalThreshold()`. Integrated in `useWallet.ts` refresh cycle. Uses 10% of batch lifetime threshold (matches Arkade), falls back to 3 days.
- [x] **Dynamic fee estimation** — `ark-wallet.ts`: `getFeeRate()`, `estimateCollaborativeExitFee()`. Fetches from Esplora `/fee-estimates` (next-block target), iterative coin selection in `sendPayment()` (up to 5 rounds). Replaced hardcoded 200 sat fee.
- [x] **Swap recovery & refunds** — `lightning.ts`: `getSwapHistory()`, `refundSwap()`, `restoreSwaps()`. Enabled `swapManager: true` in ArkadeLightning for auto-claim/auto-refund. Exposed in `useLightning` hook.
- [x] **Unilateral exit** — `ark-wallet.ts`: `unilateralExit()`, `completeUnilateralExit()`, `isAspReachable()`, `getUnilateralExitEligibleVtxos()`, `getUnrolledVtxos()`. Uses SDK's `Unroll.Session` async iterator + `OnchainWallet` for P2A fee bumping.

### Phase 2 — Security Hardening (DONE)
- [x] **Wallet encryption** — `wallet-crypto.ts`: `encryptWithPassword()`, `decryptWithPassword()` (AES-GCM + PBKDF2, 100k iterations). `wallet-storage.ts`: `setupPassword()`, `verifyPassword()`, `saveMnemonicEncrypted()`, `getMnemonicDecrypted()`. Backward-compatible with plaintext wallets.

### Phase 3 — UX Polish (TODO)
- [ ] BIP21 unified QR (better receive experience)
- [ ] Send-all button
- [ ] Balance privacy toggle
- [ ] Self-send detection
- [ ] Subdust consolidation

### Phase 4 — Advanced Features (TODO)
- [ ] VTXO management screen
- [ ] ArkNotes
- [ ] Token reissue & burn
- [ ] QR scanner
- [ ] Fiat prices
- [ ] Nostr cloud backup

---

## Architecture Notes

### Key Derivation Difference
- **Us:** `m/44'/1237'/0'/0/0` with `SingleKey.fromHex()`
- **Arkade:** `m/44/1237/0'` with `MnemonicIdentity` (BIP86 Taproot)
- **Impact:** Different addresses from the same seed. We should evaluate whether to migrate to `MnemonicIdentity` for SDK compatibility. This is a breaking change for existing users.

### Payment Detection
- **Us:** 30-second polling interval in `useWallet.ts`
- **Arkade:** Service worker + WebSocket listeners for near-instant detection
- **Impact:** Our UX feels slower for incoming payments. Consider adding WebSocket subscription to Esplora for UTXO notifications.

### Identity Model
- **Us:** `SingleKey` — bare private key, simpler but less flexible
- **Arkade SDK:** `MnemonicIdentity` (recommended), `SeedIdentity`, `SingleKey`, `ReadonlyDescriptorIdentity`
- **Impact:** `MnemonicIdentity` would give us BIP86 Taproot addresses and better SDK compatibility. Worth evaluating for new wallets.
