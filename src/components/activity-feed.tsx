"use client";

import Link from "next/link";
import { useGlobalTrades } from "@/hooks/useGlobalTrades";
import { useAppStore } from "@/lib/store";
import { formatTokenAmount, formatSats } from "@/lib/format";

function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function ActivityFeed() {
  const { trades, loading } = useGlobalTrades();
  const tokens = useAppStore((s) => s.tokens);

  const visible = trades.slice(0, 8);

  if (loading && visible.length === 0) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground/40 font-medium">
          Recent Trades
        </h2>
        <div className="rounded-xl bg-white/[0.04] border border-white/[0.07] p-3 space-y-2 animate-pulse">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-3 w-10 rounded bg-white/[0.06]" />
              <div className="h-3 w-16 rounded bg-white/[0.04]" />
              <div className="h-3 w-8 rounded bg-white/[0.04] ml-auto" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!loading && visible.length === 0) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground/40 font-medium">
          Recent Trades
        </h2>
        <div className="rounded-xl bg-white/[0.04] border border-white/[0.07] p-4 text-center">
          <p className="text-xs text-muted-foreground/40">No recent trades</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground/40 font-medium">
        Recent Trades
      </h2>
      <div className="rounded-xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden divide-y divide-white/[0.05]">
        {visible.map((trade, i) => {
          const tokenMeta = tokens.find((t) => t.assetId === trade.assetId);
          const decimals = tokenMeta?.decimals;
          const ticker = tokenMeta?.ticker ?? trade.assetId.slice(0, 8);
          // offerType "sell" = maker sold tokens (taker bought)
          const isBuy = trade.offerType === "sell";

          return (
            <Link
              key={trade.filledInTxid || `${trade.offerOutpoint}-${i}`}
              href={`/token/${ticker}`}
              className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors"
            >
              <span
                className={`shrink-0 text-[10px] font-bold uppercase ${
                  isBuy ? "text-emerald-400/80" : "text-amber-400/80"
                }`}
              >
                {isBuy ? "BUY" : "SELL"}
              </span>

              <span className="shrink-0 text-[11px] font-mono font-medium text-muted-foreground/70">
                ${ticker}
              </span>

              <span className="text-[11px] tabular-nums text-muted-foreground/50">
                {formatTokenAmount(trade.tokenAmount, decimals)}
              </span>

              <span className="text-[10px] text-muted-foreground/30">@</span>

              <span className="text-[11px] tabular-nums text-muted-foreground/50">
                {formatSats(trade.satAmount)} sat
              </span>

              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/30">
                {timeAgo(trade.timestamp)}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
