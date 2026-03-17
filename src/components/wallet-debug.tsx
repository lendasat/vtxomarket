"use client";

import { useEffect, useState, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import {
  getRawBalance,
  getVtxoDetails,
  settleVtxos,
  renewVtxos,
  getBalance,
  type WalletBalance,
  type VtxoInfo,
} from "@/lib/ark-wallet";
import { Button } from "@/components/ui/button";

const stateColor = (state?: string) => {
  switch (state) {
    case "settled":
      return "bg-green-500/20 text-green-400";
    case "preconfirmed":
      return "bg-blue-500/20 text-blue-400";
    case "swept":
      return "bg-red-500/20 text-red-400";
    case "spent":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

export function WalletDebug() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const balance = useAppStore((s) => s.balance);
  const setBalance = useAppStore((s) => s.setBalance);

  const [rawBalance, setRawBalance] = useState<WalletBalance | null>(null);
  const [vtxos, setVtxos] = useState<VtxoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [settling, setSettling] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const loadDebugInfo = useCallback(async () => {
    if (!arkWallet) return;
    setLoading(true);
    try {
      const [raw, vtxoList] = await Promise.all([
        getRawBalance(arkWallet),
        getVtxoDetails(arkWallet),
      ]);
      setRawBalance(raw);
      setVtxos(vtxoList);
    } catch (e) {
      console.error("Failed to load debug info:", e);
    } finally {
      setLoading(false);
    }
  }, [arkWallet]);

  useEffect(() => {
    loadDebugInfo();
  }, [loadDebugInfo, balance]);

  const handleSettle = async () => {
    if (!arkWallet) return;
    setSettling(true);
    setActionResult(null);
    setActionError("");
    try {
      const txid = await settleVtxos(arkWallet);
      setActionResult(`Settled! ${txid.slice(0, 20)}...`);
      // Refresh balance
      const bal = await getBalance(arkWallet);
      setBalance(bal);
      await loadDebugInfo();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Settle failed");
    } finally {
      setSettling(false);
    }
  };

  const handleRecover = async () => {
    if (!arkWallet) return;
    setRecovering(true);
    setActionResult(null);
    setActionError("");
    try {
      const txid = await renewVtxos(arkWallet);
      if (txid) {
        setActionResult(`Recovered! ${txid.slice(0, 20)}...`);
      } else {
        setActionResult("Nothing to recover");
      }
      const bal = await getBalance(arkWallet);
      setBalance(bal);
      await loadDebugInfo();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Recovery failed");
    } finally {
      setRecovering(false);
    }
  };

  const hasSettleable = rawBalance && (rawBalance.boarding?.confirmed ?? 0) > 0;
  const hasRecoverable = rawBalance && rawBalance.recoverable > 0;

  return (
    <div className="space-y-4">
      {/* Raw SDK Balance */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Raw SDK Balance
          </p>
          <Button variant="ghost" size="icon-xs" onClick={loadDebugInfo} disabled={loading}>
            <RefreshIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {rawBalance ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
            <span className="text-muted-foreground">total</span>
            <span>{rawBalance.total.toLocaleString()}</span>
            <span className="text-muted-foreground">available</span>
            <span className={rawBalance.available === 0 ? "text-destructive" : "text-green-400"}>
              {rawBalance.available.toLocaleString()}
            </span>
            <span className="text-muted-foreground">settled</span>
            <span>{rawBalance.settled.toLocaleString()}</span>
            <span className="text-muted-foreground">preconfirmed</span>
            <span>{rawBalance.preconfirmed.toLocaleString()}</span>
            <span className="text-muted-foreground">recoverable</span>
            <span className={rawBalance.recoverable > 0 ? "text-yellow-400" : ""}>
              {rawBalance.recoverable.toLocaleString()}
            </span>
            <span className="text-muted-foreground">boarding.total</span>
            <span>{(rawBalance.boarding?.total ?? 0).toLocaleString()}</span>
            <span className="text-muted-foreground">boarding.confirmed</span>
            <span>{(rawBalance.boarding?.confirmed ?? 0).toLocaleString()}</span>
            <span className="text-muted-foreground">boarding.unconfirmed</span>
            <span>{(rawBalance.boarding?.unconfirmed ?? 0).toLocaleString()}</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading...</p>
        )}
      </div>

      {/* Actions */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Actions
        </p>
        <Button
          className="w-full"
          variant={hasSettleable ? "default" : "secondary"}
          disabled={settling || !hasSettleable}
          onClick={handleSettle}
        >
          {settling ? "Settling..." : "Settle Confirmed UTXOs"}
        </Button>
        <Button
          className="w-full"
          variant={hasRecoverable ? "default" : "secondary"}
          disabled={recovering || !hasRecoverable}
          onClick={handleRecover}
        >
          {recovering
            ? "Recovering..."
            : `Recover Sats${hasRecoverable ? ` (${rawBalance!.recoverable.toLocaleString()})` : ""}`}
        </Button>
        {actionResult && <p className="text-xs text-green-400 font-mono">{actionResult}</p>}
        {actionError && <p className="text-xs text-destructive">{actionError}</p>}
      </div>

      {/* UTXOs & VTXOs */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          UTXOs & VTXOs <span className="text-muted-foreground">({vtxos.length})</span>
        </p>
        {vtxos.length === 0 ? (
          <p className="text-xs text-muted-foreground">No coins found</p>
        ) : (
          <div className="space-y-2">
            {vtxos.map((vtxo, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2"
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                      vtxo.type === "boarding"
                        ? "bg-muted text-muted-foreground"
                        : "bg-purple-500/20 text-purple-400"
                    }`}
                  >
                    {vtxo.type}
                  </span>
                  {vtxo.state && (
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${stateColor(vtxo.state)}`}
                    >
                      {vtxo.state}
                    </span>
                  )}
                  {vtxo.type === "boarding" && (
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                        vtxo.confirmed
                          ? "bg-green-500/20 text-green-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {vtxo.confirmed ? "confirmed" : "unconfirmed"}
                    </span>
                  )}
                  {vtxo.batchExpiry && (
                    <span className="text-[10px] text-muted-foreground">
                      exp {new Date(vtxo.batchExpiry).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <span className="text-xs font-mono shrink-0 ml-2">
                  {vtxo.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mapped BalanceInfo */}
      {balance && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Mapped BalanceInfo
          </p>
          <pre className="rounded-lg border bg-muted/30 p-3 font-mono text-xs overflow-x-auto">
            {JSON.stringify(balance, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311V15a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75H8.5a.75.75 0 0 1 0 1.5H7.058l.398.397a4 4 0 0 0 6.693-1.793.75.75 0 0 1 1.163-.57ZM4.688 8.576a5.5 5.5 0 0 1 9.201-2.466l.312.311V5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75H11.5a.75.75 0 0 1 0-1.5h1.442l-.398-.397a4 4 0 0 0-6.693 1.793.75.75 0 0 1-1.163.57Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
