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
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

// ── Simple sliding-window rate limiter ────────────────────────────────────────
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "60", 10); // requests per window

function rateLimiter() {
  return async (c: Context, next: Next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const now = Date.now();
    const timestamps = rateLimitMap.get(ip) || [];
    // Evict old entries
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    recent.push(now);
    rateLimitMap.set(ip, recent);
    // Periodic cleanup of stale IPs (every 1000 requests)
    if (rateLimitMap.size > 10000) {
      for (const [key, ts] of rateLimitMap) {
        if (ts.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitMap.delete(key);
      }
    }
    await next();
  };
}
import { config } from "./config";
import {
  getAllAssets,
  getAsset,
  getVtxosForAsset,
  getHoldersForAsset,
  getStats,
  upsertOffer,
  upsertAsset,
  upsertAssetMetadata,
  getOffer,
  getOpenOffersForAsset,
  getAllOpenOffers,
  markOfferCancelled,
  getMarketSummary,
  getTradesForAsset,
  getRecentTrades,
} from "./db";
import { fetchVtxosByOutpoints, fetchAssetMetadata } from "./ark-client";
import { getRecentLogs } from "./log-buffer";

/** Verify a BIP-340 Schnorr signature. Returns true if valid. */
function verifySchnorrSig(signatureHex: string, message: Uint8Array, pubkeyHex: string): boolean {
  const sigBytes = Uint8Array.from(Buffer.from(signatureHex, "hex"));
  const pubkeyBytes = Uint8Array.from(Buffer.from(pubkeyHex, "hex"));
  return schnorr.verify(sigBytes, message, pubkeyBytes);
}

export function buildApp(): Hono {
  const app = new Hono();

  // ── Middleware ─────────────────────────────────────────────────────────────
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((s) => s.trim());

  function isAllowedOrigin(origin: string): boolean {
    return allowedOrigins.some((allowed) =>
      allowed.startsWith("*.")
        ? origin.endsWith(allowed.slice(1)) || origin === `https://${allowed.slice(2)}`
        : allowed === origin
    );
  }

  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : allowedOrigins[0]),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );
  app.use("*", rateLimiter());
  if (config.logLevel === "debug") {
    app.use("*", logger());
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", (c) => {
    const stats = getStats();
    return c.json({
      status: "ok",
      version: process.env.INDEXER_VERSION || "dev",
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

  // ── Discover unknown asset (fetch metadata from Ark server on demand) ──────
  app.post("/assets/:id/discover", async (c) => {
    const assetId = c.req.param("id");
    const existing = getAsset(assetId);
    if (existing && (existing.name || existing.ticker)) {
      return c.json({ asset: existing });
    }

    const meta = await fetchAssetMetadata(assetId);
    if (!meta) return c.json({ error: "Asset not found on Ark server" }, 404);

    upsertAsset({
      assetId,
      name: meta.name ?? null,
      ticker: meta.ticker ?? null,
      decimals: meta.decimals ?? 0,
      supply: meta.supply ?? "0",
      firstSeenTxid: "discovered",
    });
    if (meta.icon) {
      upsertAssetMetadata(assetId, { image: meta.icon });
    }

    const asset = getAsset(assetId);
    return c.json({ asset });
  });

  // ── Update asset metadata (creator submits after issuance) ─────────────────
  // Requires a Schnorr signature proving the caller owns the creator private key.
  // First write sets the creator identity; subsequent writes must match it.
  // Supply and createdAt are immutable after first set to prevent tampering.
  app.put("/assets/:id/metadata", async (c) => {
    const assetId = c.req.param("id");
    const asset = getAsset(assetId);
    if (!asset) return c.json({ error: "Asset not found — it may not have been indexed yet" }, 404);

    const body = await c.req.json();
    const {
      description,
      image,
      creator,
      creatorArkAddress,
      controlAssetId,
      website,
      twitter,
      telegram,
      supply,
      createdAt,
      signature,
    } = body;

    // If a creator is already set, only that same creator can update metadata
    if (asset.creator && creator && asset.creator !== creator) {
      return c.json({ error: "Unauthorized: creator pubkey does not match" }, 403);
    }
    if (asset.creator && !creator) {
      return c.json({ error: "Unauthorized: must provide creator pubkey" }, 403);
    }

    // Require Schnorr signature proving the caller owns the creator key
    const creatorPubkey = creator || asset.creator;
    if (!creatorPubkey) {
      return c.json({ error: "missing creator pubkey" }, 400);
    }
    if (!signature) {
      return c.json(
        { error: "missing signature — sign sha256('metadata:{assetId}') with creator key" },
        400
      );
    }
    try {
      const message = sha256(new TextEncoder().encode(`metadata:${assetId}`));
      if (!verifySchnorrSig(signature, message, creatorPubkey)) {
        return c.json({ error: "unauthorized: invalid signature" }, 403);
      }
    } catch {
      return c.json({ error: "unauthorized: malformed signature" }, 403);
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
  // Requires Schnorr signature proving the caller owns the maker private key.
  // Verified against arkd: the VTXO must exist, be unspent, and hold the claimed asset.
  // offerType: "sell" (default) = maker locks tokens, "buy" = maker locks sats
  app.post("/offers", async (c) => {
    const body = await c.req.json();
    const {
      offerOutpoint,
      assetId,
      tokenAmount,
      satAmount,
      vtxoSatsValue,
      makerArkAddress,
      makerPkScript,
      makerXOnlyPubkey,
      swapScriptHex,
      arkadeScriptHex,
      expiresAt,
      signature,
    } = body;
    const offerType = body.offerType ?? "sell";
    if (
      !offerOutpoint ||
      !assetId ||
      !tokenAmount ||
      !satAmount ||
      !makerArkAddress ||
      !makerPkScript ||
      !makerXOnlyPubkey ||
      !swapScriptHex ||
      !expiresAt
    ) {
      return c.json({ error: "missing required fields" }, 400);
    }

    // Verify Schnorr signature proving the caller owns the maker key
    if (!signature) {
      return c.json(
        { error: "missing signature — sign sha256('offer:{offerOutpoint}') with maker key" },
        400
      );
    }
    try {
      const message = sha256(new TextEncoder().encode(`offer:${offerOutpoint}`));
      if (!verifySchnorrSig(signature, message, makerXOnlyPubkey)) {
        return c.json({ error: "unauthorized: invalid signature" }, 403);
      }
    } catch {
      return c.json({ error: "unauthorized: malformed signature" }, 403);
    }
    if (offerType !== "sell" && offerType !== "buy") {
      return c.json({ error: "offerType must be 'sell' or 'buy'" }, 400);
    }

    // Reject re-registration of offers that are already filled/cancelled/expired
    const existing = getOffer(offerOutpoint);
    if (existing && existing.status !== "open") {
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

    if (offerType === "sell") {
      // Sell offer: verify VTXO holds the claimed asset
      const matchingAsset = vtxo.assets?.find((a) => a.assetId === assetId);
      if (!matchingAsset) {
        return c.json({ error: "VTXO does not hold the claimed asset" }, 400);
      }
      if (BigInt(matchingAsset.amount) < BigInt(tokenAmount)) {
        return c.json(
          {
            error: `VTXO holds ${matchingAsset.amount} tokens, but offer claims ${tokenAmount}`,
          },
          400
        );
      }
    } else {
      // Buy offer: verify VTXO holds sufficient sats
      const vtxoSats = Number(vtxo.amount);
      if (vtxoSats < Number(satAmount)) {
        return c.json(
          {
            error: `VTXO holds ${vtxoSats} sats, but offer claims ${satAmount}`,
          },
          400
        );
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

    upsertOffer({
      offerOutpoint,
      assetId,
      tokenAmount,
      satAmount,
      vtxoSatsValue: vtxoSatsValue ?? "330",
      makerArkAddress,
      makerPkScript,
      makerXOnlyPubkey,
      swapScriptHex,
      arkadeScriptHex: arkadeScriptHex ?? "",
      offerType,
      expiresAt,
    });
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

  // Maker cancels their offer — requires Schnorr signature to prove key ownership.
  // The maker must sign sha256("cancel:{outpoint}") with their x-only private key.
  app.delete("/offers/:outpoint", async (c) => {
    const outpoint = c.req.param("outpoint");
    const offer = getOffer(outpoint);
    if (!offer) {
      return c.json({ error: "offer not found" }, 404);
    }
    if (offer.status !== "open") {
      return c.json({ error: `offer already ${offer.status}` }, 409);
    }

    // Require a Schnorr signature proving the caller owns the maker's private key.
    let signature: string | undefined;
    try {
      const body = await c.req.json();
      signature = body?.signature;
    } catch {
      // No JSON body — check query param
    }
    if (!signature) {
      signature = c.req.query("signature");
    }
    if (!signature) {
      return c.json(
        { error: "missing signature — sign sha256('cancel:{outpoint}') with maker key" },
        400
      );
    }

    // Verify the Schnorr signature against the stored maker pubkey
    try {
      const message = sha256(new TextEncoder().encode(`cancel:${outpoint}`));
      const sigBytes = Uint8Array.from(Buffer.from(signature, "hex"));
      const pubkeyBytes = Uint8Array.from(Buffer.from(offer.makerXOnlyPubkey, "hex"));
      const valid = schnorr.verify(sigBytes, message, pubkeyBytes);
      if (!valid) {
        return c.json({ error: "unauthorized: invalid signature" }, 403);
      }
    } catch {
      return c.json({ error: "unauthorized: malformed signature" }, 403);
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

      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
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
      return c.json({
        logs: [],
        error: "Could not read introspector logs (docker not available?)",
      });
    }
  });

  return app;
}
