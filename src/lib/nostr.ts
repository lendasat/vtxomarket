import NDK, { NDKPrivateKeySigner, type NDKUserProfile } from "@nostr-dev-kit/ndk";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
];

let ndkInstance: NDK | null = null;
let connected = false;

export function getNDK(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: RELAYS,
      enableOutboxModel: false,
      autoConnectUserRelays: false,
    });
  }
  return ndkInstance;
}

const CONNECT_TIMEOUT_MS = 5_000;

export async function connectNDK(): Promise<NDK> {
  const ndk = getNDK();
  if (!connected) {
    // NDK v3: connect() without a timeout hangs forever if any relay is down.
    // Pass a timeout so it resolves after 5s even if some relays are slow.
    // Relays that didn't connect in time continue connecting in the background.
    await ndk.connect(CONNECT_TIMEOUT_MS);
    connected = true;
  }
  return ndk;
}

export async function loginWithPrivateKey(privateKeyHex: string): Promise<NDK> {
  const ndk = getNDK();
  const signer = new NDKPrivateKeySigner(privateKeyHex);
  ndk.signer = signer;
  return ndk;
}

/**
 * Ensure the NDK singleton has a signer and is connected.
 * Throws if no signer is set (call loginWithPrivateKey first).
 */
export function ensureNostrReady(): NDK {
  const ndk = getNDK();
  if (!ndk.signer) {
    throw new Error("Nostr signer not initialized. Please wait for wallet setup.");
  }
  if (!connected) {
    throw new Error("Nostr not connected to relays.");
  }
  return ndk;
}

/** Fetch the signed-in user's profile (kind 0) from relays */
export async function fetchMyProfile(): Promise<NDKUserProfile | null> {
  const ndk = ensureNostrReady();
  const user = await ndk.signer!.user();
  user.ndk = ndk;
  return user.fetchProfile();
}

/** Update the signed-in user's profile. Merges with existing fields. */
export async function updateMyProfile(updates: Partial<NDKUserProfile>): Promise<NDKUserProfile> {
  const ndk = ensureNostrReady();
  const user = await ndk.signer!.user();
  user.ndk = ndk;

  // Fetch existing profile so we don't overwrite fields we don't touch
  await user.fetchProfile();

  user.profile = { ...user.profile, ...updates };
  await user.publish(); // signs kind 0 event and broadcasts to relays
  return user.profile;
}

// Custom event kind for vtxo.market token listings
export const VTXO_TOKEN_KIND = 30078;

export { RELAYS };
