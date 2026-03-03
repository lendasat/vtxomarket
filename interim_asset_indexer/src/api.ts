/**
 * Hono HTTP API.
 *
 * Routes:
 *   GET /health               → service health + stats
 *   GET /assets               → all known assets
 *   GET /assets/:id           → single asset metadata
 *   GET /assets/:id/vtxos     → VTXOs holding this asset (?spendable=true for live holders)
 *   GET /assets/:id/holders   → balances grouped by script (spendable only)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import {
  getAllAssets,
  getAsset,
  getVtxosForAsset,
  getHoldersForAsset,
  getStats,
} from "./db";
import { getRecentLogs } from "./log-buffer";

export function buildApp(): Hono {
  const app = new Hono();

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use("*", cors());
  if (config.logLevel === "debug") {
    app.use("*", logger());
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", (c) => {
    const stats = getStats();
    return c.json({
      status: "ok",
      network: config.network,
      arkServerUrl: config.arkServerUrl,
      ...stats,
      uptime: Math.floor(process.uptime()),
    });
  });

  // ── Logs (ring buffer for debug UI) ───────────────────────────────────────
  app.get("/logs", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 200);
    return c.json({ logs: getRecentLogs(limit) });
  });

  // ── Assets list ────────────────────────────────────────────────────────────
  app.get("/assets", (c) => {
    const assets = getAllAssets();
    return c.json({ assets });
  });

  // ── Single asset ───────────────────────────────────────────────────────────
  app.get("/assets/:id", (c) => {
    const asset = getAsset(c.req.param("id"));
    if (!asset) return c.json({ error: "Not found" }, 404);
    return c.json({ asset });
  });

  // ── VTXOs for asset ────────────────────────────────────────────────────────
  app.get("/assets/:id/vtxos", (c) => {
    const assetId = c.req.param("id");
    const asset = getAsset(assetId);
    if (!asset) return c.json({ error: "Asset not found" }, 404);

    const spendableOnly = c.req.query("spendable") === "true";
    const vtxos = getVtxosForAsset(assetId, spendableOnly);

    return c.json({
      assetId,
      spendableOnly,
      count: vtxos.length,
      vtxos: vtxos.map((v) => ({
        outpoint: v.outpoint,
        amount: v.amount,
        script: v.script,
        isSpent: v.isSpent === 1,
        seenInTxid: v.seenInTxid,
        spentInTxid: v.spentInTxid,
      })),
    });
  });

  // ── Holders for asset ──────────────────────────────────────────────────────
  app.get("/assets/:id/holders", (c) => {
    const assetId = c.req.param("id");
    const asset = getAsset(assetId);
    if (!asset) return c.json({ error: "Asset not found" }, 404);

    const holders = getHoldersForAsset(assetId);
    return c.json({
      assetId,
      holderCount: holders.length,
      holders: holders.map((h) => ({
        script: h.script,
        amount: h.totalAmount,
      })),
    });
  });

  return app;
}
