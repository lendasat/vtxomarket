"use client";

import { useState, useEffect, useCallback } from "react";
import { getMnemonic, saveMnemonic, saveNostrKeyOverride } from "@/lib/wallet-storage";
import { generateMnemonic, validateMnemonic, decodeNsec } from "@/lib/wallet-crypto";

type Screen = "loading" | "auth" | "backup" | "ready";
type AuthMode = "signup" | "signin";
type ImportMode = "mnemonic" | "nsec";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [newMnemonic, setNewMnemonic] = useState("");

  useEffect(() => {
    getMnemonic()
      .then((m) => setScreen(m ? "ready" : "auth"))
      .catch(() => setScreen("auth"));
  }, []);

  if (screen === "loading") {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/60" />
      </div>
    );
  }

  if (screen === "backup") {
    return (
      <BackupScreen
        mnemonic={newMnemonic}
        onComplete={() => {
          setNewMnemonic("");
          setScreen("ready");
        }}
      />
    );
  }

  if (screen === "auth") {
    return (
      <AuthScreen
        onComplete={() => setScreen("ready")}
        onCreated={(mnemonic) => {
          setNewMnemonic(mnemonic);
          setScreen("backup");
        }}
      />
    );
  }

  return <>{children}</>;
}

/** Shows the seed phrase after wallet creation and requires the user to confirm backup. */
function BackupScreen({ mnemonic, onComplete }: { mnemonic: string; onComplete: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = mnemonic.split(" ");

  const handleCopy = () => {
    navigator.clipboard.writeText(mnemonic).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background p-4">
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] h-[320px] rounded-full bg-white/[0.02] blur-[100px]" />
      <div className="relative w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-b from-white via-white/90 to-white/40 bg-clip-text text-transparent">
            vtxo.market
          </h1>
          <p className="mt-2 text-sm text-muted-foreground/40">Back up your seed phrase</p>
        </div>

        <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden p-6 space-y-5">
          <div className="space-y-2 text-center">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="h-7 w-7 text-amber-400"
              >
                <path
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <p className="text-xs text-muted-foreground/60 leading-relaxed max-w-xs mx-auto">
              Write these 12 words down and store them safely. This is the{" "}
              <span className="text-foreground/80 font-medium">only way</span> to recover your
              wallet.
            </p>
          </div>

          {/* Seed phrase grid */}
          <div className="grid grid-cols-3 gap-2">
            {words.map((word, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 py-2"
              >
                <span className="text-[10px] text-muted-foreground/30 w-4 text-right">{i + 1}</span>
                <span className="text-xs font-mono text-foreground/80">{word}</span>
              </div>
            ))}
          </div>

          <button
            onClick={handleCopy}
            className="w-full h-9 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs text-muted-foreground/50 hover:text-foreground/70 transition-all"
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>

          <label className="flex items-start gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-white/[0.15] bg-white/[0.05] accent-white"
            />
            <span className="text-xs text-muted-foreground/50 group-hover:text-muted-foreground/70 leading-relaxed">
              I have saved my seed phrase somewhere safe. I understand that if I lose it, I lose
              access to my funds.
            </span>
          </label>

          <button
            onClick={onComplete}
            disabled={!confirmed}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-white/[0.12] via-white/[0.08] to-white/[0.12] border border-white/[0.14] text-base font-semibold transition-all hover:from-white/[0.18] hover:via-white/[0.12] hover:to-white/[0.18] hover:border-white/[0.2] hover:shadow-[0_0_24px_rgba(255,255,255,0.06)] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthScreen({
  onComplete,
  onCreated,
}: {
  onComplete: () => void;
  onCreated: (mnemonic: string) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [importMode, setImportMode] = useState<ImportMode>("mnemonic");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [nsecInput, setNsecInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreateWallet = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const mnemonic = generateMnemonic();
      await saveMnemonic(mnemonic);
      onCreated(mnemonic);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create wallet");
      setLoading(false);
    }
  }, [onCreated]);

  const handleImportMnemonic = useCallback(async () => {
    setError("");
    const cleaned = mnemonicInput.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(cleaned)) {
      setError("Invalid seed phrase. Must be 12 valid BIP39 words.");
      return;
    }
    setLoading(true);
    try {
      await saveMnemonic(cleaned);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import wallet");
      setLoading(false);
    }
  }, [mnemonicInput, onComplete]);

  const handleImportNsec = useCallback(async () => {
    setError("");
    let hexKey: string;
    try {
      hexKey = decodeNsec(nsecInput);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid nsec");
      return;
    }
    setLoading(true);
    try {
      // Generate a fresh mnemonic for the Ark wallet
      const mnemonic = generateMnemonic();
      await saveMnemonic(mnemonic);
      // Store the nsec as the Nostr key override
      await saveNostrKeyOverride(hexKey);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import nsec");
      setLoading(false);
    }
  }, [nsecInput, onComplete]);

  const inputClass =
    "w-full px-4 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all";

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background p-4">
      {/* Background glow */}
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] h-[320px] rounded-full bg-white/[0.02] blur-[100px]" />

      <div className="relative w-full max-w-md">
        {/* Branding */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-b from-white via-white/90 to-white/40 bg-clip-text text-transparent">
            vtxo.market
          </h1>
          <p className="mt-2 text-sm text-muted-foreground/40">Token launchpad on Arkade + Nostr</p>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-xl bg-white/[0.04] border border-white/[0.07] p-1 mb-6">
          <button
            onClick={() => {
              setMode("signup");
              setError("");
            }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
              mode === "signup"
                ? "bg-white/[0.1] text-foreground shadow-sm"
                : "text-muted-foreground/40 hover:text-muted-foreground/60"
            }`}
          >
            Create Wallet
          </button>
          <button
            onClick={() => {
              setMode("signin");
              setError("");
            }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
              mode === "signin"
                ? "bg-white/[0.1] text-foreground shadow-sm"
                : "text-muted-foreground/40 hover:text-muted-foreground/60"
            }`}
          >
            Import Wallet
          </button>
        </div>

        {/* Card */}
        <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
          {mode === "signup" ? (
            /* ── Create Wallet ── */
            <div className="p-6 space-y-5">
              <div className="space-y-2 text-center">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className="h-7 w-7 text-foreground/70"
                  >
                    <path d="M12 4.5v15m7.5-7.5h-15" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold">New Wallet</h2>
                <p className="text-xs text-muted-foreground/50 leading-relaxed max-w-xs mx-auto">
                  A 12-word seed phrase will be generated. You{"'"}ll be asked to back it up before
                  continuing.
                </p>
              </div>

              <button
                onClick={handleCreateWallet}
                disabled={loading}
                className="w-full h-12 rounded-xl bg-gradient-to-r from-white/[0.12] via-white/[0.08] to-white/[0.12] border border-white/[0.14] text-base font-semibold transition-all hover:from-white/[0.18] hover:via-white/[0.12] hover:to-white/[0.18] hover:border-white/[0.2] hover:shadow-[0_0_24px_rgba(255,255,255,0.06)] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                    Creating...
                  </span>
                ) : (
                  "Create Wallet"
                )}
              </button>
            </div>
          ) : (
            /* ── Import Wallet ── */
            <div className="p-6 space-y-5">
              {/* Import mode toggle */}
              <div className="flex rounded-lg bg-white/[0.03] border border-white/[0.06] p-0.5">
                <button
                  onClick={() => {
                    setImportMode("mnemonic");
                    setError("");
                  }}
                  className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                    importMode === "mnemonic"
                      ? "bg-white/[0.08] text-foreground"
                      : "text-muted-foreground/40 hover:text-muted-foreground/60"
                  }`}
                >
                  Seed Phrase
                </button>
                <button
                  onClick={() => {
                    setImportMode("nsec");
                    setError("");
                  }}
                  className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                    importMode === "nsec"
                      ? "bg-white/[0.08] text-foreground"
                      : "text-muted-foreground/40 hover:text-muted-foreground/60"
                  }`}
                >
                  Nostr nsec
                </button>
              </div>

              {importMode === "mnemonic" ? (
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium mb-2 block">
                      12-Word Seed Phrase
                    </label>
                    <textarea
                      value={mnemonicInput}
                      onChange={(e) => setMnemonicInput(e.target.value)}
                      placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
                      rows={3}
                      className={`${inputClass} py-3 resize-none`}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground/35 leading-relaxed">
                    Enter your 12-word BIP39 seed phrase to restore your Ark wallet and Nostr
                    identity.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground/50 font-medium mb-2 block">
                      Nostr Private Key
                    </label>
                    <input
                      type="password"
                      value={nsecInput}
                      onChange={(e) => setNsecInput(e.target.value)}
                      placeholder="nsec1..."
                      className={`${inputClass} h-11 font-mono text-xs`}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground/35 leading-relaxed">
                    Import your Nostr identity via nsec. A new Ark wallet will be generated
                    alongside it.
                  </p>
                </div>
              )}

              <button
                onClick={importMode === "mnemonic" ? handleImportMnemonic : handleImportNsec}
                disabled={
                  loading || (importMode === "mnemonic" ? !mnemonicInput.trim() : !nsecInput.trim())
                }
                className="w-full h-12 rounded-xl bg-gradient-to-r from-white/[0.12] via-white/[0.08] to-white/[0.12] border border-white/[0.14] text-base font-semibold transition-all hover:from-white/[0.18] hover:via-white/[0.12] hover:to-white/[0.18] hover:border-white/[0.2] hover:shadow-[0_0_24px_rgba(255,255,255,0.06)] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                    Importing...
                  </span>
                ) : (
                  "Import Wallet"
                )}
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mx-6 mb-6 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-[11px] text-muted-foreground/25 leading-relaxed">
          Your keys never leave this device.
          <br />
          Powered by Arkade + Nostr.
        </p>
      </div>
    </div>
  );
}
