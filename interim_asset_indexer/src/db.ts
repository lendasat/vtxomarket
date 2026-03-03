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
