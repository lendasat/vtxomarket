"use client";

/**
 * Real-time swap status tracker with step indicator and live updates.
 *
 * Shows a vertical timeline of swap steps with animated transitions.
 * Used in both Send and Receive flows during the processing phase.
 */

import type { SwapStep, ActiveSwap } from "../lib/types";
import { getChainName, type EvmChainKey } from "../lib/constants";

// ── Step configuration ──────────────────────────────────────────────────────

interface StepConfig {
  label: string;
  description: string;
}

function getSendSteps(chain: EvmChainKey): StepConfig[] {
  const chainName = getChainName(chain);
  return [
    { label: "Sending BTC", description: "Transferring sats via Arkade" },
    { label: "Locking HTLC", description: `Waiting for ${chainName} HTLC lock` },
    { label: "Claiming", description: `Claiming stablecoins on ${chainName}` },
    { label: "Complete", description: "Swap finished successfully" },
  ];
}

function getReceiveSteps(chain: EvmChainKey): StepConfig[] {
  const chainName = getChainName(chain);
  return [
    { label: "Awaiting deposit", description: `Waiting for ${chainName} deposit` },
    { label: "Locking BTC", description: "Counterparty locking BTC in VHTLC" },
    { label: "Claiming", description: "Claiming BTC to your Arkade wallet" },
    { label: "Complete", description: "Swap finished successfully" },
  ];
}

/** Map swap step to a numeric index in the timeline */
function stepToIndex(step: SwapStep, direction: "send" | "receive"): number {
  if (direction === "send") {
    switch (step) {
      case "funding": return 0;
      case "processing": return 1;
      case "claiming": return 2;
      case "success": return 3;
      default: return -1;
    }
  }
  // receive
  switch (step) {
    case "awaiting_deposit": return 0;
    case "processing": return 1;
    case "claiming": return 2;
    case "success": return 3;
    default: return -1;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

interface SwapStatusTrackerProps {
  step: SwapStep;
  swap: ActiveSwap;
}

export function SwapStatusTracker({ step, swap }: SwapStatusTrackerProps) {
  const steps = swap.direction === "send"
    ? getSendSteps(swap.chain)
    : getReceiveSteps(swap.chain);
  const currentIdx = stepToIndex(step, swap.direction);
  const isError = step === "error";

  return (
    <div className="space-y-4">
      {/* Swap summary card */}
      <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground/50">
            {swap.direction === "send" ? "Sending" : "Receiving"}
          </span>
          <span className="text-xs text-foreground/80 font-medium tabular-nums">
            {swap.sourceDisplay}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground/50">
            {swap.direction === "send" ? "Recipient gets" : "You receive"}
          </span>
          <span className="text-xs text-foreground/80 font-medium tabular-nums">
            {swap.targetDisplay}
          </span>
        </div>
        {swap.id && (
          <div className="flex items-center justify-between pt-1 border-t border-white/[0.06]">
            <span className="text-[10px] text-muted-foreground/30">Swap ID</span>
            <code className="text-[10px] text-muted-foreground/30 font-mono">
              {swap.id.slice(0, 8)}...{swap.id.slice(-4)}
            </code>
          </div>
        )}
      </div>

      {/* Step timeline */}
      <div className="space-y-0">
        {steps.map((s, idx) => {
          const isDone = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const isPending = idx > currentIdx;

          return (
            <div key={idx} className="flex gap-3 items-start">
              {/* Timeline dot + line */}
              <div className="flex flex-col items-center">
                <div
                  className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 transition-all ${
                    isDone
                      ? "bg-emerald-500/20 text-emerald-400"
                      : isCurrent && !isError
                        ? "bg-blue-500/20 text-blue-400"
                        : isCurrent && isError
                          ? "bg-red-500/20 text-red-400"
                          : "bg-white/[0.06] text-muted-foreground/20"
                  }`}
                >
                  {isDone ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
                    </svg>
                  ) : isCurrent && !isError ? (
                    <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                  ) : (
                    <div className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={`w-px h-6 transition-all ${
                      isDone ? "bg-emerald-500/30" : "bg-white/[0.06]"
                    }`}
                  />
                )}
              </div>

              {/* Label + description */}
              <div className="pb-4 -mt-0.5">
                <p
                  className={`text-sm font-medium transition-all ${
                    isDone
                      ? "text-emerald-400/70"
                      : isCurrent
                        ? "text-foreground"
                        : "text-muted-foreground/30"
                  }`}
                >
                  {s.label}
                </p>
                {(isCurrent || isDone) && (
                  <p className="text-[11px] text-muted-foreground/40 mt-0.5">
                    {s.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Backend status badge */}
      {swap.backendStatus && (
        <div className="flex items-center justify-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.06]">
            <div className={`h-1.5 w-1.5 rounded-full ${
              step === "success" ? "bg-emerald-400" :
              step === "error" ? "bg-red-400" :
              "bg-blue-400 animate-pulse"
            }`} />
            <span className="text-[10px] text-muted-foreground/40 font-mono uppercase tracking-wider">
              {swap.backendStatus}
            </span>
          </span>
        </div>
      )}

      {/* Claim tx hash */}
      {swap.claimTxHash && (
        <div className="rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.12] px-4 py-3">
          <p className="text-[10px] text-emerald-400/60 uppercase tracking-[0.15em] font-medium mb-1">
            Claim Transaction
          </p>
          <code className="text-xs text-emerald-400/80 font-mono break-all">
            {swap.claimTxHash}
          </code>
        </div>
      )}
    </div>
  );
}
