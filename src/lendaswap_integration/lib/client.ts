/**
 * Lendaswap SDK client — singleton with lazy initialization.
 *
 * Uses IndexedDB for persistent wallet & swap storage (browser).
 * The SDK generates its own HD wallet (separate from the Ark wallet)
 * for HTLC signing keys and preimage derivation.
 *
 * IMPORTANT: The SDK depends on @arkade-os/sdk which cannot be
 * statically bundled with Turbopack. We use dynamic import() to
 * load it at runtime, matching the pattern used in ark-wallet.ts.
 */

// Proxy all Lendaswap API calls through Next.js rewrites (/api/lendaswap/*)
// to avoid CORS issues with the remote API (x-api-key header blocked by preflight).
const LENDASWAP_API_URL = "/api/lendaswap";
const ARKADE_SERVER_URL =
  process.env.NEXT_PUBLIC_ARK_SERVER_URL || "https://arkade.computer";
const ESPLORA_URL =
  process.env.NEXT_PUBLIC_ESPLORA_URL || "https://mempool.space/api";
const LENDASWAP_API_KEY =
  process.env.NEXT_PUBLIC_LENDASWAP_API_KEY || "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;

/**
 * Returns the singleton Lendaswap Client instance.
 *
 * On first call, initializes the SDK with:
 *   - IdbWalletStorage (IndexedDB) for mnemonic + key index persistence
 *   - IdbSwapStorage (IndexedDB) for swap state persistence
 *   - The configured Lendaswap API endpoint
 *
 * Subsequent calls return the same promise (deduped initialization).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getLendaswapClient(): Promise<any> {
  if (!clientPromise) {
    clientPromise = initClient();
  }
  return clientPromise;
}

/**
 * Tear down the singleton. Useful for logout / wallet disconnect.
 */
export function resetLendaswapClient(): void {
  clientPromise = null;
}

// ── Internal ────────────────────────────────────────────────────────────────

async function initClient() {
  // Dynamic import to avoid Turbopack static bundling issues
  const { Client, IdbWalletStorage, IdbSwapStorage } = await import(
    "@lendasat/lendaswap-sdk-pure"
  );

  const builder = Client.builder()
    .withBaseUrl(LENDASWAP_API_URL)
    .withArkadeServerUrl(ARKADE_SERVER_URL)
    .withEsploraUrl(ESPLORA_URL)
    .withSignerStorage(new IdbWalletStorage())
    .withSwapStorage(new IdbSwapStorage());

  if (LENDASWAP_API_KEY) {
    builder.withApiKey(LENDASWAP_API_KEY);
  }

  const client = await builder.build();

  // Verify connectivity
  try {
    await client.healthCheck();
  } catch (err) {
    console.warn("[lendaswap] Health check failed — API may be unreachable:", err);
  }

  return client;
}
