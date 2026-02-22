"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { TokenCard } from "@/components/token-card";
import { MOCK_TOKENS } from "@/lib/mock-tokens";

type SortMode = "trending" | "new" | "top" | "finishing";

const SORT_TABS: { key: SortMode; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
  { key: "top", label: "Top" },
  { key: "finishing", label: "Graduating" },
];

export default function Home() {
  const [sort, setSort] = useState<SortMode>("trending");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let tokens = [...MOCK_TOKENS];

    if (search.trim()) {
      const q = search.toLowerCase();
      tokens = tokens.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.ticker.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      );
    }

    switch (sort) {
      case "trending":
        tokens.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case "new":
        tokens.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "top":
        tokens.sort((a, b) => b.marketCap - a.marketCap);
        break;
      case "finishing":
        tokens.sort((a, b) => b.curveProgress - a.curveProgress);
        break;
    }

    return tokens;
  }, [sort, search]);

  const topMovers = useMemo(
    () =>
      [...MOCK_TOKENS]
        .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
        .slice(0, 5),
    []
  );

  // Top 2 for hero
  const heroTokens = topMovers.slice(0, 2);

  const totalMcap = MOCK_TOKENS.reduce((s, t) => s + t.marketCap, 0);
  const totalVolume = MOCK_TOKENS.reduce((s, t) => s + t.volume24h, 0);

  function formatSats(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  }

  return (
    <div className="space-y-5">
      {/* ── Hero: Top Movers ── */}
      <div className="relative">
        {/* Decorative glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-40 rounded-full bg-white/[0.02] blur-3xl pointer-events-none" />

        <div className="relative space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight">Marketplace</h1>
              <span className="text-[10px] text-muted-foreground/30 tabular-nums font-medium mt-1">
                {MOCK_TOKENS.length} tokens
              </span>
            </div>
            <Link href="/create">
              <button className="h-9 px-5 rounded-xl bg-white/[0.07] backdrop-blur-sm border border-white/[0.1] text-xs font-medium text-foreground/80 hover:bg-white/[0.12] hover:text-foreground hover:border-white/[0.14] transition-all">
                + Create Token
              </button>
            </Link>
          </div>

          {/* Hero cards — top 2 movers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {heroTokens.map((t, i) => {
              const up = t.change24h >= 0;
              return (
                <Link
                  key={t.id}
                  href={`/token/${t.id}`}
                  className="group glass-card relative rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden transition-all hover:bg-white/[0.06] hover:border-white/[0.1]"
                >
                  {/* Subtle colored glow */}
                  <div className={`absolute -top-8 -right-8 w-24 h-24 rounded-full blur-2xl pointer-events-none ${
                    up ? "bg-emerald-500/[0.04]" : "bg-red-500/[0.04]"
                  }`} />

                  <div className="relative p-4 sm:p-5 space-y-3">
                    {/* Token identity row */}
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 sm:h-11 sm:w-11 shrink-0 rounded-xl flex items-center justify-center text-sm font-bold bg-white/[0.06] border border-white/[0.08] text-muted-foreground/50">
                        {t.image ? (
                          <img src={t.image} alt={t.name} className="h-full w-full rounded-xl object-cover" />
                        ) : (
                          t.ticker.slice(0, 2)
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm sm:text-base font-bold truncate">{t.name}</p>
                        <p className="text-[11px] font-mono text-muted-foreground/40">${t.ticker}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className={`text-lg sm:text-xl font-bold tabular-nums ${up ? "text-emerald-400" : "text-red-400"}`}>
                          {up ? "+" : ""}{t.change24h.toFixed(1)}%
                        </span>
                      </div>
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center gap-3 pt-1">
                      <span className="text-[9px] uppercase tracking-[0.2em] font-medium px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.07] text-muted-foreground/40">
                        {i === 0 ? "#1" : "#2"}
                      </span>
                      <div className="h-5 w-px bg-white/[0.06]" />
                      <div>
                        <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Price</p>
                        <p className="text-xs font-semibold tabular-nums">{t.price.toFixed(2)} <span className="text-muted-foreground/30">sat</span></p>
                      </div>
                      <div className="h-5 w-px bg-white/[0.06]" />
                      <div>
                        <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Vol</p>
                        <p className="text-xs font-semibold tabular-nums">{formatSats(t.volume24h)}</p>
                      </div>
                      <div className="h-5 w-px bg-white/[0.06] hidden sm:block" />
                      <div className="hidden sm:block">
                        <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">MCap</p>
                        <p className="text-xs font-semibold tabular-nums">{formatSats(t.marketCap)}</p>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          {/* Remaining movers as chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground/40 font-medium">
              Also moving
            </span>
            {topMovers.slice(2).map((t) => {
              const up = t.change24h >= 0;
              return (
                <Link
                  key={t.id}
                  href={`/token/${t.id}`}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg bg-white/[0.05] border border-white/[0.07] px-2.5 py-1.5 text-[11px] transition-all hover:bg-white/[0.09] hover:border-white/[0.1]"
                >
                  <span className="font-mono font-medium text-muted-foreground/70">${t.ticker}</span>
                  <span className={`font-medium tabular-nums ${up ? "text-emerald-400" : "text-red-400"}`}>
                    {up ? "+" : ""}{t.change24h.toFixed(1)}%
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-xl bg-white/[0.04] border border-white/[0.07] p-1">
          {SORT_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSort(tab.key)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                sort === tab.key
                  ? "bg-white/[0.1] text-foreground shadow-sm backdrop-blur-sm"
                  : "text-muted-foreground/50 hover:text-muted-foreground/70"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 w-full sm:max-w-xs ml-auto">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40">
            <path fillRule="evenodd" d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z" clipRule="evenodd" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tokens..."
            className="w-full h-8 pl-9 pr-3 text-xs rounded-xl bg-white/[0.04] border border-white/[0.07] text-foreground placeholder:text-muted-foreground/35 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
          />
        </div>
      </div>

      {/* Token grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((token) => (
          <TokenCard key={token.id} token={token} />
        ))}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="text-center py-16 space-y-3">
          <p className="text-sm text-muted-foreground/50">
            No tokens found for &ldquo;{search}&rdquo;
          </p>
          <button
            onClick={() => setSearch("")}
            className="text-xs text-muted-foreground/40 hover:text-foreground/60 transition-colors"
          >
            Clear search
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="text-center pt-4 pb-6">
        <p className="text-[10px] text-muted-foreground/20 uppercase tracking-widest">
          Powered by Ark &middot; Settled on Bitcoin &middot; Published via Nostr
        </p>
      </div>
    </div>
  );
}
