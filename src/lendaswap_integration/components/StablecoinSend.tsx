"use client";

/**
 * StablecoinSend — Send sats, recipient gets stablecoins on EVM.
 * Simplified UI: amount + address → send. Quote fetched inline.
 */

import { useState, useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { useAccount } from "wagmi";
import { useLendaswap } from "../hooks/useLendaswap";
import { CoinChainSelectors } from "./CoinChainSelectors";
import { EvmConnectButton } from "./EvmConnectButton";
import { QuoteDisplay } from "./QuoteDisplay";
import { SwapStatusTracker } from "./SwapStatusTracker";
import { getChainName, type EvmChainKey, type StablecoinKey } from "../lib/constants";

export function StablecoinSend() {
  const balance = useAppStore((s) => s.balance);
  const { ready, state, getQuote, createSendSwap, getSendEstimate, reset, setStep } =
    useLendaswap();

  const { address: evmAddress, isConnected: evmConnected } = useAccount();

  const [coin, setCoin] = useState<StablecoinKey>("USDC");
  const [chain, setChain] = useState<EvmChainKey>("arbitrum");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [usdEstimate, setUsdEstimate] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-fill address when wallet connects
  useEffect(() => {
    if (evmConnected && evmAddress && !address) {
      setAddress(evmAddress);
    }
  }, [evmConnected, evmAddress, address]);

  const sats = parseInt(amount, 10);
  const isValidAmount = !isNaN(sats) && sats > 0;
  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(address);
  const canQuote = isValidAmount && isValidAddress && ready;
  const chainLabel = getChainName(chain);

  const { step, quote, swap, error } = state;

  // Live USD estimate as user types
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!isValidAmount || sats < 1000) {
      setUsdEstimate(null);
      return;
    }
    setEstimating(true);
    debounceRef.current = setTimeout(async () => {
      const est = await getSendEstimate({ coin, chain, amountSats: sats });
      setUsdEstimate(est);
      setEstimating(false);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amount, coin, chain, sats, isValidAmount, getSendEstimate]);

  // ── Handlers ──────────────────────────────────────────────────────

  const handleSend = async () => {
    if (!canQuote) return;
    await getQuote({ coin, chain, amount: sats, direction: "send" });
  };

  const handleConfirm = async () => {
    if (!quote) return;
    await createSendSwap({
      coin,
      chain,
      amountSats: sats,
      destinationEvmAddress: address,
    });
  };

  const handleDone = () => {
    reset();
    setAmount("");
    setAddress("");
    setUsdEstimate(null);
  };

  // ── Processing / Success / Error ──────────────────────────────────

  if (step === "funding" || step === "processing" || step === "claiming" || step === "success") {
    return (
      <div className="space-y-4">
        {swap && <SwapStatusTracker step={step} swap={swap} />}
        {step === "success" && (
          <>
            <div className="rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.12] px-4 py-3">
              <p className="text-xs text-emerald-400/80">
                Done! {swap?.targetDisplay} sent to recipient on {chainLabel}.
              </p>
            </div>
            <button
              onClick={handleDone}
              className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14]"
            >
              Done
            </button>
          </>
        )}
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="space-y-4">
        {swap && <SwapStatusTracker step={step} swap={swap} />}
        <div className="rounded-xl bg-red-500/[0.08] border border-red-500/[0.12] px-4 py-3">
          <p className="text-xs text-red-400/80">{error}</p>
        </div>
        <button
          onClick={handleDone}
          className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14]"
        >
          Close
        </button>
      </div>
    );
  }

  // ── Confirm step ──────────────────────────────────────────────────

  if (step === "confirming" && quote) {
    return (
      <div className="space-y-4">
        <QuoteDisplay quote={quote} coin={coin} direction="send" />

        <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-3">
          <p className="text-[10px] text-muted-foreground/40 uppercase tracking-[0.15em] mb-1">
            Recipient on {chainLabel}
          </p>
          <code className="text-xs text-muted-foreground/60 break-all">{address}</code>
        </div>

        {balance && sats > balance.available && (
          <div className="rounded-xl bg-orange-500/[0.08] border border-orange-500/[0.12] px-4 py-3">
            <p className="text-xs text-orange-400/80">
              Insufficient balance ({balance.available.toLocaleString()} sats available)
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => setStep("idle")}
            className="flex-1 h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] text-sm font-medium text-muted-foreground/60 transition-all hover:bg-white/[0.1]"
          >
            Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={!!(balance && sats > balance.available)}
            className="flex-1 h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Confirm & Send
          </button>
        </div>
      </div>
    );
  }

  // ── Quoting spinner ───────────────────────────────────────────────

  if (step === "quoting") {
    return (
      <div className="flex items-center justify-center py-10 gap-3">
        <div className="h-4 w-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground/50">Fetching quote...</span>
      </div>
    );
  }

  // ── Idle (input form) ─────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <CoinChainSelectors coin={coin} setCoin={setCoin} chain={chain} setChain={setChain} />

      {/* Amount */}
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
        {isValidAmount && (
          <p className="text-[11px] text-muted-foreground/30 tabular-nums">
            {estimating
              ? "estimating..."
              : usdEstimate
                ? `≈ ${usdEstimate} ${coin} on ${chainLabel}`
                : ""}
          </p>
        )}
        {balance && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground/30">
              Available: {balance.available.toLocaleString()} sats
            </span>
            <button
              onClick={() => setAmount(String(balance.available))}
              className="text-[10px] text-blue-400/60 hover:text-blue-400/80 transition-colors font-medium uppercase tracking-wider"
            >
              Max
            </button>
          </div>
        )}
      </div>

      {/* Recipient */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/30 uppercase tracking-[0.15em]">
            Recipient on {chainLabel}
          </span>
          <EvmConnectButton />
        </div>
        <div className="relative">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x..."
            className="w-full h-11 px-4 pr-16 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
          />
          {evmConnected && evmAddress && address !== evmAddress && (
            <button
              onClick={() => setAddress(evmAddress)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-medium text-blue-400/70 hover:text-blue-400 bg-blue-500/[0.1] rounded-md transition-colors"
            >
              Use wallet
            </button>
          )}
        </div>
      </div>

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={!canQuote}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {!ready
          ? "Initializing..."
          : !isValidAmount
            ? "Enter amount in sats"
            : !isValidAddress
              ? "Enter recipient address"
              : `Send ${usdEstimate ? usdEstimate + " " : ""}${coin}`}
      </button>

      <p className="text-center text-[10px] text-muted-foreground/30">Powered by LendaSwap</p>
    </div>
  );
}
