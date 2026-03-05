/**
 * Core indexing logic.
 *
 * For each arkTx notification from the SSE stream:
 *   1. Skip if already processed (idempotent)
 *   2. Mark spent VTXOs in DB
 *   3. Batch-query arkd indexer for spendable outpoints → get assets[]
 *   4. For each VTXO with assets: upsert asset metadata + VTXO record
 */

import { config } from "./config";
import { log } from "./logger";
import {
  isTxProcessed,
  markTxProcessed,
  upsertAsset,
  upsertVtxo,
  markVtxosSpent,
  getOffer,
  markOfferFilled,
  markOfferCancelled,
} from "./db";
import { fetchVtxosByOutpoints, fetchAssetMetadata } from "./ark-client";
import type { TxNotification } from "./types";

// Cache of assetIds whose metadata we've already fetched this session
const assetMetadataFetched = new Set<string>();

export async function handleTxNotification(notification: TxNotification): Promise<void> {
  const { txid, spentVtxos, spendableVtxos } = notification;

  if (isTxProcessed(txid)) {
    log.debug("indexer: tx already processed, skipping", { txid });
    return;
  }

  // ── Step 1: mark spent VTXOs ────────────────────────────────────────────────
  if (spentVtxos.length > 0) {
    const spentOutpoints = spentVtxos.map(
      (v) => `${v.outpoint.txid}:${v.outpoint.vout}`
    );
    markVtxosSpent(spentOutpoints, txid);
    log.debug("indexer: marked VTXOs spent", { txid, count: spentOutpoints.length });

    // Detect offer state changes when their VTXOs are spent.
    // commitmentTx = taker filled the offer; arkTx = maker cancelled (or other spend).
    for (const spent of spentVtxos) {
      const outpoint = `${spent.outpoint.txid}:${spent.outpoint.vout}`;
      const offer = getOffer(outpoint);
      if (offer && offer.status === 'open') {
        if (notification.eventType === 'commitmentTx') {
          markOfferFilled(offer.offerOutpoint, txid);
          log.info('indexer: offer filled', { offerOutpoint: offer.offerOutpoint, txid });
        } else {
          // arkTx spending an offer VTXO = maker cancelled via on-chain settle
          markOfferCancelled(offer.offerOutpoint);
          log.info('indexer: offer cancelled (VTXO spent in arkTx)', { offerOutpoint: offer.offerOutpoint, txid });
        }
      }
    }
  }

  // ── Step 2: fetch full VTXO data for spendable outpoints ───────────────────
  if (spendableVtxos.length > 0) {
    const allOutpoints = spendableVtxos.map(
      (v) => `${v.outpoint.txid}:${v.outpoint.vout}`
    );

    // Process in batches to avoid URL length limits
    const batches = chunk(allOutpoints, config.outpointBatchSize);
    let totalAssetVtxos = 0;

    for (const batch of batches) {
      const vtxos = await fetchVtxosByOutpoints(batch);

      for (const vtxo of vtxos) {
        if (!vtxo.assets || vtxo.assets.length === 0) continue;

        const outpoint = `${vtxo.outpoint.txid}:${vtxo.outpoint.vout}`;

        for (const asset of vtxo.assets) {
          // ── Ensure asset metadata exists ──────────────────────────────────
          if (!assetMetadataFetched.has(asset.assetId)) {
            await ensureAssetMetadata(asset.assetId, txid);
            assetMetadataFetched.add(asset.assetId);
          }

          // ── Upsert VTXO ───────────────────────────────────────────────────
          upsertVtxo({
            outpoint,
            assetId: asset.assetId,
            amount: asset.amount,
            script: vtxo.script ?? vtxo.pubkey ?? "",
            isSpent: vtxo.isSpent ?? false,
            seenInTxid: txid,
            spentInTxid: null,
          });

          totalAssetVtxos++;
        }
      }
    }

    if (totalAssetVtxos > 0) {
      log.info("indexer: indexed asset VTXOs", { txid, count: totalAssetVtxos });
    }
  }

  // ── Step 3: mark as processed ───────────────────────────────────────────────
  markTxProcessed(txid);
}

async function ensureAssetMetadata(assetId: string, txid: string): Promise<void> {
  const meta = await fetchAssetMetadata(assetId);

  upsertAsset({
    assetId,
    name: meta?.name ?? null,
    ticker: meta?.ticker ?? null,
    decimals: meta?.decimals ?? 0,
    supply: meta?.supply ?? "0",
    firstSeenTxid: txid,
  });

  log.info("indexer: recorded asset", {
    assetId: assetId.slice(0, 16) + "…",
    name: meta?.name,
    ticker: meta?.ticker,
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
