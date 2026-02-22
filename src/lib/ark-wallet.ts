// We use dynamic import because Turbopack (Next.js 16) breaks @arkade-os/sdk
// when bundling it statically. The dynamic import ensures it loads correctly
// in the browser at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArkWallet = any;

export const ARK_SERVER_URL = process.env.NEXT_PUBLIC_ARK_SERVER_URL || "https://arkade.computer";
const ESPLORA_URL = process.env.NEXT_PUBLIC_ESPLORA_URL || "https://mempool.space/api";

export const ONCHAIN_FEE_SATS = 200;

let _sdk: typeof import("@arkade-os/sdk") | null = null;

async function getSDK() {
  if (!_sdk) {
    _sdk = await import("@arkade-os/sdk");
  }
  return _sdk;
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
  console.log("[ark] SDK loaded, creating wallet...");
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendPayment(wallet: any, address: string, amountSats: number): Promise<string> {
  if (isBtcAddress(address)) {
    const totalNeeded = amountSats + ONCHAIN_FEE_SATS;
    const vtxos = await wallet.getVtxos();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = [...vtxos].sort((a: any, b: any) => (a.virtualStatus.batchExpiry ?? 0) - (b.virtualStatus.batchExpiry ?? 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selected: any[] = [];
    let total = 0;
    for (const v of sorted) {
      selected.push(v);
      total += v.value;
      if (total >= totalNeeded) break;
    }
    if (total < totalNeeded) throw new Error("Insufficient balance (amount + 200 sats network fee)");

    const outputs: { address: string; amount: bigint }[] = [
      { address, amount: BigInt(amountSats) },
    ];
    const change = total - totalNeeded;
    if (change > 0) {
      const changeAddr = await wallet.getAddress();
      outputs.push({ address: changeAddr, amount: BigInt(change) });
    }

    const txid = await wallet.settle(
      { inputs: selected, outputs },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event: any) => console.log("[collaborative-exit]", event)
    );
    return txid;
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
  name: string;
  ticker: string;
  decimals?: number;
  icon?: string;
}

export interface IssueTokenResult {
  arkTxId: string;
  assetId: string;
}

/**
 * Issue a new token on Ark.
 *
 * We replicate the SDK's assetManager.issue() logic manually because the
 * mainnet Ark server requires ALL outputs to have amount >= dustAmount,
 * including OP_RETURN. The SDK's Packet.txOut() returns amount=0 which
 * the server rejects. We set the packet output to dustAmount instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function issueToken(wallet: any, params: IssueTokenParams): Promise<IssueTokenResult> {
  const { amount, name, ticker, decimals, icon } = params;
  if (amount <= 0) throw new Error("Amount must be greater than 0");

  const sdk = await getSDK();
  const { AssetGroup, AssetOutput, AssetId, Packet, Metadata } = sdk.asset;
  const { ArkAddress } = sdk;

  // Build metadata using proper Metadata.create(keyBytes, valueBytes) objects
  const enc = new TextEncoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata: any[] = [
    Metadata.create(enc.encode("name"), enc.encode(name)),
    Metadata.create(enc.encode("ticker"), enc.encode(ticker)),
  ];
  if (decimals !== undefined) {
    metadata.push(Metadata.create(enc.encode("decimals"), enc.encode(String(decimals))));
  }
  if (icon) {
    metadata.push(Metadata.create(enc.encode("icon"), enc.encode(icon)));
  }

  // Coin selection: need 2*dustAmount (main output + packet output both >= dust)
  const vtxos = await wallet.getVtxos({ withRecoverable: false });
  const dustAmt = Number(wallet.dustAmount);
  const minRequired = dustAmt * 2;

  console.log("[ark] issueToken: dustAmount=%d, minRequired=%d, vtxos=%d", dustAmt, minRequired, vtxos.length);

  // Sort by expiry (ascending), then value (descending) — same as SDK
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sorted = [...vtxos].sort((a: any, b: any) => {
    const expiryA = a.virtualStatus?.batchExpiry || Number.MAX_SAFE_INTEGER;
    const expiryB = b.virtualStatus?.batchExpiry || Number.MAX_SAFE_INTEGER;
    if (expiryA !== expiryB) return expiryA - expiryB;
    return b.value - a.value;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectedInputs: any[] = [];
  let selectedAmount = 0;
  for (const coin of sorted) {
    selectedInputs.push(coin);
    selectedAmount += coin.value;
    if (selectedAmount >= minRequired) break;
  }
  if (selectedAmount < minRequired) {
    throw new Error(`Not enough sats: need ${minRequired}, have ${selectedAmount}`);
  }

  console.log("[ark] issueToken: selected %d inputs, total %d sats", selectedInputs.length, selectedAmount);

  // Build asset packet
  const issuedAssetOutput = AssetOutput.create(0, BigInt(amount));
  const issuedAssetGroup = AssetGroup.create(null, null, [], [issuedAssetOutput], metadata);
  const packet = Packet.create([issuedAssetGroup]);
  const packetOut = packet.txOut();

  // Ark server requires amount >= dustAmount for ALL outputs (including OP_RETURN).
  // Assign dustAmount to the packet output, rest to main output.
  const packetAmount = BigInt(dustAmt);
  const mainAmount = BigInt(selectedAmount) - packetAmount;

  const address = await wallet.getAddress();
  const outputAddress = ArkAddress.decode(address);

  const outputs = [
    { script: outputAddress.pkScript, amount: mainAmount },
    { ...packetOut, amount: packetAmount },
  ];

  console.log("[ark] issueToken: submitting tx (main=%d, packet=%d)", Number(mainAmount), Number(packetAmount));

  const { arkTxid } = await wallet.buildAndSubmitOffchainTx(selectedInputs, outputs);
  const assetId = AssetId.create(arkTxid, 0).toString();

  console.log("[ark] issueToken: success! txid=%s, assetId=%s", arkTxid, assetId);

  return { arkTxId: arkTxid, assetId };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any[] = [...boardingUtxos];
  if (inputs.length === 0) throw new Error("No confirmed UTXOs to settle");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = inputs.reduce((sum: number, input: any) => sum + input.value, 0);
  if (total < MIN_SETTLE_SATS) {
    throw new Error(`Boarding balance too low to settle: ${total} sats (need >= ${MIN_SETTLE_SATS})`);
  }

  // Use settle() without explicit outputs — let the SDK handle fee deduction
  // and route all funds to our off-chain address automatically
  const txid = await wallet.settle(
    { inputs },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[settle]", event)
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
 * Settle ALL preconfirmed VTXOs (and boarding UTXOs) into an on-chain round.
 * Calls wallet.settle() with NO params, which collects everything and joins
 * the next Ark server round. This is a blocking call — it waits for the
 * server to run a round, so we wrap it with a timeout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function settleAll(wallet: any): Promise<string> {
  const settlePromise = wallet.settle(
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => console.log("[settleAll]", event),
  );

  const txid = await withTimeout<string>(settlePromise, SETTLE_TIMEOUT, "settleAll");
  return txid;
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
  const txid = await wallet.assetManager.send({
    address: recipientAddress,
    assetId,
    amount: assetAmount,
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
