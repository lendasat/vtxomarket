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
  upsertOffer,
  getOffer,
  getOpenOffersForAsset,
  getAllOpenOffers,
  markOfferCancelled,
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

  // ── Offers ─────────────────────────────────────────────────────────────────

  // Maker self-reports after creating the swap VTXO
  app.post("/offers", async (c) => {
    const body = await c.req.json();
    const { offerOutpoint, assetId, tokenAmount, satAmount, vtxoSatsValue, makerArkAddress, makerPkScript, makerXOnlyPubkey, swapScriptHex, arkadeScriptHex, expiresAt } = body;
    if (!offerOutpoint || !assetId || !tokenAmount || !satAmount || !makerArkAddress || !makerPkScript || !makerXOnlyPubkey || !swapScriptHex || !expiresAt) {
      return c.json({ error: "missing required fields" }, 400);
    }
    upsertOffer({ offerOutpoint, assetId, tokenAmount, satAmount, vtxoSatsValue: vtxoSatsValue ?? '330', makerArkAddress, makerPkScript, makerXOnlyPubkey, swapScriptHex, arkadeScriptHex: arkadeScriptHex ?? '', expiresAt });
    return c.json({ ok: true }, 201);
  });

  // List open offers (optional ?assetId= filter)
  app.get("/offers", (c) => {
    const assetId = c.req.query("assetId");
    const offers = assetId ? getOpenOffersForAsset(assetId) : getAllOpenOffers();
    return c.json({ count: offers.length, offers });
  });

  // Single offer (outpoint URL-encoded: %3A for the colon)
  app.get("/offers/:outpoint", (c) => {
    const offer = getOffer(c.req.param("outpoint"));
    if (!offer) return c.json({ error: "not found" }, 404);
    return c.json({ offer });
  });

  // Maker cancels their offer
  app.delete("/offers/:outpoint", (c) => {
    markOfferCancelled(c.req.param("outpoint"));
    return c.body(null, 204);
  });

  return app;
}
