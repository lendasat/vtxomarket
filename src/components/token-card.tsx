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

function formatSats(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function TokenCard({ token }: TokenCardProps) {
  const isPositive = token.change24h >= 0;

  return (
    <Link href={`/token/${token.id}`} className="block group">
      <div className="glass-card relative rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden transition-all duration-300 hover:bg-white/[0.07] hover:border-white/[0.12] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.2)]">
        <div className="p-4 space-y-3">
          {/* Top row: avatar + name + price */}
          <div className="flex items-center gap-3">
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

            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm truncate leading-tight">
                {token.name}
              </h3>
              <p className="text-[11px] font-mono text-muted-foreground/40 mt-0.5">
                ${token.ticker}
              </p>
            </div>

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

          {/* Bonding curve bar */}
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-white/[0.1] to-white/[0.2] transition-all duration-500"
              style={{ width: `${token.curveProgress}%` }}
            />
          </div>

          {/* Mcap + volume */}
          <div className="flex items-center text-[10px] text-muted-foreground/35 tabular-nums">
            <span>mcap {formatSats(token.marketCap)}</span>
            <span className="mx-2 text-white/[0.06]">/</span>
            <span>vol {formatSats(token.volume24h)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
