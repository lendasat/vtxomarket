"use client";

import { useState, useRef, useCallback } from "react";
import { hex as scureHex } from "@scure/base";
import { useAppStore } from "@/lib/store";
import { useTokens } from "@/hooks/useTokens";
import {
  encodeLE64,
  createSwapOffer,
  fillSwapOffer,
  cancelSwapOffer,
  type SwapOffer,
} from "@/lib/ark-wallet";

// ── Opcode reference data ──────────────────────────────────────────────────────

// Hex values from introspector/pkg/arkade/opcode.go (authoritative source)
const OPCODES = [
  { byte: "0xCF", dec: 207, name: "OP_INSPECTOUTPUTVALUE",        used: true,  desc: "Pop output index → push output[i].value as 8-byte LE64" },
  { byte: "0xD1", dec: 209, name: "OP_INSPECTOUTPUTSCRIPTPUBKEY", used: true,  desc: "Pop output index → push witnessProgram, then version on top" },
  { byte: "0xCE", dec: 206, name: "OP_INSPECTOUTPUTASSET",        used: false, desc: "Not implemented in introspector — 0xCE is OP_UNKNOWN206" },
  { byte: "0xD0", dec: 208, name: "OP_INSPECTOUTPUTNONCE",        used: false, desc: "Pop output index → push output[i].nonce (confidential tx)" },
  { byte: "0xC9", dec: 201, name: "OP_INSPECTINPUTVALUE",         used: false, desc: "Pop input index → push input[i].value as 8-byte LE64" },
  { byte: "0xCA", dec: 202, name: "OP_INSPECTINPUTSCRIPTPUBKEY",  used: false, desc: "Pop input index → push input[i].scriptPubKey" },
  { byte: "0xDF", dec: 223, name: "OP_GREATERTHANOREQUAL64",      used: true,  desc: "Pop b (top), pop a → push 1 if int64(a) >= int64(b)" },
  { byte: "0xD7", dec: 215, name: "OP_ADD64",                     used: false, desc: "Pop two LE64 values → push their sum as LE64" },
  { byte: "0xD8", dec: 216, name: "OP_SUB64",                     used: false, desc: "Pop two LE64 values → push their difference as LE64" },
  { byte: "0xDC", dec: 220, name: "OP_LESSTHAN64",                used: false, desc: "Pop b (top), pop a → push 1 if int64(a) < int64(b)" },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
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

function buildAnnotatedSwapLeaf(satAmount: number, makerPkScriptHex: string): AnnotatedByte[] | null {
  const pkScript = hexToBytes(makerPkScriptHex);
  if (!pkScript || pkScript.length !== 34) return null;

  const satAmountLE64 = encodeLE64(satAmount);
  const result: AnnotatedByte[] = [];

  result.push({ hex: "00", label: "OP_0 (output index 0)", highlight: "standard" });
  result.push({ hex: "cf", label: "OP_INSPECTOUTPUTVALUE", highlight: "opcode" });
  result.push({ hex: "08", label: "PUSH 8 bytes", highlight: "push" });
  for (let i = 0; i < 8; i++) {
    result.push({ hex: satAmountLE64[i].toString(16).padStart(2, "0"), label: `satAmount LE64[${i}]`, highlight: "data" });
  }
  result.push({ hex: "df", label: "OP_GREATERTHANOREQUAL64", highlight: "opcode" });
  result.push({ hex: "69", label: "OP_VERIFY", highlight: "standard" });
  result.push({ hex: "00", label: "OP_0 (output index 0)", highlight: "standard" });
  result.push({ hex: "d1", label: "OP_INSPECTOUTPUTSCRIPTPUBKEY", highlight: "opcode" });
  result.push({ hex: "22", label: "PUSH 34 bytes", highlight: "push" });
  for (let i = 0; i < 34; i++) {
    result.push({ hex: pkScript[i].toString(16).padStart(2, "0"), label: `makerPkScript[${i}]`, highlight: "data" });
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
  info:    "text-zinc-400",
  success: "text-green-400",
  error:   "text-red-400",
  event:   "text-sky-400",
};

// ── Main component ────────────────────────────────────────────────────────────

export default function LabPage() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const heldAssets = useAppStore((s) => s.heldAssets);
  useTokens();
  const tokens = useAppStore((s) => s.tokens);

  // Map held assets to token metadata for the dropdown
  const userTokens = heldAssets
    .filter((a) => a.amount > 0)
    .map((a) => {
      const token = tokens.find((t) => t.assetId === a.assetId);
      return {
        assetId: a.assetId,
        amount: a.amount,
        name: token?.name ?? "Unknown",
        ticker: token?.ticker ?? "???",
      };
    });

  // ── Script Builder state ─────────────────────────────────────────────────
  const [sbSatAmount, setSbSatAmount] = useState("10000");
  const [sbPkScript, setSbPkScript]   = useState("");
  const [sbExpiry, setSbExpiry]       = useState("3600");
  const [sbAnnotated, setSbAnnotated] = useState<AnnotatedByte[] | null>(null);
  const [sbError, setSbError]         = useState("");

  // ── Live Testing state ───────────────────────────────────────────────────
  const [tab, setTab] = useState<"create" | "fill" | "cancel">("create");
  const [logs, setLogs]   = useState<LogLine[]>([]);
  const [busy, setBusy]   = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Create offer
  const [coAssetId, setCoAssetId]         = useState("");
  const [coTokenAmount, setCoTokenAmount] = useState("");
  const [coSatAmount, setCoSatAmount]     = useState("");
  const [coExpiry, setCoExpiry]           = useState("3600");
  const [lastOffer, setLastOffer]         = useState<SwapOffer | null>(null);

  // Fill / Cancel offer
  const [fcOutpoint, setFcOutpoint]         = useState("");
  const [fcSwapScriptHex, setFcSwapScriptHex] = useState("");
  const [fcAssetId, setFcAssetId]           = useState("");
  const [fcTokenAmount, setFcTokenAmount]   = useState("");
  const [fcSatAmount, setFcSatAmount]       = useState("");
  const [fcMakerAddress, setFcMakerAddress] = useState("");

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
      setSbError("makerPkScript must be exactly 34 bytes (68 hex chars). P2TR scripts start with 5120.");
      return;
    }
    setSbAnnotated(annotated);
  };

  // ── Live Testing handlers ────────────────────────────────────────────────

  const handleCreateOffer = async () => {
    if (!arkWallet) { addLog("error", "Wallet not connected"); return; }
    const tokenAmount = parseInt(coTokenAmount, 10);
    const satAmount   = parseInt(coSatAmount, 10);
    const expiresInSeconds = parseInt(coExpiry, 10);
    if (!coAssetId || isNaN(tokenAmount) || isNaN(satAmount)) {
      addLog("error", "Fill in assetId, tokenAmount, and satAmount");
      return;
    }
    setBusy(true);
    addLog("info", `Creating offer: ${tokenAmount} tokens @ ${satAmount} sats`);
    try {
      const offer = await createSwapOffer(arkWallet, {
        assetId: coAssetId,
        tokenAmount,
        satAmount,
        expiresInSeconds,
      });
      setLastOffer(offer);
      addLog("success", `Offer created: ${offer.offerOutpoint}`);
      addLog("info", `swapScriptHex: ${offer.swapScriptHex.slice(0, 40)}...`);
      addLog("info", `expiresAt: ${new Date(offer.expiresAt * 1000).toISOString()}`);
      // Auto-fill fill/cancel fields
      setFcOutpoint(offer.offerOutpoint);
      setFcSwapScriptHex(offer.swapScriptHex);
      setFcAssetId(offer.assetId);
      setFcTokenAmount(String(offer.tokenAmount));
      setFcSatAmount(String(offer.satAmount));
      setFcMakerAddress(offer.makerArkAddress);
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleFill = async () => {
    if (!arkWallet) { addLog("error", "Wallet not connected"); return; }
    if (!fcOutpoint || !fcSwapScriptHex) {
      addLog("error", "Paste offerOutpoint and swapScriptHex");
      return;
    }
    const offer: SwapOffer = {
      offerOutpoint: fcOutpoint,
      swapScriptHex: fcSwapScriptHex,
      arkadeScriptHex: "",
      assetId: fcAssetId,
      tokenAmount: parseInt(fcTokenAmount, 10) || 0,
      satAmount: parseInt(fcSatAmount, 10) || 0,
      makerArkAddress: fcMakerAddress,
      vtxoSatsValue: 0,
      makerPkScript: "",
      makerXOnlyPubkey: "",
      expiresAt: 0,
    };
    setBusy(true);
    addLog("info", `Filling offer: ${fcOutpoint}`);
    try {
      const txid = await fillSwapOffer(arkWallet, offer, (ev) => {
        addLog("event", JSON.stringify(ev).slice(0, 120));
      });
      addLog("success", `Filled! arkTxId: ${txid}`);
    } catch (e) {
      addLog("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!arkWallet) { addLog("error", "Wallet not connected"); return; }
    if (!fcOutpoint || !fcSwapScriptHex) {
      addLog("error", "Paste offerOutpoint and swapScriptHex");
      return;
    }
    const offer: SwapOffer = {
      offerOutpoint: fcOutpoint,
      swapScriptHex: fcSwapScriptHex,
      arkadeScriptHex: "",
      assetId: fcAssetId,
      tokenAmount: parseInt(fcTokenAmount, 10) || 0,
      satAmount: parseInt(fcSatAmount, 10) || 0,
      vtxoSatsValue: 0,
      makerArkAddress: fcMakerAddress,
      makerPkScript: "",
      makerXOnlyPubkey: "",
      expiresAt: 0,
    };
    setBusy(true);
    addLog("info", `Cancelling offer: ${fcOutpoint}`);
    try {
      const txid = await cancelSwapOffer(arkWallet, offer, (ev) => {
        addLog("event", JSON.stringify(ev).slice(0, 120));
      });
      addLog("success", `Cancelled! arkTxId: ${txid}`);
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
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">Description</th>
              </tr>
            </thead>
            <tbody>
              {OPCODES.map((op) => (
                <tr
                  key={op.byte}
                  className={`border-b border-white/[0.04] last:border-0 ${op.used ? "bg-white/[0.02]" : ""}`}
                >
                  <td className="px-4 py-2.5 font-mono">
                    <span className={op.used ? "text-orange-400 font-bold" : "text-muted-foreground"}>
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
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{op.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Orange = opcodes used in our swap script. All are OP_SUCCESS extensions — validated by the ASP&apos;s Arkade Script interpreter, not standard Bitcoin nodes.
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
              <label className="text-xs text-muted-foreground mb-1 block">expiresIn (seconds)</label>
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
              makerPkScript (34 bytes hex — P2TR starts with <span className="text-orange-400">5120</span>)
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
                <span className="ml-3 font-mono text-zinc-500">{sbAnnotated.map((b) => b.hex).join(" ")}</span>
              </p>
              <div className="flex flex-wrap gap-1">
                {sbAnnotated.map((b, i) => {
                  const colors: Record<string, string> = {
                    opcode:   "bg-orange-500/15 text-orange-300 border-orange-500/20",
                    data:     "bg-sky-500/10 text-sky-300 border-sky-500/20",
                    push:     "bg-purple-500/10 text-purple-300 border-purple-500/20",
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
                  { color: "bg-orange-500/15 border-orange-500/20", label: "Arkade opcode (0xCF / 0xD1 / 0xDF)" },
                  { color: "bg-sky-500/10 border-sky-500/20",       label: "Inline data (satAmount LE64, pkScript)" },
                  { color: "bg-purple-500/10 border-purple-500/20", label: "Push length prefix" },
                  { color: "bg-white/[0.05] border-white/[0.08]",   label: "Standard Bitcoin opcode" },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-muted-foreground">
                    <span className={`inline-block w-3 h-3 rounded border ${item.color}`} />
                    {item.label}
                  </div>
                ))}
              </div>

              {/* LE64 tester */}
              <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <p className="text-xs text-muted-foreground mb-1">LE64 encoding of <span className="font-mono text-foreground">{sbSatAmount} sats</span></p>
                <p className="font-mono text-xs text-orange-300">
                  {(() => {
                    try { return bytesToHex(encodeLE64(parseInt(sbSatAmount, 10))); } catch { return "—"; }
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
            <div className="flex border-b border-white/[0.07]">
              {(["create", "fill", "cancel"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-5 py-3 text-xs font-medium capitalize transition-colors ${
                    tab === t
                      ? "text-foreground border-b border-foreground -mb-px"
                      : "text-muted-foreground hover:text-foreground/70"
                  }`}
                >
                  {t === "create" ? "Create Offer" : t === "fill" ? "Fill Offer" : "Cancel Offer"}
                </button>
              ))}
            </div>

            <div className="p-5 space-y-3">
              {/* Create Offer */}
              {tab === "create" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="text-xs text-muted-foreground mb-1 block">Asset</label>
                      {userTokens.length > 0 ? (
                        <select
                          value={coAssetId}
                          onChange={(e) => setCoAssetId(e.target.value)}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20 appearance-none"
                        >
                          <option value="" className="bg-zinc-900">Select a token…</option>
                          {userTokens.map((t) => (
                            <option key={t.assetId} value={t.assetId} className="bg-zinc-900">
                              {t.ticker} — {t.name} ({t.amount.toLocaleString()} held)
                            </option>
                          ))}
                        </select>
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
                      <label className="text-xs text-muted-foreground mb-1 block">Token amount</label>
                      <input
                        type="number"
                        value={coTokenAmount}
                        onChange={(e) => setCoTokenAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="100"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Sat amount (price)</label>
                      <input
                        type="number"
                        value={coSatAmount}
                        onChange={(e) => setCoSatAmount(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="10000"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Expires in (seconds)</label>
                      <input
                        type="number"
                        value={coExpiry}
                        onChange={(e) => setCoExpiry(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="3600"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleCreateOffer}
                    disabled={busy}
                    className="px-5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.10] border border-white/[0.09] text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create Offer"}
                  </button>
                  {lastOffer && (
                    <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] space-y-1 text-xs font-mono">
                      <div><span className="text-muted-foreground">outpoint  </span><span className="text-green-400">{lastOffer.offerOutpoint}</span></div>
                      <div><span className="text-muted-foreground">expiresAt </span>{new Date(lastOffer.expiresAt * 1000).toISOString()}</div>
                      <div className="truncate"><span className="text-muted-foreground">script    </span>{lastOffer.swapScriptHex.slice(0, 48)}…</div>
                    </div>
                  )}
                </>
              )}

              {/* Fill / Cancel shared fields */}
              {(tab === "fill" || tab === "cancel") && (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">offerOutpoint (txid:vout)</label>
                    <input
                      value={fcOutpoint}
                      onChange={(e) => setFcOutpoint(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                      placeholder="abc123…:0"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">swapScriptHex</label>
                    <textarea
                      value={fcSwapScriptHex}
                      onChange={(e) => setFcSwapScriptHex(e.target.value)}
                      rows={2}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20 resize-none"
                      placeholder="hex of VtxoScript.encode()"
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
                      <label className="text-xs text-muted-foreground mb-1 block">Token amount</label>
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
                  {tab === "fill" && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Maker Ark address (sats go here)</label>
                      <input
                        value={fcMakerAddress}
                        onChange={(e) => setFcMakerAddress(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="ark1…"
                      />
                    </div>
                  )}
                  {tab === "cancel" && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Your Ark address (tokens return here)</label>
                      <input
                        value={fcMakerAddress}
                        onChange={(e) => setFcMakerAddress(e.target.value)}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-white/20"
                        placeholder="ark1…"
                      />
                    </div>
                  )}
                  <button
                    onClick={tab === "fill" ? handleFill : handleCancel}
                    disabled={busy}
                    className="px-5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.10] border border-white/[0.09] text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {busy
                      ? tab === "fill" ? "Filling…" : "Cancelling…"
                      : tab === "fill" ? "Fill Offer" : "Cancel Offer"}
                  </button>
                </>
              )}
            </div>

            {/* Log output */}
            <div
              ref={logRef}
              className="border-t border-white/[0.07] h-44 overflow-y-auto p-4 font-mono text-xs space-y-0.5 bg-black/20"
            >
              {logs.length === 0 && (
                <p className="text-zinc-600">Waiting for events…</p>
              )}
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
