# Arkade Swap Intent Standard

> Non-interactive, trustless token-to-BTC swaps on the Ark protocol.
>
> **Status:** Draft v0.1 — open for feedback.
> **Reference implementation:** [vtxomarket swap protocol](../src/lib/swap_protocol/)

---

## Overview

This document specifies the **intent message format** and **execution protocol** for non-interactive token swaps on Ark. The goal is interoperability: any wallet or frontend that implements this standard can create and fill swap offers without coordinating with the counterparty.

A swap is a single atomic operation: tokens move from seller to buyer, sats move from buyer to seller — or nothing happens. No custodian, no escrow, no interactive rounds.

### Roles

| Role | Description |
|------|-------------|
| **Maker** | Creates an offer by locking funds into a swap VTXO |
| **Taker** | Fills an offer by spending the swap VTXO with the correct conditions |
| **Introspector** | Co-signer that validates Arkade Script conditions before signing |
| **ASP** | Ark Service Provider that finalizes offchain transactions |

---

## 1. Intent Message

The intent message is what gets published to an orderbook (indexer). Any taker can use it to fill the offer.

```typescript
interface SwapIntent {
  // === Identification ===
  type: "sell" | "buy";
  offerOutpoint: string;           // "txid:vout" — the swap VTXO on the ASP

  // === Maker ===
  makerArkAddress: string;         // Ark address (bech32m encoded)
  makerPkScript: string;           // hex, 34-byte P2TR (OP_1 + 0x20 + key)
  makerXOnlyPubkey: string;        // hex, 32-byte x-only pubkey

  // === Terms ===
  assetId: string;                 // "txid_hex + vout_hex" (36-byte hex blob)
  tokenAmount: number;             // exact token units (respecting decimals)
  satAmount: number;               // exact sats

  // === Script ===
  swapScriptHex: string;           // hex of TapTree.encode() — 3-leaf tree
  arkadeScriptHex: string;         // hex of introspection opcode conditions

  // === Timing ===
  expiresAt: number;               // unix timestamp (UTC)
  cancelDelaySeconds: number;      // BIP68 CSV from ASP unilateralExitDelay

  // === Signers ===
  introspectorPubkey: string;      // hex, from GET /v1/info
  aspPubkey: string;               // hex, from ASP /v1/info
}
```

### Determinism

Given the same `(makerPkScript, satAmount, assetId, tokenAmount, introspectorPubkey, aspPubkey, cancelDelaySeconds)`, any implementation MUST produce the **identical** `arkadeScriptHex` and `swapScriptHex`. This allows the taker to independently verify the offer.

---

## 2. Offer Types

### Sell Offer

Maker locks **tokens** into a swap VTXO. Taker pays **sats** to receive the tokens.

**Arkade Script conditions** (verified by introspector):
- `output[0].value >= satAmount` (maker receives enough sats)
- `output[0].scriptPubKey == makerPkScript` (sats go to maker's address)

### Buy Offer

Maker locks **sats** into a swap VTXO. Taker delivers **tokens** to receive the sats.

**Arkade Script conditions**:
- `output[0].scriptPubKey == buyerPkScript` (tokens go to buyer's address)
- `output[0]` has `>= tokenAmount` of the specified `assetId`

---

## 3. Taproot Script Tree

Every swap VTXO uses a 3-leaf taproot tree with an unspendable internal key:

```
              Root
             /    \
        Branch    Leaf 2 (Cancel Forfeit)
        /    \
   Leaf 0    Leaf 1
   (Swap)    (Cancel Exit)
```

### Leaf 0 — Swap (MultisigClosure)

```
<introspectorTweakedPubkey> OP_CHECKSIGVERIFY <aspPubkey> OP_CHECKSIG
```

Used when the taker fills the offer. Both introspector and ASP must sign.

### Leaf 1 — Cancel Exit (CSV Timelock)

```
<bip68_sequence> OP_CHECKSEQUENCEVERIFY OP_DROP <makerPubkey> OP_CHECKSIG
```

Maker can reclaim funds unilaterally after the timeout. BIP68 time-encoding:

```
bip68Value = 0x400000 | ceil(cancelDelaySeconds / 512)
```

### Leaf 2 — Cancel Forfeit (Collaborative)

```
<makerPubkey> OP_CHECKSIGVERIFY <aspPubkey> OP_CHECKSIG
```

Maker + ASP cancel instantly without waiting for timeout. No introspector needed.

---

## 4. Arkade Script Byte Format

### Sell Offer Script

```
00                              # OP_0 (output index 0)
CF                              # OP_INSPECTOUTPUTVALUE
08                              # push 8 bytes
<8-byte satAmount LE64>         # required sat amount
DF                              # OP_GREATERTHANOREQUAL64
69                              # OP_VERIFY
00                              # OP_0 (output index 0)
D1                              # OP_INSPECTOUTPUTSCRIPTPUBKEY
51                              # OP_1 (segwit v1)
88                              # OP_EQUALVERIFY
20                              # push 32 bytes
<32-byte witness program>       # maker's P2TR witness program
87                              # OP_EQUAL
```

### Buy Offer Script

```
00                              # OP_0 (output index 0)
D1                              # OP_INSPECTOUTPUTSCRIPTPUBKEY
51                              # OP_1 (segwit v1)
88                              # OP_EQUALVERIFY
20                              # push 32 bytes
<32-byte witness program>       # buyer's P2TR witness program
88                              # OP_EQUALVERIFY
00                              # OP_0 (output index 0)
20                              # push 32 bytes
<32-byte assetTxid reversed>    # asset ID txid in internal byte order
00                              # OP_0 (group index 0)
EF                              # OP_INSPECTOUTASSETLOOKUP
E0                              # OP_SCRIPTNUMTOLE64
08                              # push 8 bytes
<8-byte tokenAmount LE64>       # required token amount
DF                              # OP_GREATERTHANOREQUAL64
```

### Critical: Asset ID Byte Order

The asset txid MUST be reversed from display order to internal order:

```
display:  "0123456789abcdef..."  (big-endian hex)
internal: reverse(hexToBytes(display))  (little-endian)
```

---

## 5. Introspector Key Tweaking

Each arkade script produces a unique introspector public key:

```
scriptHash = TaggedHash("ArkScriptHash", arkadeScriptBytes)
           = sha256(sha256("ArkScriptHash") || sha256("ArkScriptHash") || script)

tweakedPubkey = basePubkey + scriptHash * G
```

The base pubkey is fetched from `GET /v1/info`. Always normalize to x-only (even Y) before tweaking.

---

## 6. OP_RETURN Extension Packet

The offchain transaction includes an OP_RETURN output with two packets:

```
OP_RETURN <push> "ARK" <assetPacket> <introspectorPacket>
```

### Asset Packet (type `0x00`)

Encoded by the Arkade SDK's `Packet.create()`. Contains asset group allocations mapping input assets to output destinations.

### Introspector Packet (type `0x01`)

```
<varint: entryCount>
  <u16le: inputIndex>
  <varint: scriptLength>
  <bytes: arkadeScript>
  <varint: witnessLength>  // 0 for swaps
```

---

## 7. Introspector API

### GET /v1/info

```json
{ "version": "v0.0.1", "signerPubkey": "02aa225448..." }
```

### POST /v1/tx (Light Path)

**Request:**
```json
{
  "ark_tx": "<base64 PSBT>",
  "checkpoint_txs": ["<base64 PSBT>", ...]
}
```

**Response:**
```json
{
  "signedArkTx": "<base64 PSBT>",
  "signedCheckpointTxs": ["<base64 PSBT>", ...]
}
```

The introspector:
1. Finds the arkade script PSBT field (key `0xDE` + `"arkadescript"`) on each input
2. Executes the opcode conditions against the transaction outputs
3. Co-signs with its tweaked private key if conditions pass
4. Returns the co-signed PSBTs

---

## 8. Fill Flow (Light Path)

```
Taker                         Introspector                ASP
  |                                |                        |
  |-- 1. Verify offer ------------|                        |
  |   (reconstruct arkadeScript,  |                        |
  |    check it matches offer)    |                        |
  |                                |                        |
  |-- 2. Build offchain tx --------|                        |
  |   (swap VTXO + funding VTXOs  |                        |
  |    → maker payment + change   |                        |
  |    + OP_RETURN packets)       |                        |
  |                                |                        |
  |-- 3. Sign taker inputs --------|                        |
  |                                |                        |
  |-- 4. POST /v1/tx ------------>|                        |
  |                                |-- validate conditions  |
  |                                |-- co-sign input 0      |
  |<-- signedArkTx + checkpoints --|                        |
  |                                |                        |
  |-- 5. Merge sigs (BIP-174) ----|                        |
  |                                |                        |
  |-- 6. submitTx(merged) --------|----------------------->|
  |                                |          validate + sign|
  |<-- arkTxid + signedCheckpoints |<----------------------|
  |                                |                        |
  |-- 7. Sign checkpoints --------|                        |
  |-- 8. finalizeTx(arkTxid) -----|----------------------->|
  |                                |                broadcast|
  |<-- done -----------------------|<----------------------|
```

---

## 9. Verification Requirements

Before filling an offer, the taker MUST verify:

1. **Arkade Script matches parameters**: Reconstruct the expected script from `(makerPkScript, satAmount)` or `(buyerPkScript, assetId, tokenAmount)` and compare byte-for-byte against `arkadeScriptHex`.

2. **VTXO exists on ASP**: Query the ASP's indexer (`getVtxos({ outpoints: [offerOutpoint] })`) to confirm the swap VTXO is spendable.

3. **Output correctness**: After building the offchain tx, verify `output[0]` matches the maker's payment address and amount.

---

## 10. Security Considerations

- **No custodial risk**: Funds are locked in taproot scripts, not held by any party.
- **Introspector is a co-signer, not a custodian**: It can refuse to sign but cannot steal funds.
- **Cancel path ensures recoverability**: Maker can always reclaim after CSV timeout.
- **Script determinism prevents manipulation**: Taker independently verifies the arkade script.
- **BIP68 time-encoding required**: The ASP rejects block-based CSV (`0x400000` flag must be set).

---

## 11. Open Questions

- [ ] Should the intent message include a signature from the maker (to prove ownership)?
- [ ] Should there be a standard orderbook relay protocol (Nostr, HTTP, gRPC)?
- [ ] How to handle offer expiry propagation across multiple frontends?
- [ ] Should the introspector packet format be versioned?
- [ ] Multi-asset swaps (token-for-token) — extend arkade script with dual conditions?

---

## Changelog

- **v0.1** (2026-03-20): Initial draft based on vtxomarket reference implementation.
