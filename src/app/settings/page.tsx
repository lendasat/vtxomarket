"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { deleteMnemonic, deleteAllWalletData } from "@/lib/wallet-storage";
import {
  mnemonicToNostrPrivateKeyHex,
  mnemonicToArkPrivateKeyHex,
} from "@/lib/wallet-crypto";

export default function SettingsPage() {
  const mnemonic = useAppStore((s) => s.mnemonic);
  const user = useAppStore((s) => s.user);
  const walletReady = useAppStore((s) => s.walletReady);

  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDownload = () => {
    if (!mnemonic) return;
    const blob = new Blob([mnemonic], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vtxo-fun-seed-phrase.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    if (
      !confirm(
        "This will delete your wallet from this browser. Make sure you backed up your seed phrase!"
      )
    )
      return;
    await deleteMnemonic();
    sessionStorage.clear();
    window.location.reload();
  };

  // Derive keys for display
  let nostrPrivKeyHex = "";
  let arkPrivKeyHex = "";
  if (mnemonic) {
    try { nostrPrivKeyHex = mnemonicToNostrPrivateKeyHex(mnemonic); } catch { /* */ }
    try { arkPrivKeyHex = mnemonicToArkPrivateKeyHex(mnemonic); } catch { /* */ }
  }

  const truncate = (s: string, chars = 16) => {
    if (s.length <= chars * 2 + 3) return s;
    return `${s.slice(0, chars)}...${s.slice(-chars)}`;
  };

  return (
    <div className="mx-auto max-w-lg space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground/60">
          Wallet and account settings
        </p>
      </div>

      {/* Seed Phrase */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Seed Phrase</h2>
            <p className="mt-1 text-[11px] text-muted-foreground/50 leading-relaxed">
              Your 12-word seed phrase controls both your Ark wallet and Nostr
              identity. Never share it.
            </p>
          </div>

          {!mnemonic ? (
            <p className="text-xs text-muted-foreground/50">Generating wallet...</p>
          ) : !revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="w-full h-10 rounded-xl bg-white/[0.07] border border-white/[0.1] text-sm font-medium transition-all hover:bg-white/[0.12] hover:border-white/[0.14]"
            >
              Reveal Seed Phrase
            </button>
          ) : (
            <>
              <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4">
                <div className="flex flex-wrap gap-2">
                  {mnemonic.split(" ").map((word, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.05] border border-white/[0.06] px-2.5 py-1.5 text-xs font-mono"
                    >
                      <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                        {i + 1}
                      </span>
                      {word}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleDownload}
                  className="flex-1 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] text-xs font-medium transition-all hover:bg-white/[0.1]"
                >
                  Download .txt
                </button>
                <button
                  onClick={() => handleCopy(mnemonic, "mnemonic")}
                  className="flex-1 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] text-xs font-medium transition-all hover:bg-white/[0.1]"
                >
                  {copied === "mnemonic" ? "Copied!" : "Copy"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Nostr Identity */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Nostr Identity</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground/40 font-mono">
                m/44/0/0/0/0
              </p>
            </div>
            {user && (
              <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Connected
              </span>
            )}
          </div>

          {user?.npub ? (
            <CopyableField
              label="npub"
              value={user.npub}
              displayValue={truncate(user.npub)}
              copied={copied === "npub"}
              onCopy={() => handleCopy(user.npub, "npub")}
            />
          ) : (
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
              <p className="text-xs text-muted-foreground/50">Connecting to relays...</p>
            </div>
          )}

          {nostrPrivKeyHex && revealed && (
            <>
              <div className="h-px bg-white/[0.06]" />
              <CopyableField
                label="Private Key (hex)"
                value={nostrPrivKeyHex}
                displayValue={truncate(nostrPrivKeyHex)}
                copied={copied === "nostr-key"}
                onCopy={() => handleCopy(nostrPrivKeyHex, "nostr-key")}
                sensitive
              />
            </>
          )}
        </div>
      </div>

      {/* Ark Wallet */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Ark Wallet</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground/40 font-mono">
                m/44&apos;/1237&apos;/0&apos;/0/0
              </p>
            </div>
            <span
              className={`text-[10px] font-medium px-2.5 py-1 rounded-full border ${
                walletReady
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-white/[0.04] text-muted-foreground/50 border-white/[0.08]"
              }`}
            >
              {walletReady ? "Connected" : "Offline"}
            </span>
          </div>

          {arkPrivKeyHex && revealed && (
            <CopyableField
              label="Private Key (hex)"
              value={arkPrivKeyHex}
              displayValue={truncate(arkPrivKeyHex)}
              copied={copied === "ark-key"}
              onCopy={() => handleCopy(arkPrivKeyHex, "ark-key")}
              sensitive
            />
          )}

          {!walletReady && (
            <p className="text-[11px] text-muted-foreground/40 leading-relaxed">
              Could not connect to Ark server. Wallet features are offline but
              your keys are safe.
            </p>
          )}
        </div>
      </div>

      {/* Logout */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Logout</h2>
            <p className="mt-1 text-[11px] text-muted-foreground/50 leading-relaxed">
              Sign out and return to the login screen. Make sure you&apos;ve backed up your seed phrase first.
            </p>
          </div>
          <button
            onClick={async () => {
              await deleteAllWalletData();
              sessionStorage.clear();
              window.location.reload();
            }}
            className="w-full h-10 rounded-xl bg-white/[0.07] border border-white/[0.1] text-sm font-semibold transition-all hover:bg-white/[0.12] hover:border-white/[0.14]"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-2xl bg-red-500/[0.04] border border-red-500/[0.12] overflow-hidden">
        <div className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-red-400">Danger Zone</h2>
          <button
            onClick={handleDelete}
            className="w-full h-10 rounded-xl bg-red-500/10 border border-red-500/20 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/20 hover:border-red-500/30"
          >
            Delete Wallet
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyableField({
  label,
  value,
  displayValue,
  copied,
  onCopy,
  sensitive,
}: {
  label: string;
  value: string;
  displayValue: string;
  copied: boolean;
  onCopy: () => void;
  sensitive?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground/50 font-medium">{label}</p>
      <button
        onClick={onCopy}
        className={`w-full flex items-center justify-between gap-3 py-2.5 px-3.5 rounded-xl transition-all ${
          sensitive
            ? "bg-red-500/[0.04] border border-red-500/[0.08] hover:bg-red-500/[0.08]"
            : "bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.07]"
        }`}
      >
        <code className="text-xs text-muted-foreground/60 font-mono truncate">
          {displayValue}
        </code>
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground/50">
          {copied ? "Copied!" : "Copy"}
        </span>
      </button>
    </div>
  );
}
