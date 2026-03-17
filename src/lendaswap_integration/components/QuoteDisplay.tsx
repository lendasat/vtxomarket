"use client";

/**
 * Displays a swap quote with rate, fees, and amount breakdown.
 * Rendered between the input form and the confirm button.
 */

import type { QuoteInfo } from "../lib/types";
import type { StablecoinKey } from "../lib/constants";
import { fromSmallestUnit } from "../lib/constants";

interface QuoteDisplayProps {
  quote: QuoteInfo;
  coin: StablecoinKey;
  direction: "send" | "receive";
}

export function QuoteDisplay({ quote, coin, direction }: QuoteDisplayProps) {
  const isSend = direction === "send";

  // Format the exchange rate for display
  const rate = parseFloat(quote.exchangeRate);
  const rateDisplay = rate > 0 ? rate.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";

  const totalFeeSats = quote.protocolFeeSats + quote.networkFeeSats;

  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4 space-y-2.5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3.5 w-3.5 text-muted-foreground/40"
        >
          <path
            fillRule="evenodd"
            d="M13.78 10.47a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 1 1 1.06-1.06l.97.97V5.75a.75.75 0 0 1 1.5 0v5.69l.97-.97a.75.75 0 0 1 1.06 0ZM2.22 5.53a.75.75 0 0 1 0-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1-1.06 1.06l-.97-.97v5.69a.75.75 0 0 1-1.5 0V4.56l-.97.97a.75.75 0 0 1-1.06 0Z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/40 font-medium">
          Quote
        </span>
      </div>

      {/* Rate */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/50">Rate</span>
        <span className="text-xs text-foreground/80 tabular-nums">
          1 BTC = {rateDisplay} {coin}
        </span>
      </div>

      {/* You send / You receive */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/50">
          {isSend ? "You send" : "You deposit"}
        </span>
        <span className="text-xs text-foreground/80 tabular-nums font-medium">
          {isSend
            ? `${parseInt(quote.sourceAmount).toLocaleString()} sats`
            : `${fromSmallestUnit(quote.sourceAmount, coin)} ${coin}`}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/50">
          {isSend ? "Recipient gets" : "You receive"}
        </span>
        <span className="text-xs text-foreground/80 tabular-nums font-medium">
          {isSend
            ? `${fromSmallestUnit(quote.targetAmount, coin)} ${coin}`
            : `${parseInt(quote.targetAmount).toLocaleString()} sats`}
        </span>
      </div>

      {/* Divider */}
      <div className="border-t border-white/[0.06]" />

      {/* Fees */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/50">Fees</span>
        <span className="text-[11px] text-muted-foreground/40 tabular-nums">
          {totalFeeSats.toLocaleString()} sats
          <span className="ml-1 text-muted-foreground/25">
            ({quote.protocolFeeSats} protocol + {quote.networkFeeSats} network)
          </span>
        </span>
      </div>

      {/* Limits */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/50">Limits</span>
        <span className="text-[11px] text-muted-foreground/30 tabular-nums">
          {quote.minAmountSats.toLocaleString()} – {quote.maxAmountSats.toLocaleString()} sats
        </span>
      </div>
    </div>
  );
}
