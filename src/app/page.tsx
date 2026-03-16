"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { TokenCard } from "@/components/token-card";
import { ActivityFeed } from "@/components/activity-feed";
import { useTokens } from "@/hooks/useTokens";
import { useMarketSummary } from "@/hooks/useMarketSummary";
import { useAppStore } from "@/lib/store";
import { formatTokenAmount } from "@/lib/format";

type SortMode = "trending" | "new";

const SORT_TABS: { key: SortMode; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
];

export default function Home() {
  const { tokens, loading } = useTokens();
  const { data: marketData } = useMarketSummary();
  const user = useAppStore((s) => s.user);
  const [sort, setSort] = useState<SortMode>("trending");
  const [search, setSearch] = useState("");

  const myTokens = useMemo(() => {
    if (!user?.pubkey) return [];
    return tokens.filter((t) => t.creator === user.pubkey);
  }, [tokens, user?.pubkey]);

  const filtered = useMemo(() => {
    let list = [...tokens];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.ticker.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      );
    }

    switch (sort) {
      case "trending":
        list.sort((a, b) => b.tradeCount - a.tradeCount);
        break;
      case "new":
        list.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }

    return list;
  }, [tokens, sort, search]);

  const topMovers = useMemo(
    () => [...tokens].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
    [tokens]
  );

  const heroTokens = topMovers.slice(0, 2);

  return (
    <div className="space-y-5">
      {/* ── Hero: Top Movers ── */}
      <div className="relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-40 rounded-full bg-white/[0.02] blur-3xl pointer-events-none" />

        <div className="relative space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight">Marketplace</h1>
              <span className="text-[10px] text-muted-foreground/30 tabular-nums font-medium mt-1">
                {tokens.length} tokens
              </span>
            </div>
            <Link href="/create">
              <button className="h-9 px-5 rounded-xl bg-white/[0.07] backdrop-blur-sm border border-white/[0.1] text-xs font-medium text-foreground/80 hover:bg-white/[0.12] hover:text-foreground hover:border-white/[0.14] transition-all">
                + Create Token
              </button>
            </Link>
          </div>

          {/* Loading state */}
          {loading && tokens.length === 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[0, 1].map((i) => (
                <div key={i} className="rounded-2xl bg-white/[0.04] border border-white/[0.07] p-5 space-y-3 animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="h-11 w-11 rounded-xl bg-white/[0.06]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-24 rounded bg-white/[0.06]" />
                      <div className="h-3 w-16 rounded bg-white/[0.04]" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Hero cards — top 2 by recency */}
          {heroTokens.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {heroTokens.map((t, i) => {
                const md = marketData.get(t.assetId);
                const price = md?.bestOfferPrice ?? md?.lastTradePrice ?? null;
                return (
                  <Link
                    key={t.id}
                    href={`/token/${t.ticker}`}
                    className="group glass-card relative rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden transition-all hover:bg-white/[0.06] hover:border-white/[0.1]"
                  >
                    <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full blur-2xl pointer-events-none bg-emerald-500/[0.04]" />

                    <div className="relative p-4 sm:p-5 space-y-3">
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
                          {price != null ? (
                            <span className="text-xs tabular-nums font-medium text-emerald-400/70">
                              {price.toLocaleString(undefined, { maximumFractionDigits: 2 })} sat/tk
                            </span>
                          ) : (
                            <span className="text-xs tabular-nums text-muted-foreground/50">
                              {formatTokenAmount(t.supply, t.decimals)} supply
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 pt-1">
                        <span className="text-[9px] uppercase tracking-[0.2em] font-medium px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.07] text-muted-foreground/40">
                          {i === 0 ? "Latest" : "Recent"}
                        </span>
                        <div className="h-5 w-px bg-white/[0.06]" />
                        <div>
                          <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Replies</p>
                          <p className="text-xs font-semibold tabular-nums">{t.replies}</p>
                        </div>
                        <div className="h-5 w-px bg-white/[0.06]" />
                        <div>
                          <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Trades</p>
                          <p className="text-xs font-semibold tabular-nums">{t.tradeCount}</p>
                        </div>
                        {md && md.openOfferCount > 0 && (
                          <>
                            <div className="h-5 w-px bg-white/[0.06]" />
                            <div>
                              <p className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Offers</p>
                              <p className="text-xs font-semibold tabular-nums text-emerald-400/60">{md.openOfferCount}</p>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Remaining movers as chips */}
          {topMovers.length > 2 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
              <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground/40 font-medium">
                Also listed
              </span>
              {topMovers.slice(2).map((t) => (
                <Link
                  key={t.id}
                  href={`/token/${t.ticker}`}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg bg-white/[0.05] border border-white/[0.07] px-2.5 py-1.5 text-[11px] transition-all hover:bg-white/[0.09] hover:border-white/[0.1]"
                >
                  <span className="font-mono font-medium text-muted-foreground/70">${t.ticker}</span>
                  <span className="font-medium tabular-nums text-muted-foreground/50">
                    {formatTokenAmount(t.supply, t.decimals)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Your Issued Tokens ── */}
      {myTokens.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground/40 font-medium">
            Your Issued Tokens
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {myTokens.map((t) => {
              const md = marketData.get(t.assetId);
              return (
                <Link
                  key={t.id}
                  href={`/token/${t.ticker}`}
                  className="group flex items-center gap-3 rounded-xl bg-white/[0.04] border border-white/[0.07] p-3 transition-all hover:bg-white/[0.07] hover:border-white/[0.12]"
                >
                  <div className="h-9 w-9 shrink-0 rounded-lg bg-white/[0.06] border border-white/[0.06] flex items-center justify-center text-[10px] font-bold text-muted-foreground/50">
                    {t.image ? (
                      <img src={t.image} alt={t.name} className="h-full w-full rounded-lg object-cover" />
                    ) : (
                      t.ticker.slice(0, 2)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{t.name}</p>
                    <p className="text-[10px] font-mono text-muted-foreground/40">${t.ticker}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {md && md.openOfferCount > 0 ? (
                      <span className="text-[10px] tabular-nums text-emerald-400/60 font-medium">
                        {md.openOfferCount} offer{md.openOfferCount !== 1 ? "s" : ""}
                      </span>
                    ) : (
                      <span className="text-[10px] tabular-nums text-muted-foreground/30">
                        {formatTokenAmount(t.supply, t.decimals)} supply
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Recent Activity ── */}
      <ActivityFeed />

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

      {/* Loading skeleton grid */}
      {loading && tokens.length === 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl bg-white/[0.04] border border-white/[0.07] p-4 space-y-3 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-white/[0.06]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-20 rounded bg-white/[0.06]" />
                  <div className="h-3 w-12 rounded bg-white/[0.04]" />
                </div>
              </div>
              <div className="h-1 rounded-full bg-white/[0.06]" />
              <div className="h-3 w-32 rounded bg-white/[0.04]" />
            </div>
          ))}
        </div>
      )}

      {/* Token grid */}
      {filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((token) => (
            <TokenCard
              key={token.id}
              token={token}
              marketData={marketData.get(token.assetId)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 space-y-3">
          {search ? (
            <>
              <p className="text-sm text-muted-foreground/50">
                No tokens found for &ldquo;{search}&rdquo;
              </p>
              <button
                onClick={() => setSearch("")}
                className="text-xs text-muted-foreground/40 hover:text-foreground/60 transition-colors"
              >
                Clear search
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground/50">
                No tokens yet. Be the first to create one!
              </p>
              <Link
                href="/create"
                className="inline-block text-xs text-foreground/60 hover:text-foreground transition-colors"
              >
                + Create Token
              </Link>
            </>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="text-center pt-4 pb-6">
        <p className="text-[10px] text-muted-foreground/20 uppercase tracking-widest">
          Powered by Ark &middot; Settled on Bitcoin
        </p>
      </div>
    </div>
  );
}
