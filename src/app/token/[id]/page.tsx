"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenChart } from "@/components/token-chart";
import { useAppStore } from "@/lib/store";
import { useComments } from "@/hooks/useComments";
import { useTrades } from "@/hooks/useTrades";
import { fetchTokenByTicker, subscribeToCurveState } from "@/lib/nostr-market";
import {
  calculateBuyTokens,
  calculateSellSats,
  calculateSlippage,
  getPrice,
  getMarketCap,
  getCurveProgress,
  isCurveComplete,
  type CurveState,
} from "@/lib/bonding-curve";
import { executeBuy, executeSell } from "@/lib/trade-engine";
import type { Token } from "@/lib/store";

type TradeTab = "buy" | "sell";
type InfoTab = "thread" | "trades";

const QUICK_BUY_AMOUNTS = [100, 500, 1_000, 5_000, 10_000];
const QUICK_SELL_PCTS = [25, 50, 75, 100];

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatSats(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function shortPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}...${pk.slice(-4)}`;
}

export default function TokenPage() {
  const params = useParams();
  const router = useRouter();
  const ticker = (params.id as string)?.toUpperCase();

  const tokens = useAppStore((s) => s.tokens);
  const upsertToken = useAppStore((s) => s.upsertToken);
  const nostrReady = useAppStore((s) => s.nostrReady);
  const walletReady = useAppStore((s) => s.walletReady);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const user = useAppStore((s) => s.user);
  const heldAssets = useAppStore((s) => s.heldAssets);

  const [token, setToken] = useState<Token | null>(null);
  const [fetching, setFetching] = useState(true);

  // Find token from store or fetch from Nostr
  useEffect(() => {
    const found = tokens.find((t) => t.ticker === ticker);
    if (found) {
      setToken(found);
      setFetching(false);
      return;
    }

    if (!nostrReady) return;

    setFetching(true);
    fetchTokenByTicker(ticker).then((result) => {
      if (result) {
        upsertToken(result);
        setToken(result);
      }
      setFetching(false);
    });
  }, [ticker, tokens, nostrReady, upsertToken]);

  // Keep token in sync with store
  useEffect(() => {
    const found = tokens.find((t) => t.ticker === ticker);
    if (found) setToken(found);
  }, [tokens, ticker]);

  // Subscribe to live curve state updates
  useEffect(() => {
    if (!nostrReady || !ticker || !token) return;

    const sub = subscribeToCurveState(ticker, (curve: CurveState) => {
      // Read latest token from store to avoid stale closure overwriting
      // newer fields (e.g. tradeCount updated by another event)
      const latest = useAppStore.getState().tokens.find((t) => t.ticker === ticker);
      if (!latest) return;
      upsertToken({
        ...latest,
        virtualTokenReserves: curve.virtualTokenReserves,
        virtualSatReserves: curve.virtualSatReserves,
        realTokenReserves: curve.realTokenReserves,
        price: getPrice(curve),
        marketCap: getMarketCap(curve),
        curveProgress: getCurveProgress(curve),
      });
    });

    return () => {
      if (sub) sub.stop();
    };
  }, [nostrReady, ticker, token?.id, upsertToken]);

  // Comments & trades
  const { comments, loading: commentsLoading, postComment } = useComments(token?.id ?? null, ticker);
  const { trades, loading: tradesLoading } = useTrades(ticker);

  // User holding for this token
  const userHolding = useMemo(() => {
    if (!token?.assetId || heldAssets.length === 0) return 0;
    const held = heldAssets.find((a) => a.assetId === token.assetId);
    return held?.amount ?? 0;
  }, [token?.assetId, heldAssets]);
  const userHoldingValue = token ? Math.floor(userHolding * (token.price ?? 0)) : 0;

  // Trade state
  const [tradeTab, setTradeTab] = useState<TradeTab | null>(null);
  const [infoTab, setInfoTab] = useState<InfoTab>("thread");
  const [amount, setAmount] = useState("");
  const [sellPct, setSellPct] = useState<number | null>(null);
  const [slippage, setSlippage] = useState("1");
  const [showSlippage, setShowSlippage] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeError, setTradeError] = useState("");
  const [tradeSuccess, setTradeSuccess] = useState("");

  const openTrade = (tab: TradeTab) => {
    setTradeTab(tab);
    setAmount("");
    setSellPct(null);
    setShowSlippage(false);
    setTradeError("");
    setTradeSuccess("");
  };
  const closeTrade = () => {
    setTradeTab(null);
    setAmount("");
    setSellPct(null);
    setTradeError("");
    setTradeSuccess("");
  };

  const curveState: CurveState | null = token
    ? {
        virtualTokenReserves: token.virtualTokenReserves,
        virtualSatReserves: token.virtualSatReserves,
        realTokenReserves: token.realTokenReserves,
      }
    : null;

  const amountNum = parseInt(amount, 10);
  const estimatedTokens =
    amountNum && !isNaN(amountNum) && curveState
      ? calculateBuyTokens(curveState, amountNum).tokensOut
      : 0;
  const estimatedSats =
    amountNum && !isNaN(amountNum) && curveState && tradeTab === "sell"
      ? calculateSellSats(curveState, amountNum).satsOut
      : 0;
  const slippagePct =
    amountNum && !isNaN(amountNum) && curveState && tradeTab === "buy"
      ? calculateSlippage(curveState, amountNum)
      : 0;

  const graduated = curveState ? isCurveComplete(curveState) : false;

  // Execute buy
  const handleBuy = useCallback(async () => {
    if (!arkWallet || !token || !curveState || !user?.pubkey || !amountNum) return;
    setTradeLoading(true);
    setTradeError("");
    setTradeSuccess("");
    try {
      const result = await executeBuy(arkWallet, {
        ticker: token.ticker,
        satAmount: amountNum,
        creatorArkAddress: token.creatorArkAddress,
        curveState,
        buyerPubkey: user.pubkey,
      });
      setTradeSuccess(`Order placed! Expecting ${result.expectedTokens.toLocaleString()} $${token.ticker}. Waiting for creator to fill...`);
      setAmount("");
    } catch (err) {
      setTradeError(err instanceof Error ? err.message : "Buy failed");
    } finally {
      setTradeLoading(false);
    }
  }, [arkWallet, token, curveState, user?.pubkey, amountNum]);

  // Execute sell
  const handleSell = useCallback(async () => {
    if (!arkWallet || !token || !curveState || !user?.pubkey || !amountNum) return;
    setTradeLoading(true);
    setTradeError("");
    setTradeSuccess("");
    try {
      const result = await executeSell(arkWallet, {
        ticker: token.ticker,
        tokenAmount: amountNum,
        assetId: token.assetId,
        creatorArkAddress: token.creatorArkAddress,
        curveState,
        sellerPubkey: user.pubkey,
      });
      setTradeSuccess(`Sell order placed! Expecting ${result.expectedSats.toLocaleString()} sats. Waiting for creator to fill...`);
      setAmount("");
    } catch (err) {
      setTradeError(err instanceof Error ? err.message : "Sell failed");
    } finally {
      setTradeLoading(false);
    }
  }, [arkWallet, token, curveState, user?.pubkey, amountNum]);

  // Post comment
  const handlePostComment = async () => {
    if (!newComment.trim()) return;
    try {
      await postComment(newComment);
      setNewComment("");
    } catch (err) {
      console.error("Failed to post comment:", err);
    }
  };

  // Loading state
  if (fetching) {
    return (
      <div className="py-20 text-center space-y-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground/30 border-t-transparent mx-auto" />
        <p className="text-sm text-muted-foreground/50">Loading token...</p>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="py-20 text-center space-y-3">
        <p className="text-muted-foreground">Token not found</p>
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          Back to Marketplace
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back + Token header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push("/")}
          className="shrink-0 h-8 w-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/[0.1] transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div className="h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-xl bg-white/[0.06] border border-white/[0.06] flex items-center justify-center text-[10px] font-bold text-muted-foreground/60 tracking-wider">
            {token.image ? (
              <img src={token.image} alt={token.name} className="h-full w-full rounded-xl object-cover" />
            ) : (
              token.ticker.slice(0, 2)
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="font-bold text-base sm:text-lg truncate">{token.name}</h1>
              <span className="text-[11px] font-mono text-muted-foreground/40 hidden sm:inline">${token.ticker}</span>
              {graduated && (
                <span className="text-[9px] font-medium text-emerald-400 bg-emerald-400/10 rounded px-1.5 py-0.5">
                  Graduated
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/40">
              <span className="sm:hidden font-mono">${token.ticker}</span>
              <span className="hidden sm:inline">by {shortPubkey(token.creator)}</span>
              <span>{timeAgo(token.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base sm:text-lg font-bold tabular-nums">
            {token.price < 0.01 ? token.price.toFixed(4) : token.price.toFixed(2)}
            <span className="text-[10px] text-muted-foreground/30 ml-0.5">sat</span>
          </p>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid gap-4 lg:grid-cols-[1fr,340px]">
        {/* Left column: Chart + Tabs */}
        <div className="space-y-4">
          {/* Chart card */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-3 sm:p-4">
            <TokenChart trades={trades} basePrice={token.price} />
          </div>

          {/* Buy / Sell buttons */}
          {!graduated && (
            <div className="flex gap-2.5">
              <button
                onClick={() => openTrade("buy")}
                className="flex-1 py-3 rounded-xl bg-emerald-500/90 text-white text-sm font-semibold hover:bg-emerald-400/90 shadow-[0_4px_20px_rgba(52,211,153,0.15)] hover:shadow-[0_4px_24px_rgba(52,211,153,0.25)] transition-all"
              >
                Buy
              </button>
              <button
                onClick={() => openTrade("sell")}
                className="flex-1 py-3 rounded-xl bg-red-500/90 text-white text-sm font-semibold hover:bg-red-400/90 shadow-[0_4px_20px_rgba(248,113,113,0.15)] hover:shadow-[0_4px_24px_rgba(248,113,113,0.25)] transition-all"
              >
                Sell
              </button>
            </div>
          )}

          {graduated && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-center">
              <p className="text-xs text-emerald-400 font-medium">
                This token has graduated! Trading via bonding curve is complete.
              </p>
            </div>
          )}

          {/* Info tabs */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
            <div className="flex border-b border-white/[0.07]">
              {(["thread", "trades"] as InfoTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setInfoTab(tab)}
                  className={`flex-1 py-3 text-xs font-medium capitalize transition-colors ${
                    infoTab === tab
                      ? "text-foreground border-b-2 border-primary"
                      : "text-muted-foreground/60 hover:text-muted-foreground"
                  }`}
                >
                  {tab}
                  {tab === "thread" && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/40">{comments.length}</span>
                  )}
                  {tab === "trades" && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/40">{trades.length}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="p-4">
              {/* Thread */}
              {infoTab === "thread" && (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Post a reply..."
                      className="h-9 text-xs rounded-lg"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handlePostComment();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-9 px-4 rounded-lg text-xs"
                      disabled={!newComment.trim() || !nostrReady}
                      onClick={handlePostComment}
                    >
                      Post
                    </Button>
                  </div>

                  {commentsLoading && comments.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">Loading comments...</p>
                  )}

                  {!commentsLoading && comments.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">No comments yet. Be the first!</p>
                  )}

                  <div className="space-y-3">
                    {comments.map((c) => (
                      <div key={c.id} className="flex gap-3">
                        <div className="h-7 w-7 shrink-0 rounded-full bg-muted/50 flex items-center justify-center text-[10px] font-mono text-muted-foreground">
                          {c.pubkey.slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono text-muted-foreground/70">{shortPubkey(c.pubkey)}</span>
                            <span className="text-[10px] text-muted-foreground/40">{timeAgo(c.time)}</span>
                          </div>
                          <p className="text-xs text-foreground/90 mt-0.5 leading-relaxed">{c.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Trades */}
              {infoTab === "trades" && (
                <div>
                  {tradesLoading && trades.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">Loading trades...</p>
                  )}

                  {!tradesLoading && trades.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">No trades yet.</p>
                  )}

                  <div className="divide-y divide-white/[0.05]">
                    {trades.map((t) => {
                      const isBuy = t.type === "buy";
                      return (
                        <div
                          key={t.arkTxId}
                          className="flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isBuy ? "bg-emerald-400" : "bg-red-400"
                          }`} />
                          <span className="shrink-0 text-[11px] font-mono text-muted-foreground/40">
                            {shortPubkey(isBuy ? t.buyer : t.seller)}
                          </span>
                          <span className={`shrink-0 text-[11px] font-medium ${isBuy ? "text-emerald-400/80" : "text-red-400/80"}`}>
                            {isBuy ? "bought" : "sold"}
                          </span>
                          <span className="text-[11px] font-semibold tabular-nums">
                            {t.tokens.toLocaleString()}
                            <span className="text-muted-foreground/35 font-normal ml-0.5">${t.ticker}</span>
                          </span>
                          <div className="flex-1" />
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
                            {t.sats.toLocaleString()} <span className="text-muted-foreground/30">sat</span>
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground/25 tabular-nums">
                            {timeAgo(t.timestamp)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column: Bonding + Info */}
        <div className="space-y-4">
          {/* Bonding curve */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
                Bonding Curve
              </h3>
              <span className="text-sm font-semibold tabular-nums">{token.curveProgress.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-white/[0.1] to-white/[0.2] transition-all"
                style={{ width: `${Math.min(100, token.curveProgress)}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground/40 leading-relaxed">
              {graduated
                ? "Bonding curve complete! Token has graduated."
                : "When the bonding curve reaches 100%, the token graduates and liquidity is locked."}
            </p>
          </div>

          {/* User holding */}
          {userHolding > 0 && (
            <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-2">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
                Your Holdings
              </h3>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold tabular-nums">{userHolding.toLocaleString()} ${token.ticker}</span>
                <span className="text-xs text-muted-foreground/50 tabular-nums">~{formatSats(userHoldingValue)} sats</span>
              </div>
            </div>
          )}

          {/* Token info */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-3">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
              Token Info
            </h3>

            <div className="space-y-2.5">
              <InfoRow label="Market Cap" value={`${formatSats(token.marketCap)} sats`} />
              <InfoRow label="Trades" value={String(token.tradeCount)} />
              <InfoRow label="Replies" value={String(comments.length)} />
              <InfoRow label="Creator" value={shortPubkey(token.creator)} mono />
            </div>

            {token.description && (
              <>
                <div className="h-px bg-white/[0.06]" />
                <p className="text-xs text-muted-foreground/50 leading-relaxed">
                  {token.description}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Trade overlay modal */}
      {tradeTab !== null && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeTrade}
          />

          <div className="relative w-full sm:max-w-sm sm:mx-4 rounded-t-2xl sm:rounded-2xl border-t sm:border border-white/[0.1] bg-card/95 backdrop-blur-2xl shadow-[0_16px_64px_rgba(0,0,0,0.5)] overflow-hidden max-h-[90vh] overflow-y-auto">
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-white/[0.15]" />
            </div>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 pt-3 sm:pt-5 pb-3">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-muted/60 flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                  {token.ticker.slice(0, 2)}
                </div>
                <div>
                  <p className="text-sm font-semibold">{token.name}</p>
                  <p className="text-[11px] text-muted-foreground/50">${token.ticker}</p>
                </div>
              </div>
              <button
                onClick={closeTrade}
                className="h-8 w-8 rounded-lg bg-muted/20 flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                  <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                </svg>
              </button>
            </div>

            {/* Buy / Sell toggle */}
            <div className="px-5 pb-4">
              <div className="flex gap-1.5 rounded-lg bg-muted/20 p-1">
                <button
                  onClick={() => { setTradeTab("buy"); setAmount(""); setSellPct(null); setTradeError(""); setTradeSuccess(""); }}
                  className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${
                    tradeTab === "buy"
                      ? "bg-emerald-500 text-white shadow-sm"
                      : "text-muted-foreground/60 hover:text-muted-foreground"
                  }`}
                >
                  Buy
                </button>
                <button
                  onClick={() => { setTradeTab("sell"); setAmount(""); setSellPct(null); setTradeError(""); setTradeSuccess(""); }}
                  className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${
                    tradeTab === "sell"
                      ? "bg-red-500 text-white shadow-sm"
                      : "text-muted-foreground/60 hover:text-muted-foreground"
                  }`}
                >
                  Sell
                </button>
              </div>
            </div>

            {/* Trade form */}
            <div className="px-5 pb-5 space-y-4">
              {/* You pay/sell */}
              <div className="rounded-xl bg-muted/10 border border-border/20 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-muted-foreground/50">
                    {tradeTab === "buy" ? "You pay" : "You sell"}
                  </span>
                  {tradeTab === "sell" && (
                    <span className="text-[11px] text-muted-foreground/40">
                      Balance: {userHolding.toLocaleString()} ${token.ticker}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, "");
                      setAmount(v);
                      setSellPct(null);
                    }}
                    placeholder="0"
                    className="flex-1 bg-transparent text-xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/20"
                  />
                  <span className="text-xs font-medium text-muted-foreground/50">
                    {tradeTab === "buy" ? "sats" : token.ticker}
                  </span>
                </div>
              </div>

              {/* Quick amounts */}
              <div className="flex gap-1.5">
                {tradeTab === "buy"
                  ? QUICK_BUY_AMOUNTS.map((a) => (
                      <button
                        key={a}
                        onClick={() => { setAmount(String(a)); setSellPct(null); }}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                          amount === String(a)
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            : "bg-muted/15 text-muted-foreground/50 border border-transparent hover:bg-muted/25"
                        }`}
                      >
                        {a >= 1000 ? `${a / 1000}K` : a}
                      </button>
                    ))
                  : QUICK_SELL_PCTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          const tokens = Math.floor(userHolding * (p / 100));
                          setAmount(String(tokens));
                          setSellPct(p);
                        }}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                          sellPct === p
                            ? "bg-red-500/15 text-red-400 border border-red-500/30"
                            : "bg-muted/15 text-muted-foreground/50 border border-transparent hover:bg-muted/25"
                        }`}
                      >
                        {p}%
                      </button>
                    ))}
              </div>

              {/* Arrow divider */}
              <div className="flex justify-center">
                <div className="h-8 w-8 rounded-full bg-muted/20 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 text-muted-foreground/40">
                    <path fillRule="evenodd" d="M8 2a.75.75 0 0 1 .75.75v8.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V2.75A.75.75 0 0 1 8 2Z" clipRule="evenodd" />
                  </svg>
                </div>
              </div>

              {/* You receive */}
              <div className="rounded-xl bg-muted/10 border border-border/20 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-muted-foreground/50">You receive</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xl font-semibold tabular-nums text-muted-foreground/70">
                    {tradeTab === "buy"
                      ? (estimatedTokens > 0 ? `~${estimatedTokens.toLocaleString()}` : "0")
                      : (estimatedSats > 0 ? `~${estimatedSats.toLocaleString()}` : "0")}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground/50">
                    {tradeTab === "buy" ? token.ticker : "sats"}
                  </span>
                </div>
              </div>

              {/* Slippage */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setShowSlippage(!showSlippage)}
                  className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
                >
                  Slippage: {slippage}%
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={`inline ml-1 h-3 w-3 transition-transform ${showSlippage ? "rotate-180" : ""}`}>
                    <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                  </svg>
                </button>
                {tradeTab === "buy" && slippagePct > 0 && (
                  <span className={`text-[11px] tabular-nums ${slippagePct > 5 ? "text-red-400" : "text-muted-foreground/40"}`}>
                    Impact: {slippagePct.toFixed(2)}%
                  </span>
                )}
              </div>

              {showSlippage && (
                <div className="flex gap-1.5">
                  {["0.5", "1", "2", "5"].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                        slippage === s
                          ? "bg-muted/30 text-foreground border border-border/40"
                          : "bg-muted/10 text-muted-foreground/50 border border-transparent hover:bg-muted/20"
                      }`}
                    >
                      {s}%
                    </button>
                  ))}
                </div>
              )}

              {/* Error / Success */}
              {tradeError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
                  <p className="text-xs text-red-400">{tradeError}</p>
                </div>
              )}
              {tradeSuccess && (
                <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
                  <p className="text-xs text-emerald-400">{tradeSuccess}</p>
                </div>
              )}

              {/* Action button */}
              <button
                disabled={!amountNum || amountNum <= 0 || tradeLoading || !walletReady}
                onClick={tradeTab === "buy" ? handleBuy : handleSell}
                className={`w-full py-3.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                  tradeTab === "buy"
                    ? "bg-emerald-500 hover:bg-emerald-400 text-white"
                    : "bg-red-500 hover:bg-red-400 text-white"
                }`}
              >
                {tradeLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-transparent" />
                    Processing...
                  </span>
                ) : tradeTab === "buy"
                  ? amountNum > 0 ? `Buy ~${estimatedTokens.toLocaleString()} $${token.ticker}` : "Enter amount"
                  : amountNum > 0 ? `Sell ${amountNum.toLocaleString()} $${token.ticker}` : "Enter amount"}
              </button>

              <div className="h-[env(safe-area-inset-bottom)] sm:hidden" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground/50">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${mono ? "font-mono text-muted-foreground/70" : ""}`}>
        {value}
      </span>
    </div>
  );
}
