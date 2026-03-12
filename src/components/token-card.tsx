"use client";

import Link from "next/link";
import type { Token } from "@/lib/store";
import { formatTokenAmount } from "@/lib/format";
import { QuickBuyButton } from "@/components/quick-buy-button";
import type { TokenMarketData } from "@/hooks/useMarketSummary";

interface TokenCardProps {
  token: Token;
  marketData?: TokenMarketData;
}

export function TokenCard({ token, marketData }: TokenCardProps) {
  const hasPrice = marketData?.bestOfferPrice != null || marketData?.lastTradePrice != null;
  const displayPrice = marketData?.bestOfferPrice ?? marketData?.lastTradePrice ?? null;
  const hasOffers = marketData && marketData.openOfferCount > 0;

  return (
    <Link href={`/token/${token.ticker}`} className="block group">
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
              {hasPrice ? (
                <p className="text-xs tabular-nums font-medium text-emerald-400/70">
                  {displayPrice!.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span className="text-[10px] text-muted-foreground/25 ml-0.5">sat/tk</span>
                </p>
              ) : (
                <p className="text-xs tabular-nums text-muted-foreground/40">
                  {formatTokenAmount(token.supply, token.decimals)}
                  <span className="text-[10px] text-muted-foreground/25 ml-0.5">supply</span>
                </p>
              )}
            </div>
          </div>

          {/* Stats row + quick buy */}
          <div className="flex items-center text-[10px] text-muted-foreground/35 tabular-nums">
            <span>{token.tradeCount} trades</span>
            <span className="mx-2 text-white/[0.06]">/</span>
            <span>{token.replies} replies</span>
            {hasOffers && (
              <>
                <span className="mx-2 text-white/[0.06]">/</span>
                <span className="text-emerald-400/50">{marketData.openOfferCount} offers</span>
              </>
            )}
            {hasOffers && (
              <div className="ml-auto">
                <QuickBuyButton
                  assetId={token.assetId}
                  ticker={token.ticker}
                  decimals={token.decimals}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
