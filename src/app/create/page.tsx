"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { issueToken, getDustAmount, getReceivingAddresses } from "@/lib/ark-wallet";
import { uploadImage } from "@/lib/image-upload";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";

const NAME_MAX = 32;
const TICKER_MAX = 10;
const DESC_MAX = 256;

export default function CreatePage() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  const arkWallet = useAppStore((s) => s.arkWallet);
  const walletReady = useAppStore((s) => s.walletReady);
  const upsertToken = useAppStore((s) => s.upsertToken);

  const balance = useAppStore((s) => s.balance);
  const [dustAmount, setDustAmount] = useState<number>(0);
  const [reissuable, setReissuable] = useState(false);
  // Need 2×dust for fixed supply (1 TX), 4×dust for reissuable (2 TXs)
  const minIssuanceCost = dustAmount * (reissuable ? 4 : 2);
  const hasEnoughSats = (balance?.available ?? 0) >= minIssuanceCost;

  useEffect(() => {
    if (!arkWallet) return;
    getDustAmount()
      .then((d) => setDustAmount(d))
      .catch((err) =>
        console.warn(
          "[create] Failed to get dust amount:",
          err instanceof Error ? err.message : err
        )
      );
  }, [arkWallet]);

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageUploadState, setImageUploadState] = useState<"idle" | "uploading" | "done" | "error">(
    "idle"
  );
  const [imageUploadedUrl, setImageUploadedUrl] = useState<string | null>(null);
  const [showUploadedBadge, setShowUploadedBadge] = useState(false);

  const [showSocials, setShowSocials] = useState(false);
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");

  const [supply, setSupply] = useState("");
  const supplyNum = parseInt(supply, 10);
  const [decimals, setDecimals] = useState("0");

  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    if (file.size > 15 * 1024 * 1024) {
      setError("Image must be under 15 MB");
      return;
    }
    setImageFile(file);
    setImageUploadState("uploading");
    setImageUploadedUrl(null);
    setError("");

    // Show local preview immediately while upload runs in background
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);

    // Upload to nostr.build — returns a plain HTTPS URL
    uploadImage(file)
      .then((url) => {
        setImageUploadedUrl(url);
        setImageUploadState("done");
        setShowUploadedBadge(true);
        setTimeout(() => setShowUploadedBadge(false), 1000);
      })
      .catch((err) => {
        console.error("Image upload failed:", err);
        setImageUploadState("error");
        setError("Image upload failed — you can still paste a URL manually.");
      });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const removeImage = () => {
    setImageFile(null);
    setImagePreview(null);
    setImageUploadedUrl(null);
    setImageUploadState("idle");
    setShowUploadedBadge(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // For display: use local preview while uploading, then uploaded URL
  const resolvedImage = imagePreview || imageUrl || undefined;

  const canCreate =
    name.trim().length > 0 &&
    ticker.trim().length > 0 &&
    supplyNum > 0 &&
    !isNaN(supplyNum) &&
    walletReady &&
    hasEnoughSats &&
    imageUploadState !== "uploading";

  const handleCreate = async () => {
    if (!canCreate || !arkWallet) return;
    setLoading(true);
    setError("");

    try {
      // Always use the hosted URL — never the raw base64 preview.
      // The SDK serialises the icon string verbatim into the OP_RETURN output,
      // so a base64 data URI would balloon the transaction size past the weight limit.
      const finalImage = imageUrl || imageUploadedUrl || "";
      const tickerUp = ticker.toUpperCase();

      let controlAssetId: string | undefined;

      if (reissuable) {
        // Official Arkade protocol: two separate issuances.
        // Step 1: issue a 1-unit control asset (no metadata) — proves reissuance rights
        setStep("Issuing control asset...");
        const controlResult = await issueToken(arkWallet, { amount: 1 });
        controlAssetId = controlResult.assetId;
        // Step 2: issue the main token with metadata, linked to the control asset
        setStep("Issuing main token...");
      } else {
        setStep("Issuing token on Arkade...");
      }

      const decimalsNum = parseInt(decimals, 10) || 0;
      const result = await issueToken(arkWallet, {
        amount: supplyNum,
        name,
        ticker: tickerUp,
        decimals: decimalsNum,
        icon: finalImage || undefined,
        ...(controlAssetId && { controlAssetId }),
      });

      // Get creator's Ark address
      const addrs = await getReceivingAddresses(arkWallet);
      const creatorArkAddress = addrs.offchainAddr;

      // Step 2: Submit metadata to indexer.
      // Wait for the indexer to pick up the asset from the SSE stream, then PUT metadata.
      setStep("Token issued! Waiting for indexer...");
      const metaBody = JSON.stringify({
        description,
        image: finalImage || undefined,
        creator: user?.pubkey ?? "",
        creatorArkAddress,
        supply: supplyNum,
        createdAt: Math.floor(Date.now() / 1000),
        ...(decimalsNum > 0 && { decimals: decimalsNum }),
        ...(website && { website }),
        ...(twitter && { twitter }),
        ...(telegram && { telegram }),
        ...(controlAssetId && { controlAssetId }),
      });
      // Sign metadata to prove creator key ownership
      let signedMetaBody = metaBody;
      try {
        const { sha256 } = await import("@noble/hashes/sha256");
        const { hex: scureHex } = await import("@scure/base");
        const { getMnemonic, getNostrKeyOverride } = await import("@/lib/wallet-storage");
        const { mnemonicToNostrPrivateKeyHex } = await import("@/lib/wallet-crypto");
        const { schnorr } = await import("@noble/curves/secp256k1");
        const mnemonic = await getMnemonic();
        const nostrOverride = await getNostrKeyOverride();
        const nostrPrivKey =
          nostrOverride || (mnemonic ? mnemonicToNostrPrivateKeyHex(mnemonic) : null);
        if (nostrPrivKey) {
          const metaMsg = sha256(new TextEncoder().encode(`metadata:${result.assetId}`));
          const metaSig = schnorr.sign(metaMsg, nostrPrivKey);
          const parsed = JSON.parse(metaBody);
          parsed.signature = scureHex.encode(metaSig);
          signedMetaBody = JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn("Failed to sign metadata:", e);
      }

      let metaOk = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 2000));
        try {
          const metaResp = await fetch(`${INDEXER_URL}/assets/${result.assetId}/metadata`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: signedMetaBody,
          });
          if (metaResp.ok) {
            metaOk = true;
            break;
          }
          if (metaResp.status !== 404) break; // non-retryable error
        } catch {
          /* network error, retry */
        }
        setStep("Token issued! Waiting for indexer...");
      }
      if (!metaOk) {
        console.warn("Metadata submit failed — token is on-chain, metadata may update later");
      }

      // Step 3: Add to local state
      upsertToken({
        id: result.assetId,
        assetId: result.assetId,
        name,
        ticker: tickerUp,
        description,
        image: finalImage || undefined,
        creator: user?.pubkey ?? "unknown",
        creatorArkAddress,
        createdAt: Math.floor(Date.now() / 1000),
        supply: supplyNum,
        ...(decimalsNum > 0 && { decimals: decimalsNum }),
        ...(controlAssetId && { controlAssetId }),
        replies: 0,
        tradeCount: 0,
        ...(website && { website }),
        ...(twitter && { twitter }),
        ...(telegram && { telegram }),
      });

      router.push(`/token/${tickerUp}`);
    } catch (err) {
      console.error("Failed to create token:", err);
      const msg = err instanceof Error ? err.message : "Failed to create token";
      if (/duplicated offchain tx/i.test(msg)) {
        // The tx was already submitted — token exists on Ark server.
        // This happens when a previous attempt succeeded server-side
        // but the client didn't get the response back.
        setError(
          "Token was already created (previous attempt succeeded). Check your wallet for the asset."
        );
      } else if (/insufficient|not enough|funds|AMOUNT_TOO_LOW/i.test(msg)) {
        setError("__insufficient__");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
      setStep("");
    }
  };

  const inputClass =
    "w-full px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all";

  return (
    <div className="mx-auto max-w-xl py-4 sm:py-8">
      {/* ── Hero header ── */}
      <div className="relative mb-8 sm:mb-10 text-center">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-32 rounded-full bg-white/[0.03] blur-3xl pointer-events-none" />

        <div className="relative">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight bg-gradient-to-b from-white via-white/90 to-white/40 bg-clip-text text-transparent">
            Launch your token
          </h1>
          <p className="mt-3 text-sm text-muted-foreground/50 max-w-sm mx-auto leading-relaxed">
            Issue on Arkade. Trade on vtxo.market.
            <br />
            <span className="text-muted-foreground/35">Immutable. Permissionless. Yours.</span>
          </p>
        </div>
      </div>

      {/* Wallet connecting */}
      {!walletReady && (
        <div className="mb-6 rounded-xl bg-orange-500/10 border border-orange-500/20 px-4 py-3 flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-400/50 border-t-transparent shrink-0" />
          <p className="text-xs text-orange-400/80">Connecting to Ark wallet...</p>
        </div>
      )}

      {/* Main form card */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        {/* Image upload section */}
        <div className="p-4 sm:p-6 pb-0 sm:pb-0">
          <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium mb-3 block">
            Token Image
          </label>

          {imagePreview ? (
            <div className="relative w-full flex justify-center">
              <div className="relative">
                <img
                  src={imagePreview}
                  alt="Token preview"
                  className="h-32 w-32 rounded-2xl object-cover ring-2 ring-white/[0.08]"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-red-500/90 text-white flex items-center justify-center text-xs font-bold hover:bg-red-400 transition-colors"
                >
                  &times;
                </button>
                {/* Upload status badge */}
                {imageUploadState === "uploading" && (
                  <div className="absolute bottom-0 inset-x-0 rounded-b-2xl bg-black/60 flex items-center justify-center gap-1.5 py-1.5">
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    <span className="text-[10px] text-white/80">Uploading…</span>
                  </div>
                )}
                {showUploadedBadge && (
                  <div className="absolute bottom-0 inset-x-0 rounded-b-2xl bg-emerald-500/70 flex items-center justify-center gap-1 py-1.5">
                    <span className="text-[10px] text-white font-medium">Uploaded ✓</span>
                  </div>
                )}
                {imageUploadState === "error" && (
                  <div className="absolute bottom-0 inset-x-0 rounded-b-2xl bg-red-500/70 flex items-center justify-center gap-1 py-1.5">
                    <span className="text-[10px] text-white">Upload failed</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`
                cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200
                flex flex-col items-center justify-center py-10 gap-3
                ${
                  dragActive
                    ? "border-white/[0.2] bg-white/[0.04] scale-[1.01]"
                    : "border-white/[0.08] hover:border-white/[0.14] hover:bg-white/[0.03]"
                }
              `}
            >
              <div className="h-12 w-12 rounded-xl bg-white/[0.06] flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  className="h-6 w-6 text-muted-foreground/60"
                >
                  <path d="M12 16V4m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                  <path
                    d="M2 17l.621 2.485A2 2 0 0 0 4.561 21h14.878a2 2 0 0 0 1.94-1.515L22 17"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground/80">
                  Drop image here or <span className="text-foreground">browse</span>
                </p>
                <p className="text-xs text-muted-foreground/40 mt-1">
                  JPG, PNG, GIF &middot; Max 15 MB &middot; Auto-hosted on nostr.build
                </p>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />

          {/* Or use URL */}
          {!imagePreview && (
            <div className="mt-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="h-px flex-1 bg-white/[0.06]" />
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40">
                  or paste URL
                </span>
                <div className="h-px flex-1 bg-white/[0.06]" />
              </div>
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/image.png"
                className={`${inputClass} h-9 text-xs`}
              />
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="mx-4 sm:mx-6 mt-6 h-px bg-white/[0.07]" />

        {/* Form fields */}
        <div className="p-4 sm:p-6 space-y-5">
          {/* Name + Ticker row */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr,140px] gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium">
                  Name <span className="text-red-400">*</span>
                </label>
                <span className="text-[10px] tabular-nums text-muted-foreground/40">
                  {name.length}/{NAME_MAX}
                </span>
              </div>
              <input
                placeholder="e.g. Bitcoin Frog"
                value={name}
                onChange={(e) => {
                  if (e.target.value.length <= NAME_MAX) setName(e.target.value);
                }}
                className={`${inputClass} h-11`}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium">
                  Ticker <span className="text-red-400">*</span>
                </label>
                <span className="text-[10px] tabular-nums text-muted-foreground/40">
                  {ticker.length}/{TICKER_MAX}
                </span>
              </div>
              <input
                placeholder="FROG"
                value={ticker}
                onChange={(e) => {
                  if (e.target.value.length <= TICKER_MAX) setTicker(e.target.value.toUpperCase());
                }}
                className={`${inputClass} h-11 font-mono tracking-wider`}
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium">
                Description
              </label>
              <span className="text-[10px] tabular-nums text-muted-foreground/40">
                {description.length}/{DESC_MAX}
              </span>
            </div>
            <textarea
              placeholder="Describe your token, its purpose, community, and vision..."
              value={description}
              onChange={(e) => {
                if (e.target.value.length <= DESC_MAX) setDescription(e.target.value);
              }}
              rows={3}
              className={`${inputClass} py-3 resize-none`}
            />
          </div>

          {/* Supply + Decimals row */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr,120px] gap-4">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium">
                Total Supply <span className="text-red-400">*</span>
              </label>
              <input
                type="number"
                min={1}
                placeholder="e.g. 1000000"
                value={supply}
                onChange={(e) => setSupply(e.target.value)}
                className={`${inputClass} h-11`}
              />
              {supply && supplyNum > 0 && (
                <p className="text-[11px] text-muted-foreground/40">
                  {supplyNum.toLocaleString()} tokens will be issued
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium">
                Decimals
              </label>
              <input
                type="number"
                min={0}
                max={18}
                placeholder="0"
                value={decimals}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (e.target.value === "" || (v >= 0 && v <= 18)) setDecimals(e.target.value);
                }}
                className={`${inputClass} h-11`}
              />
              <p className="text-[11px] text-muted-foreground/40">0–18</p>
            </div>
          </div>

          {/* Social links toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowSocials(!showSocials)}
              className="flex items-center gap-2 text-xs text-muted-foreground/60 hover:text-foreground/80 transition-colors group"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`h-3 w-3 transition-transform duration-200 ${showSocials ? "rotate-90" : ""}`}
              >
                <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
              <span className="group-hover:underline">
                {showSocials ? "Hide" : "Add"} social links
              </span>
              <span className="text-[10px] text-muted-foreground/40">optional</span>
            </button>

            {showSocials && (
              <div className="mt-4 space-y-3 pl-5 border-l-2 border-white/[0.06]">
                <div className="space-y-1.5">
                  <label className="text-[11px] text-muted-foreground/50 font-medium">
                    Website
                  </label>
                  <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://yourproject.com"
                    className={`${inputClass} h-9 text-xs`}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-muted-foreground/50 font-medium">
                    X / Twitter
                  </label>
                  <input
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    placeholder="https://x.com/yourproject"
                    className={`${inputClass} h-9 text-xs`}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-muted-foreground/50 font-medium">
                    Telegram
                  </label>
                  <input
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    placeholder="https://t.me/yourproject"
                    className={`${inputClass} h-9 text-xs`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Reissuable toggle */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <div className="relative shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={reissuable}
                  onChange={(e) => setReissuable(e.target.checked)}
                  className="sr-only"
                />
                <div
                  className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
                    reissuable
                      ? "bg-white/[0.9] border-white/[0.9]"
                      : "bg-white/[0.04] border-white/[0.2]"
                  }`}
                >
                  {reissuable && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 12 12"
                      fill="none"
                      className="w-2.5 h-2.5"
                    >
                      <path
                        d="M2 6l3 3 5-5"
                        stroke="#000"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground/80">Reissuable supply</p>
                <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                  Creates a control asset that lets you mint more tokens later. Costs ~
                  {dustAmount > 0 ? (dustAmount * 4).toLocaleString() : "1,320"} sats (two Ark
                  transactions).
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Divider */}
        <div className="mx-4 sm:mx-6 h-px bg-white/[0.07]" />

        {/* Preview + Info */}
        <div className="p-4 sm:p-6 space-y-5">
          {/* Live preview */}
          {(name || ticker || resolvedImage) && (
            <div className="rounded-xl bg-white/[0.05] border border-white/[0.07] p-4">
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/40 font-medium mb-3">
                Preview
              </p>
              <div className="flex items-center gap-4">
                <div className="relative">
                  {resolvedImage ? (
                    <img
                      src={resolvedImage}
                      alt="Token"
                      className="h-12 w-12 rounded-xl object-cover ring-1 ring-white/[0.1] shadow-[0_0_16px_rgba(255,255,255,0.04)]"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded-xl bg-white/[0.08] border border-white/[0.08] flex items-center justify-center text-lg font-bold text-muted-foreground/50 shadow-[0_0_16px_rgba(255,255,255,0.04)]">
                      {(ticker || name)?.[0] || "?"}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold leading-tight truncate">{name || "Token Name"}</p>
                  <p className="text-xs text-muted-foreground/50 font-mono mt-0.5">
                    ${ticker || "TICKER"}
                  </p>
                </div>
                {supplyNum > 0 && (
                  <div className="shrink-0 text-right">
                    <span className="text-[10px] text-muted-foreground/30 font-medium px-2 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06]">
                      {supplyNum >= 1_000_000_000
                        ? `${(supplyNum / 1_000_000_000).toFixed(1)}B`
                        : supplyNum >= 1_000_000
                          ? `${(supplyNum / 1_000_000).toFixed(1)}M`
                          : supplyNum >= 1_000
                            ? `${(supplyNum / 1_000).toFixed(1)}K`
                            : supplyNum.toLocaleString()}{" "}
                      supply
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Info box */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 flex gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-0.5"
            >
              <path
                fillRule="evenodd"
                d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM9 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 8a.75.75 0 0 0 0 1.5h.75v1.75a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8.25 8h-1.5Z"
                clipRule="evenodd"
              />
            </svg>
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground/80">Token Issuance</p>
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                Your token is issued on Arkade (Ark protocol) and listed on vtxo.market
                automatically. Costs ~
                {minIssuanceCost > 0 ? minIssuanceCost.toLocaleString() : "660"} sats.
              </p>
            </div>
          </div>

          {/* Error */}
          {error && error !== "__insufficient__" && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Insufficient funds error (after failed attempt) */}
          {error === "__insufficient__" && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 space-y-2">
              <p className="text-xs text-red-400 font-medium">Not enough sats to issue a token</p>
              <p className="text-[11px] text-red-400/70 leading-relaxed">
                You need at least{" "}
                {minIssuanceCost > 0 ? `${minIssuanceCost.toLocaleString()} sats` : "more sats"}{" "}
                available in your Ark wallet. You currently have{" "}
                {(balance?.available ?? 0).toLocaleString()} sats.
              </p>
              <Link
                href="/wallet"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors mt-1"
              >
                Go to Wallet
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-3 w-3"
                >
                  <path
                    fillRule="evenodd"
                    d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
            </div>
          )}

          {/* Insufficient sats warning (before they click, only after balance loaded) */}
          {walletReady && balance && !hasEnoughSats && dustAmount > 0 && !error && (
            <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 px-4 py-3 space-y-2">
              <p className="text-xs text-orange-400 font-medium">
                Minimum {minIssuanceCost.toLocaleString()} sats required to create a token
              </p>
              <p className="text-[11px] text-orange-400/70 leading-relaxed">
                You have {(balance?.available ?? 0).toLocaleString()} sats available. Deposit at
                least {(minIssuanceCost - (balance?.available ?? 0)).toLocaleString()} more sats to
                your Ark wallet.
              </p>
              <Link
                href="/wallet"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors mt-1"
              >
                Deposit sats
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-3 w-3"
                >
                  <path
                    fillRule="evenodd"
                    d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
            </div>
          )}

          {/* Create button */}
          <button
            onClick={handleCreate}
            disabled={!canCreate || loading}
            className="relative w-full h-12 rounded-xl bg-gradient-to-r from-white/[0.12] via-white/[0.08] to-white/[0.12] border border-white/[0.14] text-base font-semibold transition-all hover:from-white/[0.18] hover:via-white/[0.12] hover:to-white/[0.18] hover:border-white/[0.2] hover:shadow-[0_0_24px_rgba(255,255,255,0.06)] active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:shadow-none"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                {step || "Creating..."}
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-4 w-4"
                >
                  <path d="M7.628 1.099a.75.75 0 0 1 .744 0l5.25 3a.75.75 0 0 1 0 1.302l-5.25 3a.75.75 0 0 1-.744 0l-5.25-3a.75.75 0 0 1 0-1.302l5.25-3ZM2.57 7.24l4.308 2.462a.75.75 0 0 0 .744 0L11.93 7.24a.75.75 0 0 1 .744 1.302l-4.308 2.462a2.25 2.25 0 0 1-2.232 0L1.826 8.542A.75.75 0 0 1 2.57 7.24Z" />
                  <path d="M2.57 10.24l4.308 2.462a.75.75 0 0 0 .744 0l4.308-2.462a.75.75 0 0 1 .744 1.302l-4.308 2.462a2.25 2.25 0 0 1-2.232 0l-4.308-2.462a.75.75 0 0 1 .744-1.302Z" />
                </svg>
                Launch Token
              </span>
            )}
          </button>

          {/* Issuance cost note (when user has enough) */}
          {dustAmount > 0 && hasEnoughSats && (
            <p className="text-center text-[11px] text-muted-foreground/30">
              Issuance costs ~{minIssuanceCost > 0 ? minIssuanceCost.toLocaleString() : "660"} sats
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
