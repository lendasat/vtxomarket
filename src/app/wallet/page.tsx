"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import { safeUrl } from "@/lib/safe-url";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/lib/store";
import { useTokens } from "@/hooks/useTokens";
import {
  getBalance,
  getReceivingAddresses,
  sendPayment,
  sendAsset,
  getTransactionHistory,
  getAspOnchainFee,
  renewVtxos,
} from "@/lib/ark-wallet";
import type { TxHistoryItem } from "@/lib/ark-wallet";
import { getInvoiceSatoshis } from "@/lib/lightning";
import {
  isLnurlOrLightningAddress,
  isLightningAddress,
  fetchPayParams,
  requestInvoice,
  minSats,
  maxSats,
  type LnurlPayParams,
} from "@/lib/lnurl";
import { useLightning } from "@/hooks/useLightning";
import { WalletDebug } from "@/components/wallet-debug";
import {
  StablecoinSend as LendaswapStablecoinSend,
  StablecoinReceive as LendaswapStablecoinReceive,
  useLendaswapHistory,
} from "@/lendaswap_integration";
import type { StablecoinTxItem } from "@/lendaswap_integration/lib/types";
import { formatSats, formatTokenAmount, parseTokenInput } from "@/lib/format";

type Tab = "onchain" | "lightning" | "arkade" | "stablecoin";
type Mode = null | "send" | "receive" | "debug";
type WalletView = "overview" | "history";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  {
    key: "onchain",
    label: "Onchain",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3"
      >
        <path
          fillRule="evenodd"
          d="M8.914 6.025a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95l-2 2a3.5 3.5 0 0 1-5.95-2.475.75.75 0 0 1 1.5 0 2 2 0 0 0 3.41 1.414l2-2a2 2 0 0 0 0-2.828.75.75 0 0 1 0-1.06Z"
          clipRule="evenodd"
        />
        <path
          fillRule="evenodd"
          d="M7.086 9.975a.75.75 0 0 1-1.06 0 3.5 3.5 0 0 1 0-4.95l2-2a3.5 3.5 0 0 1 5.95 2.475.75.75 0 0 1-1.5 0 2 2 0 0 0-3.41-1.414l-2 2a2 2 0 0 0 0 2.828.75.75 0 0 1 0 1.06Z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  {
    key: "lightning",
    label: "Lightning",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3"
      >
        <path d="M9.58 1.077a.75.75 0 0 1 .405.82L9.165 6h4.085a.75.75 0 0 1 .567 1.241l-6.5 7.5a.75.75 0 0 1-1.302-.638L6.835 10H2.75a.75.75 0 0 1-.567-1.241l6.5-7.5a.75.75 0 0 1 .897-.182Z" />
      </svg>
    ),
  },
  {
    key: "arkade",
    label: "Arkade",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3"
      >
        <path d="M8.372 1.349a.75.75 0 0 0-.744 0l-4.81 2.748L8 7.131l5.182-3.034-4.81-2.748ZM14 5.357 8.75 8.43v6.005l4.872-2.784A.75.75 0 0 0 14 11V5.357ZM7.25 14.435V8.43L2 5.357V11c0 .27.144.518.378.651l4.872 2.784Z" />
      </svg>
    ),
  },
  {
    key: "stablecoin",
    label: "Stablecoins",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3"
      >
        <path
          fillRule="evenodd"
          d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM8.75 4.37V4a.75.75 0 0 0-1.5 0v.37c-.906.27-1.75.96-1.75 2.13 0 1.42 1.2 2 2.5 2.36 1.07.3 1.25.6 1.25.89 0 .5-.48.88-1.25.88s-1.25-.38-1.25-.88a.75.75 0 0 0-1.5 0c0 1.17.844 1.86 1.75 2.13V12a.75.75 0 0 0 1.5 0v-.37c.906-.27 1.75-.96 1.75-2.13 0-1.42-1.2-2-2.5-2.36-1.07-.3-1.25-.6-1.25-.89 0-.5.48-.88 1.25-.88s1.25.38 1.25.88a.75.75 0 0 0 1.5 0c0-1.17-.844-1.86-1.75-2.13Z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
];

export default function WalletPage() {
  const balance = useAppStore((s) => s.balance);
  const addresses = useAppStore((s) => s.addresses);
  const walletReady = useAppStore((s) => s.walletReady);
  const walletError = useAppStore((s) => s.walletError);
  const hasCachedData = useAppStore((s) => s.hasCachedData);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const setBalance = useAppStore((s) => s.setBalance);
  const setAddresses = useAppStore((s) => s.setAddresses);
  const heldAssets = useAppStore((s) => s.heldAssets);
  // Load token metadata from Nostr (needed if user navigates here directly)
  useTokens();
  // Load LendaSwap swap history into the store on mount (regardless of active tab)
  useLendaswapHistory();
  const tokens = useAppStore((s) => s.tokens);
  const stablecoinTxs = useAppStore((s) => s.stablecoinTxs);

  // Map held assets to token metadata
  const userTokens = heldAssets
    .filter((a) => a.amount > 0)
    .map((a) => {
      const token = tokens.find((t) => t.assetId === a.assetId);
      return {
        assetId: a.assetId,
        amount: a.amount,
        decimals: token?.decimals,
        name: token?.name ?? "Unknown",
        ticker: token?.ticker ?? "???",
        image: token?.image,
      };
    });

  const {
    ready: lnReady,
    initError: lnInitError,
    calcSendFee,
    calcReceiveFee,
    sendLightning,
    receiveLightning,
    waitForReceive,
  } = useLightning();

  const [mode, setMode] = useState<Mode>(null);
  const [tab, setTab] = useState<Tab>("arkade");
  const [copied, setCopied] = useState(false);
  const [walletView, setWalletView] = useState<WalletView>("overview");
  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState("");

  // Send state
  const [sendAddress, setSendAddress] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");
  const [estimatedFee, setEstimatedFee] = useState<number | null>(null);
  const [sendAssetId, setSendAssetId] = useState<string | null>(null);

  // Lightning receive state
  const [lnReceiveAmount, setLnReceiveAmount] = useState("");
  const [lnInvoice, setLnInvoice] = useState("");
  const [lnWaiting, setLnWaiting] = useState(false);
  const [lnSuccess, setLnSuccess] = useState(false);

  // Lightning send state
  const [lnSendInvoice, setLnSendInvoice] = useState("");
  const [lnSendLoading, setLnSendLoading] = useState(false);
  const [lnSendResult, setLnSendResult] = useState<string | null>(null);
  const [lnError, setLnError] = useState("");

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const truncateAddr = (addr: string, chars = 12) => {
    if (addr.length <= chars * 2 + 3) return addr;
    return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
  };

  const refreshBalance = useCallback(async () => {
    if (!arkWallet) return;
    const [bal, addrs] = await Promise.all([
      getBalance(arkWallet),
      getReceivingAddresses(arkWallet),
    ]);
    setBalance(bal);
    setAddresses(addrs);
    // Persist immediately so closing the tab after a send doesn't show stale data
    const { saveWalletCache } = await import("@/lib/wallet-cache");
    const s = useAppStore.getState();
    saveWalletCache({
      balance: bal,
      addresses: addrs,
      heldAssets: s.heldAssets,
      profile: s.profile,
    });
  }, [arkWallet, setBalance, setAddresses]);

  // Auto-recover swept/recoverable VTXOs when detected
  const autoRecoverAttempted = useRef(false);
  useEffect(() => {
    if (!arkWallet || !balance || balance.recoverable <= 0) return;
    if (autoRecoverAttempted.current) return;
    autoRecoverAttempted.current = true;
    console.log("[wallet] Auto-recovering %d recoverable sats...", balance.recoverable);
    renewVtxos(arkWallet)
      .then(async (txid) => {
        if (txid) {
          console.log("[wallet] Auto-recovery complete, txid:", txid);
          // Refresh balance to reflect recovered sats
          const bal = await getBalance(arkWallet);
          setBalance(bal);
        } else {
          console.log("[wallet] Auto-recovery: nothing to recover");
        }
      })
      .catch((err) => {
        console.warn("[wallet] Auto-recovery failed:", err);
      })
      .finally(() => {
        // Allow retry on next balance change
        autoRecoverAttempted.current = false;
      });
  }, [arkWallet, balance, setBalance]);

  // Fetch ASP's onchain output fee (flat service fee, not mining fee)
  useEffect(() => {
    if (tab !== "onchain") {
      setEstimatedFee(null);
      return;
    }
    let cancelled = false;
    getAspOnchainFee().then((fee) => {
      if (!cancelled) setEstimatedFee(fee);
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const loadHistory = useCallback(async () => {
    if (!arkWallet) return;
    setTxLoading(true);
    setTxError("");
    try {
      const history = await getTransactionHistory(arkWallet);
      // Sort newest first
      history.sort((a, b) => b.createdAt - a.createdAt);
      setTxHistory(history);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load history";
      console.error("[wallet] Failed to load tx history:", e);
      setTxError(msg);
    } finally {
      setTxLoading(false);
    }
  }, [arkWallet]);

  useEffect(() => {
    if (walletView === "history" && walletReady) {
      loadHistory();
    }
  }, [walletView, walletReady, loadHistory]);

  const handleReceive = async () => {
    if (arkWallet && !addresses) {
      const addr = await getReceivingAddresses(arkWallet);
      setAddresses(addr);
    }
    setMode("receive");
  };

  const handleSend = async () => {
    if (!arkWallet || !sendAddress || !sendAmount) return;
    const selectedToken =
      sendAssetId && tab === "arkade" ? userTokens.find((t) => t.assetId === sendAssetId) : null;
    const amt = selectedToken
      ? parseTokenInput(sendAmount, selectedToken.decimals)
      : parseInt(sendAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      setSendError("Invalid amount");
      return;
    }
    setSendLoading(true);
    setSendError("");
    setSendResult(null);
    try {
      let txid: string;
      if (sendAssetId && tab === "arkade") {
        txid = await sendAsset(arkWallet, sendAddress, sendAssetId, amt);
      } else {
        txid = await sendPayment(arkWallet, sendAddress, amt);
      }
      setSendResult(txid);
      setSendAddress("");
      setSendAmount("");
      setSendAssetId(null);
      await refreshBalance();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSendLoading(false);
    }
  };

  const resetMode = () => {
    setMode(null);
    setCopied(false);
    setSendResult(null);
    setSendError("");
    setSendAddress("");
    setSendAmount("");
    setLnReceiveAmount("");
    setLnInvoice("");
    setLnWaiting(false);
    setLnSuccess(false);
    setLnSendInvoice("");
    setLnSendLoading(false);
    setLnSendResult(null);
    setLnError("");
    setSendAssetId(null);
  };

  const addressForTab = (t: Tab): string => {
    if (t === "arkade") return addresses?.offchainAddr || "...";
    if (t === "onchain") return addresses?.boardingAddr || "...";
    return "";
  };

  const totalSats = balance?.available ?? 0;

  return (
    <>
      <div className="mx-auto max-w-lg pb-36 md:pb-6 space-y-6">
        {/* ── Balance hero ── */}
        <div className="pt-4 sm:pt-8 pb-2 text-center">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/40 font-medium">
            Spendable Balance
          </p>
          {walletReady || hasCachedData ? (
            <>
              <p
                className={`mt-3 text-5xl sm:text-6xl font-bold tabular-nums tracking-tight ${hasCachedData && !walletReady ? "text-muted-foreground/50" : ""}`}
              >
                {totalSats.toLocaleString()}
              </p>
              <p className="mt-1 text-sm text-muted-foreground/40">sats</p>
              {hasCachedData && !walletReady && (
                <div className="flex items-center justify-center gap-2 mt-3">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
                  <p className="text-xs text-muted-foreground/40">Syncing...</p>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="mt-3 text-5xl font-bold tabular-nums text-muted-foreground/20">—</p>
              {walletError ? (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-red-400/80">{walletError}</p>
                  <button
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/[0.07] border border-white/[0.1] text-xs font-medium transition-all hover:bg-white/[0.12]"
                  >
                    <RefreshIcon className="size-3" />
                    Retry
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 mt-3">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
                  <p className="text-xs text-muted-foreground/40">Connecting to Ark...</p>
                </div>
              )}
            </>
          )}

          {/* Boarding settlement notice */}
          {balance && balance.onchain > 0 && (
            <div className="flex items-center justify-center gap-2 mt-5 px-3 py-2 rounded-full bg-orange-500/[0.08] border border-orange-500/[0.12] mx-auto w-fit">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-orange-400/40 border-t-orange-400" />
              <span className="text-[11px] text-orange-400/80 font-medium">
                Settling {balance.onchain.toLocaleString()} sats
                {balance.onchainConfirmed > 0 ? "..." : " (awaiting confirmation)"}
              </span>
            </div>
          )}

          {/* Utility links */}
          <div className="flex items-center justify-center gap-4 mt-4">
            <button
              onClick={refreshBalance}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
            >
              <RefreshIcon className="size-3" />
              Refresh
            </button>
            <button
              onClick={() => setMode("debug")}
              className="flex items-center gap-1.5 text-[11px] text-orange-400/50 hover:text-orange-400 transition-colors"
            >
              <BugIcon className="size-3" />
              Debug
            </button>
          </div>
        </div>

        {/* ── View toggle ── */}
        <div className="flex gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.07]">
          {(["overview", "history"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setWalletView(v)}
              className={`flex-1 py-2.5 rounded-lg text-xs font-medium transition-all ${
                walletView === v
                  ? "bg-white/[0.1] text-foreground shadow-sm"
                  : "text-muted-foreground/50 hover:text-muted-foreground/70"
              }`}
            >
              {v === "overview" ? "Overview" : "History"}
            </button>
          ))}
        </div>

        {walletView === "history" ? (
          /* ── Transaction History ── */
          <TransactionHistoryView
            txHistory={txHistory}
            stablecoinTxs={stablecoinTxs}
            txLoading={txLoading}
            txError={txError}
            walletReady={walletReady}
            onRefresh={loadHistory}
          />
        ) : (
          <>
            {/* ── Assets breakdown ── */}
            <div className="space-y-3">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
                Assets
              </p>
              <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm divide-y divide-white/[0.06] overflow-hidden">
                <AssetRow
                  icon={<BitcoinIcon className="size-9" />}
                  name="Bitcoin"
                  description="Arkade"
                  value={balance?.available ?? 0}
                  iconFill
                />
                {balance && balance.onchain > 0 && (
                  <AssetRow
                    icon={<ClockIcon className="size-4 text-orange-400/80" />}
                    name="Settling"
                    description={
                      balance.onchainConfirmed > 0 ? "Auto-boarding" : "Awaiting confirmation"
                    }
                    value={balance.onchain}
                  />
                )}
                {balance && balance.recoverable > 0 && (
                  <AssetRow
                    icon={<AlertIcon className="size-4 text-yellow-400/80" />}
                    name="Recoverable"
                    description="Needs action"
                    value={balance.recoverable}
                    highlight
                  />
                )}
              </div>
            </div>

            {/* ── Your Tokens ── */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
                  Your Tokens
                </p>
                <Link
                  href="/"
                  className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                >
                  View all
                </Link>
              </div>

              {userTokens.length === 0 ? (
                <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] p-8 text-center">
                  <p className="text-xs text-muted-foreground/40">No tokens yet</p>
                  <Link
                    href="/create"
                    className="mt-3 inline-block text-xs text-foreground/70 hover:text-foreground transition-colors underline underline-offset-4"
                  >
                    Create your first token
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  {userTokens.map((token) => (
                    <Link
                      key={token.assetId}
                      href={`/token/${token.ticker}`}
                      className="glass-card flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] hover:border-white/[0.1] transition-all group"
                    >
                      {/* Token icon */}
                      <div className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.06] border border-white/[0.06] flex items-center justify-center text-[10px] font-bold text-muted-foreground/50 tracking-wider">
                        {token.image ? (
                          <img
                            src={safeUrl(token.image) ?? ""}
                            alt={token.name}
                            className="h-full w-full rounded-xl object-cover"
                          />
                        ) : (
                          token.ticker.slice(0, 2)
                        )}
                      </div>

                      {/* Name + holding */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold truncate">{token.name}</span>
                          <span className="text-[10px] font-mono text-muted-foreground/40">
                            ${token.ticker}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/40 tabular-nums">
                          {formatTokenAmount(token.amount, token.decimals)} tokens
                        </p>
                      </div>

                      {/* Amount */}
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold tabular-nums">
                          {formatTokenAmount(token.amount, token.decimals)}
                          <span className="text-[10px] text-muted-foreground/30 ml-0.5">
                            tokens
                          </span>
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Floating Send / Receive buttons ── */}
      {!mode && (
        <div
          className="fixed bottom-28 md:bottom-6 left-0 right-0 md:left-[60px] z-40 pointer-events-none"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="mx-auto max-w-lg px-4 flex gap-3 pointer-events-auto">
            <button
              disabled={!walletReady}
              onClick={() => handleReceive()}
              className="flex-1 h-12 rounded-2xl bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] text-sm font-semibold flex items-center justify-center gap-2 shadow-[0_8px_32px_rgba(0,0,0,0.3)] transition-all hover:bg-white/[0.12] hover:border-white/[0.14] hover:shadow-[0_8px_40px_rgba(0,0,0,0.4)] active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowDownIcon className="size-4" />
              Receive
            </button>
            <button
              disabled={!walletReady}
              onClick={() => setMode("send")}
              className="flex-1 h-12 rounded-2xl bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] text-sm font-semibold flex items-center justify-center gap-2 shadow-[0_8px_32px_rgba(0,0,0,0.3)] transition-all hover:bg-white/[0.12] hover:border-white/[0.14] hover:shadow-[0_8px_40px_rgba(0,0,0,0.4)] active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowUpIcon className="size-4" />
              Send
            </button>
          </div>
        </div>
      )}

      {/* ── Send / Receive / Debug overlay ── */}
      {mode && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetMode} />

          {/* Bottom sheet on mobile, centered modal on desktop */}
          <div className="relative w-full sm:max-w-md sm:mx-4 rounded-t-2xl sm:rounded-2xl border-t sm:border border-white/[0.1] bg-card/95 backdrop-blur-2xl shadow-[0_16px_64px_rgba(0,0,0,0.5)] overflow-hidden max-h-[85vh] overflow-y-auto">
            {/* Handle bar (mobile) */}
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-white/[0.15]" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-3 sm:pt-5 pb-3">
              <h2 className="text-base font-semibold">
                {mode === "debug" ? "Debug" : mode === "send" ? "Send" : "Receive"}
              </h2>
              <button
                onClick={resetMode}
                className="h-8 w-8 rounded-lg bg-white/[0.06] flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.1] transition-all"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-4 w-4"
                >
                  <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                </svg>
              </button>
            </div>

            {/* Debug content */}
            {mode === "debug" && (
              <div className="px-5 pb-5">
                <WalletDebug />
              </div>
            )}

            {/* Send / Receive content */}
            {mode !== "debug" && (
              <div className="px-5 pb-5 space-y-4">
                {/* Tabs */}
                <div className="flex gap-1.5 p-1 rounded-xl bg-white/[0.04] border border-white/[0.07]">
                  {TABS.map(({ key, label, icon }) => {
                    const active = tab === key;
                    return (
                      <button
                        key={key}
                        onClick={() => {
                          setTab(key);
                          setCopied(false);
                        }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all ${
                          active
                            ? "bg-white/[0.1] text-foreground shadow-sm"
                            : "text-muted-foreground/50 hover:text-muted-foreground/70"
                        }`}
                      >
                        {icon}
                        {label}
                      </button>
                    );
                  })}
                </div>

                {/* ── RECEIVE ── */}
                {mode === "receive" && (
                  <div>
                    {tab === "stablecoin" ? (
                      <LendaswapStablecoinReceive />
                    ) : tab === "lightning" ? (
                      <LightningReceive
                        lnReady={lnReady}
                        lnInitError={lnInitError}
                        lnSuccess={lnSuccess}
                        lnWaiting={lnWaiting}
                        lnInvoice={lnInvoice}
                        lnReceiveAmount={lnReceiveAmount}
                        lnError={lnError}
                        copied={copied}
                        calcReceiveFee={calcReceiveFee}
                        setLnReceiveAmount={setLnReceiveAmount}
                        setLnError={setLnError}
                        setLnInvoice={setLnInvoice}
                        setLnWaiting={setLnWaiting}
                        setLnSuccess={setLnSuccess}
                        receiveLightning={receiveLightning}
                        waitForReceive={waitForReceive}
                        copyToClipboard={copyToClipboard}
                        truncateAddr={truncateAddr}
                        refreshBalance={refreshBalance}
                      />
                    ) : (
                      <>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-[0.15em] mb-4">
                          Your {tab === "arkade" ? "Arkade" : "Onchain Boarding"} Address
                        </p>
                        <div className="flex justify-center py-2">
                          <div className="rounded-xl bg-white p-3">
                            <QRCodeSVG
                              value={addressForTab(tab)}
                              size={160}
                              bgColor="#ffffff"
                              fgColor="#111827"
                              level="M"
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => copyToClipboard(addressForTab(tab))}
                          className="mt-4 w-full flex items-center justify-between gap-3 py-3 px-4 rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] transition-all"
                        >
                          <code className="text-xs text-muted-foreground/60 break-all">
                            {truncateAddr(addressForTab(tab))}
                          </code>
                          <span className="shrink-0 text-xs font-medium text-muted-foreground/50">
                            {copied ? "Copied!" : "Copy"}
                          </span>
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* ── SEND ── */}
                {mode === "send" && (
                  <div>
                    {tab === "stablecoin" ? (
                      <LendaswapStablecoinSend />
                    ) : tab === "lightning" ? (
                      <LightningSend
                        lnReady={lnReady}
                        lnInitError={lnInitError}
                        lnSendInvoice={lnSendInvoice}
                        lnSendLoading={lnSendLoading}
                        lnSendResult={lnSendResult}
                        lnError={lnError}
                        copied={copied}
                        calcSendFee={calcSendFee}
                        setLnSendInvoice={setLnSendInvoice}
                        setLnError={setLnError}
                        sendLightning={sendLightning}
                        setLnSendResult={setLnSendResult}
                        setLnSendLoading={setLnSendLoading}
                        copyToClipboard={copyToClipboard}
                        truncateAddr={truncateAddr}
                        refreshBalance={refreshBalance}
                      />
                    ) : (
                      <>
                        {sendResult ? (
                          <SuccessView
                            txid={sendResult}
                            copied={copied}
                            copyToClipboard={copyToClipboard}
                            truncateAddr={truncateAddr}
                          />
                        ) : (
                          <div className="space-y-4">
                            {tab === "arkade" && userTokens.length > 0 && (
                              <div className="space-y-2">
                                <label className="text-[11px] text-muted-foreground/50 font-medium">
                                  Asset
                                </label>
                                <select
                                  value={sendAssetId ?? ""}
                                  onChange={(e) => {
                                    setSendAssetId(e.target.value || null);
                                    setSendAmount("");
                                  }}
                                  className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all appearance-none cursor-pointer"
                                >
                                  <option value="" className="bg-[#1a1a1a]">
                                    Bitcoin (BTC)
                                  </option>
                                  {userTokens.map((t) => (
                                    <option
                                      key={t.assetId}
                                      value={t.assetId}
                                      className="bg-[#1a1a1a]"
                                    >
                                      {t.name} ({t.ticker}) —{" "}
                                      {formatTokenAmount(t.amount, t.decimals)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div className="space-y-2">
                              <label className="text-[11px] text-muted-foreground/50 font-medium">
                                {tab === "arkade" ? "Arkade Address" : "Bitcoin Address"}
                              </label>
                              <input
                                value={sendAddress}
                                onChange={(e) => setSendAddress(e.target.value)}
                                placeholder="Paste address..."
                                className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-[11px] text-muted-foreground/50 font-medium">
                                {sendAssetId && tab === "arkade"
                                  ? `Amount (${userTokens.find((t) => t.assetId === sendAssetId)?.ticker ?? "tokens"})`
                                  : "Amount (sats)"}
                              </label>
                              <input
                                type="number"
                                value={sendAmount}
                                onChange={(e) => setSendAmount(e.target.value)}
                                placeholder="0"
                                className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
                              />
                              {sendAssetId && tab === "arkade" ? (
                                <button
                                  type="button"
                                  className="text-[11px] text-muted-foreground/40 hover:text-foreground/60 transition-colors"
                                  onClick={() => {
                                    const t = userTokens.find((t) => t.assetId === sendAssetId);
                                    setSendAmount(String(t?.amount ?? 0));
                                  }}
                                >
                                  Max:{" "}
                                  {formatTokenAmount(
                                    userTokens.find((t) => t.assetId === sendAssetId)?.amount ?? 0,
                                    userTokens.find((t) => t.assetId === sendAssetId)?.decimals
                                  )}{" "}
                                  {userTokens.find((t) => t.assetId === sendAssetId)?.ticker ??
                                    "tokens"}
                                </button>
                              ) : (
                                balance && (
                                  <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground/40 hover:text-foreground/60 transition-colors"
                                    onClick={() => setSendAmount(String(balance.available))}
                                  >
                                    Max: {balance.available.toLocaleString()} sats
                                  </button>
                                )
                              )}
                            </div>
                            {tab === "onchain" &&
                              sendAmount &&
                              parseInt(sendAmount) > 0 &&
                              estimatedFee !== null && (
                                <p className="text-[11px] text-muted-foreground/40">
                                  Network fee: {estimatedFee} sats &middot; Total:{" "}
                                  {(parseInt(sendAmount) + estimatedFee).toLocaleString()} sats
                                </p>
                              )}
                            {sendError && <p className="text-xs text-red-400/80">{sendError}</p>}
                            <button
                              disabled={sendLoading || !sendAddress || !sendAmount}
                              onClick={handleSend}
                              className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {sendLoading ? "Sending..." : "Send"}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Safe area spacer */}
                <div className="h-[env(safe-area-inset-bottom)] sm:hidden" />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ===================== Transaction History =====================

type UnifiedTxItem =
  | { kind: "ark"; data: TxHistoryItem }
  | { kind: "stablecoin"; data: StablecoinTxItem };

function TransactionHistoryView({
  txHistory,
  stablecoinTxs,
  txLoading,
  txError,
  walletReady,
  onRefresh,
}: {
  txHistory: TxHistoryItem[];
  stablecoinTxs: StablecoinTxItem[];
  txLoading: boolean;
  txError?: string;
  walletReady: boolean;
  onRefresh: () => void;
}) {
  // Merge ark + stablecoin txs, sorted newest-first
  const unified: UnifiedTxItem[] = useMemo(() => {
    const ark: UnifiedTxItem[] = txHistory.map((tx) => ({ kind: "ark" as const, data: tx }));
    const stable: UnifiedTxItem[] = stablecoinTxs.map((tx) => ({
      kind: "stablecoin" as const,
      data: tx,
    }));
    const now = Date.now();

    const toMs = (item: UnifiedTxItem): number => {
      const raw = item.data.createdAt;
      if (!raw || raw === 0) return now;
      if (item.kind === "ark") {
        // Ark txs: always unix seconds
        return raw * 1000;
      }
      // Stablecoin txs: should be ms, but guard against seconds
      // If value looks like seconds (< year 2001 in ms = ~10^12), convert
      return raw < 1e12 ? raw * 1000 : raw;
    };

    return [...ark, ...stable].sort((a, b) => {
      const aTime = toMs(a);
      const bTime = toMs(b);
      return (bTime || now) - (aTime || now);
    });
  }, [txHistory, stablecoinTxs]);

  if (!walletReady) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
        <p className="text-xs text-muted-foreground/40">Connecting to wallet...</p>
      </div>
    );
  }

  if (txLoading && unified.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
        <p className="text-xs text-muted-foreground/40">Loading transactions...</p>
      </div>
    );
  }

  if (txError && unified.length === 0) {
    return (
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] p-8 text-center space-y-2">
        <p className="text-xs text-red-400/80">{txError}</p>
        <button
          onClick={onRefresh}
          className="text-[10px] text-muted-foreground/50 hover:text-foreground/60 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (unified.length === 0) {
    return (
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] p-8 text-center">
        <HistoryIcon className="size-8 text-muted-foreground/20 mx-auto" />
        <p className="mt-3 text-sm text-muted-foreground/40">No transactions yet</p>
        <p className="mt-1 text-[11px] text-muted-foreground/30">
          Send or receive sats to see your history
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
          Transactions
        </p>
        <button
          onClick={onRefresh}
          disabled={txLoading}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors disabled:opacity-30"
        >
          <RefreshIcon className={`size-3 ${txLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm divide-y divide-white/[0.06] overflow-hidden">
        {unified.map((item, i) =>
          item.kind === "ark" ? (
            <TxRow
              key={`${item.data.arkTxid || item.data.boardingTxid || item.data.commitmentTxid}-${i}`}
              tx={item.data}
            />
          ) : (
            <StablecoinTxRow key={item.data.swapId} tx={item.data} />
          )
        )}
      </div>
    </div>
  );
}

function TxRow({ tx }: { tx: TxHistoryItem }) {
  const isSent = tx.type === "SENT";
  const date = new Date(tx.createdAt * 1000);
  const timeStr = formatTxTime(date);
  const txid = tx.arkTxid || tx.commitmentTxid || tx.boardingTxid;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          isSent ? "bg-red-500/[0.08] text-red-400/70" : "bg-emerald-500/[0.08] text-emerald-400/70"
        }`}
      >
        {isSent ? <ArrowUpIcon className="size-4" /> : <ArrowDownIcon className="size-4" />}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{isSent ? "Sent" : "Received"}</p>
          {!tx.settled && tx.boardingTxid && (
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-orange-500/[0.06] text-orange-400/60 border border-orange-500/[0.1]">
              Settling...
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/35 mt-0.5">
          {timeStr}
          {txid && (
            <>
              <span className="mx-1.5 text-white/[0.06]">&middot;</span>
              <span className="font-mono">
                {txid.slice(0, 8)}...{txid.slice(-4)}
              </span>
            </>
          )}
        </p>
      </div>

      <span
        className={`text-sm font-semibold tabular-nums ${
          isSent ? "text-red-400/80" : "text-emerald-400/80"
        }`}
      >
        {isSent ? "-" : "+"}
        {tx.amount.toLocaleString()}
        <span className="text-[10px] text-muted-foreground/30 ml-1">sats</span>
      </span>
    </div>
  );
}

// Statuses where collaborative refund is available immediately (arkade_to_evm only)
const COLLAB_REFUNDABLE_STATUSES = new Set([
  "clientfundedserverrefunded",
  "clientinvalidfunded",
  "clientfundedtoolate",
]);

// Additional statuses that may be refundable (locktime-based, SDK checks internally)
const LOCKTIME_REFUNDABLE_STATUSES = new Set([
  "expired",
  "clientfundingseen",
  "clientfunded",
  "serverfunded",
]);

// Statuses where the swap was already refunded
const ALREADY_REFUNDED_STATUSES = new Set([
  "clientrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
]);

function StablecoinTxRow({ tx }: { tx: StablecoinTxItem }) {
  const [expanded, setExpanded] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [refundResult, setRefundResult] = useState<string | null>(null);
  const isSend = tx.direction === "send";
  const txDate = new Date(tx.createdAt);
  const timeStr = isNaN(txDate.getTime()) ? "Unknown" : formatTxTime(txDate);
  const isDone = tx.status === "complete";
  const isFailed = tx.status === "failed";
  const isAlreadyRefunded = ALREADY_REFUNDED_STATUSES.has(tx.backendStatus);

  const isRefundable =
    isSend &&
    !isAlreadyRefunded &&
    (COLLAB_REFUNDABLE_STATUSES.has(tx.backendStatus) ||
      LOCKTIME_REFUNDABLE_STATUSES.has(tx.backendStatus));

  const statusBadge = isAlreadyRefunded
    ? { label: "Refunded", cls: "bg-blue-500/[0.06] text-blue-400/60 border-blue-500/[0.1]" }
    : isRefundable
      ? {
          label: "Refundable",
          cls: "bg-orange-500/[0.06] text-orange-400/60 border-orange-500/[0.1]",
        }
      : isFailed
        ? { label: "Failed", cls: "bg-red-500/[0.06] text-red-400/60 border-red-500/[0.1]" }
        : isDone
          ? {
              label: "Complete",
              cls: "bg-emerald-500/[0.06] text-emerald-400/60 border-emerald-500/[0.1]",
            }
          : tx.status === "claiming"
            ? {
                label: "Claiming",
                cls: "bg-blue-500/[0.06] text-blue-400/60 border-blue-500/[0.1]",
                pulse: true,
              }
            : tx.status === "processing"
              ? {
                  label: "Processing",
                  cls: "bg-blue-500/[0.06] text-blue-400/60 border-blue-500/[0.1]",
                  pulse: true,
                }
              : tx.status === "pending"
                ? {
                    label: "Pending",
                    cls: "bg-blue-500/[0.06] text-blue-400/60 border-blue-500/[0.1]",
                    pulse: true,
                  }
                : null;

  const actionLabel = isAlreadyRefunded
    ? "Refunded"
    : isDone
      ? isSend
        ? "Sent"
        : "Received"
      : isFailed
        ? isSend
          ? "Send"
          : "Receive"
        : isSend
          ? "Sending"
          : "Receiving";

  return (
    <div>
      <div
        className="flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Icon */}
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            isSend
              ? "bg-red-500/[0.08] text-red-400/70"
              : "bg-emerald-500/[0.08] text-emerald-400/70"
          }`}
        >
          {isSend ? <ArrowUpIcon className="size-4" /> : <ArrowDownIcon className="size-4" />}
        </div>

        {/* Label + meta */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{actionLabel}</p>
          <p className="text-[11px] text-muted-foreground/35 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{timeStr}</span>
            <span className="text-white/[0.06]">&middot;</span>
            <span className="text-[8px] font-semibold px-1 py-px rounded bg-purple-500/[0.08] text-purple-400/50 uppercase tracking-wider">
              Swap
            </span>
            {statusBadge && (
              <span
                className={`inline-flex items-center gap-1 text-[8px] font-medium px-1 py-px rounded border ${statusBadge.cls}`}
              >
                {(statusBadge as { pulse?: boolean }).pulse && (
                  <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                )}
                {statusBadge.label}
              </span>
            )}
          </p>
        </div>

        {/* Amount */}
        <div className="shrink-0 text-right">
          <span
            className={`text-sm font-semibold tabular-nums ${isSend ? "text-red-400/80" : "text-emerald-400/80"}`}
          >
            {isSend ? "-" : "+"}
            {tx.stablecoinDisplay}
          </span>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mx-4 mb-3 rounded-xl bg-white/[0.02] border border-white/[0.05] p-3 space-y-2">
          {[
            ["Status", (tx.backendStatus ?? "unknown").toUpperCase()],
            ["Direction", isSend ? "BTC → Stablecoin" : "Stablecoin → BTC"],
            ...(tx.satsAmount ? [["Sats", `${tx.satsAmount.toLocaleString()} sats`]] : []),
            ...(tx.chain ? [["Chain", tx.chain.charAt(0).toUpperCase() + tx.chain.slice(1)]] : []),
            ...(tx.destinationAddress
              ? [
                  [
                    "To",
                    `${tx.destinationAddress.slice(0, 8)}...${tx.destinationAddress.slice(-4)}`,
                  ],
                ]
              : []),
            ...(tx.claimTxHash
              ? [["Claim TX", `${tx.claimTxHash.slice(0, 8)}...${tx.claimTxHash.slice(-4)}`]]
              : []),
            ["Swap ID", `${tx.swapId.slice(0, 8)}...${tx.swapId.slice(-4)}`],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <span className="text-[10px] text-muted-foreground/30 shrink-0">{label}</span>
              <span className="text-[10px] text-muted-foreground/50 font-mono text-right break-all">
                {value}
              </span>
            </div>
          ))}

          {isRefundable && !refundResult && (
            <button
              disabled={refunding}
              onClick={async (e) => {
                e.stopPropagation();
                setRefunding(true);
                try {
                  const { getLendaswapClient } = await import("@/lendaswap_integration/lib/client");
                  const client = await getLendaswapClient();
                  const addresses = useAppStore.getState().addresses;
                  if (!addresses?.offchainAddr) {
                    setRefundResult("No Arkade address available");
                    return;
                  }
                  const result = await client.refundSwap(tx.swapId, {
                    destinationAddress: addresses.offchainAddr,
                  });
                  if (result.success) {
                    setRefundResult(
                      result.txId
                        ? `Refund successful! TX: ${result.txId.slice(0, 12)}...`
                        : "Refund submitted"
                    );
                  } else {
                    setRefundResult(result.message || "Refund failed");
                  }
                } catch (err) {
                  setRefundResult(err instanceof Error ? err.message : "Refund failed");
                } finally {
                  setRefunding(false);
                }
              }}
              className="w-full h-8 rounded-lg bg-orange-500/[0.1] border border-orange-500/[0.15] text-[11px] font-semibold text-orange-400/80 transition-all hover:bg-orange-500/[0.15] disabled:opacity-40"
            >
              {refunding ? "Refunding..." : "Refund to Arkade wallet"}
            </button>
          )}
          {refundResult && (
            <p
              className={`text-[10px] text-center ${refundResult.startsWith("Refund successful") ? "text-emerald-400/70" : "text-muted-foreground/50"}`}
            >
              {refundResult}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatTxTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ===================== Sub-components =====================

function AssetRow({
  icon,
  name,
  description,
  value,
  highlight,
  iconFill,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  value: number;
  highlight?: boolean;
  iconFill?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl overflow-hidden ${iconFill ? "" : "bg-white/[0.06] text-muted-foreground/50"}`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-[11px] text-muted-foreground/35">{description}</p>
      </div>
      <span
        className={`text-sm font-semibold tabular-nums ${highlight ? "text-yellow-400/80" : ""}`}
      >
        {value.toLocaleString()}
        <span className="text-[10px] text-muted-foreground/30 ml-1">sats</span>
      </span>
    </div>
  );
}

function SuccessView({
  txid,
  copied,
  copyToClipboard,
  truncateAddr,
}: {
  txid: string;
  copied: boolean;
  copyToClipboard: (text: string) => void;
  truncateAddr: (addr: string, chars?: number) => string;
}) {
  return (
    <div className="text-center py-6 space-y-4">
      <CheckIcon className="size-12 text-emerald-400/80 mx-auto" />
      <p className="text-sm font-semibold text-emerald-400/80">Sent!</p>
      <button
        onClick={() => copyToClipboard(txid)}
        className="w-full flex items-center justify-between gap-2 py-3 px-4 rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] transition-all"
      >
        <span className="text-xs text-muted-foreground/50 font-mono truncate">
          txid: {truncateAddr(txid, 14)}
        </span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground/40">
          {copied ? "Copied!" : "Copy"}
        </span>
      </button>
    </div>
  );
}

function LightningReceive({
  lnReady,
  lnInitError,
  lnSuccess,
  lnWaiting,
  lnInvoice,
  lnReceiveAmount,
  lnError,
  copied,
  calcReceiveFee,
  setLnReceiveAmount,
  setLnError,
  setLnInvoice,
  setLnWaiting,
  setLnSuccess,
  receiveLightning,
  waitForReceive,
  copyToClipboard,
  truncateAddr,
  refreshBalance,
}: {
  lnReady: boolean;
  lnInitError: string | null;
  lnSuccess: boolean;
  lnWaiting: boolean;
  lnInvoice: string;
  lnReceiveAmount: string;
  lnError: string;
  copied: boolean;
  calcReceiveFee: (sats: number) => number;
  setLnReceiveAmount: (v: string) => void;
  setLnError: (v: string) => void;
  setLnInvoice: (v: string) => void;
  setLnWaiting: (v: boolean) => void;
  setLnSuccess: (v: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  receiveLightning: (sats: number) => Promise<{ invoice: string; swap: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForReceive: (swap: any) => Promise<void>;
  copyToClipboard: (text: string) => void;
  truncateAddr: (addr: string, chars?: number) => string;
  refreshBalance: () => Promise<void>;
}) {
  if (lnSuccess) {
    return (
      <div className="text-center py-8 space-y-3">
        <CheckIcon className="size-12 text-emerald-400/80 mx-auto" />
        <p className="text-sm font-semibold text-emerald-400/80">Payment Received!</p>
      </div>
    );
  }

  if (lnWaiting) {
    return (
      <div className="text-center space-y-4">
        {lnInvoice && (
          <>
            <div className="flex justify-center py-2">
              <div className="rounded-xl bg-white p-3">
                <QRCodeSVG
                  value={lnInvoice.toUpperCase()}
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#111827"
                  level="L"
                />
              </div>
            </div>
            <button
              onClick={() => copyToClipboard(lnInvoice)}
              className="w-full flex items-center justify-between gap-3 py-3 px-4 rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] transition-all"
            >
              <code className="text-xs text-muted-foreground/60 break-all">
                {truncateAddr(lnInvoice, 16)}
              </code>
              <span className="shrink-0 text-xs font-medium text-muted-foreground/50">
                {copied ? "Copied!" : "Copy"}
              </span>
            </button>
          </>
        )}
        <div className="flex items-center justify-center gap-2 pt-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
          <p className="text-xs text-muted-foreground/40">Waiting for payment...</p>
        </div>
      </div>
    );
  }

  if (!lnReady) {
    return (
      <div className="text-center py-8 space-y-3">
        {lnInitError ? (
          <>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-6 w-6 text-amber-400/70 mx-auto"
            >
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <p className="text-xs text-amber-400/70 max-w-[260px] mx-auto">{lnInitError}</p>
          </>
        ) : (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent mx-auto" />
            <p className="text-xs text-muted-foreground/40">Connecting to Lightning...</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-[11px] text-muted-foreground/50 font-medium">Amount (sats)</label>
        <input
          type="number"
          value={lnReceiveAmount}
          onChange={(e) => {
            setLnReceiveAmount(e.target.value);
            setLnError("");
          }}
          placeholder="0"
          className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
        />
      </div>
      {lnReceiveAmount && parseInt(lnReceiveAmount) > 0 && (
        <p className="text-[11px] text-muted-foreground/40">
          Fee: ~{calcReceiveFee(parseInt(lnReceiveAmount)).toLocaleString()} sats
        </p>
      )}
      {lnError && <p className="text-xs text-red-400/80">{lnError}</p>}
      <button
        disabled={!lnReceiveAmount || parseInt(lnReceiveAmount) <= 0}
        onClick={async () => {
          const sats = parseInt(lnReceiveAmount);
          if (isNaN(sats) || sats <= 0) {
            setLnError("Invalid amount");
            return;
          }
          setLnError("");
          try {
            const { invoice, swap } = await receiveLightning(sats);
            setLnInvoice(invoice);
            setLnWaiting(true);
            navigator.clipboard.writeText(invoice).catch(() => {});
            waitForReceive(swap)
              .then(() => {
                setLnWaiting(false);
                setLnSuccess(true);
                refreshBalance();
              })
              .catch((err) => {
                setLnWaiting(false);
                setLnError(err instanceof Error ? err.message : "Receive failed");
              });
          } catch (err) {
            setLnError(err instanceof Error ? err.message : "Failed to create invoice");
          }
        }}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Generate Invoice
      </button>
    </div>
  );
}

function LightningSend({
  lnReady,
  lnInitError,
  lnSendInvoice,
  lnSendLoading,
  lnSendResult,
  lnError,
  copied,
  calcSendFee,
  setLnSendInvoice,
  setLnError,
  sendLightning,
  setLnSendResult,
  setLnSendLoading,
  copyToClipboard,
  truncateAddr,
  refreshBalance,
}: {
  lnReady: boolean;
  lnInitError: string | null;
  lnSendInvoice: string;
  lnSendLoading: boolean;
  lnSendResult: string | null;
  lnError: string;
  copied: boolean;
  calcSendFee: (sats: number) => number;
  setLnSendInvoice: (v: string) => void;
  setLnError: (v: string) => void;
  sendLightning: (invoice: string) => Promise<{ txid: string }>;
  setLnSendResult: (v: string | null) => void;
  setLnSendLoading: (v: boolean) => void;
  copyToClipboard: (text: string) => void;
  truncateAddr: (addr: string, chars?: number) => string;
  refreshBalance: () => Promise<void>;
}) {
  const [lnurlParams, setLnurlParams] = useState<LnurlPayParams | null>(null);
  const [lnurlLoading, setLnurlLoading] = useState(false);
  const [lnurlAmount, setLnurlAmount] = useState("");

  const inputValue = lnSendInvoice.trim();
  const isLnurlInput = isLnurlOrLightningAddress(inputValue);
  const isBolt11 =
    !isLnurlInput && inputValue.length > 10 && inputValue.toLowerCase().startsWith("ln");

  const prevInputRef = useRef("");
  useEffect(() => {
    if (prevInputRef.current === inputValue) return;
    prevInputRef.current = inputValue;
    if (!isLnurlInput) {
      setLnurlParams(null);
      return;
    }
    let cancelled = false;
    setLnurlLoading(true);
    setLnurlParams(null);
    setLnError("");
    fetchPayParams(inputValue).then((params) => {
      if (cancelled) return;
      setLnurlLoading(false);
      if (params) setLnurlParams(params);
      else setLnError("Failed to resolve LNURL / Lightning Address");
    });
    return () => {
      cancelled = true;
    };
  }, [inputValue, isLnurlInput, setLnError]);

  if (lnSendResult) {
    return (
      <SuccessView
        txid={lnSendResult}
        copied={copied}
        copyToClipboard={copyToClipboard}
        truncateAddr={truncateAddr}
      />
    );
  }

  if (!lnReady) {
    return (
      <div className="text-center py-8 space-y-3">
        {lnInitError ? (
          <>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-6 w-6 text-amber-400/70 mx-auto"
            >
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <p className="text-xs text-amber-400/70 max-w-[260px] mx-auto">{lnInitError}</p>
          </>
        ) : (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent mx-auto" />
            <p className="text-xs text-muted-foreground/40">Connecting to Lightning...</p>
          </>
        )}
      </div>
    );
  }

  const handleSend = async () => {
    if (!inputValue) return;
    setLnSendLoading(true);
    setLnError("");
    try {
      let invoice: string;
      if (lnurlParams) {
        const sats = parseInt(lnurlAmount, 10);
        if (isNaN(sats) || sats <= 0) {
          setLnError("Enter a valid amount");
          setLnSendLoading(false);
          return;
        }
        const min = minSats(lnurlParams);
        const max = maxSats(lnurlParams);
        if (sats < min) {
          setLnError(`Minimum amount is ${min.toLocaleString()} sats`);
          setLnSendLoading(false);
          return;
        }
        if (sats > max) {
          setLnError(`Maximum amount is ${max.toLocaleString()} sats`);
          setLnSendLoading(false);
          return;
        }
        const result = await requestInvoice(lnurlParams.callback, sats);
        if (!result) {
          setLnError("Failed to get invoice from LNURL service");
          setLnSendLoading(false);
          return;
        }
        invoice = result.pr;
      } else {
        invoice = inputValue;
      }
      const { txid } = await sendLightning(invoice);
      setLnSendResult(txid);
      setLnSendInvoice("");
      setLnurlAmount("");
      await refreshBalance();
    } catch (err) {
      setLnError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setLnSendLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-[11px] text-muted-foreground/50 font-medium">
          Invoice, LNURL, or Lightning Address
        </label>
        <input
          value={lnSendInvoice}
          onChange={(e) => {
            setLnSendInvoice(e.target.value);
            setLnError("");
            setLnurlAmount("");
          }}
          placeholder="lnbc1..., lnurl1..., or user@domain.com"
          className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
        />
      </div>

      {lnurlLoading && (
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
          <p className="text-xs text-muted-foreground/40">
            Resolving {isLightningAddress(inputValue) ? "Lightning Address" : "LNURL"}...
          </p>
        </div>
      )}

      {lnurlParams && (
        <div className="space-y-4">
          <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4 space-y-1.5">
            <p className="text-xs text-muted-foreground/50">
              Pay to <span className="text-foreground/80 font-medium">{lnurlParams.domain}</span>
            </p>
            {lnurlParams.description && (
              <p className="text-xs text-muted-foreground/40">{lnurlParams.description}</p>
            )}
            <p className="text-xs text-muted-foreground/40">
              {minSats(lnurlParams).toLocaleString()} – {maxSats(lnurlParams).toLocaleString()} sats
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-[11px] text-muted-foreground/50 font-medium">
              Amount (sats)
            </label>
            <input
              type="number"
              value={lnurlAmount}
              onChange={(e) => {
                setLnurlAmount(e.target.value);
                setLnError("");
              }}
              placeholder={`${minSats(lnurlParams).toLocaleString()} - ${maxSats(lnurlParams).toLocaleString()}`}
              className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
            />
          </div>
          {lnurlAmount &&
            (() => {
              const sats = parseInt(lnurlAmount, 10);
              if (isNaN(sats) || sats <= 0) return null;
              const fee = calcSendFee(sats);
              return (
                <p className="text-[11px] text-muted-foreground/40">
                  Fee: ~{fee.toLocaleString()} sats &middot; Total: ~{(sats + fee).toLocaleString()}{" "}
                  sats
                </p>
              );
            })()}
        </div>
      )}

      {isBolt11 &&
        !lnurlParams &&
        (() => {
          try {
            const invoiceSats = getInvoiceSatoshis(inputValue);
            const fee = calcSendFee(invoiceSats);
            return (
              <div className="space-y-0.5">
                <p className="text-[11px] text-muted-foreground/50">
                  Amount:{" "}
                  <span className="text-foreground/80">{invoiceSats.toLocaleString()} sats</span>
                </p>
                <p className="text-[11px] text-muted-foreground/40">
                  Fee: ~{fee.toLocaleString()} sats &middot; Total: ~
                  {(invoiceSats + fee).toLocaleString()} sats
                </p>
              </div>
            );
          } catch {
            return <p className="text-xs text-red-400/80">Invalid invoice</p>;
          }
        })()}

      {lnError && <p className="text-xs text-red-400/80">{lnError}</p>}

      <button
        disabled={
          lnSendLoading || !inputValue || lnurlLoading || (lnurlParams ? !lnurlAmount : false)
        }
        onClick={handleSend}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {lnSendLoading ? "Sending..." : lnurlParams ? "Pay" : "Send"}
      </button>
    </div>
  );
}

// ===================== Icons =====================

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M10 3a.75.75 0 0 1 .75.75v10.638l3.96-4.158a.75.75 0 1 1 1.08 1.04l-5.25 5.5a.75.75 0 0 1-1.08 0l-5.25-5.5a.75.75 0 1 1 1.08-1.04l3.96 4.158V3.75A.75.75 0 0 1 10 3Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311V15a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75H8.5a.75.75 0 0 1 0 1.5H7.058l.398.397a4 4 0 0 0 6.693-1.793.75.75 0 0 1 1.163-.57ZM4.688 8.576a5.5 5.5 0 0 1 9.201-2.466l.312.311V5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75H11.5a.75.75 0 0 1 0-1.5h1.442l-.398-.397a4 4 0 0 0-6.693 1.793.75.75 0 0 1-1.163.57Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BugIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M6.56 1.14a.75.75 0 0 1 .177 1.045 3.989 3.989 0 0 0-.464.86c.185.17.382.329.59.473A6.048 6.048 0 0 1 10 3c1.272 0 2.463.39 3.137.518.208-.144.405-.303.59-.473a3.993 3.993 0 0 0-.464-.86.75.75 0 0 1 1.222-.869c.369.519.627 1.124.706 1.78a4.042 4.042 0 0 1-.96.834c-.1.079-.203.154-.31.225A5.527 5.527 0 0 1 15.5 7.5h.75a.75.75 0 0 1 0 1.5h-.876a7.552 7.552 0 0 1-.124 1H16a.75.75 0 0 1 0 1.5h-1.09A5.5 5.5 0 0 1 4.59 11.5H3.5a.75.75 0 0 1 0-1.5h.75c-.04-.328-.08-.66-.124-1H3.25a.75.75 0 0 1 0-1.5h.75A5.527 5.527 0 0 1 5.56 4.155c-.107-.07-.21-.146-.31-.225a4.042 4.042 0 0 1-.96-.834 4.238 4.238 0 0 1 .706-1.78.75.75 0 0 1 1.045-.177l.018.012ZM10 5a3.5 3.5 0 0 0-3.5 3.5 10.508 10.508 0 0 0 .053 1H13.447c.035-.328.053-.661.053-1A3.5 3.5 0 0 0 10 5Zm-3.362 6.5a4 4 0 0 0 6.724 0H6.638Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M8.914 6.025a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95l-2 2a3.5 3.5 0 0 1-5.95-2.475.75.75 0 0 1 1.5 0 2 2 0 0 0 3.41 1.414l2-2a2 2 0 0 0 0-2.828.75.75 0 0 1 0-1.06Z"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M7.086 9.975a.75.75 0 0 1-1.06 0 3.5 3.5 0 0 1 0-4.95l2-2a3.5 3.5 0 0 1 5.95 2.475.75.75 0 0 1-1.5 0 2 2 0 0 0-3.41-1.414l-2 2a2 2 0 0 0 0 2.828.75.75 0 0 1 0 1.06Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BitcoinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 4091.27 4091.73" fill="none" className={className}>
      <path
        d="M4030.06 2540.77c-273.24 1096.01-1383.32 1763.02-2479.46 1489.71C454.78 3757.18-212.17 2647.1 61.14 1551.17 334.25 455.3 1444.32-211.7 2540.47 61.51c1096.08 273.24 1762.97 1383.26 1489.59 2479.26z"
        fill="#f7931a"
      />
      <path
        d="M2947.77 1754.38c40.72-272.26-166.56-418.61-450-516.24l91.95-368.8-224.5-55.94-89.51 359.09c-59.02-14.72-119.63-28.59-179.87-42.34l90.16-361.46-224.36-55.94-92 368.68c-48.84-11.12-96.81-22.11-143.35-33.69l.26-1.16-309.59-77.31-59.72 239.78s166.56 38.18 163.05 40.53c90.91 22.69 107.35 82.87 104.62 130.57l-104.74 420.15c6.26 1.59 14.38 3.89 23.34 7.49-7.49-1.86-15.46-3.89-23.73-5.87l-146.81 588.57c-11.11 27.62-39.31 69.07-102.87 53.33 2.25 3.26-163.17-40.72-163.17-40.72l-111.46 256.98 292.15 72.83c54.35 13.63 107.61 27.89 160.06 41.3l-92.9 373.03 224.24 55.94 92-369.07c61.26 16.63 120.71 31.97 178.91 46.43l-91.69 367.33 224.51 55.94 92.89-372.33c382.82 72.45 670.67 43.24 791.83-303.02 97.63-278.78-4.86-439.58-206.26-544.44 146.69-33.83 257.18-130.31 286.64-329.61l-.07-.05zm-512.93 719.26c-69.38 278.78-538.76 128.08-690.94 90.29l123.28-494.2c152.17 37.93 640.17 113.17 567.67 403.91zm69.43-723.3c-63.29 253.58-453.96 124.75-580.69 93.16l111.77-448.21c126.73 31.59 534.85 90.55 468.94 355.05h-.02z"
        fill="#fff"
      />
    </svg>
  );
}

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path d="M8.372 1.349a.75.75 0 0 0-.744 0l-4.81 2.748L8 7.131l5.182-3.034-4.81-2.748ZM14 5.357 8.75 8.43v6.005l4.872-2.784A.75.75 0 0 0 14 11V5.357ZM7.25 14.435V8.43L2 5.357V11c0 .27.144.518.378.651l4.872 2.784Z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
