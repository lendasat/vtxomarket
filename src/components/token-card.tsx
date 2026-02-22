"use client";

import Link from "next/link";
import type { Token } from "@/lib/store";

interface TokenCardProps {
  token: Token & {
    price: number;
    change24h: number;
    volume24h: number;
    holders: number;
    curveProgress: number;
    creatorShort: string;
  };
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatSats(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function TokenCard({ token }: TokenCardProps) {
  const isPositive = token.change24h >= 0;
  const isNew = Date.now() / 1000 - token.createdAt < 300;

  return (
    <Link href={`/token/${token.id}`} className="block group">
      <div className="glass-card relative rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden transition-all duration-300 hover:bg-white/[0.07] hover:border-white/[0.12] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.2)]">
        <div className="p-4">
          {/* Top row: avatar + name + price */}
          <div className="flex items-start gap-3">
            {/* Avatar */}
            <div className="h-10 w-10 shrink-0 rounded-xl bg-white/[0.07] border border-white/[0.08] flex items-center justify-center text-xs font-bold text-muted-foreground/60 tracking-wider">
              {token.image ? (
                <img
                  src={token.image}
                  alt={token.name}
                  className="h-full w-full rounded-xl object-cover"
                />
              ) : (
                token.ticker.slice(0, 2)
              )}
            </div>

            {/* Name + ticker + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm truncate leading-tight">
                  {token.name}
                </h3>
                <span className="shrink-0 text-[11px] font-mono text-muted-foreground/40">
                  ${token.ticker}
                </span>
                {isNew && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-foreground/60">
                    <span className="h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
                    new
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground/30 mt-0.5">
                {token.creatorShort} &middot; {timeAgo(token.createdAt)}
              </p>
            </div>

            {/* Price + change */}
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold tabular-nums">
                {token.price.toFixed(2)}
                <span className="text-[10px] text-muted-foreground/30 ml-0.5">sat</span>
              </p>
              {token.change24h !== 0 && (
                <p
                  className={`text-[11px] font-medium tabular-nums ${
                    isPositive ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {isPositive ? "+" : ""}
                  {token.change24h.toFixed(1)}%
                </p>
              )}
            </div>
          </div>

          {/* Description */}
          <p className="mt-2.5 text-xs text-muted-foreground/50 line-clamp-1 leading-relaxed">
            {token.description}
          </p>

          {/* Bonding curve progress */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted-foreground/30">
                Bonding curve
              </span>
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground/40">
                {token.curveProgress}%
              </span>
            </div>
            <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-white/[0.1] to-white/[0.2] transition-all duration-500"
                style={{ width: `${token.curveProgress}%` }}
              />
            </div>
          </div>

          {/* Stats row */}
          <div className="mt-3 flex items-center text-[10px] text-muted-foreground/35 tabular-nums">
            <span>mcap {formatSats(token.marketCap)}</span>
            <span className="mx-2 text-white/[0.06]">/</span>
            <span>vol {formatSats(token.volume24h)}</span>
            <span className="mx-2 text-white/[0.06]">/</span>
            <span>{token.holders} holders</span>
            <span className="ml-auto">{token.replies} replies</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
