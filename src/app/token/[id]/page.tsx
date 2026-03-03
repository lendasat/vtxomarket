"use client";

import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/lib/store";
import { useComments } from "@/hooks/useComments";
import { useTrades } from "@/hooks/useTrades";
import { fetchTokenByTicker, publishTokenListing } from "@/lib/nostr-market";
import { reissueToken } from "@/lib/ark-wallet";
import type { Token } from "@/lib/store";

type InfoTab = "thread" | "trades" | "manage";

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

  // Comments & trades
  const { comments, loading: commentsLoading, postComment } = useComments(token?.id ?? null, ticker);
  const { trades, loading: tradesLoading } = useTrades(ticker);

  // User holding for this token
  const userHolding = useMemo(() => {
    if (!token?.assetId || heldAssets.length === 0) return 0;
    const held = heldAssets.find((a) => a.assetId === token.assetId);
    return held?.amount ?? 0;
  }, [token?.assetId, heldAssets]);

  const [infoTab, setInfoTab] = useState<InfoTab>("thread");
  const [newComment, setNewComment] = useState("");

  // Manage tab state
  const [reissueAmount, setReissueAmount] = useState("");
  const [reissueLoading, setReissueLoading] = useState(false);
  const [reissueError, setReissueError] = useState("");
  const [reissueSuccess, setReissueSuccess] = useState("");

  // Only creator who holds the control asset can manage
  const isCreator = user?.pubkey === token?.creator;
  const canManage = isCreator && !!token?.controlAssetId;

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

  // Reissue handler
  const handleReissue = async () => {
    if (!arkWallet || !token || !token.controlAssetId) return;
    const amt = parseInt(reissueAmount, 10);
    if (!amt || amt <= 0) return;
    setReissueLoading(true);
    setReissueError("");
    setReissueSuccess("");
    try {
      await reissueToken(arkWallet, token.assetId, amt);
      const newSupply = token.supply + amt;
      await publishTokenListing({
        name: token.name,
        ticker: token.ticker,
        description: token.description,
        image: token.image,
        assetId: token.assetId,
        arkTxId: token.assetId,
        creatorArkAddress: token.creatorArkAddress,
        supply: newSupply,
        controlAssetId: token.controlAssetId,
        ...(token.website && { website: token.website }),
        ...(token.twitter && { twitter: token.twitter }),
        ...(token.telegram && { telegram: token.telegram }),
      });
      upsertToken({ ...token, supply: newSupply });
      setReissueSuccess(`Minted ${amt.toLocaleString()} tokens. New supply: ${newSupply.toLocaleString()}`);
      setReissueAmount("");
    } catch (err) {
      setReissueError(err instanceof Error ? err.message : "Reissue failed");
    } finally {
      setReissueLoading(false);
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
            {token.supply.toLocaleString()} <span className="text-muted-foreground/30 text-xs">supply</span>
          </p>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid gap-4 lg:grid-cols-[1fr,300px]">
        {/* Left: Tabs */}
        <div className="space-y-4">
          {/* Info tabs */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
            <div className="flex border-b border-white/[0.07]">
              {(["thread", "trades"] as const).map((tab) => (
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
              {canManage && (
                <button
                  onClick={() => setInfoTab("manage")}
                  className={`flex-1 py-3 text-xs font-medium transition-colors ${
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

              {/* Manage */}
              {infoTab === "manage" && canManage && token && (
                <div className="space-y-4">
                  {/* Supply info */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-muted-foreground/50">Total supply</span>
                      <span className="text-xs font-medium tabular-nums">{token.supply.toLocaleString()} tokens</span>
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
              <span className="text-sm font-semibold tabular-nums">{userHolding.toLocaleString()} ${token.ticker}</span>
            </div>
          )}

          {/* Token info */}
          <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm p-4 space-y-3">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground/40">
              Token Info
            </h3>
            <div className="space-y-2.5">
              <InfoRow label="Supply" value={token.supply.toLocaleString()} />
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
