/**
 * Entry point — wires together DB, SSE stream, and HTTP server.
 */

import { config } from "./config";
import { log, setLogLevel } from "./logger";
import { getDb, expireStaleOffers } from "./db";
import { startStream, stopStream } from "./stream";
import { handleTxNotification } from "./indexer";
import { buildApp } from "./api";

// Apply log level before anything else
setLogLevel(config.logLevel);

log.info("Starting interim-asset-indexer", {
  network: config.network,
  arkServerUrl: config.arkServerUrl,
  port: config.port,
  db: config.databasePath,
});

// ── Initialize DB ─────────────────────────────────────────────────────────────
getDb(); // ensures schema is created
setInterval(expireStaleOffers, 60_000); // sweep expired offers every minute

// ── Start SSE stream ──────────────────────────────────────────────────────────
startStream(handleTxNotification);

// ── Start HTTP server ─────────────────────────────────────────────────────────
const app = buildApp();

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

log.info(`HTTP server listening on port ${server.port}`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  log.info("Shutting down…");
  stopStream();
  server.stop();
  process.exit(0);
}
