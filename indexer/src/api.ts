/**
 * Hono HTTP API.
 *
 * Routes:
 *   GET /health               → service health + stats
 *   GET /assets               → all known assets
 *   GET /assets/:id           → single asset metadata
 *   GET /assets/:id/vtxos     → VTXOs holding this asset (?spendable=true for live holders)
 *   GET /assets/:id/holders   → balances grouped by script (spendable only)
 *   GET /market-summary        → per-asset market stats (open offer count, best price, last fill)
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
  upsertAssetMetadata,
  getOffer,
  getOpenOffersForAsset,
  getAllOpenOffers,
  markOfferCancelled,
  getMarketSummary,
  getTradesForAsset,
  getRecentTrades,
} from "./db";
import { fetchVtxosByOutpoints } from "./ark-client";
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

  // ── Update asset metadata (creator submits after issuance) ─────────────────
  // First write sets the creator identity; subsequent writes must match it.
  // Supply and createdAt are immutable after first set to prevent tampering.
  app.put("/assets/:id/metadata", async (c) => {
    const assetId = c.req.param("id");
    const asset = getAsset(assetId);
    if (!asset) return c.json({ error: "Asset not found — it may not have been indexed yet" }, 404);

    const body = await c.req.json();
    const { description, image, creator, creatorArkAddress, controlAssetId, website, twitter, telegram, supply, createdAt } = body;

    // If a creator is already set, only that same creator can update metadata
    if (asset.creator && creator && asset.creator !== creator) {
      return c.json({ error: "Unauthorized: creator pubkey does not match" }, 403);
    }
    if (asset.creator && !creator) {
      return c.json({ error: "Unauthorized: must provide creator pubkey" }, 403);
    }

    upsertAssetMetadata(assetId, {
      description,
      image,
      creator,
      creatorArkAddress,
      controlAssetId,
      website,
      twitter,
      telegram,
      // Only set supply/createdAt on first write (immutable after)
      supply: asset.supply === "0" || !asset.supply ? supply : undefined,
      createdAt: !asset.createdAt ? createdAt : undefined,
    });

    return c.json({ ok: true });
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

  // ── Market summary ───────────────────────────────────────────────────────
  app.get("/market-summary", (c) => {
    const summary = getMarketSummary();
    return c.json({ summary });
  });

  // ── Trades (filled offers) ─────────────────────────────────────────────
  app.get("/assets/:id/trades", (c) => {
    const assetId = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
    const trades = getTradesForAsset(assetId, limit);
    return c.json({
      assetId,
      count: trades.length,
      trades: trades.map((t) => ({
        offerOutpoint: t.offerOutpoint,
        offerType: t.offerType,
        tokenAmount: t.tokenAmount,
        satAmount: t.satAmount,
        price: Number(t.satAmount) / Number(t.tokenAmount),
        makerArkAddress: t.makerArkAddress,
        filledInTxid: t.filledInTxid,
        timestamp: t.filledAt,
      })),
    });
  });

  app.get("/trades", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const trades = getRecentTrades(limit);
    return c.json({
      count: trades.length,
      trades: trades.map((t) => ({
        offerOutpoint: t.offerOutpoint,
        assetId: t.assetId,
        offerType: t.offerType,
        tokenAmount: t.tokenAmount,
        satAmount: t.satAmount,
        price: Number(t.satAmount) / Number(t.tokenAmount),
        makerArkAddress: t.makerArkAddress,
        filledInTxid: t.filledInTxid,
        timestamp: t.filledAt,
      })),
    });
  });

  // ── Offers ─────────────────────────────────────────────────────────────────

  // Maker self-reports after creating the swap VTXO.
  // Verified against arkd: the VTXO must exist, be unspent, and hold the claimed asset.
  // offerType: "sell" (default) = maker locks tokens, "buy" = maker locks sats
  app.post("/offers", async (c) => {
    const body = await c.req.json();
    const { offerOutpoint, assetId, tokenAmount, satAmount, vtxoSatsValue, makerArkAddress, makerPkScript, makerXOnlyPubkey, swapScriptHex, arkadeScriptHex, expiresAt } = body;
    const offerType = body.offerType ?? 'sell';
    if (!offerOutpoint || !assetId || !tokenAmount || !satAmount || !makerArkAddress || !makerPkScript || !makerXOnlyPubkey || !swapScriptHex || !expiresAt) {
      return c.json({ error: "missing required fields" }, 400);
    }
    if (offerType !== 'sell' && offerType !== 'buy') {
      return c.json({ error: "offerType must be 'sell' or 'buy'" }, 400);
    }

    // Reject re-registration of offers that are already filled/cancelled/expired
    const existing = getOffer(offerOutpoint);
    if (existing && existing.status !== 'open') {
      return c.json({ error: `offer already ${existing.status}` }, 409);
    }

    // Verify the VTXO actually exists on the Ark server
    const vtxos = await fetchVtxosByOutpoints([offerOutpoint]);
    if (vtxos.length === 0) {
      return c.json({ error: "VTXO not found on Ark server" }, 400);
    }
    const vtxo = vtxos[0];
    if (vtxo.isSpent) {
      return c.json({ error: "VTXO is already spent" }, 400);
    }

    if (offerType === 'sell') {
      // Sell offer: verify VTXO holds the claimed asset
      const matchingAsset = vtxo.assets?.find((a) => a.assetId === assetId);
      if (!matchingAsset) {
        return c.json({ error: "VTXO does not hold the claimed asset" }, 400);
      }
      if (BigInt(matchingAsset.amount) < BigInt(tokenAmount)) {
        return c.json({
          error: `VTXO holds ${matchingAsset.amount} tokens, but offer claims ${tokenAmount}`,
        }, 400);
      }
    } else {
      // Buy offer: verify VTXO holds sufficient sats
      const vtxoSats = Number(vtxo.amount);
      if (vtxoSats < Number(satAmount)) {
        return c.json({
          error: `VTXO holds ${vtxoSats} sats, but offer claims ${satAmount}`,
        }, 400);
      }
    }

    // Validate expiresAt is within a reasonable range (max 30 days from now)
    const now = Math.floor(Date.now() / 1000);
    const maxExpiry = now + 30 * 24 * 60 * 60;
    if (expiresAt > maxExpiry) {
      return c.json({ error: "expiresAt too far in the future (max 30 days)" }, 400);
    }
    if (expiresAt < now) {
      return c.json({ error: "expiresAt is in the past" }, 400);
    }

    upsertOffer({ offerOutpoint, assetId, tokenAmount, satAmount, vtxoSatsValue: vtxoSatsValue ?? '330', makerArkAddress, makerPkScript, makerXOnlyPubkey, swapScriptHex, arkadeScriptHex: arkadeScriptHex ?? '', offerType, expiresAt });
    return c.json({ ok: true }, 201);
  });

  // List open offers (optional ?assetId= and ?offerType= filters)
  app.get("/offers", (c) => {
    const assetId = c.req.query("assetId");
    const offerType = c.req.query("offerType");
    const offers = assetId
      ? getOpenOffersForAsset(assetId, offerType)
      : getAllOpenOffers(offerType);
    return c.json({ count: offers.length, offers });
  });

  // Single offer (outpoint URL-encoded: %3A for the colon)
  app.get("/offers/:outpoint", (c) => {
    const offer = getOffer(c.req.param("outpoint"));
    if (!offer) return c.json({ error: "not found" }, 404);
    return c.json({ offer });
  });

  // Maker cancels their offer — requires maker's pubkey to prevent unauthorized cancellation
  app.delete("/offers/:outpoint", async (c) => {
    const outpoint = c.req.param("outpoint");
    const offer = getOffer(outpoint);
    if (!offer) {
      return c.json({ error: "offer not found" }, 404);
    }
    if (offer.status !== 'open') {
      return c.json({ error: `offer already ${offer.status}` }, 409);
    }

    // Require the maker's pubkey as proof of ownership.
    // Accept from query param (for simple DELETE) or JSON body.
    let makerPubkey: string | undefined;
    try {
      const body = await c.req.json();
      makerPubkey = body?.makerXOnlyPubkey;
    } catch {
      // No JSON body — check query param
    }
    if (!makerPubkey) {
      makerPubkey = c.req.query("makerXOnlyPubkey");
    }
    if (!makerPubkey || makerPubkey !== offer.makerXOnlyPubkey) {
      return c.json({ error: "unauthorized: makerXOnlyPubkey does not match" }, 403);
    }

    markOfferCancelled(outpoint);
    return c.body(null, 204);
  });

  // ── Introspector logs proxy ──────────────────────────────────────────────────
  // Reads Docker container logs for the introspector service and returns parsed entries.

  app.get("/introspector/logs", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10), 500);
    try {
      const proc = Bun.spawn(
        ["docker", "logs", "introspector", "--tail", String(limit), "--timestamps"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Docker sends logs to stderr for container stderr output
      const raw = (stdout + "\n" + stderr).trim();
      if (!raw) return c.json({ logs: [] });

      const entries = raw.split("\n").filter(Boolean).map((line) => {
        // Docker --timestamps prepends: "2026-03-04T09:44:09.123456789Z "
        // Logrus format: time="..." level=info msg="..." key=val
        const timeMatch = line.match(/time="([^"]+)"/);
        const levelMatch = line.match(/level=(\w+)/);
        const msgMatch = line.match(/msg="([^"]+)"/);
        const ts = timeMatch?.[1] ?? line.slice(0, 30);
        const level = levelMatch?.[1] ?? "info";
        const msg = msgMatch?.[1] ?? line;
        // Collect remaining key=val pairs as meta
        const meta: Record<string, string> = {};
        const kvRegex = /(\w+)=(?:"([^"]*)"|(\S+))/g;
        let m;
        while ((m = kvRegex.exec(line)) !== null) {
          const key = m[1];
          if (key === "time" || key === "level" || key === "msg") continue;
          meta[key] = m[2] ?? m[3];
        }
        return { ts, level, msg, meta: Object.keys(meta).length > 0 ? meta : undefined };
      });
      return c.json({ logs: entries });
    } catch {
      return c.json({ logs: [], error: "Could not read introspector logs (docker not available?)" });
    }
  });

  return app;
}
