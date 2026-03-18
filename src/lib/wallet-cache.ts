/**
 * Stale-while-revalidate cache for wallet display data.
 *
 * Persists the last-known balance, addresses, held assets, and profile
 * to localStorage so the UI can show them instantly on reload while the
 * Ark SDK reconnects in the background.
 *
 * localStorage is intentional: reads are synchronous, so the very first
 * render already has data — no flash of empty state.
 */

import type { BalanceInfo } from "./ark-wallet";
import type { HeldAsset } from "./store";
import type { NDKUserProfile } from "@nostr-dev-kit/ndk";

const CACHE_KEY = "vtxo-wallet-cache";
// Bump this when BalanceInfo, HeldAsset, or cache shape changes.
const CACHE_VERSION = 1;

export interface WalletCache {
  version: number;
  balance: BalanceInfo;
  addresses: { offchainAddr: string; boardingAddr: string };
  heldAssets: HeldAsset[];
  profile: NDKUserProfile | null;
  savedAt: number;
}

/** Save current wallet state to localStorage. */
export function saveWalletCache(data: Omit<WalletCache, "savedAt" | "version">): void {
  try {
    const payload: WalletCache = { ...data, version: CACHE_VERSION, savedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or SSR — ignore silently
  }
}

/** Load cached wallet state. Returns null if nothing cached or version mismatch. */
export function loadWalletCache(): WalletCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalletCache;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clear the cache (e.g. on logout). */
export function clearWalletCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // SSR or restricted — ignore
  }
}
