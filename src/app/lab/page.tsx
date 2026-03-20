"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { hex as scureHex } from "@scure/base";
import { useAppStore, isControlAsset } from "@/lib/store";
import { safeUrl } from "@/lib/safe-url";
import { formatTokenAmount } from "@/lib/format";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";
import { useTokens } from "@/hooks/useTokens";
import {
  encodeLE64,
  createSwapOffer,
  fillSwapOffer,
  cancelSwapOffer,
  createBuyOffer,
  fillBuyOffer,
  cancelBuyOffer,
  type SwapOffer,
  type BuyOffer,
} from "@/lib/ark-wallet";

// ── Opcode reference data ──────────────────────────────────────────────────────

// Hex values from introspector/pkg/arkade/opcode.go (authoritative source)
const OPCODES = [
  {
    byte: "0xCF",
    dec: 207,
    name: "OP_INSPECTOUTPUTVALUE",
    used: true,
    desc: "Pop output index → push output[i].value as 8-byte LE64",
  },
  {
    byte: "0xD1",
    dec: 209,
    name: "OP_INSPECTOUTPUTSCRIPTPUBKEY",
    used: true,
    desc: "Pop output index → push witnessProgram, then version on top",
  },
  {
    byte: "0xCE",
    dec: 206,
    name: "OP_INSPECTOUTPUTASSET",
    used: false,
    desc: "Not implemented in introspector — 0xCE is OP_UNKNOWN206",
  },
  {
    byte: "0xD0",
    dec: 208,
    name: "OP_INSPECTOUTPUTNONCE",
    used: false,
    desc: "Pop output index → push output[i].nonce (confidential tx)",
  },
  {
    byte: "0xC9",
    dec: 201,
    name: "OP_INSPECTINPUTVALUE",
    used: false,
    desc: "Pop input index → push input[i].value as 8-byte LE64",
  },
  {
    byte: "0xCA",
    dec: 202,
    name: "OP_INSPECTINPUTSCRIPTPUBKEY",
    used: false,
    desc: "Pop input index → push input[i].scriptPubKey",
  },
  {
    byte: "0xDF",
    dec: 223,
    name: "OP_GREATERTHANOREQUAL64",
    used: true,
    desc: "Pop b (top), pop a → push 1 if int64(a) >= int64(b)",
  },
  {
    byte: "0xD7",
    dec: 215,
    name: "OP_ADD64",
    used: false,
    desc: "Pop two LE64 values → push their sum as LE64",
  },
  {
    byte: "0xD8",
    dec: 216,
    name: "OP_SUB64",
    used: false,
    desc: "Pop two LE64 values → push their difference as LE64",
  },
  {
    byte: "0xDC",
    dec: 220,
    name: "OP_LESSTHAN64",
    used: false,
    desc: "Pop b (top), pop a → push 1 if int64(a) < int64(b)",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  try {
    return scureHex.decode(clean);
  } catch {
    return null;
  }
}

interface AnnotatedByte {
  hex: string;
  label: string;
  highlight?: "opcode" | "data" | "push" | "standard";
}

function buildAnnotatedSwapLeaf(
  satAmount: number,
  makerPkScriptHex: string
): AnnotatedByte[] | null {
  const pkScript = hexToBytes(makerPkScriptHex);
  if (!pkScript || pkScript.length !== 34) return null;

  const satAmountLE64 = encodeLE64(satAmount);
  const result: AnnotatedByte[] = [];

  result.push({ hex: "00", label: "OP_0 (output index 0)", highlight: "standard" });
  result.push({ hex: "cf", label: "OP_INSPECTOUTPUTVALUE", highlight: "opcode" });
  result.push({ hex: "08", label: "PUSH 8 bytes", highlight: "push" });
  for (let i = 0; i < 8; i++) {
    result.push({
      hex: satAmountLE64[i].toString(16).padStart(2, "0"),
      label: `satAmount LE64[${i}]`,
      highlight: "data",
    });
  }
  result.push({ hex: "df", label: "OP_GREATERTHANOREQUAL64", highlight: "opcode" });
  result.push({ hex: "69", label: "OP_VERIFY", highlight: "standard" });
  result.push({ hex: "00", label: "OP_0 (output index 0)", highlight: "standard" });
  result.push({ hex: "d1", label: "OP_INSPECTOUTPUTSCRIPTPUBKEY", highlight: "opcode" });
  result.push({ hex: "22", label: "PUSH 34 bytes", highlight: "push" });
  for (let i = 0; i < 34; i++) {
    result.push({
      hex: pkScript[i].toString(16).padStart(2, "0"),
      label: `makerPkScript[${i}]`,
      highlight: "data",
    });
  }
  result.push({ hex: "87", label: "OP_EQUAL", highlight: "standard" });
  result.push({ hex: "69", label: "OP_VERIFY", highlight: "standard" });
  result.push({ hex: "ac", label: "OP_CHECKSIG (taker signs)", highlight: "standard" });

  return result;
}

// ── Log panel ─────────────────────────────────────────────────────────────────

interface LogLine {
  ts: string;
  level: "info" | "success" | "error" | "event";
  msg: string;
}

const LEVEL_STYLE: Record<LogLine["level"], string> = {
  info: "text-zinc-400",
  success: "text-green-400",
  error: "text-red-400",
  event: "text-sky-400",
};

// ── Main component ────────────────────────────────────────────────────────────

export default function LabPage() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const heldAssets = useAppStore((s) => s.heldAssets);
  useTokens();
  const tokens = useAppStore((s) => s.tokens);

  // Map held assets to token metadata for the dropdown (exclude control assets)
  const userTokens = heldAssets
    .filter((a) => a.amount > 0 && !isControlAsset(a.assetId, tokens))
    .map((a) => {
      const token = tokens.find((t) => t.assetId === a.assetId);
      return {
        assetId: a.assetId,
        amount: a.amount,
        name: token?.name ?? "Unknown",
        ticker: token?.ticker ?? "???",
        image: token?.image,
        decimals: token?.decimals,
      };
    });

  // Close buy asset dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (cbDropdownRef.current && !cbDropdownRef.current.contains(e.target as Node)) {
        setCbDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ── Script Builder state ─────────────────────────────────────────────────
  const [sbSatAmount, setSbSatAmount] = useState("10000");
  const [sbPkScript, setSbPkScript] = useState("");
  const [sbExpiry, setSbExpiry] = useState("3600");
  const [sbAnnotated, setSbAnnotated] = useState<AnnotatedByte[] | null>(null);
  const [sbError, setSbError] = useState("");

  // ── Live Testing state ───────────────────────────────────────────────────
  const [tab, setTab] = useState<
    "create-sell" | "create-buy" | "take-sell" | "take-buy" | "cancel"
  >("create-sell");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Create sell offer
  const [coAssetId, setCoAssetId] = useState("");
  const [coTokenAmount, setCoTokenAmount] = useState("");
  const [coSatAmount, setCoSatAmount] = useState("");
  const [lastOffer, setLastOffer] = useState<SwapOffer | null>(null);

  // Create buy offer
  const [cbAssetId, setCbAssetId] = useState("");
  const [cbTokenAmount, setCbTokenAmount] = useState("");
  const [cbSatAmount, setCbSatAmount] = useState("");
  const [lastBuyOffer, setLastBuyOffer] = useState<BuyOffer | null>(null);
  const [cbSearch, setCbSearch] = useState("");
  const [cbDropdownOpen, setCbDropdownOpen] = useState(false);
  const cbDropdownRef = useRef<HTMLDivElement>(null);

  // Fill / Cancel offer (shared fields)
  const [fcOutpoint, setFcOutpoint] = useState("");
  const [fcSwapScriptHex, setFcSwapScriptHex] = useState("");
  const [fcArkadeScriptHex, setFcArkadeScriptHex] = useState("");
  const [fcAssetId, setFcAssetId] = useState("");
  const [fcTokenAmount, setFcTokenAmount] = useState("");
  const [fcSatAmount, setFcSatAmount] = useState("");
  const [fcMakerAddress, setFcMakerAddress] = useState("");
  const [fcMakerPkScript, setFcMakerPkScript] = useState("");
  const [fcMakerXOnlyPubkey, setFcMakerXOnlyPubkey] = useState("");
  const [fcOfferType, setFcOfferType] = useState<"sell" | "buy">("sell");

  const addLog = useCallback((level: LogLine["level"], msg: string) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { ts, level, msg }];
      return next.slice(-200);
    });
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 20);
  }, []);

  // ── Script Builder handler ───────────────────────────────────────────────

  const handleBuildScript = () => {
    setSbError("");
    setSbAnnotated(null);
    const satAmount = parseInt(sbSatAmount, 10);
    if (isNaN(satAmount) || satAmount <= 0) {
      setSbError("satAmount must be a positive integer");
      return;
    }
    if (!sbPkScript.trim()) {
      setSbError("Enter the maker P2TR scriptPubKey (34 bytes hex, e.g. 5120...xxxx)");
      return;
    }
    const annotated = buildAnnotatedSwapLeaf(satAmount, sbPkScript.trim().replace(/^0x/, ""));
    if (!annotated) {
      setSbError(
        "makerPkScript must be exactly 34 bytes (68 hex chars). P2TR scripts start with 5120."
      );
      return;
    }
    setSbAnnotated(annotated);
  };

  // ── Live Testing handlers ────────────────────────────────────────────────

  const handleCreateSellOffer = async () => {
    if (!arkWallet) {
      addLog("error", "Wallet not connected");
      return;
    }
    const tokenAmount = parseInt(coTokenAmount, 10);
    const satAmount = parseInt(coSatAmount, 10);
    if (!coAssetId || isNaN(tokenAmount) || isNaN(satAmount)) {
      addLog("error", "Fill in assetId, tokenAmount, and satAmount");
      return;
    }
    setBusy(true);
    addLog("info", `Creating sell offer: ${tokenAmount} tokens @ ${satAmount} sats`);
    try {
      const offer = await createSwapOffer(arkWallet, {
        assetId: coAssetId,
        tokenAmount,
        satAmount,
      });
      setLastOffer(offer);
      addLog("success", `Sell offer created: ${offer.offerOutpoint}`);
      // Sign and post to indexer (retry on VTXO not found)
      const { sha256: sha256Sell } = await import("@noble/hashes/sha256");
      const { hex: hexSell } = await import("@scure/base");
      const sellMsg = sha256Sell(new TextEncoder().encode(`offer:${offer.offerOutpoint}`));
      const sellSigBytes = await arkWallet.identity.signMessage(sellMsg, "schnorr");
      const sellPayload = { ...offer, signature: hexSell.encode(sellSigBytes) };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          addLog("info", "Retrying indexer post...");
          await new Promise((r) => setTimeout(r, 2000));
        }
        try {
          const resp = await fetch(`${INDEXER_URL}/offers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sellPayload),
          });
          if (resp.ok) {
            addLog("info", "Posted to indexer");
            break;
          }
          const errText = await resp.text().catch(() => "");
          if (!errText.includes("VTXO not found")) {
            addLog("info", `Indexer post failed: ${errText}`);
            break;
          }
        } catch {
          addLog("info", "Indexer post failed (network error)");
          break;
        }
      }
      // Auto-fill fill/cancel fields
      setFcOutpoint(offer.offerOutpoint);
      setFcSwapScriptHex(offer.swapScriptHex);
      setFcArkadeScriptHex(offer.arkadeScriptHex);
      setFcAssetId(offer.assetId);
      setFcTokenAmount(String(offer.tokenAmount));
      setFcSatAmount(String(offer.satAmount));
      setFcMakerAddress(offer.makerArkAddress);
      setFcMakerPkScript(offer.makerPkScript);
      setFcMakerXOnlyPubkey(offer.makerXOnlyPubkey);
      setFcOfferType("sell");
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBuyOffer = async () => {
    if (!arkWallet) {
      addLog("error", "Wallet not connected");
      return;
    }
    const tokenAmount = parseInt(cbTokenAmount, 10);
    const satAmount = parseInt(cbSatAmount, 10);
    if (!cbAssetId || isNaN(tokenAmount) || isNaN(satAmount)) {
      addLog("error", "Fill in assetId, tokenAmount, and satAmount");
      return;
    }
    setBusy(true);
    addLog("info", `Creating buy offer: buying ${tokenAmount} tokens for ${satAmount} sats`);
    try {
      const offer = await createBuyOffer(arkWallet, {
        assetId: cbAssetId,
        tokenAmount,
        satAmount,
      });
      setLastBuyOffer(offer);
      addLog("success", `Buy offer created: ${offer.offerOutpoint}`);
      // Sign and post to indexer (retry on VTXO not found)
      const { sha256: sha256Buy } = await import("@noble/hashes/sha256");
      const { hex: hexBuy } = await import("@scure/base");
      const buyMsg = sha256Buy(new TextEncoder().encode(`offer:${offer.offerOutpoint}`));
      const buySigBytes = await arkWallet.identity.signMessage(buyMsg, "schnorr");
      const buyPayload = { ...offer, signature: hexBuy.encode(buySigBytes) };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          addLog("info", "Retrying indexer post...");
          await new Promise((r) => setTimeout(r, 2000));
        }
        try {
          const resp = await fetch(`${INDEXER_URL}/offers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buyPayload),
          });
          if (resp.ok) {
            addLog("info", "Posted to indexer");
            break;
          }
          const errText = await resp.text().catch(() => "");
          if (!errText.includes("VTXO not found")) {
            addLog("info", `Indexer post failed: ${errText}`);
            break;
          }
        } catch {
          addLog("info", "Indexer post failed (network error)");
          break;
        }
      }
      // Auto-fill fill/cancel fields
      setFcOutpoint(offer.offerOutpoint);
      setFcSwapScriptHex(offer.swapScriptHex);
      setFcArkadeScriptHex(offer.arkadeScriptHex);
      setFcAssetId(offer.assetId);
      setFcTokenAmount(String(offer.tokenAmount));
      setFcSatAmount(String(offer.satAmount));
      setFcMakerAddress(offer.makerArkAddress);
      setFcMakerPkScript(offer.makerPkScript);
      setFcMakerXOnlyPubkey(offer.makerXOnlyPubkey);
      setFcOfferType("buy");
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleTakeSell = async () => {
    if (!arkWallet) {
      addLog("error", "Wallet not connected");
      return;
    }
    if (!fcOutpoint || !fcSwapScriptHex) {
      addLog("error", "Paste offerOutpoint and swapScriptHex");
      return;
    }
    const offer: SwapOffer = {
      offerOutpoint: fcOutpoint,
      swapScriptHex: fcSwapScriptHex,
      arkadeScriptHex: fcArkadeScriptHex,
      assetId: fcAssetId,
      tokenAmount: parseInt(fcTokenAmount, 10) || 0,
      satAmount: parseInt(fcSatAmount, 10) || 0,
      makerArkAddress: fcMakerAddress,
      vtxoSatsValue: 0,
      makerPkScript: fcMakerPkScript,
      makerXOnlyPubkey: fcMakerXOnlyPubkey,
      expiresAt: 0,
    };
    setBusy(true);
    addLog("info", `Taking sell offer (buying tokens): ${fcOutpoint}`);
    try {
      const txid = await fillSwapOffer(arkWallet, offer, (ev) => {
        addLog(
          "event",
          JSON.stringify(ev, (_, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 120)
        );
      });
      addLog("success", `Filled! arkTxId: ${txid}`);
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleTakeBuy = async () => {
    if (!arkWallet) {
      addLog("error", "Wallet not connected");
      return;
    }
    if (!fcOutpoint || !fcSwapScriptHex) {
      addLog("error", "Paste offerOutpoint and swapScriptHex");
      return;
    }
    const offer: BuyOffer = {
      offerOutpoint: fcOutpoint,
      offerType: "buy",
      swapScriptHex: fcSwapScriptHex,
      arkadeScriptHex: fcArkadeScriptHex,
      assetId: fcAssetId,
      tokenAmount: parseInt(fcTokenAmount, 10) || 0,
      satAmount: parseInt(fcSatAmount, 10) || 0,
      vtxoSatsValue: parseInt(fcSatAmount, 10) || 0,
      makerArkAddress: fcMakerAddress,
      makerPkScript: fcMakerPkScript,
      makerXOnlyPubkey: fcMakerXOnlyPubkey,
      expiresAt: 0,
    };
    setBusy(true);
    addLog("info", `Taking buy offer (selling tokens): ${fcOutpoint}`);
    try {
      const txid = await fillBuyOffer(arkWallet, offer, (ev) => {
        addLog(
          "event",
          JSON.stringify(ev, (_, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 120)
        );
      });
      addLog("success", `Filled! arkTxId: ${txid}`);
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!arkWallet) {
      addLog("error", "Wallet not connected");
      return;
    }
    if (!fcOutpoint || !fcSwapScriptHex) {
      addLog("error", "Paste offerOutpoint and swapScriptHex");
      return;
    }
    setBusy(true);
    addLog("info", `Cancelling ${fcOfferType} offer: ${fcOutpoint}`);
    try {
      let txid: string;
      if (fcOfferType === "buy") {
        const offer: BuyOffer = {
          offerOutpoint: fcOutpoint,
          offerType: "buy",
          swapScriptHex: fcSwapScriptHex,
          arkadeScriptHex: fcArkadeScriptHex,
          assetId: fcAssetId,
          tokenAmount: parseInt(fcTokenAmount, 10) || 0,
          satAmount: parseInt(fcSatAmount, 10) || 0,
          vtxoSatsValue: parseInt(fcSatAmount, 10) || 0,
          makerArkAddress: fcMakerAddress,
          makerPkScript: "",
          makerXOnlyPubkey: "",
          expiresAt: 0,
        };
        txid = await cancelBuyOffer(arkWallet, offer, (ev) => {
          addLog("event", JSON.stringify(ev).slice(0, 120));
        });
      } else {
        const offer: SwapOffer = {
          offerOutpoint: fcOutpoint,
          swapScriptHex: fcSwapScriptHex,
          arkadeScriptHex: fcArkadeScriptHex,
          assetId: fcAssetId,
          tokenAmount: parseInt(fcTokenAmount, 10) || 0,
          satAmount: parseInt(fcSatAmount, 10) || 0,
          vtxoSatsValue: 0,
          makerArkAddress: fcMakerAddress,
          makerPkScript: "",
          makerXOnlyPubkey: "",
          expiresAt: 0,
        };
        txid = await cancelSwapOffer(arkWallet, offer, (ev) => {
          addLog("event", JSON.stringify(ev).slice(0, 120));
        });
      }
      addLog("success", `Cancelled! arkTxId: ${txid}`);
      // Notify indexer with signed cancel message
      try {
        const { sha256 } = await import("@noble/hashes/sha256");
        const { hex } = await import("@scure/base");
        const message = sha256(new TextEncoder().encode(`cancel:${fcOutpoint}`));
        const sigBytes = await arkWallet.identity.signMessage(message, "schnorr");
        await fetch(`${INDEXER_URL}/offers/${encodeURIComponent(fcOutpoint)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signature: hex.encode(sigBytes) }),
        });
        addLog("info", "Indexer notified of cancellation");
      } catch (e) {
        addLog("info", `Indexer notification failed (non-critical): ${e}`);
      }
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen px-4 py-8 max-w-3xl mx-auto space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Swap Lab</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Arkade Script opcodes, script builder and live swap testing.
        </p>
      </div>

      {/* ── 1. Opcode Reference ── */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Opcode Reference
        </h2>
        <div className="rounded-xl border border-white/[0.07] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.07] bg-white/[0.03]">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Byte</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Dec</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {OPCODES.map((op) => (
                <tr
                  key={op.byte}
                  className={`border-b border-white/[0.04] last:border-0 ${op.used ? "bg-white/[0.02]" : ""}`}
                >
                  <td className="px-4 py-2.5 font-mono">
                    <span
                      className={op.used ? "text-orange-400 font-bold" : "text-muted-foreground"}
                    >
                      {op.byte}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-muted-foreground">{op.dec}</td>
                  <td className="px-4 py-2.5 font-mono">
                    <span className={op.used ? "text-foreground" : "text-muted-foreground"}>
                      {op.name}
                    </span>
                    {op.used && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-orange-500/10 text-orange-400 border border-orange-500/20">
                        used
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
                    {op.desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Orange = opcodes used in our swap script. All are OP_SUCCESS extensions — validated by the
          ASP&apos;s Arkade Script interpreter, not standard Bitcoin nodes.
        </p>
      </section>

      {/* ── 2. Script Builder ── */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Script Builder
        </h2>
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">satAmount (sats)</label>
              <input
                type="number"
                value={sbSatAmount}
                onChange={(e) => setSbSatAmount(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                placeholder="10000"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                expiresIn (seconds)
              </label>
              <input
                type="number"
                value={sbExpiry}
                onChange={(e) => setSbExpiry(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                placeholder="3600"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              makerPkScript (34 bytes hex — P2TR starts with{" "}
              <span className="text-orange-400">5120</span>)
            </label>
            <input
              type="text"
              value={sbPkScript}
              onChange={(e) => setSbPkScript(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
              placeholder="5120xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
          </div>
          {sbError && <p className="text-xs text-red-400">{sbError}</p>}
          <button
            onClick={handleBuildScript}
            className="px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.10] border border-white/[0.09] text-sm font-medium transition-colors"
          >
            Build Swap Leaf
          </button>

          {sbAnnotated && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Swap leaf bytes — {sbAnnotated.length} bytes total
                <span className="ml-3 font-mono text-zinc-500">
                  {sbAnnotated.map((b) => b.hex).join(" ")}
                </span>
              </p>
              <div className="flex flex-wrap gap-1">
                {sbAnnotated.map((b, i) => {
                  const colors: Record<string, string> = {
                    opcode: "bg-orange-500/15 text-orange-300 border-orange-500/20",
                    data: "bg-sky-500/10 text-sky-300 border-sky-500/20",
                    push: "bg-purple-500/10 text-purple-300 border-purple-500/20",
                    standard: "bg-white/[0.05] text-zinc-300 border-white/[0.08]",
                  };
                  return (
                    <div
                      key={i}
                      title={b.label}
                      className={`px-1.5 py-0.5 rounded border text-[11px] font-mono cursor-default ${colors[b.highlight ?? "standard"]}`}
                    >
                      {b.hex}
                    </div>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
                {[
                  {
                    color: "bg-orange-500/15 border-orange-500/20",
                    label: "Arkade opcode (0xCF / 0xD1 / 0xDF)",
                  },
                  {
                    color: "bg-sky-500/10 border-sky-500/20",
                    label: "Inline data (satAmount LE64, pkScript)",
                  },
                  { color: "bg-purple-500/10 border-purple-500/20", label: "Push length prefix" },
                  {
                    color: "bg-white/[0.05] border-white/[0.08]",
                    label: "Standard Bitcoin opcode",
                  },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-muted-foreground">
                    <span className={`inline-block w-3 h-3 rounded border ${item.color}`} />
                    {item.label}
                  </div>
                ))}
              </div>

              {/* LE64 tester */}
              <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <p className="text-xs text-muted-foreground mb-1">
                  LE64 encoding of{" "}
                  <span className="font-mono text-foreground">{sbSatAmount} sats</span>
                </p>
                <p className="font-mono text-xs text-orange-300">
                  {(() => {
                    try {
                      return bytesToHex(encodeLE64(parseInt(sbSatAmount, 10)));
                    } catch {
                      return "—";
                    }
                  })()}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── 3. Live Testing ── */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Live Testing
        </h2>

        {!arkWallet && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 text-center text-sm text-muted-foreground">
            Connect your wallet to use live testing.
          </div>
        )}

        {arkWallet && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-white/[0.07] overflow-x-auto">
              {(
                [
                  ["create-sell", "Create Sell"],
                  ["create-buy", "Create Buy"],
                  ["take-sell", "Take Sell"],
                  ["take-buy", "Take Buy"],
                  ["cancel", "Cancel"],
                ] as const
              ).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`shrink-0 px-4 py-3 text-xs font-medium transition-colors ${
                    tab === t
                      ? "text-foreground border-b border-foreground -mb-px"
                      : "text-muted-foreground hover:text-foreground/70"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="p-5 space-y-3">
              {/* Create Sell Offer */}
              {tab === "create-sell" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Lock tokens into a swap VTXO. Taker pays sats to buy them.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="text-xs text-muted-foreground mb-1 block">Asset</label>
                      {userTokens.length > 0 ? (
                        <LabAssetPicker
                          tokens={userTokens}
                          value={coAssetId}
                          onChange={setCoAssetId}
                        />
                      ) : (
                        <input
                          value={coAssetId}
                          onChange={(e) => setCoAssetId(e.target.value)}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                          placeholder="hex asset ID (no tokens found in wallet)"
                        />
                      )}
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Token amount
                      </label>
                      <input
                        type="number"
                        value={coTokenAmount}
                        onChange={(e) => setCoTokenAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="100"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Sat amount (price)
                      </label>
                      <input
                        type="number"
                        value={coSatAmount}
                        onChange={(e) => setCoSatAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="10000"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleCreateSellOffer}
                    disabled={busy}
                    className="px-5 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-sm font-medium text-red-400 transition-colors disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create Sell Offer"}
                  </button>
                  {lastOffer && (
                    <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] space-y-1 text-xs font-mono">
                      <div>
                        <span className="text-muted-foreground">outpoint </span>
                        <span className="text-green-400">{lastOffer.offerOutpoint}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">expiresAt </span>
                        {new Date(lastOffer.expiresAt * 1000).toISOString()}
                      </div>
                      <div className="truncate">
                        <span className="text-muted-foreground">script </span>
                        {lastOffer.swapScriptHex.slice(0, 48)}…
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Create Buy Offer */}
              {tab === "create-buy" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Lock sats into a swap VTXO. Taker delivers tokens to fill it.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2 relative" ref={cbDropdownRef}>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Asset (token you want to buy)
                      </label>
                      <input
                        value={cbSearch}
                        onChange={(e) => {
                          setCbSearch(e.target.value);
                          setCbDropdownOpen(true);
                          // Clear selection if user edits search after selecting
                          if (cbAssetId) setCbAssetId("");
                        }}
                        onFocus={() => setCbDropdownOpen(true)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="Search by name, ticker, or asset ID…"
                      />
                      {cbAssetId && (
                        <div className="mt-1 text-[10px] font-mono text-emerald-400/70 truncate">
                          {cbAssetId}
                        </div>
                      )}
                      {cbDropdownOpen && (
                        <div className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto rounded-lg bg-zinc-900 border border-white/[0.1] shadow-xl">
                          {tokens
                            .filter((t) => !isControlAsset(t.assetId, tokens))
                            .filter((t) => {
                              if (!cbSearch.trim()) return true;
                              const q = cbSearch.toLowerCase();
                              return (
                                t.name.toLowerCase().includes(q) ||
                                t.ticker.toLowerCase().includes(q) ||
                                t.assetId.toLowerCase().includes(q)
                              );
                            })
                            .slice(0, 20)
                            .map((t) => (
                              <button
                                key={t.assetId}
                                onClick={() => {
                                  setCbAssetId(t.assetId);
                                  setCbSearch(`${t.ticker} — ${t.name}`);
                                  setCbDropdownOpen(false);
                                }}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors flex items-center gap-2"
                              >
                                <span className="font-mono font-medium text-foreground">
                                  {t.ticker}
                                </span>
                                <span className="text-muted-foreground">{t.name}</span>
                                <span className="ml-auto text-[10px] font-mono text-muted-foreground/40 truncate max-w-[120px]">
                                  {t.assetId.slice(0, 12)}…
                                </span>
                              </button>
                            ))}
                          {tokens
                            .filter((t) => !isControlAsset(t.assetId, tokens))
                            .filter((t) => {
                              if (!cbSearch.trim()) return true;
                              const q = cbSearch.toLowerCase();
                              return (
                                t.name.toLowerCase().includes(q) ||
                                t.ticker.toLowerCase().includes(q) ||
                                t.assetId.toLowerCase().includes(q)
                              );
                            }).length === 0 && (
                            <div className="px-3 py-3 text-xs text-muted-foreground/50 text-center">
                              No assets found
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Token amount to buy
                      </label>
                      <input
                        type="number"
                        value={cbTokenAmount}
                        onChange={(e) => setCbTokenAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="100"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Sats to pay
                      </label>
                      <input
                        type="number"
                        value={cbSatAmount}
                        onChange={(e) => setCbSatAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="10000"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleCreateBuyOffer}
                    disabled={busy}
                    className="px-5 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-sm font-medium text-emerald-400 transition-colors disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create Buy Offer"}
                  </button>
                  {lastBuyOffer && (
                    <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] space-y-1 text-xs font-mono">
                      <div>
                        <span className="text-muted-foreground">outpoint </span>
                        <span className="text-green-400">{lastBuyOffer.offerOutpoint}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">type </span>
                        <span className="text-emerald-400">buy</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">expiresAt </span>
                        {new Date(lastBuyOffer.expiresAt * 1000).toISOString()}
                      </div>
                      <div className="truncate">
                        <span className="text-muted-foreground">script </span>
                        {lastBuyOffer.swapScriptHex.slice(0, 48)}…
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Take Sell / Take Buy / Cancel — shared fields */}
              {(tab === "take-sell" || tab === "take-buy" || tab === "cancel") && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {tab === "take-sell" && "Fill a sell offer — you pay sats, receive tokens."}
                    {tab === "take-buy" && "Fill a buy offer — you deliver tokens, receive sats."}
                    {tab === "cancel" && "Cancel your own offer — reclaim locked funds."}
                  </p>
                  {tab === "cancel" && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Offer type</label>
                      <div className="flex gap-2">
                        {(["sell", "buy"] as const).map((t) => (
                          <button
                            key={t}
                            onClick={() => setFcOfferType(t)}
                            className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-colors ${
                              fcOfferType === t
                                ? "bg-white/[0.1] border-white/[0.2] text-foreground"
                                : "bg-white/[0.03] border-white/[0.06] text-muted-foreground hover:text-foreground/70"
                            }`}
                          >
                            {t === "sell"
                              ? "Sell offer (reclaim tokens)"
                              : "Buy offer (reclaim sats)"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      offerOutpoint (txid:vout)
                    </label>
                    <input
                      value={fcOutpoint}
                      onChange={(e) => setFcOutpoint(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                      placeholder="abc123…:0"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      swapScriptHex
                    </label>
                    <textarea
                      value={fcSwapScriptHex}
                      onChange={(e) => setFcSwapScriptHex(e.target.value)}
                      rows={2}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20 resize-none"
                      placeholder="hex of VtxoScript.encode()"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      arkadeScriptHex
                    </label>
                    <textarea
                      value={fcArkadeScriptHex}
                      onChange={(e) => setFcArkadeScriptHex(e.target.value)}
                      rows={2}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20 resize-none"
                      placeholder="hex of arkade script"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Asset ID</label>
                      <input
                        value={fcAssetId}
                        onChange={(e) => setFcAssetId(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="asset hex"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Token amount
                      </label>
                      <input
                        type="number"
                        value={fcTokenAmount}
                        onChange={(e) => setFcTokenAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="100"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Sat amount</label>
                      <input
                        type="number"
                        value={fcSatAmount}
                        onChange={(e) => setFcSatAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="10000"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Maker Ark address
                    </label>
                    <input
                      value={fcMakerAddress}
                      onChange={(e) => setFcMakerAddress(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                      placeholder="ark1…"
                    />
                  </div>
                  <button
                    onClick={
                      tab === "take-sell"
                        ? handleTakeSell
                        : tab === "take-buy"
                          ? handleTakeBuy
                          : handleCancel
                    }
                    disabled={busy}
                    className={`px-5 py-2 rounded-lg border text-sm font-medium transition-colors disabled:opacity-50 ${
                      tab === "cancel"
                        ? "bg-red-500/20 hover:bg-red-500/30 border-red-500/30 text-red-400"
                        : tab === "take-sell"
                          ? "bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/30 text-emerald-400"
                          : "bg-amber-500/20 hover:bg-amber-500/30 border-amber-500/30 text-amber-400"
                    }`}
                  >
                    {busy
                      ? tab === "take-sell"
                        ? "Filling…"
                        : tab === "take-buy"
                          ? "Filling…"
                          : "Cancelling…"
                      : tab === "take-sell"
                        ? "Take Sell (Buy Tokens)"
                        : tab === "take-buy"
                          ? "Take Buy (Sell Tokens)"
                          : "Cancel Offer"}
                  </button>
                </>
              )}
            </div>

            {/* Log output */}
            <div
              ref={logRef}
              className="border-t border-white/[0.07] h-44 overflow-y-auto p-4 font-mono text-xs space-y-0.5 bg-black/20"
            >
              {logs.length === 0 && <p className="text-zinc-600">Waiting for events…</p>}
              {logs.map((l, i) => (
                <div key={i} className="flex gap-3 leading-5">
                  <span className="text-zinc-600 shrink-0">{l.ts}</span>
                  <span className={LEVEL_STYLE[l.level]}>{l.msg}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-white/[0.07] flex justify-end px-4 py-2">
              <button
                onClick={() => setLogs([])}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear log
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Bottom padding for mobile nav */}
      <div className="h-24 md:h-4" />
    </div>
  );
}

function LabAssetPicker({
  tokens: tokenList,
  value,
  onChange,
}: {
  tokens: {
    assetId: string;
    amount: number;
    name: string;
    ticker: string;
    image?: string;
    decimals?: number;
  }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = tokenList.find((t) => t.assetId === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 h-10 px-3 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm transition-all hover:bg-white/[0.07] focus:border-white/[0.14]"
      >
        {selected ? (
          <>
            <div className="h-6 w-6 shrink-0 rounded-md bg-white/[0.06] border border-white/[0.06] flex items-center justify-center overflow-hidden">
              {selected.image ? (
                <img
                  src={safeUrl(selected.image) ?? ""}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-[8px] font-bold text-muted-foreground/40">
                  {selected.ticker.slice(0, 2)}
                </span>
              )}
            </div>
            <span className="flex-1 text-left truncate font-medium">{selected.ticker}</span>
            <span className="text-[10px] text-muted-foreground/30 tabular-nums">
              {formatTokenAmount(selected.amount, selected.decimals)} held
            </span>
          </>
        ) : (
          <span className="flex-1 text-left text-muted-foreground/40">Select a token...</span>
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto rounded-lg bg-zinc-900 border border-white/[0.1] shadow-xl">
          {tokenList.map((t) => (
            <button
              key={t.assetId}
              onClick={() => {
                onChange(t.assetId);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-white/[0.06] ${value === t.assetId ? "bg-white/[0.04]" : ""}`}
            >
              <div className="h-6 w-6 shrink-0 rounded-md bg-white/[0.06] border border-white/[0.06] flex items-center justify-center overflow-hidden">
                {t.image ? (
                  <img src={safeUrl(t.image) ?? ""} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[8px] font-bold text-muted-foreground/40">
                    {t.ticker.slice(0, 2)}
                  </span>
                )}
              </div>
              <div className="flex-1 text-left min-w-0">
                <span className="font-medium">{t.ticker}</span>
                <span className="text-muted-foreground/40 ml-1.5 text-[11px]">{t.name}</span>
              </div>
              <span className="text-[10px] text-muted-foreground/30 tabular-nums shrink-0">
                {formatTokenAmount(t.amount, t.decimals)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
