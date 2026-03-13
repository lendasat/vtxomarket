/**
 * Swap offer lifecycle: create, fill, and cancel.
 *
 * - createSwapOffer(): Maker sends tokens to a swap script VTXO
 * - fillSwapOffer():   Taker buys tokens by co-signing via introspector
 * - cancelSwapOffer(): Maker reclaims tokens after CSV timelock expires
 *
 * All functions require an initialized ArkWallet (from initArkWallet).
 * fillSwapOffer requires the wallet's ArkProvider to be wrapped with
 * IntrospectorArkProvider (done automatically in initArkWallet when
 * NEXT_PUBLIC_INTROSPECTOR_URL is set).
 */

import { hex as scureHex } from "@scure/base";
import { buildSwapScript, decodeSwapScript } from "./script";
import { getIntrospectorInfo } from "./introspector-client";

const hexToBytes = scureHex.decode;
const bytesToHex = scureHex.encode;

// ── Types ─────────────────────────────────────────────────────────────────────

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
  swapScriptHex: string;    // hex of TapTree.encode() — taker reconstructs from this
  arkadeScriptHex: string;  // hex of standalone introspection conditions (PSBT custom field)
  expiresAt: number;
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a non-interactive swap offer by sending tokens to a swap script VTXO.
 * Uses the Arkade Introspector for condition validation and co-signing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createSwapOffer(wallet: any, params: SwapOfferParams): Promise<SwapOffer> {
  const { ArkAddress } = await import("@arkade-os/sdk");

  // Validate satAmount >= dust minimum
  const dustAmount = Number(wallet.dustAmount ?? 330);
  if (params.satAmount < dustAmount) {
    throw new Error(
      `satAmount (${params.satAmount}) is below the minimum VTXO dust amount (${dustAmount} sats). ` +
      `Set a price of at least ${dustAmount} sats.`
    );
  }

  // bip68 seconds must be a multiple of 512 — round up
  const rawSeconds = params.expiresInSeconds ?? 3600;
  const cancelSeconds = Math.ceil(rawSeconds / 512) * 512;

  const makerArkAddress = await wallet.getAddress();
  const decodedAddr = ArkAddress.decode(makerArkAddress);
  const makerPkScript: Uint8Array = decodedAddr.pkScript;
  const makerXOnlyPubkey: Uint8Array = await wallet.identity.xOnlyPublicKey();

  // Get ASP and introspector public keys
  const aspInfo = await wallet.arkProvider.getInfo();
  const aspPubkeyHex: string = aspInfo.signerPubkey ?? aspInfo.pubkey;
  let aspPubkeyBytes = hexToBytes(aspPubkeyHex);
  if (aspPubkeyBytes.length === 33) aspPubkeyBytes = aspPubkeyBytes.slice(1);

  const introspectorInfo = await getIntrospectorInfo();
  let introspectorPubkey = hexToBytes(introspectorInfo.signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const vtxoScript = await buildSwapScript({
    makerPkScript,
    makerXOnlyPubkey,
    satAmount: params.satAmount,
    cancelSeconds,
    introspectorPubkey,
    aspPubkey: aspPubkeyBytes,
  });

  // Derive the swap script's Ark address
  const network: string = aspInfo.network ?? "tb";
  const swapArkAddress = vtxoScript.address(network, aspPubkeyBytes).encode();

  // Transfer tokens to the swap script address
  const arkTxId = await wallet.send({
    address: swapArkAddress,
    amount: 0,
    assets: [{ assetId: params.assetId, amount: params.tokenAmount }],
  });

  const offerOutpoint = `${arkTxId}:0`;
  const vtxoSatsValue = Number(wallet.dustAmount ?? 330);

  // Compute approximate absolute expiry for UI display
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + cancelSeconds;

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
    arkadeScriptHex: bytesToHex(vtxoScript.arkadeScript),
    expiresAt,
  };
}

// ── Fill ──────────────────────────────────────────────────────────────────────

/**
 * Fill a swap offer as taker.
 * Uses the introspector to co-sign the MultisigClosure swap leaf.
 * The ArkProvider must be wrapped with IntrospectorArkProvider for this to work.
 */
export async function fillSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  // Get introspector base pubkey (needed to decode the swap script)
  const introspectorInfo = await getIntrospectorInfo();
  let introspectorPubkey = hexToBytes(introspectorInfo.signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const arkadeScriptBytes = hexToBytes(offer.arkadeScriptHex);
  const vtxoScript = await decodeSwapScript(
    hexToBytes(offer.swapScriptHex),
    arkadeScriptBytes,
    introspectorPubkey,
  );
  const swapLeaf = vtxoScript.leaves[0];       // MultisigClosure(introspectorTweaked, ASP)
  // For fill: forfeit uses the same swap leaf (introspector co-signs via SubmitFinalization)
  const swapForfeitLeaf = vtxoScript.leaves[0];

  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330;

  const tapTreeBytes = vtxoScript.encode();

  // NOTE: `assets` MUST be included — the ASP requires an Extension (asset packet)
  // when inputs hold assets. Without it: "ASSET_VALIDATION_FAILED: asset packet
  // not found in tx". The SDK routes all input assets to the first offchain output
  // (the maker's sat payment) via the Extension. The ASP's asset conservation
  // logic then handles actual VTXO creation — the taker receives tokens in their
  // change VTXO, and the maker receives sats in theirs.
  const swapVtxo = {
    txid,
    vout,
    value: vtxoSatsValue,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
    tapTree: tapTreeBytes,
    intentTapLeafScript: swapLeaf,        // spend via MultisigClosure (introspector validates)
    forfeitTapLeafScript: swapForfeitLeaf, // forfeit via same leaf (introspector co-signs)
  };

  // The swap VTXO only holds dust sats — the taker must fund the sat payment
  // from their own VTXOs.
  const takerVtxos = await wallet.getVtxos();
  const spendable = takerVtxos.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) =>
      (v.virtualStatus?.state === "settled" || v.virtualStatus?.state === "preconfirmed") &&
      !v.isSpent &&
      `${v.txid}:${v.vout}` !== offer.offerOutpoint
  );

  // Simple coin selection: largest first until we cover the output
  const sorted = [...spendable].sort((a: { value: number }, b: { value: number }) => b.value - a.value);
  let fundedSats = vtxoSatsValue; // swap VTXO contributes its dust value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fundingVtxos: any[] = [];
  for (const v of sorted) {
    if (fundedSats >= offer.satAmount) break;
    fundingVtxos.push(v);
    fundedSats += v.value;
  }
  if (fundedSats < offer.satAmount) {
    throw new Error(
      `Insufficient funds to fill offer: have ${fundedSats} sats, need ${offer.satAmount} sats`
    );
  }

  // Set swap context just before settle — inside try/finally so it always gets cleared.
  if (wallet.arkProvider?.setSwapContext) {
    wallet.arkProvider.setSwapContext({
      offerOutpoint: offer.offerOutpoint,
      arkadeScriptHex: offer.arkadeScriptHex,
      tapTreeHex: bytesToHex(tapTreeBytes),
      vtxoSatsValue,
      forfeitTapLeafScript: swapForfeitLeaf,
      satAmount: offer.satAmount,
      makerPkScriptHex: offer.makerPkScript,
    });
  }

  try {
    return await wallet.settle(
      {
        inputs: [swapVtxo, ...fundingVtxos],
        outputs: [{ address: offer.makerArkAddress, amount: BigInt(offer.satAmount) }],
      },
      eventCallback ?? ((event: unknown) => console.log("[fillSwapOffer]", event)),
    );
  } finally {
    // Clear swap context after settle completes (or fails)
    if (wallet.arkProvider?.clearSwapContext) {
      wallet.arkProvider.clearSwapContext();
    }
  }
}

// ── Cancel ────────────────────────────────────────────────────────────────────

/**
 * Cancel a swap offer as maker (after CSV timelock expires). Spends via the CSV cancel leaf.
 * No introspector needed — uses standard maker+ASP forfeit (leaf 2).
 */
export async function cancelSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  let introspectorPubkey = hexToBytes((await getIntrospectorInfo()).signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const vtxoScript = await decodeSwapScript(
    hexToBytes(offer.swapScriptHex),
    hexToBytes(offer.arkadeScriptHex),
    introspectorPubkey,
  );
  const cancelLeaf = vtxoScript.leaves[1];        // CSV + maker CHECKSIG
  const cancelForfeitLeaf = vtxoScript.leaves[2];  // MultisigClosure(maker, ASP)

  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330;

  const swapVtxo = {
    txid,
    vout,
    value: vtxoSatsValue,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
    tapTree: vtxoScript.encode(),
    intentTapLeafScript: cancelLeaf,        // maker uses cancel leaf (CSV)
    forfeitTapLeafScript: cancelForfeitLeaf, // standard maker+ASP forfeit
  };

  return wallet.settle(
    {
      inputs: [swapVtxo],
      outputs: [{ address: offer.makerArkAddress, amount: BigInt(vtxoSatsValue) }],
    },
    eventCallback ?? ((event: unknown) => console.log("[cancelSwapOffer]", event)),
  );
}
