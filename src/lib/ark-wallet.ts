// We use dynamic import because Turbopack (Next.js 16) breaks @arkade-os/sdk
// when bundling it statically. The dynamic import ensures it loads correctly
// in the browser at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArkWallet = any;

export const ARK_SERVER_URL = process.env.NEXT_PUBLIC_ARK_SERVER_URL || "https://arkade.computer";
const ESPLORA_URL = process.env.NEXT_PUBLIC_ESPLORA_URL || "https://mempool.space/api";

// Fallback fee if ASP info is unreachable
const FALLBACK_ONCHAIN_FEE = 200;

// -- ASP info & fee caching --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedAspInfo: any | null = null;
let _aspInfoFetchedAt = 0;
const ASP_INFO_TTL = 10 * 60 * 1000;

/**
 * Fetch full ASP info (fees, session config, etc).
 * Cached for 10 minutes. Used by both fee display and Ramps operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAspInfo(): Promise<any> {
  if (_cachedAspInfo && Date.now() - _aspInfoFetchedAt < ASP_INFO_TTL) {
    return _cachedAspInfo;
  }
  try {
    console.log("[asp-info] Fetching from %s/v1/info", ARK_SERVER_URL);
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
      signal: AbortSignal.timeout(10_000),
    });
    console.log("[asp-info] Response status: %d", resp.status);
    if (!resp.ok) return _cachedAspInfo;
    const info = await resp.json();
    _cachedAspInfo = info;
    _aspInfoFetchedAt = Date.now();
    return info;
  } catch (err) {
    console.error("[asp-info] Fetch failed:", err);
    return _cachedAspInfo;
  }
}

/**
 * Get the ASP's collaborative exit fee (per on-chain output) for UI display.
 * The ASP pays mining fees — the user only pays this service fee.
 */
export async function getAspOnchainFee(): Promise<number> {
  const info = await getAspInfo();
  const feeExpr = info?.fees?.intentFee?.onchainOutput;
  return feeExpr ? Math.ceil(parseFloat(feeExpr)) : FALLBACK_ONCHAIN_FEE;
}

/**
 * Get a RestArkProvider instance for direct ASP API calls (submitTx, finalizeTx).
 * ServiceWorkerWallet doesn't expose arkProvider, so swap protocol code uses this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getArkProvider(): Promise<any> {
  const { RestArkProvider } = await getSDK();
  return new RestArkProvider(ARK_SERVER_URL);
}

/**
 * Get a RestIndexerProvider for verifying VTXOs directly on the ASP.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAspIndexerProvider(): Promise<any> {
  const { RestIndexerProvider } = await getSDK();
  return new RestIndexerProvider(ARK_SERVER_URL);
}

/**
 * Verify that a swap offer's VTXO actually exists on the ASP.
 * Returns the VTXO data if found, throws if not.
 */
export async function verifyOfferVtxo(outpoint: string): Promise<void> {
  const [txid, voutStr] = outpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const indexer = await getAspIndexerProvider();
  const { vtxos } = await indexer.getVtxos({
    outpoints: [{ txid, vout }],
    spendableOnly: true,
  });
  if (!vtxos || vtxos.length === 0) {
    throw new Error(
      `Offer VTXO ${outpoint} not found on ASP or already spent. ` +
        "The offer may be invalid, expired, or from a malicious indexer."
    );
  }
}

/**
 * Get the serverUnrollScript (checkpoint tapscript) from ASP info.
 * ServiceWorkerWallet doesn't expose this property, so we reconstruct it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getServerUnrollScript(): Promise<any> {
  const { decodeTapscript } = await getSDK();
  const info = await getAspInfo();
  if (!info?.checkpointTapscript) {
    throw new Error("ASP info missing checkpointTapscript");
  }
  const { hex: scHex } = await import("@scure/base");
  const scriptBytes = scHex.decode(info.checkpointTapscript);
  return decodeTapscript(scriptBytes);
}

// VTXO renewal: default 3 days before expiry (matches Arkade SDK default)
const DEFAULT_RENEWAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

// Cache the SDK import *promise* (not the resolved value) to prevent
// concurrent callers from triggering duplicate imports + opcode registration.
let _sdkPromise: Promise<typeof import("@arkade-os/sdk")> | null = null;

function getSDK() {
  if (!_sdkPromise) {
    _sdkPromise = import("@arkade-os/sdk").then(async (sdk) => {
      await registerArkadeOpcodes();
      return sdk;
    });
  }
  return _sdkPromise;
}

// Use @scure/base for hex encoding/decoding — validates input and throws on
// invalid hex (odd length, non-hex chars) instead of silently producing garbage.
import { hex as scureHex } from "@scure/base";
const hexToBytes = scureHex.decode;
const bytesToHex = scureHex.encode;

// -- ServiceWorkerWallet setup (aligned with lendasat/wallet) --

const SERVICE_WORKER_PATH = "/wallet-service-worker.mjs";
const SW_SETUP_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 5;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function initArkWallet(privateKeyHex: string, retryCount = 0): Promise<ArkWallet> {
  const { SingleKey, ServiceWorkerWallet, IndexedDBWalletRepository, IndexedDBContractRepository } =
    await getSDK();
  console.log("[ark] SDK loaded, connecting to:", ARK_SERVER_URL);

  const identity = SingleKey.fromHex(privateKeyHex);
  const walletRepository = new IndexedDBWalletRepository();
  const contractRepository = new IndexedDBContractRepository();

  try {
    console.log(`[ark] ServiceWorkerWallet.setup attempt ${retryCount + 1}/${MAX_RETRIES + 1}...`);
    const wallet = await ServiceWorkerWallet.setup({
      serviceWorkerPath: SERVICE_WORKER_PATH,
      identity,
      arkServerUrl: ARK_SERVER_URL,
      esploraUrl: ESPLORA_URL,
      storage: { walletRepository, contractRepository },
      serviceWorkerActivationTimeoutMs: SW_SETUP_TIMEOUT_MS,
      messageBusTimeoutMs: SW_SETUP_TIMEOUT_MS,
    });

    console.log("[ark] ServiceWorkerWallet ready");
    return wallet;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const isTimeout =
      err.message.includes("timed out") ||
      err.message.includes("Service worker activation timed out") ||
      err.message.includes("MessageBus timed out");

    if (isTimeout && retryCount < MAX_RETRIES) {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.pow(2, retryCount) * 1000;
      console.warn(
        `[ark] Setup timed out, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})...`
      );
      await new Promise((r) => setTimeout(r, delay));
      return initArkWallet(privateKeyHex, retryCount + 1);
    }

    throw err;
  }
}

/**
 * Force the service worker to re-sync wallet state from the network.
 * Call before reading balance/VTXOs when the user explicitly refreshes.
 */
export async function reloadWalletState(wallet: ArkWallet): Promise<void> {
  if (typeof wallet.reload === "function") {
    await wallet.reload();
  }
}

/**
 * Check if the service worker wallet is still initialized.
 * Browsers can kill idle service workers — this detects that.
 */
export async function getWalletStatus(wallet: ArkWallet): Promise<boolean> {
  if (typeof wallet.getStatus !== "function") return true;
  const { walletInitialized } = await wallet.getStatus();
  return walletInitialized;
}

/**
 * Clear the ServiceWorkerWallet state (for logout).
 * Wipes both in-memory SW state and IndexedDB repositories.
 */
export async function clearArkWallet(wallet: ArkWallet): Promise<void> {
  try {
    await wallet.clear();
    if (wallet.walletRepository?.clear) await wallet.walletRepository.clear();
    if (wallet.contractRepository?.clear) await wallet.contractRepository.clear();
    console.log("[ark] Wallet state cleared");
  } catch (e) {
    console.warn("[ark] Wallet clear failed:", e);
  }
}

export interface BalanceInfo {
  total: number;
  available: number;
  offchain: number;
  onchain: number;
  onchainConfirmed: number;
  onchainUnconfirmed: number;
  settled: number;
  preconfirmed: number;
  recoverable: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getBalance(wallet: any): Promise<BalanceInfo> {
  const balance = await wallet.getBalance();
  return {
    total: balance.total,
    available: balance.available ?? 0,
    offchain: (balance.settled ?? 0) + (balance.preconfirmed ?? 0),
    onchain: balance.boarding?.total ?? 0,
    onchainConfirmed: balance.boarding?.confirmed ?? 0,
    onchainUnconfirmed: balance.boarding?.unconfirmed ?? 0,
    settled: balance.settled ?? 0,
    preconfirmed: balance.preconfirmed ?? 0,
    recoverable: balance.recoverable ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getReceivingAddresses(wallet: any) {
  const offchainAddr = await wallet.getAddress();
  const boardingAddr = await wallet.getBoardingAddress();
  return { offchainAddr, boardingAddr };
}

export function isBtcAddress(addr: string): boolean {
  return (
    /^(bc1|tb1|bcrt1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,87}$/.test(addr) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)
  );
}

/**
 * Collaborative exit: send sats to an on-chain Bitcoin address via Ramps.offboard().
 * Uses the SDK's official method which properly handles fee deduction via CEL expressions.
 */

async function collaborativeExit(
  wallet: any,
  address: string,
  amountSats: number
): Promise<string> {
  const { Ramps } = await getSDK();
  const ramps = new Ramps(wallet);
  const info = await getAspInfo();

  console.log("[ark] Collaborative exit: %d sats to %s", amountSats, address.slice(0, 12));

  // Ramps.offboard() handles coin selection, fee deduction (per-input + per-output),
  // and calls wallet.settle() with the correct inputs/outputs.
  // The `amount` param is the PRE-fee amount — offboard deducts the output fee internally.
  // So the recipient receives (amountSats - outputFee). To send exactly amountSats,
  // we need to add the output fee ourselves.
  const fee = await getAspOnchainFee();
  const txid = await ramps.offboard(
    address,
    info.fees,
    BigInt(amountSats + fee), // offboard deducts outputFee internally → recipient gets ~amountSats
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[collaborative-exit]", event)
  );
  return txid;
}

/**
 * Compute the actual wait time from VTXO expiry data and the minExpiryGap error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeMinExpiryWait(wallet: any, errorMsg: string): Promise<number> {
  // Parse minExpiryGap from error (e.g., "695h53m36s")
  const hoursMatch = errorMsg.match(/minExpiryGap:\s*(\d+)h/);
  const gapHours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  if (!gapHours) return 24; // fallback

  // Get the earliest VTXO expiry to compute actual wait
  try {
    const vtxos = await wallet.getVtxos();
    if (vtxos.length === 0) return 24;

    const earliestExpiry = Math.min(
      ...vtxos.map((v: any) => v.virtualStatus?.batchExpiry ?? Infinity)
    );
    if (!earliestExpiry || earliestExpiry === Infinity) return 24;

    const expiresInHours = (earliestExpiry * 1000 - Date.now()) / (3600 * 1000);
    const waitHours = Math.max(1, Math.ceil(expiresInHours - gapHours));
    return waitHours;
  } catch {
    return 24;
  }
}

export async function sendPayment(
  wallet: any,
  address: string,
  amountSats: number
): Promise<string> {
  if (isBtcAddress(address)) {
    try {
      return await collaborativeExit(wallet, address, amountSats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The ASP enforces a minExpiryGap: recently-settled VTXOs (with nearly
      // full expiry) cannot participate in a new round until they age past
      // the threshold. Compute actual wait time and show a clear message.
      if (msg.includes("minExpiryGap")) {
        const waitHours = await computeMinExpiryWait(wallet, msg);
        throw new Error(
          `On-chain sends are temporarily unavailable — your funds were recently settled ` +
            `and the server requires ~${waitHours}h of aging before they can be spent on-chain. ` +
            `You can send via Lightning or Ark (off-chain) in the meantime.`
        );
      }
      throw err;
    }
  }

  const txid = await wallet.sendBitcoin({ address, amount: amountSats });
  return txid;
}

export async function getDustAmount(): Promise<number> {
  const info = await getAspInfo();
  return Number(info?.dust ?? info?.utxoMinAmount ?? 330);
}

// -- Token issuance --

export interface IssueTokenParams {
  amount: number;
  name?: string;
  ticker?: string;
  decimals?: number;
  icon?: string;
  controlAssetId?: string; // when set: link this issuance to an existing control asset
}

export interface IssueTokenResult {
  arkTxId: string;
  assetId: string;
}

/**
 * Issue a new token on Ark using the SDK's assetManager.
 *
 * Reissuable token flow (two separate calls from create/page.tsx):
 *   Step 1: issueToken(wallet, { amount: 1 })
 *           → creates the control asset (1 unit, no metadata)
 *   Step 2: issueToken(wallet, { amount: N, name, ticker, ..., controlAssetId: step1.assetId })
 *           → creates the main token linked to control (carries name/ticker/metadata)
 *   reissue: wallet.assetManager.reissue({ assetId: step2.assetId, amount })
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function issueToken(wallet: any, params: IssueTokenParams): Promise<IssueTokenResult> {
  const { amount, name, ticker, decimals, icon, controlAssetId } = params;
  if (amount <= 0) throw new Error("Amount must be greater than 0");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata: Record<string, any> | undefined =
    name && ticker
      ? {
          name,
          ticker,
          ...(decimals !== undefined && { decimals }),
          ...(icon && { icon }),
        }
      : undefined;

  console.log(
    "[ark] issueToken: amount=%d, controlAssetId=%s, metadata=%o",
    amount,
    controlAssetId,
    metadata
  );

  const result = await wallet.assetManager.issue({
    amount,
    ...(controlAssetId && { controlAssetId }),
    ...(metadata && { metadata }),
  });

  console.log("[ark] issueToken: success! txid=%s, assetId=%s", result.arkTxId, result.assetId);
  return { arkTxId: result.arkTxId, assetId: result.assetId };
}

/**
 * Reissue (mint more) tokens for a reissuable asset.
 * Requires the caller to hold the control asset VTXO.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reissueToken(wallet: any, assetId: string, amount: number): Promise<string> {
  return await wallet.assetManager.reissue({ assetId, amount });
}

// -- Transaction history --

export interface TxHistoryItem {
  type: "SENT" | "RECEIVED";
  amount: number;
  settled: boolean;
  createdAt: number;
  boardingTxid: string;
  commitmentTxid: string;
  arkTxid: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTransactionHistory(wallet: any): Promise<TxHistoryItem[]> {
  const history = await wallet.getTransactionHistory();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return history.map((tx: any) => ({
    type: tx.type,
    amount: tx.amount,
    settled: tx.settled,
    createdAt: tx.createdAt,
    boardingTxid: tx.key?.boardingTxid ?? "",
    commitmentTxid: tx.key?.commitmentTxid ?? "",
    arkTxid: tx.key?.arkTxid ?? "",
  }));
}

// -- Debug helpers --

export interface WalletBalance {
  total: number;
  available: number;
  settled: number;
  preconfirmed: number;
  recoverable: number;
  boarding?: { total: number; confirmed: number; unconfirmed: number };
}

export interface VtxoInfo {
  type: "boarding" | "vtxo";
  value: number;
  confirmed: boolean;
  state?: string;
  batchExpiry?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getRawBalance(wallet: any): Promise<WalletBalance> {
  return wallet.getBalance();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getVtxoDetails(wallet: any): Promise<VtxoInfo[]> {
  const results: VtxoInfo[] = [];
  const boardingUtxos = await wallet.getBoardingUtxos();

  for (const utxo of boardingUtxos) {
    results.push({ type: "boarding", value: utxo.value, confirmed: utxo.status.confirmed });
  }
  const vtxos = await wallet.getVtxos({ withRecoverable: true });

  for (const vtxo of vtxos) {
    results.push({
      type: "vtxo",
      value: vtxo.value,
      confirmed: true,
      state: vtxo.virtualStatus.state,
      batchExpiry: vtxo.virtualStatus.batchExpiry,
    });
  }
  return results;
}

// -- Boarding UTXO filtering (aligned with lendasat/wallet) --

/**
 * Get confirmed boarding UTXOs that have NOT expired.
 * Expired boarding UTXOs cannot be cosigned by the ASP, so including them
 * in a settle round would cause failures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getConfirmedAndNotExpiredUtxos(wallet: any): Promise<any[]> {
  const { VtxoScript, hasBoardingTxExpired } = await getSDK();
  const allUtxos = await wallet.getBoardingUtxos();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return allUtxos.filter((utxo: any) => {
    if (!utxo.status?.confirmed) return false;
    try {
      const vtxoScript = VtxoScript.decode(utxo.tapTree);
      const exitPaths = vtxoScript.exitPaths();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let earliest: any = undefined;
      for (const path of exitPaths) {
        const tl = path.params?.timelock;
        if (!tl) continue;
        if (!earliest || tl.value < earliest.value) earliest = tl;
      }
      return earliest ? !hasBoardingTxExpired(utxo, earliest) : true;
    } catch {
      // If we can't decode the tapTree, include it and let the ASP decide
      return true;
    }
  });
}

// Minimum sats required to attempt boarding settlement (dust + fee headroom)
const MIN_SETTLE_SATS = 1_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function settleVtxos(wallet: any): Promise<string> {
  const boardingUtxos = await getConfirmedAndNotExpiredUtxos(wallet);
  if (boardingUtxos.length === 0) throw new Error("No confirmed UTXOs to settle");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = boardingUtxos.reduce((sum: number, u: any) => sum + u.value, 0);
  if (total < MIN_SETTLE_SATS) {
    throw new Error(
      `Boarding balance too low to settle: ${total} sats (need >= ${MIN_SETTLE_SATS})`
    );
  }

  console.log("[settleVtxos] %d boarding UTXOs = %d sats", boardingUtxos.length, total);

  // Use SDK's Ramps.onboard() — it properly handles fee deduction via the
  // Estimator (CEL expressions) and filters out UTXOs where fee >= value.
  const { Ramps } = await getSDK();
  const ramps = new Ramps(wallet);
  const info = await getAspInfo();

  const txid = await withTimeout(
    ramps.onboard(
      info.fees,
      boardingUtxos,
      undefined, // onboard full amount
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event: any) => console.log("[onboard]", event)
    ),
    SETTLE_TIMEOUT,
    "settleVtxos (onboard)"
  );
  return txid;
}

/** Finalize any pending (preconfirmed) transactions. Non-destructive no-op if none exist. */

export async function finalizePending(
  wallet: any
): Promise<{ finalized: string[]; pending: string[] }> {
  if (typeof wallet.finalizePendingTxs !== "function") return { finalized: [], pending: [] };
  return wallet.finalizePendingTxs();
}

const SETTLE_TIMEOUT = 60_000; // 60s max wait for a round

/**
 * Settle boarding UTXOs + preconfirmed VTXOs into the next Ark round.
 * Does NOT include settled VTXOs with long expiry — the ASP rejects those
 * with minExpiryGap errors. Only grabs what actually needs settling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function settleAll(wallet: any): Promise<string> {
  // Collect confirmed, non-expired boarding UTXOs
  const boardingUtxos = await getConfirmedAndNotExpiredUtxos(wallet);

  // Collect preconfirmed VTXOs only (NOT settled ones — those have long expiry)
  const vtxos = await wallet.getVtxos({ withRecoverable: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preconfirmed = vtxos.filter((v: any) => v.virtualStatus?.state === "preconfirmed");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any[] = [...boardingUtxos, ...preconfirmed];
  if (inputs.length === 0) throw new Error("Nothing to settle");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = inputs.reduce((sum: number, input: any) => sum + input.value, 0);
  if (total < MIN_SETTLE_SATS) {
    throw new Error(`Balance too low to settle: ${total} sats (need >= ${MIN_SETTLE_SATS})`);
  }

  const arkAddress = await wallet.getAddress();
  console.log(
    "[settleAll] %d boarding + %d preconfirmed = %d sats",
    boardingUtxos.length,
    preconfirmed.length,
    total
  );

  const settlePromise = wallet.settle(
    {
      inputs,
      outputs: [{ address: arkAddress, amount: BigInt(total) }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[settleAll]", event)
  );

  const txid = await withTimeout<string>(settlePromise, SETTLE_TIMEOUT, "settleAll");
  return txid;
}

// ── Non-interactive swap offers (Arkade Script + Introspector) ────────────────
//
// The full swap protocol implementation lives in src/lib/swap_protocol/.
// This file re-exports the public API for backwards compatibility.
//
// See swap_protocol/index.ts for architecture documentation.
// ──────────────────────────────────────────────────────────────────────────────

export {
  encodeLE64,
  createSwapOffer,
  lightFillSwapOffer as fillSwapOffer,
  cancelSwapOffer,
  createBuyOffer,
  lightFillBuyOffer as fillBuyOffer,
  cancelBuyOffer,
} from "./swap_protocol";
export type { SwapOfferParams, SwapOffer, BuyOfferParams, BuyOffer } from "./swap_protocol";

import { registerArkadeOpcodes } from "./swap_protocol";

// -- Asset operations --

export interface AssetInfo {
  assetId: string;
  amount: number;
}

export interface AssetDetails {
  assetId: string;
  amount: number;
  name?: string;
  ticker?: string;
}

/** Send asset tokens to a recipient Ark address */

export async function sendAsset(
  wallet: any,
  recipientAddress: string,
  assetId: string,
  assetAmount: number
): Promise<string> {
  // wallet.send() handles asset transfers with proper input/output balancing.
  // amount=0 means no BTC transfer; assets array carries the token transfer.
  const txid = await wallet.send({
    address: recipientAddress,
    amount: 0,
    assets: [{ assetId, amount: assetAmount }],
  });
  return txid;
}

/** Get all assets held by this wallet (from balance aggregation, not assetManager) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAssets(wallet: any): Promise<AssetInfo[]> {
  const balance = await wallet.getBalance();
  console.log("[ark] getBalance().assets:", JSON.stringify(balance.assets));

  // Also inspect raw VTXOs to see if any have .assets
  try {
    const vtxos = await wallet.getVtxos();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withAssets = vtxos.filter((v: any) => v.assets && v.assets.length > 0);
    console.log(`[ark] VTXOs: ${vtxos.length} total, ${withAssets.length} with assets`);

    for (const v of vtxos.slice(0, 5)) {
      console.log(
        `[ark]   VTXO ${v.txid}:${v.vout} value=${v.value} spent=${v.isSpent} assets=`,
        v.assets
      );
    }
  } catch (e) {
    console.warn("[ark] VTXO inspection failed:", e);
  }

  if (!balance.assets || !Array.isArray(balance.assets)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return balance.assets.map((a: any) => ({
    assetId: a.assetId,
    amount: Number(a.amount ?? 0),
  }));
}

// -- Asset metadata cache (24h TTL, persisted to localStorage) --

const ASSET_META_KEY = "vtxo-asset-metadata";
const ASSET_META_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CachedAssetMeta {
  name?: string;
  ticker?: string;
  cachedAt: number;
}

function loadAssetMetaCache(): Map<string, CachedAssetMeta> {
  try {
    const raw = localStorage.getItem(ASSET_META_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function saveAssetMetaCache(cache: Map<string, CachedAssetMeta>): void {
  try {
    localStorage.setItem(ASSET_META_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Quota exceeded — ignore
  }
}

const _assetMetaCache = loadAssetMetaCache();

/**
 * Get cached asset metadata, or fetch + cache it from the wallet's assetManager.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCachedAssetMeta(
  wallet: any,
  assetId: string
): Promise<{ name?: string; ticker?: string }> {
  const cached = _assetMetaCache.get(assetId);
  if (cached && Date.now() - cached.cachedAt < ASSET_META_TTL) {
    return { name: cached.name, ticker: cached.ticker };
  }
  try {
    const details = await wallet.assetManager.getAssetDetails(assetId);
    const entry: CachedAssetMeta = {
      name: details?.metadata?.name,
      ticker: details?.metadata?.ticker,
      cachedAt: Date.now(),
    };
    _assetMetaCache.set(assetId, entry);
    saveAssetMetaCache(_assetMetaCache);
    return { name: entry.name, ticker: entry.ticker };
  } catch {
    return {};
  }
}

/** Get details for a specific asset (balance from getBalance, metadata from cache/indexer) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAssetDetails(wallet: any, assetId: string): Promise<AssetDetails | null> {
  try {
    // Get amount from balance
    const balance = await wallet.getBalance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const held = balance.assets?.find((a: any) => a.assetId === assetId);
    if (!held) return null;

    const { name, ticker } = await getCachedAssetMeta(wallet, assetId);

    return {
      assetId,
      amount: Number(held.amount ?? 0),
      name,
      ticker,
    };
  } catch {
    return null;
  }
}

// -- VTXO auto-renewal --

/** Check if a VTXO is expiring within the threshold */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isVtxoExpiringSoon(vtxo: any, thresholdMs: number): boolean {
  const batchExpiry = vtxo.virtualStatus?.batchExpiry;
  if (!batchExpiry) return false;
  const now = Date.now();
  if (batchExpiry <= now) return false; // already expired
  return batchExpiry - now <= thresholdMs;
}

/** Check if a VTXO is swept but still recoverable */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRecoverable(vtxo: any): boolean {
  return vtxo.virtualStatus?.state === "swept";
}

/** Check if a VTXO is expired (past its batchExpiry) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isExpired(vtxo: any): boolean {
  if (vtxo.virtualStatus?.state === "swept") return true;
  const expiry = vtxo.virtualStatus?.batchExpiry;
  if (!expiry) return false;
  return expiry <= Date.now();
}

/**
 * Compute a dynamic renewal threshold based on actual batch lifetime.
 * Uses 10% of the batch lifetime (same as the Arkade wallet).
 * Falls back to DEFAULT_RENEWAL_THRESHOLD_MS (3 days) if we can't determine lifetime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function computeRenewalThreshold(wallet: any): Promise<number> {
  try {
    const vtxos = await wallet.getVtxos({ withRecoverable: true });
    // Find a settled VTXO with batchExpiry and commitment txids to estimate batch lifetime

    const sample = vtxos.find(
      (v: any) =>
        v.virtualStatus?.batchExpiry &&
        v.virtualStatus?.commitmentTxIds?.length > 0 &&
        v.virtualStatus?.state === "settled"
    );
    if (!sample) return DEFAULT_RENEWAL_THRESHOLD_MS;

    // Estimate batch start from the commitment tx timestamp via esplora
    const commitTxId = sample.virtualStatus.commitmentTxIds[0];
    const resp = await fetch(`${ESPLORA_URL}/tx/${commitTxId}`);
    if (!resp.ok) return DEFAULT_RENEWAL_THRESHOLD_MS;
    const txData = await resp.json();
    const blockTime = txData.status?.block_time;
    if (!blockTime) return DEFAULT_RENEWAL_THRESHOLD_MS;

    const batchStartMs = blockTime * 1000;
    const batchExpiryMs = sample.virtualStatus.batchExpiry;
    const batchLifetimeMs = batchExpiryMs - batchStartMs;

    if (batchLifetimeMs <= 0) return DEFAULT_RENEWAL_THRESHOLD_MS;

    // 10% of batch lifetime
    const threshold = Math.floor(batchLifetimeMs * 0.1);
    console.log(
      "[ark] Renewal threshold: %dh (10%% of %dd batch lifetime)",
      Math.round(threshold / 3600000),
      Math.round(batchLifetimeMs / 86400000)
    );
    return threshold;
  } catch (e) {
    console.warn("[ark] Could not compute dynamic threshold, using default 3 days:", e);
    return DEFAULT_RENEWAL_THRESHOLD_MS;
  }
}

/**
 * Find VTXOs that need renewal: expiring soon, swept/recoverable, or expired-but-unspent.
 * Mirrors the Arkade wallet's getExpiringAndRecoverableVtxos().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getVtxosNeedingRenewal(wallet: any, thresholdMs?: number): Promise<any[]> {
  const threshold = thresholdMs ?? DEFAULT_RENEWAL_THRESHOLD_MS;
  const vtxos = await wallet.getVtxos({ withRecoverable: true });
  const dustAmount = await getDustAmount();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vtxos.filter((vtxo: any) => {
    // Expiring soon
    if (isVtxoExpiringSoon(vtxo, threshold)) return true;
    // Swept but recoverable
    if (isRecoverable(vtxo)) return true;
    // Expired but somehow still unspent
    if (isExpired(vtxo) && vtxo.virtualStatus?.state !== "spent") return true;
    // Subdust — consolidate if possible
    if (vtxo.value < dustAmount && vtxo.value > 0) return true;
    return false;
  });
}

/**
 * Renew expiring/recoverable VTXOs by settling them back to our own Ark address.
 * This gives them a fresh batchExpiry. Also consolidates subdust VTXOs and
 * includes confirmed boarding UTXOs to roll everything into the next round.
 *
 * Returns the settlement txid, or null if nothing needed renewal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function renewVtxos(wallet: any, thresholdMs?: number): Promise<string | null> {
  const threshold = thresholdMs ?? DEFAULT_RENEWAL_THRESHOLD_MS;
  const expiringVtxos = await getVtxosNeedingRenewal(wallet, threshold);

  // Also grab confirmed, non-expired boarding UTXOs to consolidate in the same round
  const boardingUtxos = await getConfirmedAndNotExpiredUtxos(wallet);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any[] = [...expiringVtxos, ...boardingUtxos];
  if (inputs.length === 0) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalAmount = inputs.reduce((sum: number, input: any) => sum + input.value, 0);
  const dustAmount = await getDustAmount();

  if (totalAmount < dustAmount) {
    console.log("[ark] Renewal skipped: total %d sats below dust %d", totalAmount, dustAmount);
    return null;
  }

  const arkAddress = await wallet.getAddress();
  console.log(
    "[ark] Renewing %d VTXOs + %d boarding UTXOs (%d sats total)",
    expiringVtxos.length,
    boardingUtxos.length,
    totalAmount
  );

  const txid = await wallet.settle(
    {
      inputs,
      outputs: [{ address: arkAddress, amount: BigInt(totalAmount) }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[renewal]", event)
  );

  console.log("[ark] Renewal complete, txid:", txid);
  return txid;
}

// -- Unilateral exit (emergency escape hatch) --

export type UnilateralExitStep =
  | { type: "unroll"; txid: string }
  | { type: "wait"; txid: string }
  | { type: "done"; vtxoTxid: string };

/**
 * Check if the ASP server is reachable.
 * If not, unilateral exit may be necessary.
 */
export async function isAspReachable(): Promise<boolean> {
  try {
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Get VTXOs eligible for unilateral exit.
 * Only settled VTXOs with full transaction trees can be unrolled.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getUnilateralExitEligibleVtxos(wallet: any): Promise<VtxoInfo[]> {
  const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });

  return (
    vtxos
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((v: any) => v.virtualStatus?.state === "settled" && !v.isUnrolled)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((v: any) => ({
        type: "vtxo" as const,
        value: v.value,
        confirmed: true,
        state: v.virtualStatus.state,
        batchExpiry: v.virtualStatus.batchExpiry,
      }))
  );
}

/**
 * Perform a unilateral exit for a specific VTXO.
 * This broadcasts the off-chain transaction tree onto Bitcoin,
 * bypassing the ASP entirely.
 *
 * Requires on-chain BTC for P2A anchor fees (the OnchainWallet).
 * The process involves multiple on-chain transactions and confirmations.
 *
 * @param wallet - The Ark wallet instance
 * @param privateKeyHex - Private key for the OnchainWallet (fee bumping)
 * @param vtxoTxid - The txid of the VTXO to unilaterally exit
 * @param vtxoVout - The vout of the VTXO (default 0)
 * @param onStep - Callback for progress updates
 */

export async function unilateralExit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  privateKeyHex: string,
  vtxoTxid: string,
  vtxoVout: number = 0,
  onStep?: (step: UnilateralExitStep) => void
): Promise<string> {
  const sdk = await getSDK();
  const { Unroll, OnchainWallet, SingleKey } = sdk;

  // Determine network name from ARK_SERVER_URL
  const networkName = ARK_SERVER_URL.includes("mutinynet")
    ? "mutinynet"
    : ARK_SERVER_URL.includes("signet")
      ? "signet"
      : "bitcoin";

  // Create OnchainWallet for P2A anchor fee bumping
  const identity = SingleKey.fromHex(privateKeyHex);
  const onchainWallet = await OnchainWallet.create(identity, networkName);

  // Create unroll session for this VTXO
  const outpoint = { txid: vtxoTxid, vout: vtxoVout };
  const session = await Unroll.Session.create(
    outpoint,
    onchainWallet, // AnchorBumper
    onchainWallet.provider, // OnchainProvider (esplora)
    wallet.indexerProvider // IndexerProvider
  );

  let lastVtxoTxid = vtxoTxid;

  // Iterate through all unroll steps
  for await (const step of session) {
    switch (step.type) {
      case Unroll.StepType.WAIT:
        console.log("[ark] Unilateral exit: waiting for tx confirmation:", step.txid);
        onStep?.({ type: "wait", txid: step.txid });
        break;
      case Unroll.StepType.UNROLL:
        console.log("[ark] Unilateral exit: broadcasting tx:", step.tx?.id);
        onStep?.({ type: "unroll", txid: step.tx?.id ?? "" });
        break;
      case Unroll.StepType.DONE:
        console.log("[ark] Unilateral exit: unroll complete, vtxoTxid:", step.vtxoTxid);
        lastVtxoTxid = step.vtxoTxid;
        onStep?.({ type: "done", vtxoTxid: step.vtxoTxid });
        break;
    }
  }

  return lastVtxoTxid;
}

/**
 * Complete a unilateral exit after the CSV timelock has expired.
 * This spends the unrolled VTXO to a regular on-chain address.
 *
 * @param wallet - The Ark wallet instance
 * @param vtxoTxids - Array of unrolled VTXO txids
 * @param destinationAddress - On-chain Bitcoin address to receive funds
 */

export async function completeUnilateralExit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  vtxoTxids: string[],
  destinationAddress: string
): Promise<string> {
  const sdk = await getSDK();
  const { Unroll } = sdk;

  console.log(
    "[ark] Completing unilateral exit for %d VTXOs to %s",
    vtxoTxids.length,
    destinationAddress
  );
  const txid = await Unroll.completeUnroll(wallet, vtxoTxids, destinationAddress);
  console.log("[ark] Unilateral exit complete, final txid:", txid);
  return txid;
}

/**
 * Get VTXOs that have been fully unrolled and may be ready for completion.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getUnrolledVtxos(wallet: any): Promise<VtxoInfo[]> {
  const vtxos = await wallet.getVtxos({ withUnrolled: true });

  return (
    vtxos
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((v: any) => v.isUnrolled === true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((v: any) => ({
        type: "vtxo" as const,
        value: v.value,
        confirmed: true,
        state: "unrolled",
        batchExpiry: v.virtualStatus?.batchExpiry,
      }))
  );
}
