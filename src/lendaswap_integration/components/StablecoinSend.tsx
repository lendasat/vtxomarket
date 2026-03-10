"use client";

/**
 * StablecoinSend — Send sats from Arkade, recipient gets stablecoins on EVM.
 *
 * This is a drop-in replacement for the existing StablecoinSend component
 * in wallet/page.tsx. It implements the full Arkade→EVM swap flow:
 *
 *   1. User picks coin (USDC/USDT), chain (Arb/Eth/Polygon), enters amount + EVM address
 *   2. Fetches live quote from Lendaswap API
 *   3. User confirms → swap is created → BTC auto-sent to VHTLC
 *   4. Status tracker shows real-time progress
 *   5. Gasless claim delivers stablecoins to recipient
 *
 * Usage in wallet/page.tsx:
 *   import { StablecoinSend } from "@/lendaswap_integration";
 *   <StablecoinSend />
 */

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { useLendaswap } from "../hooks/useLendaswap";
import { CoinChainSelectors } from "./CoinChainSelectors";
import { QuoteDisplay } from "./QuoteDisplay";
import { SwapStatusTracker } from "./SwapStatusTracker";
import { getChainName, type EvmChainKey, type StablecoinKey } from "../lib/constants";

export function StablecoinSend() {
  const balance = useAppStore((s) => s.balance);
  const {
    ready,
    state,
    getQuote,
    createSendSwap,
    reset,
    setStep,
  } = useLendaswap();

  // ── Local form state ────────────────────────────────────────────────

  const [coin, setCoin] = useState<StablecoinKey>("USDC");
  const [chain, setChain] = useState<EvmChainKey>("arbitrum");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");

  const sats = parseInt(amount, 10);
  const isValidAmount = !isNaN(sats) && sats > 0;
  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(address);
  const canQuote = isValidAmount && isValidAddress && ready;
  const chainLabel = getChainName(chain);

  const { step, quote, swap, error } = state;

  // ── Handlers ────────────────────────────────────────────────────────

  const handleGetQuote = async () => {
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

  const handleBack = () => {
    if (step === "confirming") {
      setStep("idle");
    }
  };

  const handleDone = () => {
    reset();
    setAmount("");
    setAddress("");
  };

  // ── Render: Processing / Success / Error states ─────────────────────

  if (step === "funding" || step === "processing" || step === "claiming" || step === "success") {
    return (
      <div className="space-y-4">
        {swap && <SwapStatusTracker step={step} swap={swap} />}

        {step === "success" && (
          <>
            <div className="rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.12] px-4 py-3">
              <p className="text-xs text-emerald-400/80">
                Swap complete! {swap?.targetDisplay} sent to recipient on {chainLabel}.
              </p>
            </div>
            <button
              onClick={handleDone}
              className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16]"
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
          className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16]"
        >
          Close
        </button>
      </div>
    );
  }

  // ── Render: Confirm step ────────────────────────────────────────────

  if (step === "confirming" && quote) {
    return (
      <div className="space-y-4">
        <CoinChainSelectors coin={coin} setCoin={setCoin} chain={chain} setChain={setChain} disabled />

        <QuoteDisplay quote={quote} coin={coin} direction="send" />

        {/* Recipient address (read-only) */}
        <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-3">
          <p className="text-[10px] text-muted-foreground/40 uppercase tracking-[0.15em] mb-1">
            Recipient on {chainLabel}
          </p>
          <code className="text-xs text-muted-foreground/60 break-all">{address}</code>
        </div>

        {/* Balance check */}
        {balance && sats > balance.available && (
          <div className="rounded-xl bg-orange-500/[0.08] border border-orange-500/[0.12] px-4 py-3">
            <p className="text-xs text-orange-400/80">
              Insufficient balance. You have {balance.available.toLocaleString()} sats available.
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleBack}
            className="flex-1 h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] text-sm font-medium text-muted-foreground/60 transition-all hover:bg-white/[0.1]"
          >
            Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={!!(balance && sats > balance.available)}
            className="flex-1 h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Confirm & Send
          </button>
        </div>

        <p className="text-center text-[10px] text-muted-foreground/30">
          Powered by LendaSwap
        </p>
      </div>
    );
  }

  // ── Render: Quote loading ───────────────────────────────────────────

  if (step === "quoting") {
    return (
      <div className="space-y-4">
        <CoinChainSelectors coin={coin} setCoin={setCoin} chain={chain} setChain={setChain} disabled />
        <div className="flex items-center justify-center py-8 gap-3">
          <div className="h-4 w-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground/50">Fetching quote...</span>
        </div>
      </div>
    );
  }

  // ── Render: Idle (input form) ───────────────────────────────────────

  return (
    <div className="space-y-4">
      <CoinChainSelectors coin={coin} setCoin={setCoin} chain={chain} setChain={setChain} />

      {/* Recipient address */}
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder={`Recipient address on ${chainLabel} (0x...)`}
        className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
      />

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

      {/* Get quote button */}
      <button
        onClick={handleGetQuote}
        disabled={!canQuote}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {!ready ? "Initializing..." : !isValidAddress ? "Enter valid EVM address" : !isValidAmount ? "Enter amount" : `Send ${coin}`}
      </button>

      <p className="text-center text-[10px] text-muted-foreground/30">
        Powered by LendaSwap
      </p>
    </div>
  );
}
