import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
];

let ndkInstance: NDK | null = null;

export function getNDK(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({ explicitRelayUrls: RELAYS });
  }
  return ndkInstance;
}

export async function connectNDK(): Promise<NDK> {
  const ndk = getNDK();
  await ndk.connect();
  return ndk;
}

export async function loginWithPrivateKey(privateKeyHex: string): Promise<NDK> {
  const ndk = getNDK();
  const signer = new NDKPrivateKeySigner(privateKeyHex);
  ndk.signer = signer;
  return ndk;
}

// Custom event kind for vtxo.fun token listings
export const VTXO_TOKEN_KIND = 30078;

export { RELAYS };
