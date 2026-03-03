"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const INDEXER = "http://localhost:3001";
const POLL_MS = 2000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Health {
  status: string;
  network: string;
  arkServerUrl: string;
  assetCount: number;
  vtxoCount: number;
  txCount: number;
  uptime: number;
}

interface Asset {
  assetId: string;
  name: string | null;
  ticker: string | null;
  decimals: number;
  supply: string;
  firstSeenTxid: string;
  updatedAt: number;
}

interface Vtxo {
  outpoint: string;
  amount: string;
  script: string;
  isSpent: boolean;
  seenInTxid: string;
  spentInTxid: string | null;
}

interface LogEntry {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortId(id: string) {
  return id ? `${id.slice(0, 8)}…${id.slice(-6)}` : "—";
}

function elapsed(secs: number) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

const LEVEL_STYLE: Record<LogEntry["level"], string> = {
  debug: "text-zinc-500",
  info:  "text-blue-400",
  warn:  "text-yellow-400",
  error: "text-red-400",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function DevPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [vtxos, setVtxos] = useState<Vtxo[]>([]);
  const [vtxosLoading, setVtxosLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<LogEntry["level"] | "all">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [spendableOnly, setSpendableOnly] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ── Polling ─────────────────────────────────────────────────────────────────

  const poll = useCallback(async () => {
    try {
      const [h, a, l] = await Promise.all([
        fetch(`${INDEXER}/health`).then((r) => r.json()),
        fetch(`${INDEXER}/assets`).then((r) => r.json()),
        fetch(`${INDEXER}/logs?limit=200`).then((r) => r.json()),
      ]);
      setHealth(h);
      setHealthErr(false);
      setAssets(a.assets ?? []);
      setLogs(l.logs ?? []);
    } catch {
      setHealthErr(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // ── Auto-scroll logs ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, autoScroll]);

  // ── Load VTXOs when asset selected ──────────────────────────────────────────

  useEffect(() => {
    if (!selectedAsset) { setVtxos([]); return; }
    setVtxosLoading(true);
    const url = `${INDEXER}/assets/${selectedAsset}/vtxos${spendableOnly ? "?spendable=true" : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => { setVtxos(d.vtxos ?? []); setVtxosLoading(false); })
      .catch(() => setVtxosLoading(false));
  }, [selectedAsset, spendableOnly]);

  // ── Filtered logs ────────────────────────────────────────────────────────────

  const filteredLogs = logFilter === "all" ? logs : logs.filter((l) => l.level === logFilter);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono text-sm p-4 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">Indexer Debug</h1>
          <p className="text-zinc-500 text-xs">interim_asset_indexer · polls every {POLL_MS / 1000}s</p>
        </div>
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${healthErr ? "bg-red-900 text-red-300" : "bg-green-900 text-green-300"}`}>
          {healthErr ? "OFFLINE" : "ONLINE"}
        </span>
      </div>

      {/* Health stats */}
      {health && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "Network",   value: health.network },
            { label: "Assets",    value: health.assetCount },
            { label: "VTXOs",     value: health.vtxoCount },
            { label: "Txs seen",  value: health.txCount },
            { label: "Uptime",    value: elapsed(health.uptime) },
            { label: "ARK server", value: new URL(health.arkServerUrl).hostname },
          ].map(({ label, value }) => (
            <div key={label} className="bg-zinc-900 border border-zinc-800 rounded p-2">
              <div className="text-zinc-500 text-xs">{label}</div>
              <div className="text-white font-bold truncate">{String(value)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Left: Assets + VTXOs */}
        <div className="space-y-4">

          {/* Assets table */}
          <div className="bg-zinc-900 border border-zinc-800 rounded">
            <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-bold text-white">Assets ({assets.length})</span>
              <span className="text-zinc-500 text-xs">click to inspect</span>
            </div>
            {assets.length === 0 ? (
              <div className="px-3 py-6 text-center text-zinc-600">
                No assets indexed yet. Issue a token on mutinynet to see it appear here.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800">
                      <th className="px-3 py-1.5 text-left">Ticker</th>
                      <th className="px-3 py-1.5 text-left">Name</th>
                      <th className="px-3 py-1.5 text-left">Supply</th>
                      <th className="px-3 py-1.5 text-left">Asset ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr
                        key={a.assetId}
                        onClick={() => setSelectedAsset(a.assetId === selectedAsset ? null : a.assetId)}
                        className={`cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-800 transition-colors ${
                          selectedAsset === a.assetId ? "bg-zinc-800 border-l-2 border-l-blue-500" : ""
                        }`}
                      >
                        <td className="px-3 py-1.5 text-blue-400 font-bold">{a.ticker ?? "—"}</td>
                        <td className="px-3 py-1.5 text-white">{a.name ?? "—"}</td>
                        <td className="px-3 py-1.5 text-zinc-300">{Number(a.supply).toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-zinc-500" title={a.assetId}>{shortId(a.assetId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* VTXOs panel */}
          {selectedAsset && (
            <div className="bg-zinc-900 border border-zinc-800 rounded">
              <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-3">
                <span className="font-bold text-white">VTXOs</span>
                <span className="text-zinc-500 text-xs" title={selectedAsset}>{shortId(selectedAsset)}</span>
                <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={spendableOnly}
                    onChange={(e) => setSpendableOnly(e.target.checked)}
                    className="accent-blue-500"
                  />
                  Spendable only
                </label>
              </div>
              {vtxosLoading ? (
                <div className="px-3 py-4 text-zinc-500 text-xs">Loading…</div>
              ) : vtxos.length === 0 ? (
                <div className="px-3 py-4 text-zinc-600 text-xs">No VTXOs found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="px-3 py-1.5 text-left">Outpoint</th>
                        <th className="px-3 py-1.5 text-left">Amount</th>
                        <th className="px-3 py-1.5 text-left">Status</th>
                        <th className="px-3 py-1.5 text-left">Seen in tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vtxos.map((v) => (
                        <tr key={v.outpoint} className="border-b border-zinc-800/50 hover:bg-zinc-800">
                          <td className="px-3 py-1.5 text-zinc-400 font-mono" title={v.outpoint}>{shortId(v.outpoint)}</td>
                          <td className="px-3 py-1.5 text-white">{Number(v.amount).toLocaleString()}</td>
                          <td className="px-3 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${v.isSpent ? "bg-zinc-700 text-zinc-400" : "bg-green-900 text-green-300"}`}>
                              {v.isSpent ? "spent" : "live"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-zinc-500" title={v.seenInTxid}>{shortId(v.seenInTxid)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Log stream */}
        <div className="bg-zinc-900 border border-zinc-800 rounded flex flex-col" style={{ minHeight: "500px", maxHeight: "70vh" }}>
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 flex-shrink-0">
            <span className="font-bold text-white">Logs</span>
            <span className="text-zinc-500 text-xs">({filteredLogs.length})</span>

            {/* Level filter */}
            <div className="ml-auto flex items-center gap-1">
              {(["all", "debug", "info", "warn", "error"] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setLogFilter(lvl)}
                  className={`px-1.5 py-0.5 rounded text-xs transition-colors ${
                    logFilter === lvl ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            {/* Auto-scroll toggle */}
            <label className="flex items-center gap-1 text-xs text-zinc-500 cursor-pointer ml-2">
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-blue-500" />
              scroll
            </label>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-zinc-600 text-xs p-2">No log entries yet.</div>
            ) : (
              filteredLogs.map((entry, i) => (
                <div key={i} className="flex gap-2 text-xs leading-5 hover:bg-zinc-800/50 rounded px-1">
                  <span className="text-zinc-600 flex-shrink-0 tabular-nums">
                    {entry.ts.slice(11, 19)}
                  </span>
                  <span className={`flex-shrink-0 w-10 font-bold uppercase ${LEVEL_STYLE[entry.level]}`}>
                    {entry.level.slice(0, 4)}
                  </span>
                  <span className="text-zinc-300 break-all">{entry.msg}</span>
                  {entry.meta && Object.keys(entry.meta).length > 0 && (
                    <span className="text-zinc-600 break-all ml-1">
                      {JSON.stringify(entry.meta)}
                    </span>
                  )}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Raw JSON inspector */}
      {selectedAsset && (
        <details className="bg-zinc-900 border border-zinc-800 rounded">
          <summary className="px-3 py-2 cursor-pointer text-zinc-500 text-xs hover:text-zinc-300">
            Raw JSON — {selectedAsset}
          </summary>
          <pre className="px-3 pb-3 text-xs text-zinc-400 overflow-x-auto">
            {JSON.stringify(assets.find((a) => a.assetId === selectedAsset), null, 2)}
          </pre>
        </details>
      )}

    </div>
  );
}
