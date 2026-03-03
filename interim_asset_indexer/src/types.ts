/**
 * Types mirrored from the arkd REST API responses.
 * These are not imported from an SDK — the indexer has no SDK dependency
 * so it stays lean and runtime-agnostic.
 */

/** A single asset holding on a VTXO as returned by GET /v1/indexer/vtxos */
export interface VtxoAsset {
  assetId: string;
  amount: string; // bigint as decimal string
}

/** Full VTXO object returned by the indexer endpoint */
export interface IndexerVtxo {
  outpoint: {
    txid: string;
    vout: number;
  };
  pubkey: string;  // spending pubkey hex
  script: string;  // full output script hex
  amount: string;  // sats as decimal string
  assets?: VtxoAsset[];
  isSpent: boolean;
}

/** Slim outpoint reference as returned inside SSE events */
export interface SpendableVtxoRef {
  outpoint: {
    txid: string;
    vout: number;
  };
}

/** Normalized transaction event — used for both arkTx and commitmentTx */
export interface TxNotification {
  txid: string;
  spentVtxos: Array<{ outpoint: { txid: string; vout: number } }>;
  spendableVtxos: SpendableVtxoRef[];
}

/** Asset metadata from GET /v1/indexer/asset/:id (decoded) */
export interface AssetMetadata {
  assetId: string;
  name?: string;
  ticker?: string;
  decimals?: number;
  supply?: string;        // raw decimal string from the "supply" field
  controlAssetId?: string;
}
