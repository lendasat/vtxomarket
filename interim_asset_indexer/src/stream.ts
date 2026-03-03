/**
 * SSE consumer for arkd's GET /v1/txs stream.
 *
 * The stream emits newline-delimited JSON. Each line that starts with "data:"
 * contains a TxNotification. The stream reconnects automatically on disconnect.
 */

import { config } from "./config";
import { log } from "./logger";
import type { TxNotification } from "./types";

/** Called once for each transaction event (arkTx or commitmentTx) */
export type TxHandler = (notification: TxNotification) => Promise<void> | void;

interface StreamState {
  running: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const state: StreamState = {
  running: false,
  reconnectTimer: null,
};

/** Start consuming the SSE stream. Call once at startup. */
export function startStream(onTx: TxHandler): void {
  if (state.running) {
    log.warn("stream.startStream called while already running — ignoring");
    return;
  }
  state.running = true;
  connectStream(onTx);
}

/** Gracefully stop the stream (e.g. on shutdown). */
export function stopStream(): void {
  state.running = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  log.info("SSE stream stopped");
}

async function connectStream(onTx: TxHandler): Promise<void> {
  const url = `${config.arkServerUrl}/v1/txs`;
  log.info("SSE stream connecting", { url });

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      // No timeout — this is a long-lived SSE connection
    });

    if (!res.ok || !res.body) {
      log.error("SSE stream: bad response", { status: res.status });
      scheduleReconnect(onTx);
      return;
    }

    log.info("SSE stream connected");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (state.running) {
      const { done, value } = await reader.read();

      if (done) {
        log.warn("SSE stream: server closed connection");
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line || line.startsWith(":")) continue; // keepalive / comment

        const data = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!data) continue;

        processEvent(data, onTx);
      }
    }

    reader.cancel().catch(() => {});
  } catch (err) {
    if (state.running) {
      log.error("SSE stream: connection error", { error: String(err) });
    }
  }

  if (state.running) {
    scheduleReconnect(onTx);
  }
}

function scheduleReconnect(onTx: TxHandler): void {
  log.info("SSE stream: reconnecting", { delayMs: config.sseReconnectDelayMs });
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.running) {
      connectStream(onTx);
    }
  }, config.sseReconnectDelayMs);
}

function processEvent(data: string, onTx: TxHandler): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    log.debug("SSE stream: non-JSON line", { data: data.slice(0, 100) });
    return;
  }

  // The stream emits: { arkTx }, { commitmentTx }, { heartbeat }
  // We normalise both tx types into the same TxNotification shape.
  const envelope = parsed as Record<string, unknown>;

  const rawTx = (envelope.arkTx ?? envelope.commitmentTx) as Record<string, unknown> | undefined;
  if (!rawTx) {
    // heartbeat or unknown — silently skip
    log.debug("SSE stream: skipping non-tx event");
    return;
  }

  if (typeof rawTx.txid !== "string") {
    log.warn("SSE stream: tx event missing txid");
    return;
  }

  const eventType = envelope.arkTx ? "arkTx" : "commitmentTx";
  const txNotification: TxNotification = {
    txid: rawTx.txid as string,
    spentVtxos: (rawTx.spentVtxos as Array<{ outpoint: { txid: string; vout: number } }>) ?? [],
    spendableVtxos: (rawTx.spendableVtxos as Array<{ outpoint: { txid: string; vout: number } }>) ?? [],
  };

  log.debug("SSE stream: new tx", {
    type: eventType,
    txid: txNotification.txid,
    spent: txNotification.spentVtxos.length,
    spendable: txNotification.spendableVtxos.length,
  });

  // Fire and forget — errors are caught inside onTx
  Promise.resolve(onTx(txNotification)).catch((err) => {
    log.error("SSE stream: onTx handler threw", { error: String(err) });
  });
}
