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
async function getAspInfo(): Promise<any> {
  if (_cachedAspInfo && Date.now() - _aspInfoFetchedAt < ASP_INFO_TTL) {
    return _cachedAspInfo;
  }
  try {
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return _cachedAspInfo;
    const info = await resp.json();
    _cachedAspInfo = info;
    _aspInfoFetchedAt = Date.now();
    return info;
  } catch {
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

// VTXO renewal: default 3 days before expiry (matches Arkade SDK default)
const DEFAULT_RENEWAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

let _sdk: typeof import("@arkade-os/sdk") | null = null;

async function getSDK() {
  if (!_sdk) {
    _sdk = await import("@arkade-os/sdk");
    await registerArkadeOpcodes();
  }
  return _sdk;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}

const WALLET_CONNECT_TIMEOUT = 30_000;
const WALLET_MAX_RETRIES = 2;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function initArkWallet(privateKeyHex: string): Promise<ArkWallet> {
  const { SingleKey, Wallet } = await getSDK();
  console.log("[ark] SDK loaded, connecting to:", ARK_SERVER_URL);
  const identity = SingleKey.fromHex(privateKeyHex);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= WALLET_MAX_RETRIES; attempt++) {
    try {
      console.log(`[ark] Wallet.create attempt ${attempt}/${WALLET_MAX_RETRIES}...`);
      const wallet = await withTimeout(
        Wallet.create({
          identity,
          arkServerUrl: ARK_SERVER_URL,
          esploraUrl: ESPLORA_URL,
        }),
        WALLET_CONNECT_TIMEOUT,
        "Wallet.create",
      );
      console.log("[ark] Wallet created successfully");
      return wallet;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[ark] Attempt ${attempt} failed:`, lastError.message);
      if (attempt < WALLET_MAX_RETRIES) {
        console.log("[ark] Retrying in 2s...");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError ?? new Error("Ark wallet connection failed");
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collaborativeExit(wallet: any, address: string, amountSats: number): Promise<string> {
  const { Ramps } = await getSDK();
  const ramps = new Ramps(wallet);
  const info = await wallet.arkProvider.getInfo();

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
    (event: any) => console.log("[collaborative-exit]", event),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const earliestExpiry = Math.min(...vtxos.map((v: any) => v.virtualStatus?.batchExpiry ?? Infinity));
    if (!earliestExpiry || earliestExpiry === Infinity) return 24;

    const expiresInHours = (earliestExpiry * 1000 - Date.now()) / (3600 * 1000);
    const waitHours = Math.max(1, Math.ceil(expiresInHours - gapHours));
    return waitHours;
  } catch {
    return 24;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendPayment(wallet: any, address: string, amountSats: number): Promise<string> {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDustAmount(wallet: any): number {
  return Number(wallet.dustAmount ?? 0);
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
 * Issue a new token on Ark using the official SDK protocol.
 *
 * The Ark server requires ALL outputs to have amount >= dustAmount (including
 * OP_RETURN). The SDK's Packet.txOut() returns amount=0 which the server
 * rejects. We monkey-patch buildAndSubmitOffchainTx to lift the packet output
 * to dustAmount and deduct it from the main output, then delegate to
 * wallet.assetManager.issue() which handles coin selection and passthrough
 * groups correctly.
 *
 * Official reissuable token flow (two separate calls from create/page.tsx):
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

  const dustAmt = BigInt(Number(wallet.dustAmount));

  // Monkey-patch buildAndSubmitOffchainTx to fix the packet output amount.
  // The SDK builds outputs as [mainOutput(fullSats), packetOutput(0sats)].
  // The Ark server rejects amount=0 on OP_RETURN outputs, so we move dustAmt
  // from the main output to the packet output.
  const origBuildAndSubmit = wallet.buildAndSubmitOffchainTx.bind(wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet.buildAndSubmitOffchainTx = async (inputs: any[], outputs: any[]) => {
    // Find the OP_RETURN (packet) output — it has a script starting with 0x6a
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const packetIdx = outputs.findIndex((o: any) => o.script?.[0] === 0x6a || o.amount === 0n);
    if (packetIdx >= 0 && outputs[packetIdx].amount === 0n) {
      // Find the first non-OP_RETURN output (BTC change) to deduct from
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mainIdx = outputs.findIndex((_: any, i: number) => i !== packetIdx);
      if (mainIdx >= 0 && outputs[mainIdx].amount >= dustAmt * 2n) {
        outputs = outputs.map((o, i) => {
          if (i === packetIdx) return { ...o, amount: dustAmt };
          if (i === mainIdx) return { ...o, amount: o.amount - dustAmt };
          return o;
        });
        console.log("[ark] issueToken: patched packet output to %d, main=%d", Number(dustAmt), Number(outputs[mainIdx].amount));
      }
    }
    return origBuildAndSubmit(inputs, outputs);
  };

  try {
    // Build metadata object for the SDK (it expects a plain object, not Metadata[])
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

    console.log("[ark] issueToken: amount=%d, controlAssetId=%s, metadata=%o", amount, controlAssetId, metadata);

    const result = await wallet.assetManager.issue({
      amount,
      ...(controlAssetId && { controlAssetId }),
      ...(metadata && { metadata }),
    });

    console.log("[ark] issueToken: success! txid=%s, assetId=%s", result.arkTxId, result.assetId);
    return { arkTxId: result.arkTxId, assetId: result.assetId };
  } finally {
    wallet.buildAndSubmitOffchainTx = origBuildAndSubmit;
  }
}

/**
 * Reissue (mint more) tokens for a reissuable asset.
 * Requires the caller to hold the control asset VTXO.
 *
 * Applies the same OP_RETURN amount monkey-patch as issueToken — the Ark server
 * rejects amount=0 on the packet output that assetManager.reissue() produces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reissueToken(wallet: any, assetId: string, amount: number): Promise<string> {
  const dustAmt = BigInt(Number(wallet.dustAmount));
  const origBuildAndSubmit = wallet.buildAndSubmitOffchainTx.bind(wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet.buildAndSubmitOffchainTx = async (inputs: any[], outputs: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const packetIdx = outputs.findIndex((o: any) => o.script?.[0] === 0x6a || o.amount === 0n);
    if (packetIdx >= 0 && outputs[packetIdx].amount === 0n) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mainIdx = outputs.findIndex((_: any, i: number) => i !== packetIdx);
      if (mainIdx >= 0 && outputs[mainIdx].amount >= dustAmt * 2n) {
        outputs = outputs.map((o, i) => {
          if (i === packetIdx) return { ...o, amount: dustAmt };
          if (i === mainIdx) return { ...o, amount: o.amount - dustAmt };
          return o;
        });
        console.log("[ark] reissueToken: patched packet output to %d", Number(dustAmt));
      }
    }
    return origBuildAndSubmit(inputs, outputs);
  };
  try {
    return await wallet.assetManager.reissue({ assetId, amount });
  } finally {
    wallet.buildAndSubmitOffchainTx = origBuildAndSubmit;
  }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const utxo of boardingUtxos) {
    results.push({ type: "boarding", value: utxo.value, confirmed: utxo.status.confirmed });
  }
  const vtxos = await wallet.getVtxos({ withRecoverable: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const vtxo of vtxos) {
    results.push({
      type: "vtxo", value: vtxo.value, confirmed: true,
      state: vtxo.virtualStatus.state, batchExpiry: vtxo.virtualStatus.batchExpiry,
    });
  }
  return results;
}

// Minimum sats required to attempt boarding settlement (dust + fee headroom)
const MIN_SETTLE_SATS = 1_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function settleVtxos(wallet: any): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boardingUtxos = (await wallet.getBoardingUtxos()).filter((u: any) => u.status.confirmed);
  if (boardingUtxos.length === 0) throw new Error("No confirmed UTXOs to settle");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = boardingUtxos.reduce((sum: number, u: any) => sum + u.value, 0);
  if (total < MIN_SETTLE_SATS) {
    throw new Error(`Boarding balance too low to settle: ${total} sats (need >= ${MIN_SETTLE_SATS})`);
  }

  console.log("[settleVtxos] %d boarding UTXOs = %d sats", boardingUtxos.length, total);

  // Use SDK's Ramps.onboard() — it properly handles fee deduction via the
  // Estimator (CEL expressions) and filters out UTXOs where fee >= value.
  const { Ramps } = await getSDK();
  const ramps = new Ramps(wallet);
  const info = await wallet.arkProvider.getInfo();

  const txid = await withTimeout(
    ramps.onboard(
      info.fees,
      boardingUtxos,
      undefined, // onboard full amount
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event: any) => console.log("[onboard]", event),
    ),
    SETTLE_TIMEOUT,
    "settleVtxos (onboard)",
  );
  return txid;
}

/** Finalize any pending (preconfirmed) transactions. Non-destructive no-op if none exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function finalizePending(wallet: any): Promise<{ finalized: string[]; pending: string[] }> {
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
  // Collect confirmed boarding UTXOs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boardingUtxos = (await wallet.getBoardingUtxos()).filter((u: any) => u.status.confirmed);

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
  console.log("[settleAll] %d boarding + %d preconfirmed = %d sats", boardingUtxos.length, preconfirmed.length, total);

  const settlePromise = wallet.settle(
    {
      inputs,
      outputs: [{ address: arkAddress, amount: BigInt(total) }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[settleAll]", event),
  );

  const txid = await withTimeout<string>(settlePromise, SETTLE_TIMEOUT, "settleAll");
  return txid;
}

// ── Non-interactive swap offers (Arkade Script) ──────────────────────────────
//
// WHY THIS IS HAND-ASSEMBLED:
//
// Arkade provides a high-level contract language (docs.arkadeos.com/experimental/arkade-syntax)
// that compiles to Bitcoin Taproot scripts via the `arkadec` CLI compiler. The swap contract
// we need looks like this in Arkade Script:
//
//   contract Swap(pubkey maker, int amount, int expiryTime) {
//     function swap(sig takerSig, pubkey taker) {
//       require(tx.outputs[0].value >= amount);
//       require(tx.outputs[0].scriptPubKey == new P2PKH(maker));
//       require(checkSig(takerSig, taker));
//     }
//     function cancel(sig makerSig) {
//       require(tx.time >= expiryTime);
//       require(checkSig(makerSig, maker));
//     }
//   }
//
// However, the compiler (`arkadec`) is currently a CLI-only tool — there is no TypeScript API
// to compile contracts at runtime. The compiler translates `tx.outputs[0].value` into the
// OP_INSPECTOUTPUTVALUE (0xCF) opcode, etc., but we can't call it from the browser.
//
// Additionally, the SDK's `VtxoScript` constructor calls `@scure/btc-signer`'s `p2tr()`,
// which internally runs `Script.decode()` on the leaf bytes. That parser doesn't recognise
// Arkade's custom OP_SUCCESS opcodes (0xCF, 0xD1, 0xDF) and throws "Unknown opcode=cf".
//
// So we:
//   1. Hand-assemble the swap leaf bytes (the same output `arkadec` would produce)
//   2. Build the Taproot tree manually using low-level crypto primitives (tapLeafHash,
//      taprootTweakPubkey) instead of going through VtxoScript/p2tr
//
// DEPRECATION: Once the Arkade compiler is available as a TypeScript library, this entire
// section (opcode constants, manual byte assembly, manual taproot tree construction) should
// be replaced with:
//   const compiled = arkadec.compile(swapContract, { maker, amount, expiryTime });
//   const vtxoScript = new VtxoScript(compiled.scripts);
// ──────────────────────────────────────────────────────────────────────────────

// Arkade introspection opcodes — confirmed at docs.arkadeos.com/experimental/arkade-script
// These map to the OP_SUCCESS range in Tapscript (BIP 342). Standard Bitcoin nodes treat them
// as unconditional success; the Arkade ASP's custom interpreter actually evaluates them.
// @deprecated — remove when arkadec TypeScript compiler is available
const OP_INSPECTOUTPUTVALUE        = 0xCF; // OP_SUCCESS207 — push output[i].value as 8-byte LE64
const OP_INSPECTOUTPUTSCRIPTPUBKEY = 0xD1; // OP_SUCCESS209 — push output[i].scriptPubKey (34 bytes P2TR)
const OP_GREATERTHANOREQUAL64      = 0xDF; // OP_SUCCESS223 — pop two LE64, push 1 if b >= a
const OP_VERIFY                    = 0x69; // standard Bitcoin opcode
const OP_EQUAL                     = 0x87; // standard Bitcoin opcode
const OP_CHECKSIG                  = 0xAC; // standard Tapscript CHECKSIG (BIP 342)

// Register Arkade opcodes with @scure/btc-signer so Script.decode() doesn't throw
// "Unknown opcode=cf" when the SDK's VtxoScript.decode() parses our swap leaf scripts.
// OPNames is a plain JS object (reverse map of OP) — adding entries makes Script.decode
// return opcode name strings instead of throwing. OP entries enable Script.encode round-trip.
// @deprecated — remove when the SDK natively handles Arkade Script opcodes
let _arkadeOpcodesRegistered = false;
async function registerArkadeOpcodes(): Promise<void> {
  if (_arkadeOpcodesRegistered) return;
  const { OP: btcOP, OPNames: btcOPNames } = await import("@scure/btc-signer/script.js");
  const arkadeOps: Record<string, number> = {
    OP_INSPECTINPUTVALUE:         0xCA,
    OP_INSPECTINPUTSCRIPTPUBKEY:  0xCB,
    OP_INSPECTINPUTASSET:         0xCC,
    OP_INSPECTINPUTNONCE:         0xCD,
    OP_INSPECTOUTPUTASSET:        0xCE,
    OP_INSPECTOUTPUTVALUE:        0xCF,
    OP_INSPECTOUTPUTNONCE:        0xD0,
    OP_INSPECTOUTPUTSCRIPTPUBKEY: 0xD1,
    OP_ADD64:                     0xDC,
    OP_SUB64:                     0xDD,
    OP_LESSTHAN64:                0xDE,
    OP_GREATERTHANOREQUAL64:      0xDF,
  };
  for (const [name, byte] of Object.entries(arkadeOps)) {
    (btcOP as Record<string, number>)[name] = byte;
    (btcOPNames as Record<number, string>)[byte] = name;
  }
  _arkadeOpcodesRegistered = true;
}

// @deprecated — remove when arkadec TypeScript compiler is available
export function encodeLE64(n: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

interface SwapScriptParams {
  makerPkScript: Uint8Array;     // 34-byte P2TR scriptPubKey (from ArkAddress.decode().pkScript)
  makerXOnlyPubkey: Uint8Array;  // 32-byte x-only pubkey for cancel leaf
  satAmount: number;
  expiresAt: number;             // unix seconds, CLTV absolute locktime
}

// Manual taproot tree result — replaces VtxoScript which can't handle Arkade opcodes.
// @deprecated — replace with VtxoScript once the SDK supports custom opcodes or the
// arkadec compiler provides a TypeScript API.
interface SwapScriptResult {
  leaves: [TapLeafScript, TapLeafScript]; // [swapLeaf, cancelLeaf]
  tweakedPublicKey: Uint8Array;
  scripts: [Uint8Array, Uint8Array];      // raw script bytes
  encode(): Uint8Array;                   // TapTree serialization for wallet.settle
  address(prefix: string, serverPubKey: Uint8Array): ArkAddress;
}

type TapLeafScript = [
  { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] },
  Uint8Array,
];
type ArkAddress = { encode(): string };

/**
 * Build a 2-leaf taproot script for non-interactive swap.
 *
 * This is the hand-assembled equivalent of what the Arkade compiler (`arkadec`) would
 * produce from the Swap contract above. We construct the swap leaf as raw bytes because
 * @scure/btc-signer's Script.encode/decode doesn't support the Arkade opcodes, and we
 * build the taproot tree manually because VtxoScript's constructor calls p2tr() which
 * internally validates scripts through Script.decode().
 *
 * @deprecated — replace with arkadec TypeScript compiler when available
 */
async function buildSwapScript(params: SwapScriptParams): Promise<SwapScriptResult> {
  const sdk = await getSDK();
  const { ArkAddress: ArkAddr, TapTreeCoder } = sdk;
  const btc = await import("@scure/btc-signer");
  const { tapLeafHash, TAP_LEAF_VERSION } = await import("@scure/btc-signer/payment.js");
  const { taprootTweakPubkey, TAPROOT_UNSPENDABLE_KEY, concatBytes, tagSchnorr, compareBytes } = await import("@scure/btc-signer/utils.js");
  const { makerPkScript, makerXOnlyPubkey, satAmount, expiresAt } = params;

  const satAmountLE64 = encodeLE64(satAmount);

  // ── Swap leaf (hand-assembled) ──────────────────────────────────────────
  // This is what `arkadec` would compile from:
  //   function swap(sig takerSig, pubkey taker) {
  //     require(tx.outputs[0].value >= amount);         → OP_0 OP_INSPECTOUTPUTVALUE <amount> OP_GTE64 OP_VERIFY
  //     require(tx.outputs[0].scriptPubKey == maker);   → OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY <pkScript> OP_EQUAL OP_VERIFY
  //     require(checkSig(takerSig, taker));             → OP_CHECKSIG
  //   }
  const swapLeafBytes = new Uint8Array([
    0x00,                            // OP_0 — push output index 0
    OP_INSPECTOUTPUTVALUE,           // 0xCF — pushes output[0].value as 8-byte LE64 onto stack
    0x08,                            // push next 8 bytes (the required sat amount)
    ...satAmountLE64,                // required sat amount as 8-byte little-endian
    OP_GREATERTHANOREQUAL64,         // 0xDF — pops two LE64 values, pushes 1 if output >= required
    OP_VERIFY,                       // 0x69 — abort if top of stack is not truthy
    0x00,                            // OP_0 — push output index 0
    OP_INSPECTOUTPUTSCRIPTPUBKEY,    // 0xD1 — pushes output[0].scriptPubKey (34 bytes P2TR)
    0x22,                            // push next 34 bytes (the maker's P2TR scriptPubKey)
    ...makerPkScript,                // maker's P2TR scriptPubKey (0x5120 + 32-byte x-only pubkey)
    OP_EQUAL,                        // 0x87 — check that the output goes to the maker
    OP_VERIFY,                       // 0x69 — abort if not equal
    OP_CHECKSIG,                     // 0xAC — taker provides [sig, pubkey] in witness; sig binds
                                     //        to the full transaction, preventing front-running
  ]);

  // ── Cancel leaf (standard Bitcoin opcodes — can use Script.encode) ─────
  // This is what `arkadec` would compile from:
  //   function cancel(sig makerSig) {
  //     require(tx.time >= expiryTime);       → <expiryTime> CHECKLOCKTIMEVERIFY DROP
  //     require(checkSig(makerSig, maker));   → <makerPubkey> CHECKSIG
  //   }
  const cancelLeafBytes = btc.Script.encode([
    expiresAt,
    "CHECKLOCKTIMEVERIFY",
    "DROP",
    makerXOnlyPubkey,
    "CHECKSIG",
  ]);

  // ── Manual taproot tree construction ────────────────────────────────────
  // We can't use `new VtxoScript([swapLeaf, cancelLeaf])` because its constructor
  // calls `p2tr()` → `taprootHashTree()` → `checkTaprootScript()` → `Script.decode()`
  // which throws "Unknown opcode=cf" on the Arkade opcodes.
  //
  // Instead we compute the taproot tree directly:
  //   1. tapLeafHash — just a tagged SHA256, doesn't parse opcodes
  //   2. tapBranchHash — tagged SHA256 of sorted leaf hashes
  //   3. taprootTweakPubkey — tweaks the unspendable internal key with the merkle root
  //
  // @deprecated — replace with `new VtxoScript(scripts)` once the SDK supports custom opcodes

  const scripts: [Uint8Array, Uint8Array] = [swapLeafBytes, cancelLeafBytes];
  const version = TAP_LEAF_VERSION; // 0xC0
  const internalKey = TAPROOT_UNSPENDABLE_KEY;

  const leafHash0 = tapLeafHash(swapLeafBytes, version);
  const leafHash1 = tapLeafHash(cancelLeafBytes, version);

  let [lH, rH] = [leafHash0, leafHash1];
  if (compareBytes(rH, lH) === -1) [lH, rH] = [rH, lH];
  const branchHash = tagSchnorr("TapBranch", lH, rH);

  const [tweakedPubkey, parity] = taprootTweakPubkey(internalKey, branchHash);

  const leaf0: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash1] },
    concatBytes(swapLeafBytes, new Uint8Array([version])),
  ];
  const leaf1: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash0] },
    concatBytes(cancelLeafBytes, new Uint8Array([version])),
  ];

  return {
    leaves: [leaf0, leaf1],
    tweakedPublicKey: tweakedPubkey,
    scripts,
    encode(): Uint8Array {
      return TapTreeCoder.encode(
        scripts.map((s) => ({ depth: 1, version, script: s }))
      );
    },
    address(prefix: string, serverPubKey: Uint8Array): ArkAddress {
      return new ArkAddr(serverPubKey, tweakedPubkey, prefix);
    },
  };
}

/**
 * Decode a serialized TapTree (from offer.swapScriptHex) back into a SwapScriptResult.
 * Same manual taproot construction as buildSwapScript, same reason — bypasses VtxoScript.
 *
 * @deprecated — replace with `VtxoScript.decode(bytes)` once the SDK supports custom opcodes
 */
async function decodeSwapScript(tapTreeBytes: Uint8Array): Promise<SwapScriptResult> {
  const sdk = await getSDK();
  const { ArkAddress: ArkAddr, TapTreeCoder } = sdk;
  const { tapLeafHash, TAP_LEAF_VERSION } = await import("@scure/btc-signer/payment.js");
  const { taprootTweakPubkey, TAPROOT_UNSPENDABLE_KEY, concatBytes, tagSchnorr, compareBytes } = await import("@scure/btc-signer/utils.js");

  const leaves = TapTreeCoder.decode(tapTreeBytes);
  if (leaves.length !== 2) throw new Error(`Expected 2 leaves, got ${leaves.length}`);

  const scripts: [Uint8Array, Uint8Array] = [leaves[0].script, leaves[1].script];
  const version = TAP_LEAF_VERSION;
  const internalKey = TAPROOT_UNSPENDABLE_KEY;

  const leafHash0 = tapLeafHash(scripts[0], version);
  const leafHash1 = tapLeafHash(scripts[1], version);

  let [lH, rH] = [leafHash0, leafHash1];
  if (compareBytes(rH, lH) === -1) [lH, rH] = [rH, lH];
  const branchHash = tagSchnorr("TapBranch", lH, rH);

  const [tweakedPubkey, parity] = taprootTweakPubkey(internalKey, branchHash);

  const leaf0: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash1] },
    concatBytes(scripts[0], new Uint8Array([version])),
  ];
  const leaf1: TapLeafScript = [
    { version: version + parity, internalKey, merklePath: [leafHash0] },
    concatBytes(scripts[1], new Uint8Array([version])),
  ];

  return {
    leaves: [leaf0, leaf1],
    tweakedPublicKey: tweakedPubkey,
    scripts,
    encode(): Uint8Array {
      return TapTreeCoder.encode(
        scripts.map((s) => ({ depth: 1, version, script: s }))
      );
    },
    address(prefix: string, serverPubKey: Uint8Array): ArkAddress {
      return new ArkAddr(serverPubKey, tweakedPubkey, prefix);
    },
  };
}

export interface SwapOfferParams {
  assetId: string;
  tokenAmount: number;
  satAmount: number;
  expiresInSeconds?: number;  // default 3600
}

export interface SwapOffer {
  offerOutpoint: string;    // "txid:vout" — the swap VTXO IS the offer identity
  assetId: string;
  tokenAmount: number;
  satAmount: number;
  vtxoSatsValue: number;    // sats value of the swap VTXO (dust amount, e.g. 330)
  makerArkAddress: string;
  makerPkScript: string;    // hex 34 bytes
  makerXOnlyPubkey: string; // hex 32 bytes
  swapScriptHex: string;    // hex of VtxoScript.encode() — taker reconstructs from this
  expiresAt: number;
}

/**
 * Create a non-interactive swap offer by sending tokens to a swap script VTXO.
 * The swap script encodes conditions via Arkade Script introspection opcodes.
 * Any taker can fill by satisfying the script — no ASP coordination needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createSwapOffer(wallet: any, params: SwapOfferParams): Promise<SwapOffer> {
  const { ArkAddress } = await getSDK();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (params.expiresInSeconds ?? 3600);

  const makerArkAddress = await wallet.getAddress();
  const decodedAddr = ArkAddress.decode(makerArkAddress);
  const makerPkScript: Uint8Array = decodedAddr.pkScript; // 34-byte P2TR scriptPubKey

  // Extract x-only pubkey from wallet identity (SingleKey.xOnlyPublicKey() is async)
  const makerXOnlyPubkey: Uint8Array = await wallet.identity.xOnlyPublicKey();

  const vtxoScript = await buildSwapScript({ makerPkScript, makerXOnlyPubkey, satAmount: params.satAmount, expiresAt });

  // Derive the swap script's Ark address
  const aspInfo = await wallet.arkProvider.getInfo();
  const aspPubkeyHex: string = aspInfo.signerPubkey ?? aspInfo.pubkey;
  let aspPubkeyBytes = hexToBytes(aspPubkeyHex);
  if (aspPubkeyBytes.length === 33) aspPubkeyBytes = aspPubkeyBytes.slice(1); // x-only
  const network: string = aspInfo.network ?? "tb";
  const swapArkAddress = vtxoScript.address(network, aspPubkeyBytes).encode();

  // Transfer tokens to the swap script address (wallet handles coin selection)
  const arkTxId = await wallet.send({
    address: swapArkAddress,
    amount: 0,
    assets: [{ assetId: params.assetId, amount: params.tokenAmount }],
  });

  const offerOutpoint = `${arkTxId}:0`;
  // The VTXO's sats value is the ASP's dust amount (e.g. 330 sats)
  const vtxoSatsValue = Number(wallet.dustAmount ?? 330);

  return {
    offerOutpoint,
    assetId: params.assetId,
    tokenAmount: params.tokenAmount,
    satAmount: params.satAmount,
    vtxoSatsValue,
    makerArkAddress,
    makerPkScript: bytesToHex(makerPkScript),
    makerXOnlyPubkey: bytesToHex(makerXOnlyPubkey),
    swapScriptHex: bytesToHex(vtxoScript.encode()),
    expiresAt,
  };
}

/**
 * Fill a swap offer as taker.
 * Spends the swap VTXO via the introspection leaf — sends sats to maker, receives tokens.
 * Arkade opcodes are registered in OPNames (via registerArkadeOpcodes) so the SDK's
 * VtxoScript.decode() → p2tr() → Script.decode() chain works without throwing.
 */
export async function fillSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  await registerArkadeOpcodes();
  const vtxoScript = await decodeSwapScript(hexToBytes(offer.swapScriptHex));
  const swapLeaf = vtxoScript.leaves[0];   // swap leaf (introspection + taker CHECKSIG)
  const cancelLeaf = vtxoScript.leaves[1]; // cancel leaf (CLTV + maker sig)

  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330; // dust amount from offer

  const swapVtxo = {
    txid,
    vout,
    value: vtxoSatsValue,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
    tapTree: vtxoScript.encode(),
    intentTapLeafScript: swapLeaf,    // the spend path for taker
    forfeitTapLeafScript: cancelLeaf, // fallback for ASP
  };

  return wallet.settle(
    {
      inputs: [swapVtxo],
      outputs: [{ address: offer.makerArkAddress, amount: BigInt(offer.satAmount) }],
    },
    eventCallback ?? ((event: unknown) => console.log("[fillSwapOffer]", event)),
  );
}

/**
 * Cancel a swap offer as maker (after expiry). Spends via the CLTV cancel leaf.
 */
export async function cancelSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  await registerArkadeOpcodes();
  const vtxoScript = await decodeSwapScript(hexToBytes(offer.swapScriptHex));
  const swapLeaf = vtxoScript.leaves[0];
  const cancelLeaf = vtxoScript.leaves[1];

  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330;

  const swapVtxo = {
    txid,
    vout,
    value: vtxoSatsValue,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
    tapTree: vtxoScript.encode(),
    intentTapLeafScript: cancelLeaf,  // maker uses cancel leaf
    forfeitTapLeafScript: swapLeaf,
  };

  return wallet.settle(
    {
      inputs: [swapVtxo],
      outputs: [{ address: offer.makerArkAddress, amount: BigInt(vtxoSatsValue) }],
    },
    eventCallback ?? ((event: unknown) => console.log("[cancelSwapOffer]", event)),
  );
}

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const v of vtxos.slice(0, 5)) {
      console.log(`[ark]   VTXO ${v.txid}:${v.vout} value=${v.value} spent=${v.isSpent} assets=`, v.assets);
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

/** Get details for a specific asset (balance from getBalance, metadata from indexer) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAssetDetails(wallet: any, assetId: string): Promise<AssetDetails | null> {
  try {
    // Get amount from balance
    const balance = await wallet.getBalance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const held = balance.assets?.find((a: any) => a.assetId === assetId);
    if (!held) return null;

    // Try to get metadata from the indexer
    let name: string | undefined;
    let ticker: string | undefined;
    try {
      const details = await wallet.assetManager.getAssetDetails(assetId);
      name = details?.metadata?.name;
      ticker = details?.metadata?.ticker;
    } catch {
      // Indexer metadata is optional
    }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sample = vtxos.find((v: any) =>
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
  const dustAmount = Number(wallet.dustAmount ?? 0);

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

  // Also grab confirmed boarding UTXOs to consolidate in the same round
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boardingUtxos = (await wallet.getBoardingUtxos()).filter((u: any) => u.status.confirmed);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any[] = [...expiringVtxos, ...boardingUtxos];
  if (inputs.length === 0) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalAmount = inputs.reduce((sum: number, input: any) => sum + input.value, 0);
  const dustAmount = Number(wallet.dustAmount ?? 0);

  if (totalAmount < dustAmount) {
    console.log("[ark] Renewal skipped: total %d sats below dust %d", totalAmount, dustAmount);
    return null;
  }

  const arkAddress = await wallet.getAddress();
  console.log(
    "[ark] Renewing %d VTXOs + %d boarding UTXOs (%d sats total)",
    expiringVtxos.length, boardingUtxos.length, totalAmount
  );

  const txid = await wallet.settle(
    {
      inputs,
      outputs: [{ address: arkAddress, amount: BigInt(totalAmount) }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[renewal]", event),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vtxos
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((v: any) => v.virtualStatus?.state === "settled" && !v.isUnrolled)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((v: any) => ({
      type: "vtxo" as const,
      value: v.value,
      confirmed: true,
      state: v.virtualStatus.state,
      batchExpiry: v.virtualStatus.batchExpiry,
    }));
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function unilateralExit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  privateKeyHex: string,
  vtxoTxid: string,
  vtxoVout: number = 0,
  onStep?: (step: UnilateralExitStep) => void,
): Promise<string> {
  const sdk = await getSDK();
  const { Unroll, OnchainWallet, SingleKey } = sdk;

  // Determine network name from ARK_SERVER_URL
  const networkName = ARK_SERVER_URL.includes("mutinynet") ? "mutinynet"
    : ARK_SERVER_URL.includes("signet") ? "signet"
    : "bitcoin";

  // Create OnchainWallet for P2A anchor fee bumping
  const identity = SingleKey.fromHex(privateKeyHex);
  const onchainWallet = await OnchainWallet.create(identity, networkName);

  // Create unroll session for this VTXO
  const outpoint = { txid: vtxoTxid, vout: vtxoVout };
  const session = await Unroll.Session.create(
    outpoint,
    onchainWallet,            // AnchorBumper
    onchainWallet.provider,   // OnchainProvider (esplora)
    wallet.indexerProvider,   // IndexerProvider
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function completeUnilateralExit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  vtxoTxids: string[],
  destinationAddress: string,
): Promise<string> {
  const sdk = await getSDK();
  const { Unroll } = sdk;

  console.log("[ark] Completing unilateral exit for %d VTXOs to %s", vtxoTxids.length, destinationAddress);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vtxos
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((v: any) => v.isUnrolled === true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((v: any) => ({
      type: "vtxo" as const,
      value: v.value,
      confirmed: true,
      state: "unrolled",
      batchExpiry: v.virtualStatus?.batchExpiry,
    }));
}
