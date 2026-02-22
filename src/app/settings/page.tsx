"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { useAppStore } from "@/lib/store";
import { deleteAllWalletData, getNostrKeyOverride } from "@/lib/wallet-storage";
import {
  mnemonicToNostrPrivateKeyHex,
  mnemonicToArkPrivateKeyHex,
} from "@/lib/wallet-crypto";

export default function SettingsPage() {
  const mnemonic = useAppStore((s) => s.mnemonic);
  const user = useAppStore((s) => s.user);
  const profile = useAppStore((s) => s.profile);
  const nostrReady = useAppStore((s) => s.nostrReady);
  const walletReady = useAppStore((s) => s.walletReady);

  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [nostrPrivKeyHex, setNostrPrivKeyHex] = useState("");
  const [hasNsecOverride, setHasNsecOverride] = useState(false);

  // Profile editing
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profilePicture, setProfilePicture] = useState("");
  const [profileAbout, setProfileAbout] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const profileInitRef = useRef(false);

  // Sync form fields when profile loads
  useEffect(() => {
    if (profile && !profileInitRef.current) {
      profileInitRef.current = true;
      setProfileName(profile.displayName || profile.name || "");
      setProfilePicture(profile.picture || "");
      setProfileAbout(profile.about || "");
    }
  }, [profile]);

  const handleSaveProfile = async () => {
    if (!nostrReady) return;
    setSavingProfile(true);
    try {
      const { updateMyProfile } = await import("@/lib/nostr");
      const updated = await updateMyProfile({
        name: profileName || undefined,
        displayName: profileName || undefined,
        picture: profilePicture || undefined,
        about: profileAbout || undefined,
      });
      useAppStore.getState().setProfile(updated);
      setEditingProfile(false);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } catch (e) {
      console.error("[settings] Profile save failed:", e);
      alert("Failed to save profile: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSavingProfile(false);
    }
  };

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

  const handleLogout = async () => {
    await deleteAllWalletData();
    sessionStorage.clear();
    window.location.reload();
  };

  // Derive keys for display — check for nsec override
  let arkPrivKeyHex = "";
  if (mnemonic) {
    try { arkPrivKeyHex = mnemonicToArkPrivateKeyHex(mnemonic); } catch { /* */ }
  }

  useEffect(() => {
    async function loadNostrKey() {
      const override = await getNostrKeyOverride();
      if (override) {
        setNostrPrivKeyHex(override);
        setHasNsecOverride(true);
      } else if (mnemonic) {
        try {
          setNostrPrivKeyHex(mnemonicToNostrPrivateKeyHex(mnemonic));
        } catch { /* */ }
      }
    }
    loadNostrKey();
  }, [mnemonic]);

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

      {/* Profile */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Profile</h2>
            {profileSaved && (
              <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Saved
              </span>
            )}
          </div>

          {/* Avatar + name display */}
          <div className="flex items-center gap-4">
            <div className="relative h-16 w-16 shrink-0 rounded-full overflow-hidden bg-white/[0.06] border border-white/[0.08]">
              {profilePicture ? (
                <Image
                  src={profilePicture}
                  alt="Profile"
                  fill
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xl font-bold text-muted-foreground/30">
                  {(profileName || user?.npub || "?")[0]?.toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {profileName || (user?.npub ? `${user.npub.slice(0, 12)}...` : "Anonymous")}
              </p>
              {profileAbout && !editingProfile && (
                <p className="text-[11px] text-muted-foreground/40 mt-0.5 line-clamp-2">
                  {profileAbout}
                </p>
              )}
              {!profileName && !profile && nostrReady && (
                <p className="text-[11px] text-muted-foreground/30 mt-0.5">
                  No profile set yet
                </p>
              )}
            </div>
          </div>

          {/* Edit form */}
          {editingProfile ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-[11px] text-muted-foreground/50 font-medium">Display Name</label>
                <input
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="Satoshi"
                  className="w-full h-10 px-3.5 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] text-muted-foreground/50 font-medium">Profile Picture URL</label>
                <input
                  value={profilePicture}
                  onChange={(e) => setProfilePicture(e.target.value)}
                  placeholder="https://nostr.build/i/..."
                  className="w-full h-10 px-3.5 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] text-muted-foreground/50 font-medium">About</label>
                <textarea
                  value={profileAbout}
                  onChange={(e) => setProfileAbout(e.target.value)}
                  placeholder="Tell the world about yourself..."
                  rows={2}
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all resize-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setEditingProfile(false);
                    // Reset to stored values
                    setProfileName(profile?.displayName || profile?.name || "");
                    setProfilePicture(profile?.picture || "");
                    setProfileAbout(profile?.about || "");
                  }}
                  className="flex-1 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] text-xs font-medium transition-all hover:bg-white/[0.1]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveProfile}
                  disabled={savingProfile}
                  className="flex-1 h-9 rounded-xl bg-white/[0.1] border border-white/[0.12] text-xs font-semibold transition-all hover:bg-white/[0.14] disabled:opacity-40"
                >
                  {savingProfile ? "Publishing..." : "Save to Nostr"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditingProfile(true)}
              disabled={!nostrReady}
              className="w-full h-9 rounded-xl bg-white/[0.07] border border-white/[0.1] text-xs font-medium transition-all hover:bg-white/[0.12] hover:border-white/[0.14] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {nostrReady ? "Edit Profile" : "Connecting..."}
            </button>
          )}
        </div>
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
                {hasNsecOverride ? "imported nsec" : "m/44/0/0/0/0"}
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
            onClick={() => setShowLogoutConfirm(true)}
            className="w-full h-10 rounded-xl bg-white/[0.07] border border-white/[0.1] text-sm font-semibold transition-all hover:bg-white/[0.12] hover:border-white/[0.14]"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Logout confirmation overlay */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowLogoutConfirm(false)}
          />

          {/* Sheet */}
          <div className="relative w-full sm:max-w-sm mx-auto sm:mx-4 rounded-t-2xl sm:rounded-2xl bg-[oklch(0.15_0.004_260)] border border-white/[0.08] overflow-hidden animate-in slide-in-from-bottom sm:slide-in-from-bottom-0 sm:zoom-in-95 duration-200">
            {/* Drag handle (mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-white/[0.15]" />
            </div>

            <div className="p-6 space-y-4">
              <div className="text-center space-y-2">
                <div className="mx-auto h-12 w-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-red-400">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-base font-semibold">Sign out?</h3>
                <p className="text-xs text-muted-foreground/50 leading-relaxed max-w-xs mx-auto">
                  This will remove your wallet from this browser. You&apos;ll need your seed phrase to sign back in.
                </p>
              </div>

              <div className="space-y-2">
                <button
                  onClick={handleLogout}
                  className="w-full h-11 rounded-xl bg-red-500/15 border border-red-500/25 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/25 hover:border-red-500/35"
                >
                  Logout
                </button>
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  className="w-full h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] text-sm font-medium transition-all hover:bg-white/[0.1]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
