"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/lib/store";
import { getBalance, getReceivingAddresses, sendPayment, getTransactionHistory, ONCHAIN_FEE_SATS } from "@/lib/ark-wallet";
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
import { MOCK_TOKENS } from "@/lib/mock-tokens";

type Tab = "onchain" | "lightning" | "arkade" | "stablecoin";
type StableCoin = "USDC" | "USDT";
type StableChain = "arbitrum" | "ethereum" | "polygon";
type Mode = null | "send" | "receive" | "debug";
type WalletView = "overview" | "history";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  {
    key: "onchain",
    label: "Onchain",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
        <path fillRule="evenodd" d="M8.914 6.025a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95l-2 2a3.5 3.5 0 0 1-5.95-2.475.75.75 0 0 1 1.5 0 2 2 0 0 0 3.41 1.414l2-2a2 2 0 0 0 0-2.828.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
        <path fillRule="evenodd" d="M7.086 9.975a.75.75 0 0 1-1.06 0 3.5 3.5 0 0 1 0-4.95l2-2a3.5 3.5 0 0 1 5.95 2.475.75.75 0 0 1-1.5 0 2 2 0 0 0-3.41-1.414l-2 2a2 2 0 0 0 0 2.828.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    key: "lightning",
    label: "Lightning",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
        <path d="M9.58 1.077a.75.75 0 0 1 .405.82L9.165 6h4.085a.75.75 0 0 1 .567 1.241l-6.5 7.5a.75.75 0 0 1-1.302-.638L6.835 10H2.75a.75.75 0 0 1-.567-1.241l6.5-7.5a.75.75 0 0 1 .897-.182Z" />
      </svg>
    ),
  },
  {
    key: "arkade",
    label: "Arkade",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
        <path d="M8.372 1.349a.75.75 0 0 0-.744 0l-4.81 2.748L8 7.131l5.182-3.034-4.81-2.748ZM14 5.357 8.75 8.43v6.005l4.872-2.784A.75.75 0 0 0 14 11V5.357ZM7.25 14.435V8.43L2 5.357V11c0 .27.144.518.378.651l4.872 2.784Z" />
      </svg>
    ),
  },
  {
    key: "stablecoin",
    label: "Stablecoins",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
        <path fillRule="evenodd" d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM8.75 4.37V4a.75.75 0 0 0-1.5 0v.37c-.906.27-1.75.96-1.75 2.13 0 1.42 1.2 2 2.5 2.36 1.07.3 1.25.6 1.25.89 0 .5-.48.88-1.25.88s-1.25-.38-1.25-.88a.75.75 0 0 0-1.5 0c0 1.17.844 1.86 1.75 2.13V12a.75.75 0 0 0 1.5 0v-.37c.906-.27 1.75-.96 1.75-2.13 0-1.42-1.2-2-2.5-2.36-1.07-.3-1.25-.6-1.25-.89 0-.5.48-.88 1.25-.88s1.25.38 1.25.88a.75.75 0 0 0 1.5 0c0-1.17-.844-1.86-1.75-2.13Z" clipRule="evenodd" />
      </svg>
    ),
  },
];

// Mock user token holdings
const USER_TOKENS = MOCK_TOKENS.slice(0, 3).map((t) => ({
  ...t,
  holding: Math.floor(Math.random() * 10000 + 500),
}));

function formatSats(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function WalletPage() {
  const balance = useAppStore((s) => s.balance);
  const addresses = useAppStore((s) => s.addresses);
  const walletReady = useAppStore((s) => s.walletReady);
  const walletError = useAppStore((s) => s.walletError);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const setBalance = useAppStore((s) => s.setBalance);
  const setAddresses = useAppStore((s) => s.setAddresses);

  const {
    ready: lnReady,
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

  // Send state
  const [sendAddress, setSendAddress] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");

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

  // Stablecoin state
  const [stableCoin, setStableCoin] = useState<StableCoin>("USDC");
  const [stableChain, setStableChain] = useState<StableChain>("arbitrum");
  const [stableAmount, setStableAmount] = useState("");
  const [stableAddress, setStableAddress] = useState("");

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
  }, [arkWallet, setBalance, setAddresses]);

  const loadHistory = useCallback(async () => {
    if (!arkWallet) return;
    setTxLoading(true);
    try {
      const history = await getTransactionHistory(arkWallet);
      // Sort newest first
      history.sort((a, b) => b.createdAt - a.createdAt);
      setTxHistory(history);
    } catch (e) {
      console.error("[wallet] Failed to load tx history:", e);
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
    const sats = parseInt(sendAmount, 10);
    if (isNaN(sats) || sats <= 0) {
      setSendError("Invalid amount");
      return;
    }
    setSendLoading(true);
    setSendError("");
    setSendResult(null);
    try {
      const txid = await sendPayment(arkWallet, sendAddress, sats);
      setSendResult(txid);
      setSendAddress("");
      setSendAmount("");
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
    setStableCoin("USDC");
    setStableChain("arbitrum");
    setStableAmount("");
    setStableAddress("");
  };

  const addressForTab = (t: Tab): string => {
    if (t === "arkade") return addresses?.offchainAddr || "...";
    if (t === "onchain") return addresses?.boardingAddr || "...";
    return "";
  };

  const totalSats = balance?.total ?? 0;

  return (
    <>
      <div className="mx-auto max-w-lg pb-36 md:pb-6 space-y-6">
        {/* ── Balance hero ── */}
        <div className="pt-4 sm:pt-8 pb-2 text-center">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/40 font-medium">
            Total Balance
          </p>
          {walletReady ? (
            <>
              <p className="mt-3 text-5xl sm:text-6xl font-bold tabular-nums tracking-tight">
                {totalSats.toLocaleString()}
              </p>
              <p className="mt-1 text-sm text-muted-foreground/40">sats</p>
            </>
          ) : (
            <>
              <p className="mt-3 text-5xl font-bold tabular-nums text-muted-foreground/20">
                —
              </p>
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
                Settling {balance.onchain.toLocaleString()} sats{balance.onchainConfirmed > 0 ? "..." : " (awaiting confirmation)"}
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
            txLoading={txLoading}
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
              icon={<BitcoinIcon className="size-4" />}
              name="Bitcoin"
              description="Arkade"
              value={balance?.available ?? 0}
            />
            {balance && balance.onchain > 0 && (
              <AssetRow
                icon={<ClockIcon className="size-4 text-orange-400/80" />}
                name="Settling"
                description={balance.onchainConfirmed > 0 ? "Auto-boarding" : "Awaiting confirmation"}
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

          {USER_TOKENS.length === 0 ? (
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
              {USER_TOKENS.map((token) => {
                const value = Math.floor(token.holding * token.price);
                const isPositive = token.change24h >= 0;
                return (
                  <Link
                    key={token.id}
                    href={`/token/${token.id}`}
                    className="glass-card flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] hover:border-white/[0.1] transition-all group"
                  >
                    {/* Token icon */}
                    <div className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.06] border border-white/[0.06] flex items-center justify-center text-[10px] font-bold text-muted-foreground/50 tracking-wider">
                      {token.image ? (
                        <img src={token.image} alt={token.name} className="h-full w-full rounded-xl object-cover" />
                      ) : (
                        token.ticker.slice(0, 2)
                      )}
                    </div>

                    {/* Name + holding */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold truncate">{token.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/40">${token.ticker}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground/40 tabular-nums">
                        {token.holding.toLocaleString()} tokens
                      </p>
                    </div>

                    {/* Value + change */}
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums">
                        {formatSats(value)}
                        <span className="text-[10px] text-muted-foreground/30 ml-0.5">sat</span>
                      </p>
                      <p className={`text-[10px] font-medium tabular-nums ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                        {isPositive ? "+" : ""}{token.change24h.toFixed(1)}%
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
        </>
        )}
      </div>

      {/* ── Floating Send / Receive buttons ── */}
      {!mode && (
        <div className="fixed bottom-28 md:bottom-6 left-0 right-0 md:left-[60px] z-40 pointer-events-none" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
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
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
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
                        onClick={() => { setTab(key); setCopied(false); }}
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
                      <StablecoinReceive
                        stableCoin={stableCoin}
                        setStableCoin={setStableCoin}
                        stableChain={stableChain}
                        setStableChain={setStableChain}
                        copied={copied}
                        copyToClipboard={copyToClipboard}
                        truncateAddr={truncateAddr}
                      />
                    ) : tab === "lightning" ? (
                      <LightningReceive
                        lnReady={lnReady}
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
                            <QRCodeSVG value={addressForTab(tab)} size={160} bgColor="#ffffff" fgColor="#111827" level="M" />
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
                      <StablecoinSend
                        stableCoin={stableCoin}
                        setStableCoin={setStableCoin}
                        stableChain={stableChain}
                        setStableChain={setStableChain}
                        stableAmount={stableAmount}
                        setStableAmount={setStableAmount}
                        stableAddress={stableAddress}
                        setStableAddress={setStableAddress}
                      />
                    ) : tab === "lightning" ? (
                      <LightningSend
                        lnReady={lnReady}
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
                          <SuccessView txid={sendResult} copied={copied} copyToClipboard={copyToClipboard} truncateAddr={truncateAddr} />
                        ) : (
                          <div className="space-y-4">
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
                              <label className="text-[11px] text-muted-foreground/50 font-medium">Amount (sats)</label>
                              <input
                                type="number"
                                value={sendAmount}
                                onChange={(e) => setSendAmount(e.target.value)}
                                placeholder="0"
                                className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
                              />
                              {balance && (
                                <button type="button" className="text-[11px] text-muted-foreground/40 hover:text-foreground/60 transition-colors" onClick={() => setSendAmount(String(balance.available))}>
                                  Max: {balance.available.toLocaleString()} sats
                                </button>
                              )}
                            </div>
                            {tab === "onchain" && sendAmount && parseInt(sendAmount) > 0 && (
                              <p className="text-[11px] text-muted-foreground/40">
                                Network fee: {ONCHAIN_FEE_SATS} sats &middot; Total: {(parseInt(sendAmount) + ONCHAIN_FEE_SATS).toLocaleString()} sats
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

function TransactionHistoryView({
  txHistory,
  txLoading,
  walletReady,
  onRefresh,
}: {
  txHistory: TxHistoryItem[];
  txLoading: boolean;
  walletReady: boolean;
  onRefresh: () => void;
}) {
  if (!walletReady) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
        <p className="text-xs text-muted-foreground/40">Connecting to wallet...</p>
      </div>
    );
  }

  if (txLoading && txHistory.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
        <p className="text-xs text-muted-foreground/40">Loading transactions...</p>
      </div>
    );
  }

  if (txHistory.length === 0) {
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
        {txHistory.map((tx, i) => (
          <TxRow key={`${tx.arkTxid || tx.boardingTxid || tx.commitmentTxid}-${i}`} tx={tx} />
        ))}
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
          isSent
            ? "bg-red-500/[0.08] text-red-400/70"
            : "bg-emerald-500/[0.08] text-emerald-400/70"
        }`}
      >
        {isSent ? (
          <ArrowUpIcon className="size-4" />
        ) : (
          <ArrowDownIcon className="size-4" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{isSent ? "Sent" : "Received"}</p>
          {!tx.settled && (
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400/80 border border-yellow-500/20">
              Pending
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/35 mt-0.5">
          {timeStr}
          {txid && (
            <>
              <span className="mx-1.5 text-white/[0.06]">&middot;</span>
              <span className="font-mono">{txid.slice(0, 8)}...{txid.slice(-4)}</span>
            </>
          )}
        </p>
      </div>

      <span
        className={`text-sm font-semibold tabular-nums ${
          isSent ? "text-red-400/80" : "text-emerald-400/80"
        }`}
      >
        {isSent ? "-" : "+"}{tx.amount.toLocaleString()}
        <span className="text-[10px] text-muted-foreground/30 ml-1">sats</span>
      </span>
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
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clipRule="evenodd" />
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
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-muted-foreground/50">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-[11px] text-muted-foreground/35">{description}</p>
      </div>
      <span className={`text-sm font-semibold tabular-nums ${highlight ? "text-yellow-400/80" : ""}`}>
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
  lnReady, lnSuccess, lnWaiting, lnInvoice, lnReceiveAmount, lnError, copied,
  calcReceiveFee, setLnReceiveAmount, setLnError, setLnInvoice, setLnWaiting, setLnSuccess,
  receiveLightning, waitForReceive, copyToClipboard, truncateAddr, refreshBalance,
}: {
  lnReady: boolean; lnSuccess: boolean; lnWaiting: boolean; lnInvoice: string;
  lnReceiveAmount: string; lnError: string; copied: boolean;
  calcReceiveFee: (sats: number) => number; setLnReceiveAmount: (v: string) => void;
  setLnError: (v: string) => void; setLnInvoice: (v: string) => void;
  setLnWaiting: (v: boolean) => void; setLnSuccess: (v: boolean) => void;
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
                <QRCodeSVG value={lnInvoice.toUpperCase()} size={160} bgColor="#ffffff" fgColor="#111827" level="L" />
              </div>
            </div>
            <button
              onClick={() => copyToClipboard(lnInvoice)}
              className="w-full flex items-center justify-between gap-3 py-3 px-4 rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] transition-all"
            >
              <code className="text-xs text-muted-foreground/60 break-all">{truncateAddr(lnInvoice, 16)}</code>
              <span className="shrink-0 text-xs font-medium text-muted-foreground/50">{copied ? "Copied!" : "Copy"}</span>
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
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent mx-auto" />
        <p className="text-xs text-muted-foreground/40">Connecting to Lightning...</p>
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
          onChange={(e) => { setLnReceiveAmount(e.target.value); setLnError(""); }}
          placeholder="0"
          className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
        />
      </div>
      {lnReceiveAmount && parseInt(lnReceiveAmount) > 0 && (
        <p className="text-[11px] text-muted-foreground/40">Fee: ~{calcReceiveFee(parseInt(lnReceiveAmount)).toLocaleString()} sats</p>
      )}
      {lnError && <p className="text-xs text-red-400/80">{lnError}</p>}
      <button
        disabled={!lnReceiveAmount || parseInt(lnReceiveAmount) <= 0}
        onClick={async () => {
          const sats = parseInt(lnReceiveAmount);
          if (isNaN(sats) || sats <= 0) { setLnError("Invalid amount"); return; }
          setLnError("");
          try {
            const { invoice, swap } = await receiveLightning(sats);
            setLnInvoice(invoice);
            setLnWaiting(true);
            navigator.clipboard.writeText(invoice).catch(() => {});
            waitForReceive(swap)
              .then(() => { setLnWaiting(false); setLnSuccess(true); refreshBalance(); })
              .catch((err) => { setLnWaiting(false); setLnError(err instanceof Error ? err.message : "Receive failed"); });
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
  lnReady, lnSendInvoice, lnSendLoading, lnSendResult, lnError, copied,
  calcSendFee, setLnSendInvoice, setLnError, sendLightning, setLnSendResult, setLnSendLoading,
  copyToClipboard, truncateAddr, refreshBalance,
}: {
  lnReady: boolean; lnSendInvoice: string; lnSendLoading: boolean; lnSendResult: string | null;
  lnError: string; copied: boolean; calcSendFee: (sats: number) => number;
  setLnSendInvoice: (v: string) => void; setLnError: (v: string) => void;
  sendLightning: (invoice: string) => Promise<{ txid: string }>;
  setLnSendResult: (v: string | null) => void; setLnSendLoading: (v: boolean) => void;
  copyToClipboard: (text: string) => void;
  truncateAddr: (addr: string, chars?: number) => string;
  refreshBalance: () => Promise<void>;
}) {
  const [lnurlParams, setLnurlParams] = useState<LnurlPayParams | null>(null);
  const [lnurlLoading, setLnurlLoading] = useState(false);
  const [lnurlAmount, setLnurlAmount] = useState("");

  const inputValue = lnSendInvoice.trim();
  const isLnurlInput = isLnurlOrLightningAddress(inputValue);
  const isBolt11 = !isLnurlInput && inputValue.length > 10 && inputValue.toLowerCase().startsWith("ln");

  const prevInputRef = useRef("");
  useEffect(() => {
    if (prevInputRef.current === inputValue) return;
    prevInputRef.current = inputValue;
    if (!isLnurlInput) { setLnurlParams(null); return; }
    let cancelled = false;
    setLnurlLoading(true); setLnurlParams(null); setLnError("");
    fetchPayParams(inputValue).then((params) => {
      if (cancelled) return;
      setLnurlLoading(false);
      if (params) setLnurlParams(params);
      else setLnError("Failed to resolve LNURL / Lightning Address");
    });
    return () => { cancelled = true; };
  }, [inputValue, isLnurlInput, setLnError]);

  if (lnSendResult) {
    return <SuccessView txid={lnSendResult} copied={copied} copyToClipboard={copyToClipboard} truncateAddr={truncateAddr} />;
  }

  if (!lnReady) {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent mx-auto" />
        <p className="text-xs text-muted-foreground/40">Connecting to Lightning...</p>
      </div>
    );
  }

  const handleSend = async () => {
    if (!inputValue) return;
    setLnSendLoading(true); setLnError("");
    try {
      let invoice: string;
      if (lnurlParams) {
        const sats = parseInt(lnurlAmount, 10);
        if (isNaN(sats) || sats <= 0) { setLnError("Enter a valid amount"); setLnSendLoading(false); return; }
        const min = minSats(lnurlParams); const max = maxSats(lnurlParams);
        if (sats < min) { setLnError(`Minimum amount is ${min.toLocaleString()} sats`); setLnSendLoading(false); return; }
        if (sats > max) { setLnError(`Maximum amount is ${max.toLocaleString()} sats`); setLnSendLoading(false); return; }
        const result = await requestInvoice(lnurlParams.callback, sats);
        if (!result) { setLnError("Failed to get invoice from LNURL service"); setLnSendLoading(false); return; }
        invoice = result.pr;
      } else {
        invoice = inputValue;
      }
      const { txid } = await sendLightning(invoice);
      setLnSendResult(txid); setLnSendInvoice(""); setLnurlAmount("");
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
        <label className="text-[11px] text-muted-foreground/50 font-medium">Invoice, LNURL, or Lightning Address</label>
        <input
          value={lnSendInvoice}
          onChange={(e) => { setLnSendInvoice(e.target.value); setLnError(""); setLnurlAmount(""); }}
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
            {lnurlParams.description && <p className="text-xs text-muted-foreground/40">{lnurlParams.description}</p>}
            <p className="text-xs text-muted-foreground/40">{minSats(lnurlParams).toLocaleString()} – {maxSats(lnurlParams).toLocaleString()} sats</p>
          </div>
          <div className="space-y-2">
            <label className="text-[11px] text-muted-foreground/50 font-medium">Amount (sats)</label>
            <input
              type="number" value={lnurlAmount}
              onChange={(e) => { setLnurlAmount(e.target.value); setLnError(""); }}
              placeholder={`${minSats(lnurlParams).toLocaleString()} - ${maxSats(lnurlParams).toLocaleString()}`}
              className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
            />
          </div>
          {lnurlAmount && (() => {
            const sats = parseInt(lnurlAmount, 10);
            if (isNaN(sats) || sats <= 0) return null;
            const fee = calcSendFee(sats);
            return <p className="text-[11px] text-muted-foreground/40">Fee: ~{fee.toLocaleString()} sats &middot; Total: ~{(sats + fee).toLocaleString()} sats</p>;
          })()}
        </div>
      )}

      {isBolt11 && !lnurlParams && (() => {
        try {
          const invoiceSats = getInvoiceSatoshis(inputValue);
          const fee = calcSendFee(invoiceSats);
          return (
            <div className="space-y-0.5">
              <p className="text-[11px] text-muted-foreground/50">Amount: <span className="text-foreground/80">{invoiceSats.toLocaleString()} sats</span></p>
              <p className="text-[11px] text-muted-foreground/40">Fee: ~{fee.toLocaleString()} sats &middot; Total: ~{(invoiceSats + fee).toLocaleString()} sats</p>
            </div>
          );
        } catch { return <p className="text-xs text-red-400/80">Invalid invoice</p>; }
      })()}

      {lnError && <p className="text-xs text-red-400/80">{lnError}</p>}

      <button
        disabled={lnSendLoading || !inputValue || lnurlLoading || (lnurlParams ? !lnurlAmount : false)}
        onClick={handleSend}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {lnSendLoading ? "Sending..." : lnurlParams ? "Pay" : "Send"}
      </button>
    </div>
  );
}

// ===================== Stablecoin components =====================

const STABLE_COINS: { key: StableCoin; color: string; icon: React.ReactNode }[] = [
  {
    key: "USDC",
    color: "text-blue-400",
    icon: (
      <svg viewBox="0 0 2000 2000" className="h-4 w-4 shrink-0">
        <path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775ca"/>
        <path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#fff"/>
        <path d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z" fill="#fff"/>
      </svg>
    ),
  },
  {
    key: "USDT",
    color: "text-emerald-400",
    icon: (
      <svg viewBox="0 0 339.43 295.27" className="h-4 w-4 shrink-0">
        <path d="M62.15,1.45l-61.89,130a2.52,2.52,0,0,0,.54,2.94L167.95,294.56a2.55,2.55,0,0,0,3.53,0L338.63,134.4a2.52,2.52,0,0,0,.54-2.94l-61.89-130A2.5,2.5,0,0,0,275,0H64.45a2.5,2.5,0,0,0-2.3,1.45h0Z" fill="#50af95" fillRule="evenodd"/>
        <path d="M191.19,144.8v0c-1.2.09-7.4,0.46-21.23,0.46-11,0-18.81-.33-21.55-0.46v0c-42.51-1.87-74.24-9.27-74.24-18.13s31.73-16.25,74.24-18.15v28.91c2.78,0.2,10.74.67,21.74,0.67,13.2,0,19.81-.55,21-0.66v-28.9c42.42,1.89,74.08,9.29,74.08,18.13s-31.65,16.24-74.08,18.12h0Zm0-39.25V79.68h59.2V40.23H89.21V79.68H148.4v25.86c-48.11,2.21-84.29,11.74-84.29,23.16s36.18,20.94,84.29,23.16v82.9h42.78V151.83c48-2.21,84.12-11.73,84.12-23.14s-36.09-20.93-84.12-23.15h0Zm0,0h0Z" fill="#fff" fillRule="evenodd"/>
      </svg>
    ),
  },
];

const STABLE_CHAINS: { key: StableChain; label: string; icon: React.ReactNode }[] = [
  {
    key: "arbitrum",
    label: "Arbitrum",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#213147" />
        <path d="M10.87 6.22 13.5 12.3l-1.12.65-2.63-6.08 1.12-.65Zm2.63 6.08.94 2.18-1.12.65-.94-2.18 1.12-.65Z" fill="#28A0F0" />
        <path d="M9.13 6.22 6.5 12.3l1.12.65 2.63-6.08-1.12-.65Zm-2.63 6.08-.94 2.18 1.12.65.94-2.18-1.12-.65Z" fill="white" />
      </svg>
    ),
  },
  {
    key: "ethereum",
    label: "Ethereum",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#627EEA" />
        <path d="M10 3v5.25l4.38 1.96L10 3Z" fill="white" fillOpacity="0.6" />
        <path d="M10 3 5.62 10.21 10 8.25V3Z" fill="white" />
        <path d="M10 13.47v3.52l4.38-6.06L10 13.47Z" fill="white" fillOpacity="0.6" />
        <path d="M10 16.99v-3.52l-4.38-2.54L10 17Z" fill="white" />
        <path d="M10 12.66l4.38-2.45L10 8.25v4.41Z" fill="white" fillOpacity="0.2" />
        <path d="M5.62 10.21 10 12.66V8.25l-4.38 1.96Z" fill="white" fillOpacity="0.6" />
      </svg>
    ),
  },
  {
    key: "polygon",
    label: "Polygon",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#8247E5" />
        <path d="M13.05 8.36a.77.77 0 0 0-.76 0l-1.35.8-1.21.69-1.35.8a.77.77 0 0 1-.76 0l-1.06-.63a.77.77 0 0 1-.38-.66v-1.2a.73.73 0 0 1 .38-.65l1.06-.6a.77.77 0 0 1 .76 0l1.06.62a.77.77 0 0 1 .38.65v.8l1.21-.7v-.83a.73.73 0 0 0-.38-.66l-2.24-1.3a.77.77 0 0 0-.76 0l-2.3 1.33a.73.73 0 0 0-.38.65v2.62a.73.73 0 0 0 .38.65l2.27 1.31a.77.77 0 0 0 .76 0l1.35-.77 1.21-.72 1.35-.77a.77.77 0 0 1 .76 0l1.06.6a.77.77 0 0 1 .38.66v1.2a.73.73 0 0 1-.38.65l-1.03.63a.77.77 0 0 1-.76 0l-1.06-.6a.77.77 0 0 1-.38-.66v-.77l-1.21.7v.8a.73.73 0 0 0 .38.66l2.27 1.3a.77.77 0 0 0 .76 0l2.27-1.3a.77.77 0 0 0 .38-.66V9.64a.73.73 0 0 0-.38-.65l-2.3-1.32Z" fill="white" />
      </svg>
    ),
  },
];

const MOCK_DEPOSIT_ADDRESSES: Record<StableChain, string> = {
  arbitrum: "0x1a2b3c4d5e6f7890abcdef1234567890abcdef12",
  ethereum: "0xabcdef1234567890abcdef1234567890abcdef12",
  polygon: "0x7890abcdef1234567890abcdef1234567890abcd",
};

function CoinChainSelectors({
  stableCoin,
  setStableCoin,
  stableChain,
  setStableChain,
}: {
  stableCoin: StableCoin;
  setStableCoin: (v: StableCoin) => void;
  stableChain: StableChain;
  setStableChain: (v: StableChain) => void;
}) {
  return (
    <div className="flex gap-2">
      {/* Coin toggle */}
      <div className="flex rounded-lg bg-white/[0.04] border border-white/[0.07] p-0.5">
        {STABLE_COINS.map(({ key, color, icon }) => (
          <button
            key={key}
            onClick={() => setStableCoin(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
              stableCoin === key
                ? `bg-white/[0.1] ${color}`
                : "text-muted-foreground/40 hover:text-muted-foreground/60 opacity-50 hover:opacity-70"
            }`}
          >
            {icon}
            {key}
          </button>
        ))}
      </div>

      {/* Chain icons */}
      <div className="flex items-center gap-1 ml-auto">
        {STABLE_CHAINS.map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setStableChain(key)}
            title={label}
            className={`h-8 w-8 rounded-lg flex items-center justify-center transition-all ${
              stableChain === key
                ? "bg-white/[0.1] border border-white/[0.14] ring-1 ring-white/[0.06]"
                : "bg-white/[0.04] border border-transparent hover:bg-white/[0.07] opacity-40 hover:opacity-70"
            }`}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function StablecoinReceive({
  stableCoin,
  setStableCoin,
  stableChain,
  setStableChain,
  copied,
  copyToClipboard,
  truncateAddr,
}: {
  stableCoin: StableCoin;
  setStableCoin: (v: StableCoin) => void;
  stableChain: StableChain;
  setStableChain: (v: StableChain) => void;
  copied: boolean;
  copyToClipboard: (text: string) => void;
  truncateAddr: (addr: string, chars?: number) => string;
}) {
  const depositAddr = MOCK_DEPOSIT_ADDRESSES[stableChain];
  const chainLabel = STABLE_CHAINS.find((c) => c.key === stableChain)!.label;

  return (
    <div className="space-y-4">
      <CoinChainSelectors
        stableCoin={stableCoin}
        setStableCoin={setStableCoin}
        stableChain={stableChain}
        setStableChain={setStableChain}
      />

      <p className="text-[10px] text-muted-foreground/40 uppercase tracking-[0.15em]">
        Send {stableCoin} on {chainLabel} to
      </p>

      <div className="flex justify-center py-2">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={depositAddr} size={160} bgColor="#ffffff" fgColor="#111827" level="M" />
        </div>
      </div>

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

      <div className="rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.12] px-4 py-3">
        <p className="text-xs text-emerald-400/80">
          Automatically swapped into sats via LendaSwap
        </p>
      </div>

      <p className="text-center text-[10px] text-muted-foreground/30">
        Powered by LendaSwap
      </p>
    </div>
  );
}

function StablecoinSend({
  stableCoin,
  setStableCoin,
  stableChain,
  setStableChain,
  stableAmount,
  setStableAmount,
  stableAddress,
  setStableAddress,
}: {
  stableCoin: StableCoin;
  setStableCoin: (v: StableCoin) => void;
  stableChain: StableChain;
  setStableChain: (v: StableChain) => void;
  stableAmount: string;
  setStableAmount: (v: string) => void;
  stableAddress: string;
  setStableAddress: (v: string) => void;
}) {
  const sats = parseInt(stableAmount, 10);
  const estimatedStable = !isNaN(sats) && sats > 0 ? (sats * 0.00065).toFixed(2) : null;
  const chainLabel = STABLE_CHAINS.find((c) => c.key === stableChain)!.label;

  return (
    <div className="space-y-4">
      <CoinChainSelectors
        stableCoin={stableCoin}
        setStableCoin={setStableCoin}
        stableChain={stableChain}
        setStableChain={setStableChain}
      />

      {/* Recipient */}
      <input
        value={stableAddress}
        onChange={(e) => setStableAddress(e.target.value)}
        placeholder={`Recipient address on ${chainLabel} (0x...)`}
        className="w-full h-11 px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
      />

      {/* Amount with inline conversion */}
      <div className="rounded-xl bg-white/[0.05] border border-white/[0.08] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={stableAmount}
            onChange={(e) => setStableAmount(e.target.value)}
            placeholder="0"
            className="flex-1 bg-transparent text-lg font-semibold tabular-nums text-foreground placeholder:text-muted-foreground/20 outline-none"
          />
          <span className="text-xs text-muted-foreground/40 font-medium">sats</span>
        </div>
        {estimatedStable && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0">
              <path fillRule="evenodd" d="M13.78 10.47a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 1 1 1.06-1.06l.97.97V5.75a.75.75 0 0 1 1.5 0v5.69l.97-.97a.75.75 0 0 1 1.06 0ZM2.22 5.53a.75.75 0 0 1 0-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1-1.06 1.06l-.97-.97v5.69a.75.75 0 0 1-1.5 0V4.56l-.97.97a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
            </svg>
            <span>&asymp; {estimatedStable} {stableCoin} on {chainLabel}</span>
          </div>
        )}
      </div>

      <button
        disabled={!stableAmount || !stableAddress || isNaN(sats) || sats <= 0}
        className="w-full h-11 rounded-xl bg-white/[0.1] border border-white/[0.12] text-sm font-semibold transition-all hover:bg-white/[0.14] hover:border-white/[0.16] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Send {stableCoin}
      </button>

      <p className="text-center text-[10px] text-muted-foreground/30">
        Powered by LendaSwap
      </p>
    </div>
  );
}

// ===================== Icons =====================

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M10 3a.75.75 0 0 1 .75.75v10.638l3.96-4.158a.75.75 0 1 1 1.08 1.04l-5.25 5.5a.75.75 0 0 1-1.08 0l-5.25-5.5a.75.75 0 1 1 1.08-1.04l3.96 4.158V3.75A.75.75 0 0 1 10 3Z" clipRule="evenodd" />
    </svg>
  );
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z" clipRule="evenodd" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311V15a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75H8.5a.75.75 0 0 1 0 1.5H7.058l.398.397a4 4 0 0 0 6.693-1.793.75.75 0 0 1 1.163-.57ZM4.688 8.576a5.5 5.5 0 0 1 9.201-2.466l.312.311V5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75H11.5a.75.75 0 0 1 0-1.5h1.442l-.398-.397a4 4 0 0 0-6.693 1.793.75.75 0 0 1-1.163.57Z" clipRule="evenodd" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" />
    </svg>
  );
}

function BugIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M6.56 1.14a.75.75 0 0 1 .177 1.045 3.989 3.989 0 0 0-.464.86c.185.17.382.329.59.473A6.048 6.048 0 0 1 10 3c1.272 0 2.463.39 3.137.518.208-.144.405-.303.59-.473a3.993 3.993 0 0 0-.464-.86.75.75 0 0 1 1.222-.869c.369.519.627 1.124.706 1.78a4.042 4.042 0 0 1-.96.834c-.1.079-.203.154-.31.225A5.527 5.527 0 0 1 15.5 7.5h.75a.75.75 0 0 1 0 1.5h-.876a7.552 7.552 0 0 1-.124 1H16a.75.75 0 0 1 0 1.5h-1.09A5.5 5.5 0 0 1 4.59 11.5H3.5a.75.75 0 0 1 0-1.5h.75c-.04-.328-.08-.66-.124-1H3.25a.75.75 0 0 1 0-1.5h.75A5.527 5.527 0 0 1 5.56 4.155c-.107-.07-.21-.146-.31-.225a4.042 4.042 0 0 1-.96-.834 4.238 4.238 0 0 1 .706-1.78.75.75 0 0 1 1.045-.177l.018.012ZM10 5a3.5 3.5 0 0 0-3.5 3.5 10.508 10.508 0 0 0 .053 1H13.447c.035-.328.053-.661.053-1A3.5 3.5 0 0 0 10 5Zm-3.362 6.5a4 4 0 0 0 6.724 0H6.638Z" clipRule="evenodd" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M8.914 6.025a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95l-2 2a3.5 3.5 0 0 1-5.95-2.475.75.75 0 0 1 1.5 0 2 2 0 0 0 3.41 1.414l2-2a2 2 0 0 0 0-2.828.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
      <path fillRule="evenodd" d="M7.086 9.975a.75.75 0 0 1-1.06 0 3.5 3.5 0 0 1 0-4.95l2-2a3.5 3.5 0 0 1 5.95 2.475.75.75 0 0 1-1.5 0 2 2 0 0 0-3.41-1.414l-2 2a2 2 0 0 0 0 2.828.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
    </svg>
  );
}

function BitcoinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" className={className}>
      <path d="M42.47 28.85c.87-5.8-3.55-8.92-9.6-11l1.96-7.87-4.8-1.2-1.91 7.66c-1.26-.31-2.55-.61-3.84-.9l1.93-7.72-4.8-1.2-1.97 7.87c-1.04-.24-2.07-.47-3.06-.72l.01-.03-6.62-1.65-1.28 5.13s3.55.81 3.48.87c1.94.48 2.29 1.77 2.23 2.79l-2.23 8.96c.13.03.3.08.49.16l-.5-.12-3.13 12.56c-.24.59-.83 1.47-2.18 1.14.05.07-3.48-.87-3.48-.87L2 48.2l6.24 1.56c1.16.29 2.3.6 3.42.88l-1.98 7.95 4.79 1.2 1.97-7.88c1.31.36 2.59.68 3.83 1l-1.96 7.83 4.8 1.2 1.98-7.94c8.16 1.54 14.3.92 16.88-6.46 2.08-5.95-.1-9.38-4.4-11.62 3.13-.72 5.49-2.78 6.12-7.03l-.22-.04ZM34.7 39.02c-1.48 5.95-11.49 2.73-14.73 1.93l2.63-10.53c3.24.81 13.66 2.41 12.1 8.6Zm1.48-14.88c-1.35 5.41-9.68 2.66-12.38 1.99l2.38-9.55c2.7.67 12.42 1.93 10 7.56Z" />
    </svg>
  );
}

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8.372 1.349a.75.75 0 0 0-.744 0l-4.81 2.748L8 7.131l5.182-3.034-4.81-2.748ZM14 5.357 8.75 8.43v6.005l4.872-2.784A.75.75 0 0 0 14 11V5.357ZM7.25 14.435V8.43L2 5.357V11c0 .27.144.518.378.651l4.872 2.784Z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z" clipRule="evenodd" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
    </svg>
  );
}
