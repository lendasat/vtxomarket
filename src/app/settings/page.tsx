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
  const [revealedNostrKey, setRevealedNostrKey] = useState(false);
  const [revealedArkKey, setRevealedArkKey] = useState(false);

  // Profile editing
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profilePicture, setProfilePicture] = useState("");
  const [profileAbout, setProfileAbout] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const profileInitRef = useRef(false);
  const pictureInputRef = useRef<HTMLInputElement>(null);

  // Sync form fields when profile loads
  useEffect(() => {
    if (profile && !profileInitRef.current) {
      profileInitRef.current = true;
      setProfileName(profile.displayName || profile.name || "");
      setProfilePicture(profile.picture || "");
      setProfileAbout(profile.about || "");
    }
  }, [profile]);

  const handlePictureUpload = async (file: File) => {
    setUploadingPicture(true);
    setUploadError("");
    try {
      const uploadUrl = "https://nostr.build/api/v2/upload/files";

      // NIP-98: sign a kind 27235 auth event
      const { getNDK } = await import("@/lib/nostr");
      const ndk = getNDK();
      const { NDKEvent } = await import("@nostr-dev-kit/ndk");
      const authEvent = new NDKEvent(ndk);
      authEvent.kind = 27235;
      authEvent.created_at = Math.floor(Date.now() / 1000);
      authEvent.tags = [
        ["u", uploadUrl],
        ["method", "POST"],
      ];
      authEvent.content = "";
      await authEvent.sign();
      const authHeader = "Nostr " + btoa(JSON.stringify(authEvent.rawEvent()));

      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: authHeader },
        body: formData,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const data = await res.json();
      const url = data?.data?.[0]?.url;
      if (!url) throw new Error("No URL returned from upload");
      setProfilePicture(url);
    } catch (e) {
      console.error("[settings] Picture upload failed:", e);
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingPicture(false);
    }
  };

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
    a.download = "vtxomarket-seed-phrase.txt";
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
                <label className="text-[11px] text-muted-foreground/50 font-medium">Profile Picture</label>
                <div className="flex gap-2">
                  <input
                    value={profilePicture}
                    onChange={(e) => setProfilePicture(e.target.value)}
                    placeholder="https://nostr.build/i/..."
                    className="flex-1 h-10 px-3.5 text-sm rounded-xl bg-white/[0.05] border border-white/[0.08] text-foreground placeholder:text-muted-foreground/25 outline-none focus:border-white/[0.14] transition-all"
                  />
                  <input
                    ref={pictureInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handlePictureUpload(file);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => pictureInputRef.current?.click()}
                    disabled={uploadingPicture}
                    className="shrink-0 h-10 px-3 rounded-xl bg-white/[0.07] border border-white/[0.1] text-xs font-medium transition-all hover:bg-white/[0.12] disabled:opacity-40"
                  >
                    {uploadingPicture ? (
                      <span className="flex items-center gap-1.5">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-transparent" />
                        Uploading
                      </span>
                    ) : (
                      "Upload"
                    )}
                  </button>
                </div>
                {uploadError && (
                  <p className="text-[11px] text-red-400">{uploadError}</p>
                )}
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

          {nostrPrivKeyHex && (
            revealedNostrKey ? (
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
            ) : (
              <button
                onClick={() => setRevealedNostrKey(true)}
                className="w-full h-9 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-muted-foreground/40 transition-all hover:bg-white/[0.08]"
              >
                Reveal Private Key
              </button>
            )
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

          {arkPrivKeyHex && (
            revealedArkKey ? (
              <CopyableField
                label="Private Key (hex)"
                value={arkPrivKeyHex}
                displayValue={truncate(arkPrivKeyHex)}
                copied={copied === "ark-key"}
                onCopy={() => handleCopy(arkPrivKeyHex, "ark-key")}
                sensitive
              />
            ) : (
              <button
                onClick={() => setRevealedArkKey(true)}
                className="w-full h-9 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-muted-foreground/40 transition-all hover:bg-white/[0.08]"
              >
                Reveal Private Key
              </button>
            )
          )}

          {!walletReady && (
            <p className="text-[11px] text-muted-foreground/40 leading-relaxed">
              Could not connect to Ark server. Wallet features are offline but
              your keys are safe.
            </p>
          )}
        </div>
      </div>

      {/* About */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-3">
          <h2 className="text-sm font-semibold">About vtxo.market</h2>
          <p className="text-[12px] text-muted-foreground/60 leading-relaxed">
            vtxo.market is a non-profit, open-source project maintained by the Arkade community. It is free to use and will remain so. No fees, no investors, no company behind it.
          </p>
          <p className="text-[12px] text-muted-foreground/60 leading-relaxed">
            If you find it useful, consider donating sats or contributing code. Every bit helps keep the lights on.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <a
              href="https://github.com/arkade-os/vtxomarket"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] px-3.5 py-2.5 text-xs font-medium transition-all hover:bg-white/[0.09] hover:border-white/[0.12]"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 shrink-0 text-muted-foreground/60">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
              </svg>
              GitHub — Contribute or report issues
            </a>
          </div>
        </div>
      </div>

      {/* Terms of Service */}
      <div className="glass-card rounded-2xl bg-white/[0.04] border border-white/[0.07] backdrop-blur-sm overflow-hidden">
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-amber-400/70">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
            </svg>
            <h2 className="text-sm font-semibold">Terms of Service</h2>
          </div>
          <div className="space-y-2 text-[12px] text-muted-foreground/55 leading-relaxed">
            <p>
              vtxo.market is an <span className="text-foreground/70 font-medium">experimental platform</span> provided for research and entertainment purposes only. It is not a financial product or investment service.
            </p>
            <p>
              The platform is provided &ldquo;as-is&rdquo; with no warranties of any kind. We are not responsible for any losses of funds, whether caused by bugs, network failures, protocol changes, or user error. <span className="text-foreground/70 font-medium">Do not put serious money into anything on this platform.</span>
            </p>
            <p>
              All tokens issued here are on a test network (Mutinynet). They have no real monetary value. Treat this as a playground, not a market.
            </p>
            <p className="text-muted-foreground/35">
              By using vtxo.market you acknowledge these terms and accept all risks.
            </p>
          </div>
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
