"use client";

import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppStore } from "@/lib/store";
import { useComments } from "@/hooks/useComments";
import { useTrades } from "@/hooks/useTrades";
import { useTokens } from "@/hooks/useTokens";
import { reissueToken, createSwapOffer, fillSwapOffer, cancelSwapOffer, createBuyOffer, fillBuyOffer, cancelBuyOffer } from "@/lib/ark-wallet";
import { TokenChart } from "@/components/token-chart";
import { useOffers } from "@/hooks/useOffers";
import { formatTokenAmount, parseTokenInput, formatSats, formatPrice } from "@/lib/format";
import type { Token } from "@/lib/store";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";

type InfoTab = "buy-offers" | "sell-offers" | "thread" | "trades" | "manage";

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shortPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}...${pk.slice(-4)}`;
}

export default function TokenPage() {
  const params = useParams();
  const router = useRouter();
  const ticker = (params.id as string)?.toUpperCase();

  const { tokens, loading: tokensLoading } = useTokens();
  const upsertToken = useAppStore((s) => s.upsertToken);
  const nostrReady = useAppStore((s) => s.nostrReady);
  const walletReady = useAppStore((s) => s.walletReady);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const user = useAppStore((s) => s.user);
  const heldAssets = useAppStore((s) => s.heldAssets);

  const token = useMemo(() => tokens.find((t) => t.ticker === ticker) ?? null, [tokens, ticker]);
  const fetching = tokensLoading && !token;

  // Comments & trades
  const { comments, loading: commentsLoading, postComment } = useComments(ticker);
  const { trades, loading: tradesLoading } = useTrades(token?.assetId ?? null);

  // Swap offers
  const { offers, loading: offersLoading, refetch: refetchOffers } = useOffers(token?.assetId ?? null);

  // User holding for this token
  const userHolding = useMemo(() => {
    if (!token?.assetId || heldAssets.length === 0) return 0;
    const held = heldAssets.find((a) => a.assetId === token.assetId);
    return held?.amount ?? 0;
  }, [token?.assetId, heldAssets]);

  const [infoTab, setInfoTab] = useState<InfoTab>("buy-offers");
  const [showSellDialog, setShowSellDialog] = useState(false);
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [newComment, setNewComment] = useState("");

  // Manage tab state
  const [reissueAmount, setReissueAmount] = useState("");
  const [reissueLoading, setReissueLoading] = useState(false);
  const [reissueError, setReissueError] = useState("");
  const [reissueSuccess, setReissueSuccess] = useState("");

  // Trade tab state — sell offer form
  const [offerTokenAmount, setOfferTokenAmount] = useState("");
  const [offerSatAmount, setOfferSatAmount] = useState("");
  const [offerExpiry, setOfferExpiry] = useState<3600 | 21600 | 86400>(3600);
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerError, setOfferError] = useState("");
  const [offerSuccess, setOfferSuccess] = useState("");
  // Buy offer form
  const [buyOfferTokenAmount, setBuyOfferTokenAmount] = useState("");
  const [buyOfferSatAmount, setBuyOfferSatAmount] = useState("");
  const [buyOfferExpiry, setBuyOfferExpiry] = useState<3600 | 21600 | 86400>(3600);
  const [buyOfferLoading, setBuyOfferLoading] = useState(false);
  const [buyOfferError, setBuyOfferError] = useState("");
  const [buyOfferSuccess, setBuyOfferSuccess] = useState("");

  const [fillLoading, setFillLoading] = useState<string | null>(null); // offerOutpoint being filled
  const [fillError, setFillError] = useState("");
  const [cancelLoading, setCancelLoading] = useState<string | null>(null); // offerOutpoint being cancelled
  const [cancelError, setCancelError] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ type: "buy" | "sell" | "cancel"; outpoint: string } | null>(null);
  const [commentError, setCommentError] = useState("");
  const [userArkAddress, setUserArkAddress] = useState("");

  // Fetch user's Ark address (for identifying own offers)
  useEffect(() => {
    if (!arkWallet) return;
    arkWallet.getAddress().then(setUserArkAddress).catch((err: unknown) => {
      console.warn("[token] Failed to fetch user Ark address:", err instanceof Error ? err.message : err);
    });
  }, [arkWallet]);

  // Only creator who holds the control asset can manage
  const isCreator = user?.pubkey === token?.creator;
  const canManage = isCreator && !!token?.controlAssetId;

  // Split offers by type
  const sellOffers = useMemo(() => offers.filter((o) => o.offerType !== 'buy'), [offers]);
  const buyOffers = useMemo(() => offers.filter((o) => o.offerType === 'buy'), [offers]);

  // Post comment
  const handlePostComment = async () => {
    if (!newComment.trim()) return;
    setCommentError("");
    try {
      await postComment(newComment);
      setNewComment("");
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : "Failed to post comment");
    }
  };

  // Reissue handler
  const handleReissue = async () => {
    if (!arkWallet || !token || !token.controlAssetId) return;
    const amt = parseTokenInput(reissueAmount, token.decimals);
    if (!amt || amt <= 0) return;
    setReissueLoading(true);
    setReissueError("");
    setReissueSuccess("");
    try {
      await reissueToken(arkWallet, token.assetId, amt);
      const newSupply = token.supply + amt;
      // Update supply in indexer
      await fetch(`${INDEXER_URL}/assets/${token.assetId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supply: newSupply }),
      }).catch((err) => console.warn("Metadata update failed:", err));
      upsertToken({ ...token, supply: newSupply });
      setReissueSuccess(`Minted ${formatTokenAmount(amt, token.decimals)} tokens. New supply: ${formatTokenAmount(newSupply, token.decimals)}`);
      setReissueAmount("");
    } catch (err) {
      setReissueError(err instanceof Error ? err.message : "Reissue failed");
    } finally {
      setReissueLoading(false);
    }
  };

  // Create swap offer handler
  const handleCreateOffer = async () => {
    if (!arkWallet || !token) return;
    const tokenAmt = parseTokenInput(offerTokenAmount, token.decimals);
    const satAmt = parseInt(offerSatAmount, 10);
    if (!tokenAmt || tokenAmt <= 0 || !satAmt || satAmt <= 0) return;
    if (tokenAmt > userHolding) {
      setOfferError(`Insufficient balance: you hold ${formatTokenAmount(userHolding, token.decimals)} ${token.ticker}`);
      return;
    }

    setOfferLoading(true);
    setOfferError("");
    setOfferSuccess("");

    try {
      // wallet.send() handles coin selection — no need to manually find a VTXO
      const offer = await createSwapOffer(arkWallet, {
        assetId: token.assetId,
        tokenAmount: tokenAmt,
        satAmount: satAmt,
        expiresInSeconds: offerExpiry,
      });

      // Self-report to indexer
      await fetch(`${INDEXER_URL}/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offer),
      });

      setOfferSuccess(`Offer created! ${tokenAmt} ${token.ticker} for ${satAmt} sats`);
      setOfferTokenAmount("");
      setOfferSatAmount("");
      setShowSellDialog(false);
      refetchOffers();
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : "Failed to create offer");
    } finally {
      setOfferLoading(false);
    }
  };

  const tradeInFlight = fillLoading !== null || cancelLoading !== null;

  // Fill swap offer handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFill = async (offer: any) => {
    if (!arkWallet || tradeInFlight) return;
    setConfirmAction(null);
    setFillLoading(offer.offerOutpoint);
    setFillError("");
    try {
      await fillSwapOffer(arkWallet, offer);
      refetchOffers();
    } catch (err) {
      setFillError(err instanceof Error ? err.message : "Fill failed");
    } finally {
      setFillLoading(null);
    }
  };

  // Cancel own swap offer handler (maker only — works for both sell and buy offers)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCancelOffer = async (offer: any) => {
    if (!arkWallet || tradeInFlight) return;
    setConfirmAction(null);
    setCancelLoading(offer.offerOutpoint);
    setCancelError("");
    try {
      if (offer.offerType === 'buy') {
        await cancelBuyOffer(arkWallet, offer);
      } else {
        await cancelSwapOffer(arkWallet, offer);
      }
      refetchOffers();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancelLoading(null);
    }
  };

  // Create buy offer handler
  const handleCreateBuyOffer = async () => {
    if (!arkWallet || !token) return;
    const tokenAmt = parseTokenInput(buyOfferTokenAmount, token.decimals);
    const satAmt = parseInt(buyOfferSatAmount, 10);
    if (!tokenAmt || tokenAmt <= 0 || !satAmt || satAmt <= 0) return;

    setBuyOfferLoading(true);
    setBuyOfferError("");
    setBuyOfferSuccess("");

    try {
      const offer = await createBuyOffer(arkWallet, {
        assetId: token.assetId,
        tokenAmount: tokenAmt,
        satAmount: satAmt,
        expiresInSeconds: buyOfferExpiry,
      });

      // Self-report to indexer
      await fetch(`${INDEXER_URL}/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offer),
      });

      setBuyOfferSuccess(`Buy offer created! Buying ${tokenAmt} ${token.ticker} for ${satAmt} sats`);
      setBuyOfferTokenAmount("");
      setBuyOfferSatAmount("");
      setShowBuyDialog(false);
      refetchOffers();
    } catch (err) {
      setBuyOfferError(err instanceof Error ? err.message : "Failed to create buy offer");
    } finally {
      setBuyOfferLoading(false);
    }
  };

  // Fill buy offer handler — seller fills a buy offer (provides tokens, receives sats)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFillBuyOffer = async (offer: any) => {
    if (!arkWallet || tradeInFlight) return;
    setConfirmAction(null);
    setFillLoading(offer.offerOutpoint);
    setFillError("");
    try {
      await fillBuyOffer(arkWallet, offer);
      refetchOffers();
    } catch (err) {
      setFillError(err instanceof Error ? err.message : "Fill failed");
    } finally {
      setFillLoading(null);
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
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/40">
              <span className="sm:hidden font-mono">${token.ticker}</span>
              <span className="hidden sm:inline">by {shortPubkey(token.creator)}</span>
              <span>{timeAgo(token.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm tabular-nums text-muted-foreground/50">
            {formatTokenAmount(token.supply, token.decimals)} <span className="text-muted-foreground/30 text-xs">supply</span>
          </p>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid gap-4 lg:grid-cols-[1fr,300px]">
        {/* Left: Chart + Tabs */}
        <div className="space-y-4">
          {/* Price chart */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4">
            <TokenChart
              trades={trades}
              basePrice={trades.length > 0 ? trades[0].price : 0}
            />
          </div>

          {/* Buy / Sell buttons */}
          {walletReady && token && (
            <div className="flex gap-2">
              <button
                onClick={() => setShowBuyDialog(true)}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-sm font-semibold text-emerald-400 transition-all hover:bg-emerald-500/30"
              >
                Buy
              </button>
              <button
                onClick={() => setShowSellDialog(true)}
                disabled={userHolding <= 0}
                className="flex-1 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Sell
              </button>
            </div>
          )}

          {/* Info tabs */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
            <div className="flex border-b border-white/[0.07] overflow-x-auto">
              {([
                ["buy-offers", "Buy Offers", buyOffers.length],
                ["sell-offers", "Sell Offers", sellOffers.length],
                ["thread", "Thread", comments.length],
                ["trades", "Trades", trades.length],
              ] as const).map(([tab, label, count]) => (
                <button
                  key={tab}
                  onClick={() => setInfoTab(tab)}
                  className={`flex-1 shrink-0 py-3 text-xs font-medium transition-colors ${
                    infoTab === tab
                      ? "text-foreground border-b-2 border-primary"
                      : "text-muted-foreground/60 hover:text-muted-foreground"
                  }`}
                >
                  {label}
                  {count > 0 && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/40">{count}</span>
                  )}
                </button>
              ))}
              {canManage && (
                <button
                  onClick={() => setInfoTab("manage")}
                  className={`flex-1 shrink-0 py-3 text-xs font-medium transition-colors ${
                    infoTab === "manage"
                      ? "text-foreground border-b-2 border-primary"
                      : "text-muted-foreground/60 hover:text-muted-foreground"
                  }`}
                >
                  Manage
                </button>
              )}
            </div>

            <div className="p-4">
              {/* Buy Offers */}
              {infoTab === "buy-offers" && token && (
                <div>
                  {offersLoading && buyOffers.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">Loading offers...</p>
                  )}
                  {!offersLoading && buyOffers.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">No buy offers yet.</p>
                  )}
                  {buyOffers.length > 0 && (
                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
                      <div className="grid grid-cols-[1fr,1fr,1fr,auto] gap-2 px-3 py-2 border-b border-white/[0.05]">
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Wants</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Price</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Paying</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase w-20 text-right">Action</span>
                      </div>
                      {buyOffers.map((offer) => {
                        const isOwn = userArkAddress && offer.makerArkAddress === userArkAddress;
                        return (
                          <div key={offer.offerOutpoint} className="grid grid-cols-[1fr,1fr,1fr,auto] gap-2 items-center px-3 py-2.5 border-b border-white/[0.04] last:border-0">
                            <span className="text-xs tabular-nums">
                              {formatTokenAmount(offer.tokenAmount, token.decimals)}
                              <span className="text-muted-foreground/35 text-[10px] ml-0.5">${token.ticker}</span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground/70">
                              {formatPrice(offer.satAmount, offer.tokenAmount, token.decimals)}
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground/70">
                              {formatSats(offer.satAmount)}
                              <span className="text-[10px] text-muted-foreground/35 ml-0.5">sat</span>
                            </span>
                            {isOwn ? (
                              <OfferCancelButton offer={offer} cancelLoading={cancelLoading} confirmAction={confirmAction} setConfirmAction={setConfirmAction} handleCancelOffer={handleCancelOffer} walletReady={walletReady} tradeInFlight={tradeInFlight} />
                            ) : (
                              <OfferFillButton offer={offer} type="sell" fillLoading={fillLoading} confirmAction={confirmAction} setConfirmAction={setConfirmAction} handleFill={handleFillBuyOffer} walletReady={walletReady} tradeInFlight={tradeInFlight} disabled={userHolding < offer.tokenAmount} label="Sell" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fillError && <p className="text-xs text-red-400 mt-2">{fillError}</p>}
                  {cancelError && <p className="text-xs text-red-400 mt-2">{cancelError}</p>}
                </div>
              )}

              {/* Sell Offers */}
              {infoTab === "sell-offers" && token && (
                <div>
                  {offersLoading && sellOffers.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">Loading offers...</p>
                  )}
                  {!offersLoading && sellOffers.length === 0 && (
                    <p className="text-xs text-muted-foreground/40 text-center py-4">No sell offers yet.</p>
                  )}
                  {sellOffers.length > 0 && (
                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
                      <div className="grid grid-cols-[1fr,1fr,1fr,auto] gap-2 px-3 py-2 border-b border-white/[0.05]">
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Amount</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Price</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase">Total</span>
                        <span className="text-[10px] text-muted-foreground/40 font-medium uppercase w-20 text-right">Action</span>
                      </div>
                      {sellOffers.map((offer) => {
                        const isOwn = userArkAddress && offer.makerArkAddress === userArkAddress;
                        return (
                          <div key={offer.offerOutpoint} className="grid grid-cols-[1fr,1fr,1fr,auto] gap-2 items-center px-3 py-2.5 border-b border-white/[0.04] last:border-0">
                            <span className="text-xs tabular-nums">
                              {formatTokenAmount(offer.tokenAmount, token.decimals)}
                              <span className="text-muted-foreground/35 text-[10px] ml-0.5">${token.ticker}</span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground/70">
                              {formatPrice(offer.satAmount, offer.tokenAmount, token.decimals)}
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground/70">
                              {formatSats(offer.satAmount)}
                              <span className="text-[10px] text-muted-foreground/35 ml-0.5">sat</span>
                            </span>
                            {isOwn ? (
                              <OfferCancelButton offer={offer} cancelLoading={cancelLoading} confirmAction={confirmAction} setConfirmAction={setConfirmAction} handleCancelOffer={handleCancelOffer} walletReady={walletReady} tradeInFlight={tradeInFlight} />
                            ) : (
                              <OfferFillButton offer={offer} type="buy" fillLoading={fillLoading} confirmAction={confirmAction} setConfirmAction={setConfirmAction} handleFill={handleFill} walletReady={walletReady} tradeInFlight={tradeInFlight} label="Buy" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fillError && <p className="text-xs text-red-400 mt-2">{fillError}</p>}
                  {cancelError && <p className="text-xs text-red-400 mt-2">{cancelError}</p>}
                </div>
              )}

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

                  {commentError && (
                    <p className="text-xs text-red-400/80">{commentError}</p>
                  )}

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
                      // offerType "sell" = someone sold tokens (taker bought) → show as buy
                      // offerType "buy" = someone bought tokens (taker sold) → show as buy
                      const isBuy = t.offerType === "sell";
                      return (
                        <div
                          key={t.filledInTxid || t.offerOutpoint}
                          className="flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isBuy ? "bg-emerald-400" : "bg-amber-400"
                          }`} />
                          <span className="shrink-0 text-[11px] font-mono text-muted-foreground/40">
                            {shortPubkey(t.makerArkAddress)}
                          </span>
                          <span className={`shrink-0 text-[11px] font-medium ${isBuy ? "text-emerald-400/80" : "text-amber-400/80"}`}>
                            {isBuy ? "sold" : "bought"}
                          </span>
                          <span className="text-[11px] font-semibold tabular-nums">
                            {formatTokenAmount(t.tokenAmount, token?.decimals)}
                            <span className="text-muted-foreground/35 font-normal ml-0.5">${token?.ticker}</span>
                          </span>
                          <div className="flex-1" />
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
                            {formatSats(t.satAmount)} <span className="text-muted-foreground/30">sat</span>
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

              {/* Manage */}
              {infoTab === "manage" && canManage && token && (
                <div className="space-y-4">
                  {/* Supply info */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-muted-foreground/50">Total supply</span>
                      <span className="text-xs font-medium tabular-nums">{formatTokenAmount(token.supply, token.decimals)} tokens</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-muted-foreground/50">Control asset</span>
                      <span className="text-xs font-mono text-muted-foreground/70">{token.controlAssetId?.slice(0, 8)}…{token.controlAssetId?.slice(-4)}</span>
                    </div>
                  </div>

                  <div className="h-px bg-white/[0.06]" />

                  {/* Reissue form */}
                  <div className="space-y-3">
                    <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-[0.12em]">Mint more tokens</p>
                    <input
                      type="number"
                      min={1}
                      value={reissueAmount}
                      onChange={(e) => setReissueAmount(e.target.value)}
                      placeholder="Amount to mint"
                      className="w-full px-4 h-10 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
                    />

                    {reissueError && (
                      <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
                        <p className="text-xs text-red-400">{reissueError}</p>
                      </div>
                    )}
                    {reissueSuccess && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
                        <p className="text-xs text-emerald-400">{reissueSuccess}</p>
                      </div>
                    )}

                    <button
                      onClick={handleReissue}
                      disabled={!reissueAmount || parseInt(reissueAmount, 10) <= 0 || reissueLoading || !walletReady}
                      className="w-full py-2.5 rounded-xl bg-white/[0.1] border border-white/[0.14] text-sm font-semibold transition-all hover:bg-white/[0.15] disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {reissueLoading ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground/50 border-t-transparent" />
                          Minting...
                        </span>
                      ) : "Reissue"}
                    </button>

                    <p className="text-[11px] text-muted-foreground/35 leading-relaxed">
                      Reissuing mints new tokens into your wallet. This is inflation — existing holders are diluted.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column: Token info */}
        <div className="space-y-4">
          {/* User holding */}
          {userHolding > 0 && (
            <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-2">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
                Your Holdings
              </h3>
              <span className="text-sm font-semibold tabular-nums">{formatTokenAmount(userHolding, token.decimals)} ${token.ticker}</span>
            </div>
          )}

          {/* Token info */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-3">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
              Token Info
            </h3>
            <div className="space-y-2.5">
              <InfoRow label="Supply" value={formatTokenAmount(token.supply, token.decimals)} />
              <InfoRow label="Replies" value={String(comments.length)} />
              <InfoRow label="Creator" value={shortPubkey(token.creator)} mono />
              <InfoRow label="Asset ID" value={`${token.assetId.slice(0, 8)}…`} mono />
            </div>
            {token.description && (
              <>
                <div className="h-px bg-white/[0.06]" />
                <p className="text-xs text-muted-foreground/50 leading-relaxed">{token.description}</p>
              </>
            )}
            {(token.website || token.twitter || token.telegram) && (
              <>
                <div className="h-px bg-white/[0.06]" />
                <div className="flex flex-wrap gap-2">
                  {token.website && (
                    <a href={token.website} target="_blank" rel="noopener noreferrer" className="text-[11px] text-muted-foreground/50 hover:text-foreground/70 transition-colors underline">
                      Website
                    </a>
                  )}
                  {token.twitter && (
                    <a href={token.twitter} target="_blank" rel="noopener noreferrer" className="text-[11px] text-muted-foreground/50 hover:text-foreground/70 transition-colors underline">
                      X/Twitter
                    </a>
                  )}
                  {token.telegram && (
                    <a href={token.telegram} target="_blank" rel="noopener noreferrer" className="text-[11px] text-muted-foreground/50 hover:text-foreground/70 transition-colors underline">
                      Telegram
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Buy Dialog ── */}
      {token && (
        <Dialog open={showBuyDialog} onOpenChange={setShowBuyDialog}>
          <DialogContent className="bg-zinc-950 border-white/[0.1]">
            <DialogHeader>
              <DialogTitle>Create Buy Offer</DialogTitle>
              <p className="text-xs text-muted-foreground">Lock sats to buy ${token.ticker}. Any seller can fill it.</p>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground/40 mb-1 block">Token amount</label>
                  <input type="number" min={1} value={buyOfferTokenAmount} onChange={(e) => setBuyOfferTokenAmount(e.target.value)} placeholder="Amount" className="w-full px-3 h-9 text-xs rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground/40 mb-1 block">Sats to pay</label>
                  <input type="number" min={1} value={buyOfferSatAmount} onChange={(e) => setBuyOfferSatAmount(e.target.value)} placeholder="Sats" className="w-full px-3 h-9 text-xs rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all" />
                </div>
              </div>
              {buyOfferTokenAmount && buyOfferSatAmount && Number(buyOfferTokenAmount) > 0 && Number(buyOfferSatAmount) > 0 && (
                <p className="text-[11px] text-muted-foreground/50 tabular-nums">
                  Price: {formatPrice(Number(buyOfferSatAmount), Number(buyOfferTokenAmount), token.decimals)}
                </p>
              )}
              <div className="flex gap-1">
                {([["1h", 3600], ["6h", 21600], ["24h", 86400]] as const).map(([label, val]) => (
                  <button key={val} onClick={() => setBuyOfferExpiry(val)} className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${buyOfferExpiry === val ? "bg-white/[0.1] border-white/[0.2] text-foreground" : "bg-white/[0.03] border-white/[0.06] text-muted-foreground/50 hover:text-muted-foreground"}`}>{label}</button>
                ))}
              </div>
              {buyOfferError && <p className="text-xs text-red-400">{buyOfferError}</p>}
              {buyOfferSuccess && <p className="text-xs text-emerald-400">{buyOfferSuccess}</p>}
              <button
                onClick={handleCreateBuyOffer}
                disabled={!buyOfferTokenAmount || !buyOfferSatAmount || parseInt(buyOfferTokenAmount, 10) <= 0 || parseInt(buyOfferSatAmount, 10) <= 0 || buyOfferLoading || !walletReady}
                className="w-full py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-sm font-semibold text-emerald-400 transition-all hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {buyOfferLoading ? <span className="flex items-center justify-center gap-2"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-400/50 border-t-transparent" />Creating...</span> : "Create Buy Offer"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Sell Dialog ── */}
      {token && (
        <Dialog open={showSellDialog} onOpenChange={setShowSellDialog}>
          <DialogContent className="bg-zinc-950 border-white/[0.1]">
            <DialogHeader>
              <DialogTitle>Create Sell Offer</DialogTitle>
              <p className="text-xs text-muted-foreground">Lock ${token.ticker} tokens. Any buyer can fill with sats.</p>
            </DialogHeader>
            <div className="space-y-3">
              {userHolding > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground/40 mb-1 block">Token amount</label>
                      <input type="number" min={1} max={userHolding} value={offerTokenAmount} onChange={(e) => setOfferTokenAmount(e.target.value)} placeholder={`Max ${formatTokenAmount(userHolding, token.decimals)}`} className="w-full px-3 h-9 text-xs rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground/40 mb-1 block">Sats to receive</label>
                      <input type="number" min={1} value={offerSatAmount} onChange={(e) => setOfferSatAmount(e.target.value)} placeholder="Sats" className="w-full px-3 h-9 text-xs rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all" />
                    </div>
                  </div>
                  {offerTokenAmount && offerSatAmount && Number(offerTokenAmount) > 0 && Number(offerSatAmount) > 0 && (
                    <p className="text-[11px] text-muted-foreground/50 tabular-nums">
                      Price: {formatPrice(Number(offerSatAmount), Number(offerTokenAmount), token.decimals)}
                    </p>
                  )}
                  <div className="flex gap-1">
                    {([["1h", 3600], ["6h", 21600], ["24h", 86400]] as const).map(([label, val]) => (
                      <button key={val} onClick={() => setOfferExpiry(val)} className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${offerExpiry === val ? "bg-white/[0.1] border-white/[0.2] text-foreground" : "bg-white/[0.03] border-white/[0.06] text-muted-foreground/50 hover:text-muted-foreground"}`}>{label}</button>
                    ))}
                  </div>
                  {offerError && <p className="text-xs text-red-400">{offerError}</p>}
                  {offerSuccess && <p className="text-xs text-emerald-400">{offerSuccess}</p>}
                  <button
                    onClick={handleCreateOffer}
                    disabled={!offerTokenAmount || !offerSatAmount || parseInt(offerTokenAmount, 10) <= 0 || parseInt(offerSatAmount, 10) <= 0 || offerLoading || !walletReady}
                    className="w-full py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {offerLoading ? <span className="flex items-center justify-center gap-2"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-400/50 border-t-transparent" />Creating...</span> : "Create Sell Offer"}
                  </button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground/40 text-center py-3">You don&apos;t hold any ${token.ticker} to sell.</p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Offer action button helpers ──────────────────────────────────────────────

function OfferCancelButton({ offer, cancelLoading, confirmAction, setConfirmAction, handleCancelOffer, walletReady, tradeInFlight }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any; cancelLoading: string | null; confirmAction: { type: string; outpoint: string } | null;
  setConfirmAction: (v: { type: "buy" | "sell" | "cancel"; outpoint: string } | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleCancelOffer: (o: any) => void; walletReady: boolean; tradeInFlight: boolean;
}) {
  if (cancelLoading === offer.offerOutpoint) {
    return <span className="w-20 py-1 flex items-center justify-center"><span className="h-2.5 w-2.5 animate-spin rounded-full border border-red-400/50 border-t-transparent" /></span>;
  }
  if (confirmAction?.type === "cancel" && confirmAction.outpoint === offer.offerOutpoint) {
    return (
      <div className="flex gap-1">
        <button onClick={() => handleCancelOffer(offer)} className="px-2 py-1 rounded-lg bg-red-500/30 border border-red-500/40 text-[10px] font-semibold text-red-400 hover:bg-red-500/40 transition-colors">Yes</button>
        <button onClick={() => setConfirmAction(null)} className="px-2 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[10px] font-semibold text-muted-foreground hover:bg-white/[0.1] transition-colors">No</button>
      </div>
    );
  }
  return (
    <button onClick={() => setConfirmAction({ type: "cancel", outpoint: offer.offerOutpoint })} disabled={!walletReady || tradeInFlight} className="w-20 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-[11px] font-semibold text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
      Cancel
    </button>
  );
}

function OfferFillButton({ offer, type, fillLoading, confirmAction, setConfirmAction, handleFill, walletReady, tradeInFlight, disabled, label }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any; type: "buy" | "sell"; fillLoading: string | null;
  confirmAction: { type: string; outpoint: string } | null;
  setConfirmAction: (v: { type: "buy" | "sell" | "cancel"; outpoint: string } | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleFill: (o: any) => void; walletReady: boolean; tradeInFlight: boolean; disabled?: boolean; label: string;
}) {
  const isBuy = type === "buy";
  if (fillLoading === offer.offerOutpoint) {
    return <span className="w-20 py-1 flex items-center justify-center"><span className={`h-2.5 w-2.5 animate-spin rounded-full border border-t-transparent ${isBuy ? "border-emerald-400/50" : "border-amber-400/50"}`} /></span>;
  }
  if (confirmAction?.type === type && confirmAction.outpoint === offer.offerOutpoint) {
    return (
      <div className="flex gap-1">
        <button onClick={() => handleFill(offer)} className={`px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors ${isBuy ? "bg-emerald-500/30 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/40" : "bg-amber-500/30 border border-amber-500/40 text-amber-400 hover:bg-amber-500/40"}`}>Yes</button>
        <button onClick={() => setConfirmAction(null)} className="px-2 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[10px] font-semibold text-muted-foreground hover:bg-white/[0.1] transition-colors">No</button>
      </div>
    );
  }
  return (
    <button onClick={() => setConfirmAction({ type, outpoint: offer.offerOutpoint })} disabled={!walletReady || tradeInFlight || disabled} className={`w-20 py-1 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${isBuy ? "bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30" : "bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30"}`}>
      {label}
    </button>
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
