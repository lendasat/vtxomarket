/**
 * SQLite schema and typed query helpers.
 *
 * Schema (3 tables):
 *   assets   — asset metadata (one row per assetId)
 *   vtxos    — every VTXO ever seen holding an asset
 *   processed_txs — txids already indexed (deduplication)
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { log } from "./logger";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AssetRow {
  assetId: string;
  name: string | null;
  ticker: string | null;
  decimals: number;
  supply: string;       // bigint stored as TEXT to avoid JS precision loss
  firstSeenTxid: string;
  updatedAt: number;    // unix seconds
}

export interface VtxoRow {
  outpoint: string;     // "txid:vout"
  assetId: string;
  amount: string;       // bigint stored as TEXT
  script: string;       // hex pubkey/address script
  isSpent: number;      // 0 | 1 — SQLite INTEGER
  seenInTxid: string;
  spentInTxid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertVtxoParams extends Omit<VtxoRow, "isSpent" | "createdAt" | "updatedAt"> {
  isSpent: boolean;
}

export interface HolderRow {
  script: string;
  totalAmount: string;
}

export interface OfferRow {
  offerOutpoint: string;    // PRIMARY KEY: "txid:vout" of the swap VTXO
  assetId: string;
  tokenAmount: string;
  satAmount: string;
  vtxoSatsValue: string;    // sats value of the swap VTXO (dust, e.g. "330")
  makerArkAddress: string;
  makerPkScript: string;
  makerXOnlyPubkey: string;
  swapScriptHex: string;
  arkadeScriptHex: string;  // hex-encoded arkade script (introspection conditions for PSBT field)
  expiresAt: number;
  status: 'open' | 'filled' | 'expired' | 'cancelled';
  filledInTxid: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Singleton DB ───────────────────────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(config.databasePath), { recursive: true });
  _db = new Database(config.databasePath, { create: true });

  // WAL mode for better concurrent reads
  _db.run("PRAGMA journal_mode=WAL");
  _db.run("PRAGMA synchronous=NORMAL");
  _db.run("PRAGMA foreign_keys=ON");

  migrate(_db);
  log.info("Database ready", { path: config.databasePath });
  return _db;
}

// ── Migrations ─────────────────────────────────────────────────────────────────

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS assets (
      assetId       TEXT PRIMARY KEY,
      name          TEXT,
      ticker        TEXT,
      decimals      INTEGER NOT NULL DEFAULT 0,
      supply        TEXT NOT NULL DEFAULT '0',
      firstSeenTxid TEXT NOT NULL,
      updatedAt     INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS vtxos (
      outpoint      TEXT NOT NULL,
      assetId       TEXT NOT NULL REFERENCES assets(assetId),
      amount        TEXT NOT NULL,
      script        TEXT NOT NULL DEFAULT '',
      isSpent       INTEGER NOT NULL DEFAULT 0,
      seenInTxid    TEXT NOT NULL,
      spentInTxid   TEXT,
      createdAt     INTEGER NOT NULL,
      updatedAt     INTEGER NOT NULL,
      PRIMARY KEY (outpoint, assetId)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_vtxos_assetId ON vtxos(assetId)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_vtxos_script ON vtxos(script)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processed_txs (
      txid      TEXT PRIMARY KEY,
      processedAt INTEGER NOT NULL
    )
  `);

  // Migrate offers table: if old schema (has intentId column), drop and recreate
  const offerTableInfo = db.query("PRAGMA table_info(offers)").all() as { name: string }[];
  if (offerTableInfo.length > 0 && offerTableInfo.some((col) => col.name === "intentId")) {
    db.run("DROP TABLE IF EXISTS offers");
    log.info("Database: dropped old offers table (intentId schema), recreating");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS offers (
      offerOutpoint   TEXT PRIMARY KEY,
      assetId         TEXT NOT NULL,
      tokenAmount     TEXT NOT NULL,
      satAmount       TEXT NOT NULL,
      vtxoSatsValue   TEXT NOT NULL DEFAULT '330',
      makerArkAddress TEXT NOT NULL DEFAULT '',
      makerPkScript   TEXT NOT NULL DEFAULT '',
      makerXOnlyPubkey TEXT NOT NULL DEFAULT '',
      swapScriptHex   TEXT NOT NULL DEFAULT '',
      arkadeScriptHex TEXT NOT NULL DEFAULT '',
      expiresAt       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',
      filledInTxid    TEXT,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_asset_status ON offers(assetId, status)`);

  // Add missing columns (migration for existing DBs)
  const offerCols = db.query("PRAGMA table_info(offers)").all() as { name: string }[];
  if (!offerCols.some((col) => col.name === "vtxoSatsValue")) {
    db.run("ALTER TABLE offers ADD COLUMN vtxoSatsValue TEXT NOT NULL DEFAULT '330'");
    log.info("Database: added vtxoSatsValue column to offers table");
  }
  if (!offerCols.some((col) => col.name === "arkadeScriptHex")) {
    db.run("ALTER TABLE offers ADD COLUMN arkadeScriptHex TEXT NOT NULL DEFAULT ''");
    log.info("Database: added arkadeScriptHex column to offers table");
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export function isTxProcessed(txid: string): boolean {
  const db = getDb();
  const row = db.query("SELECT 1 FROM processed_txs WHERE txid = ?").get(txid);
  return row !== null;
}

export function markTxProcessed(txid: string): void {
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO processed_txs (txid, processedAt) VALUES (?, ?)",
    [txid, Math.floor(Date.now() / 1000)]
  );
}

export function upsertAsset(asset: Omit<AssetRow, "updatedAt">): void {
  const db = getDb();
  db.run(
    `INSERT INTO assets (assetId, name, ticker, decimals, supply, firstSeenTxid, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(assetId) DO UPDATE SET
       name = COALESCE(excluded.name, name),
       ticker = COALESCE(excluded.ticker, ticker),
       decimals = excluded.decimals,
       supply = excluded.supply,
       updatedAt = excluded.updatedAt`,
    [
      asset.assetId,
      asset.name,
      asset.ticker,
      asset.decimals,
      asset.supply,
      asset.firstSeenTxid,
      Math.floor(Date.now() / 1000),
    ]
  );
}

export function upsertVtxo(vtxo: UpsertVtxoParams): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO vtxos (outpoint, assetId, amount, script, isSpent, seenInTxid, spentInTxid, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(outpoint, assetId) DO UPDATE SET
       amount = excluded.amount,
       script = excluded.script,
       isSpent = excluded.isSpent,
       spentInTxid = COALESCE(excluded.spentInTxid, spentInTxid),
       updatedAt = excluded.updatedAt`,
    [
      vtxo.outpoint,
      vtxo.assetId,
      vtxo.amount,
      vtxo.script,
      vtxo.isSpent ? 1 : 0,
      vtxo.seenInTxid,
      vtxo.spentInTxid ?? null,
      now,
      now,
    ]
  );
}

/** Mark VTXOs as spent when they appear in spentVtxos of a new arkTx */
export function markVtxosSpent(outpoints: string[], spentInTxid: string): void {
  if (outpoints.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const placeholders = outpoints.map(() => "?").join(", ");
  db.run(
    `UPDATE vtxos SET isSpent = 1, spentInTxid = ?, updatedAt = ?
     WHERE outpoint IN (${placeholders}) AND isSpent = 0`,
    [spentInTxid, now, ...outpoints]
  );
}

export function getAllAssets(): AssetRow[] {
  const db = getDb();
  return db.query("SELECT * FROM assets ORDER BY updatedAt DESC").all() as AssetRow[];
}

export function getAsset(assetId: string): AssetRow | null {
  const db = getDb();
  return db.query("SELECT * FROM assets WHERE assetId = ?").get(assetId) as AssetRow | null;
}

export function getVtxosForAsset(assetId: string, spendableOnly: boolean): VtxoRow[] {
  const db = getDb();
  if (spendableOnly) {
    return db
      .query("SELECT * FROM vtxos WHERE assetId = ? AND isSpent = 0 ORDER BY createdAt DESC")
      .all(assetId) as VtxoRow[];
  }
  return db
    .query("SELECT * FROM vtxos WHERE assetId = ? ORDER BY createdAt DESC")
    .all(assetId) as VtxoRow[];
}

export function getHoldersForAsset(assetId: string): HolderRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT script, CAST(SUM(CAST(amount AS INTEGER)) AS TEXT) AS totalAmount
       FROM vtxos
       WHERE assetId = ? AND isSpent = 0 AND script != ''
       GROUP BY script
       ORDER BY CAST(totalAmount AS INTEGER) DESC`
    )
    .all(assetId) as HolderRow[];
}

export function getStats() {
  const db = getDb();
  const assetCount = (db.query("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
  const vtxoCount = (db.query("SELECT COUNT(*) AS n FROM vtxos").get() as { n: number }).n;
  const txCount = (db.query("SELECT COUNT(*) AS n FROM processed_txs").get() as { n: number }).n;
  return { assetCount, vtxoCount, txCount };
}

// ── Offer query helpers ─────────────────────────────────────────────────────

export function upsertOffer(
  offer: Omit<OfferRow, 'status' | 'filledInTxid' | 'createdAt' | 'updatedAt'>
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO offers (offerOutpoint, assetId, tokenAmount, satAmount, vtxoSatsValue, makerArkAddress, makerPkScript, makerXOnlyPubkey, swapScriptHex, arkadeScriptHex, expiresAt, status, filledInTxid, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
     ON CONFLICT(offerOutpoint) DO UPDATE SET
       tokenAmount = excluded.tokenAmount,
       satAmount = excluded.satAmount,
       vtxoSatsValue = excluded.vtxoSatsValue,
       makerArkAddress = excluded.makerArkAddress,
       makerPkScript = excluded.makerPkScript,
       makerXOnlyPubkey = excluded.makerXOnlyPubkey,
       swapScriptHex = excluded.swapScriptHex,
       arkadeScriptHex = excluded.arkadeScriptHex,
       expiresAt = excluded.expiresAt,
       updatedAt = excluded.updatedAt
     WHERE offers.status = 'open'`,
    [
      offer.offerOutpoint,
      offer.assetId,
      offer.tokenAmount,
      offer.satAmount,
      offer.vtxoSatsValue ?? '330',
      offer.makerArkAddress,
      offer.makerPkScript,
      offer.makerXOnlyPubkey,
      offer.swapScriptHex,
      offer.arkadeScriptHex ?? '',
      offer.expiresAt,
      now,
      now,
    ]
  );
}

/** Look up an offer by its offerOutpoint (the swap VTXO's "txid:vout") */
export function getOffer(offerOutpoint: string): OfferRow | null {
  const db = getDb();
  return db.query("SELECT * FROM offers WHERE offerOutpoint = ?").get(offerOutpoint) as OfferRow | null;
}

export function getOpenOffersForAsset(assetId: string): OfferRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM offers
       WHERE assetId = ? AND status = 'open'
       ORDER BY CAST(satAmount AS REAL) / CAST(tokenAmount AS REAL) ASC`
    )
    .all(assetId) as OfferRow[];
}

export function getAllOpenOffers(): OfferRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM offers
       WHERE status = 'open'
       ORDER BY CAST(satAmount AS REAL) / CAST(tokenAmount AS REAL) ASC`
    )
    .all() as OfferRow[];
}

export function markOfferFilled(offerOutpoint: string, filledInTxid: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    "UPDATE offers SET status = 'filled', filledInTxid = ?, updatedAt = ? WHERE offerOutpoint = ? AND status = 'open'",
    [filledInTxid, now, offerOutpoint]
  );
}

export function markOfferCancelled(offerOutpoint: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    "UPDATE offers SET status = 'cancelled', updatedAt = ? WHERE offerOutpoint = ? AND status = 'open'",
    [now, offerOutpoint]
  );
}

export interface MarketSummaryRow {
  assetId: string;
  openOfferCount: number;
  bestOfferPrice: number | null;   // cheapest satAmount/tokenAmount ratio
  lastFilledPrice: number | null;  // most recent filled offer price
  lastFilledAt: number | null;     // unix timestamp of last fill
}

export function getMarketSummary(): MarketSummaryRow[] {
  const db = getDb();
  // Single query: aggregate open-offer stats + join with the most-recently-filled
  // offer per asset via a correlated subquery to get its price.
  const rows = db
    .query(
      `SELECT
         o.assetId,
         SUM(CASE WHEN o.status = 'open' THEN 1 ELSE 0 END) AS openOfferCount,
         MIN(CASE WHEN o.status = 'open'
             THEN CAST(o.satAmount AS REAL) / CAST(o.tokenAmount AS REAL)
         END) AS bestOfferPrice,
         MAX(CASE WHEN o.status = 'filled' THEN o.updatedAt END) AS lastFilledAt,
         (SELECT CAST(f.satAmount AS REAL) / CAST(f.tokenAmount AS REAL)
          FROM offers f
          WHERE f.assetId = o.assetId AND f.status = 'filled'
          ORDER BY f.updatedAt DESC
          LIMIT 1
         ) AS lastFilledPrice
       FROM offers o
       GROUP BY o.assetId`
    )
    .all() as any[];

  return rows.map((r) => ({
    assetId: r.assetId,
    openOfferCount: r.openOfferCount ?? 0,
    bestOfferPrice: r.bestOfferPrice ?? null,
    lastFilledPrice: r.lastFilledPrice ?? null,
    lastFilledAt: r.lastFilledAt ?? null,
  }));
}

export function expireStaleOffers(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    "UPDATE offers SET status = 'expired', updatedAt = ? WHERE expiresAt < ? AND status = 'open'",
    [now, now]
  );
}
