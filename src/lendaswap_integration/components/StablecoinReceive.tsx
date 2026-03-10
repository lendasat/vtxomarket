"use client";

/**
 * StablecoinReceive — Seamless stablecoin-to-sats receive.
 *
 * Designed to feel identical to a normal Arkade/Onchain receive:
 * enter amount → get address → done. All swap mechanics are invisible.
 *
 * The "Powered by LendaSwap" badge has a (?) that expands to show
 * the full rate/fee breakdown for transparency.
 */

import { useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/lib/store";
import { useLendaswap } from "../hooks/useLendaswap";
import { CoinChainSelectors } from "./CoinChainSelectors";
import {
  getChainName,
  fromSmallestUnit,
  type EvmChainKey,
  type StablecoinKey,
} from "../lib/constants";

export function StablecoinReceive() {
  const balance = useAppStore((s) => s.balance);
  const { ready, state, getQuoteAndCreateReceive, reset } = useLendaswap();

  const [coin, setCoin] = useState<StablecoinKey>("USDC");
  const [chain, setChain] = useState<EvmChainKey>("arbitrum");
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const sats = parseInt(amount, 10);
  const isValidAmount = !isNaN(sats) && sats > 0;
  const chainLabel = getChainName(chain);
  const { step, quote, swap, error } = state;

  const isLoading = step === "quoting" || step === "awaiting_deposit" && !swap?.evmDepositAddress;
  const hasAddress = swap?.evmDepositAddress;
  const isActive = hasAddress || step === "processing" || step === "claiming";

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const truncateAddr = (addr: string, chars = 12) => {
    if (addr.length <= chars * 2 + 3) return addr;
    return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
  };

  // One-tap: fetch quote + create swap + show address — no intermediate steps
  const handleReceive = async () => {
    if (!isValidAmount || !ready) return;
    await getQuoteAndCreateReceive({ coin, chain, amountSats: sats });
  };

  const handleDone = () => {
    reset();
    setAmount("");
    setShowDetails(false);
  };

  // Changing coin or chain resets the active swap so user must re-enter amount
  const handleCoinChange = (c: StablecoinKey) => {
    if (isActive) handleDone();
    setCoin(c);
  };
  const handleChainChange = (c: EvmChainKey) => {
    if (isActive) handleDone();
    setChain(c);
  };

  // ── Success ─────────────────────────────────────────────────────────

  if (step === "success") {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center justify-center py-6 gap-3">
          <div className="h-12 w-12 rounded-full bg-emerald-500/[0.15] flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-emerald-400">
              <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" />
            </svg>
          </div>
          <p className="text-sm font-semibold">{swap?.targetDisplay} received</p>
          {balance && (
            <p className="text-xs text-muted-foreground/40">
              Balance: {balance.total.toLocaleString()} sats
            </p>
          )}
        </div>
        <button
          onClick={handleDone}
          className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16]"
        >
          Done
        </button>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────

  if (step === "error" && !hasAddress) {
    return (
      <div className="space-y-4">
        <CoinChainSelectors coin={coin} setCoin={handleCoinChange} chain={chain} setChain={handleChainChange}  />
        <div className="rounded-xl bg-red-500/[0.08] border border-red-500/[0.12] px-4 py-3">
          <p className="text-xs text-red-400/80">{error}</p>
        </div>
        <button
          onClick={handleDone}
          className="w-full h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] text-sm font-medium text-muted-foreground/60 transition-all hover:bg-white/[0.1]"
        >
          Try again
        </button>
      </div>
    );
  }

  // ── Deposit address shown (main active state) ───────────────────────

  if (isActive && swap) {
    const depositAddr = swap.evmDepositAddress || "";
    const depositDisplay = swap.evmDepositAmount
      ? `${fromSmallestUnit(swap.evmDepositAmount, coin)} ${coin}`
      : swap.sourceDisplay;

    const isProcessing = step === "processing" || step === "claiming";

    return (
      <div className="space-y-4">
        <CoinChainSelectors coin={coin} setCoin={handleCoinChange} chain={chain} setChain={handleChainChange}  />

        {!isProcessing ? (
          <>
            <p className="text-[10px] text-muted-foreground/40 uppercase tracking-[0.15em]">
              Send {depositDisplay} on {chainLabel} to
            </p>

            {/* QR code */}
            <div className="flex justify-center py-2">
              <div className="rounded-xl bg-white p-3">
                <QRCodeSVG value={depositAddr} size={160} bgColor="#ffffff" fgColor="#111827" level="M" />
              </div>
            </div>

            {/* Address — tap to copy */}
            <button
              onClick={() => copyToClipboard(depositAddr)}
              className="w-full flex items-center justify-between gap-3 py-3 px-4 rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] transition-all"
            >
              <code className="text-xs text-muted-foreground/60 break-all">
                {truncateAddr(depositAddr)}
              </code>
              <span className="shrink-0 text-xs font-medium text-muted-foreground/50">
                {copied ? "Copied!" : "Copy"}
              </span>
            </button>
          </>
        ) : (
          /* Swap in progress — minimal indicator */
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <div className="h-5 w-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground/50">
              {step === "claiming" ? "Claiming sats..." : "Converting to sats..."}
            </p>
          </div>
        )}

        {/* Powered by LendaSwap + expandable details */}
        <PoweredByBadge
          showDetails={showDetails}
          setShowDetails={setShowDetails}
          quote={quote}
          coin={coin}
        />
      </div>
    );
  }

  // ── Idle: amount input ──────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <CoinChainSelectors coin={coin} setCoin={handleCoinChange} chain={chain} setChain={handleChainChange}  />

      {/* Amount input */}
      <div className="rounded-xl bg-white/[0.05] border border-white/[0.08] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="flex-1 bg-transparent text-lg font-semibold tabular-nums text-foreground placeholder:text-muted-foreground/20 outline-none"
          />
          <span className="text-xs text-muted-foreground/40 font-medium">sats</span>
        </div>
      </div>

      <button
        onClick={handleReceive}
        disabled={!isValidAmount || !ready || isLoading}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <div className="h-3.5 w-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            <span>Getting address...</span>
          </>
        ) : !ready ? (
          "Initializing..."
        ) : !isValidAmount ? (
          "Enter amount"
        ) : (
          `Receive ${coin}`
        )}
      </button>

      <PoweredByBadge showDetails={false} setShowDetails={() => {}} quote={null} coin={coin} />
    </div>
  );
}

// ── "Powered by LendaSwap" with expandable details ──────────────────────

function PoweredByBadge({
  showDetails,
  setShowDetails,
  quote,
  coin,
}: {
  showDetails: boolean;
  setShowDetails: (v: boolean) => void;
  quote: { exchangeRate: string; protocolFeeSats: number; networkFeeSats: number; minAmountSats: number; maxAmountSats: number } | null;
  coin: StablecoinKey;
}) {
  return (
    <div className="space-y-0">
      <button
        onClick={() => quote && setShowDetails(!showDetails)}
        className="w-full flex items-center justify-center gap-1.5 py-1"
      >
        <span className="text-[10px] text-muted-foreground/30">Powered by LendaSwap</span>
        {quote && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`h-3 w-3 text-muted-foreground/20 transition-transform ${showDetails ? "rotate-180" : ""}`}
          >
            <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      {showDetails && quote && (
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.05] px-4 py-3 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground/30">Rate</span>
            <span className="text-[11px] text-muted-foreground/40 tabular-nums">
              1 BTC = {parseFloat(quote.exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 2 })} {coin}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground/30">Fee</span>
            <span className="text-[11px] text-muted-foreground/40 tabular-nums">
              {(quote.protocolFeeSats + quote.networkFeeSats).toLocaleString()} sats
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground/30">Limits</span>
            <span className="text-[11px] text-muted-foreground/40 tabular-nums">
              {quote.minAmountSats.toLocaleString()} – {quote.maxAmountSats.toLocaleString()} sats
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
