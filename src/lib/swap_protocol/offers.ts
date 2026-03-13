/**
 * Swap offer lifecycle: create and cancel.
 *
 * - createSwapOffer(): Maker sends tokens to a swap script VTXO
 * - cancelSwapOffer(): Maker reclaims tokens via light path (submitTx/finalizeTx)
 *
 * Fill is handled by light-fill.ts (lightFillSwapOffer) using the same
 * submitTx/finalizeTx offchain tx path — no rounds, no forfeits.
 *
 * All functions require an initialized ArkWallet (from initArkWallet).
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

// ── Cancel ────────────────────────────────────────────────────────────────────

/**
 * Cancel a swap offer as maker via the light path (submitTx/finalizeTx).
 * No introspector needed — uses MultisigClosure(maker, ASP) leaf (leaf 2)
 * as the collaborative closure. The maker signs, the ASP co-signs via submitTx.
 *
 * Returns the ark transaction ID.
 */
export async function cancelSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  const log = eventCallback ?? ((e: unknown) => console.log("[cancelSwapOffer]", e));
  const sdk = await import("@arkade-os/sdk");
  const { base64 } = await import("@scure/base");
  const { buildOffchainTx, ArkAddress } = sdk;

  // ── 1. Decode swap script ─────────────────────────────────────────────────

  let introspectorPubkey = hexToBytes((await getIntrospectorInfo()).signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const vtxoScript = await decodeSwapScript(
    hexToBytes(offer.swapScriptHex),
    hexToBytes(offer.arkadeScriptHex),
    introspectorPubkey,
  );
  const cancelForfeitLeaf = vtxoScript.leaves[2]; // MultisigClosure(maker, ASP)

  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330;

  // Swap VTXO input — collaborative closure via cancel forfeit leaf (maker + ASP)
  const cancelInput = {
    txid,
    vout,
    value: vtxoSatsValue,
    tapTree: vtxoScript.encode(),
    tapLeafScript: cancelForfeitLeaf,
    forfeitTapLeafScript: cancelForfeitLeaf,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
  };

  // ── 2. Build output — maker receives tokens back ──────────────────────────

  const makerAddr = ArkAddress.decode(offer.makerArkAddress);
  const makerOutput = {
    script: makerAddr.pkScript,
    amount: BigInt(vtxoSatsValue),
  };

  // ── 3. Build asset extension (OP_RETURN) ──────────────────────────────────

  const { asset } = sdk;
  const assetIdObj = asset.AssetId.fromString(offer.assetId);
  const assetInputs = [asset.AssetInput.create(0, BigInt(offer.tokenAmount))];
  const assetOutputs = [asset.AssetOutput.create(0, BigInt(offer.tokenAmount))];
  const group = asset.AssetGroup.create(assetIdObj, null, assetInputs, assetOutputs, []);
  const packetBytes = asset.Packet.create([group]).serialize();

  // Build OP_RETURN: "ARK" + type(0x00) + LEB128 len + packet
  const ARKADE_MAGIC = new Uint8Array([0x41, 0x52, 0x4b]);
  const typeByte = new Uint8Array([0x00]);
  const lenBytes = leb128(packetBytes.length);

  const payloadLen = ARKADE_MAGIC.length + typeByte.length + lenBytes.length + packetBytes.length;
  const payload = new Uint8Array(payloadLen);
  let off = 0;
  payload.set(ARKADE_MAGIC, off); off += ARKADE_MAGIC.length;
  payload.set(typeByte, off); off += typeByte.length;
  payload.set(lenBytes, off); off += lenBytes.length;
  payload.set(packetBytes, off);

  const opReturnScript = buildOpReturnScript(payload);

  const outputs = [
    makerOutput,
    { script: opReturnScript, amount: BigInt(0) },
  ];

  // ── 4. Build offchain tx ──────────────────────────────────────────────────

  const serverUnrollScript = wallet.serverUnrollScript;
  if (!serverUnrollScript) {
    throw new Error("wallet.serverUnrollScript not available — ensure wallet is initialized");
  }

  const offchainTx = buildOffchainTx([cancelInput], outputs, serverUnrollScript);
  log({ type: "offchain_tx_built", inputs: 1, outputs: outputs.length });

  // ── 5. Sign with maker identity ───────────────────────────────────────────

  const signedArkTx = await wallet.identity.sign(offchainTx.arkTx);
  log({ type: "maker_signed" });

  // ── 6. Submit to ASP ──────────────────────────────────────────────────────

  const checkpointPsbts = offchainTx.checkpoints.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => base64.encode(c.toPSBT())
  );

  log({ type: "submitting_to_asp" });
  const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    checkpointPsbts,
  );
  log({ type: "asp_accepted", arkTxid });

  // ── 7. Sign returned checkpoints ──────────────────────────────────────────

  const { Transaction } = await import("@scure/btc-signer");
  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (c: string) => {
      const tx = Transaction.fromPSBT(base64.decode(c), { allowUnknown: true });
      const signed = await wallet.identity.sign(tx);
      return base64.encode(signed.toPSBT());
    })
  );

  // ── 8. Finalize ───────────────────────────────────────────────────────────

  log({ type: "finalizing" });
  await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
  log({ type: "complete", arkTxid });

  return arkTxid;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** LEB128 varint (NOT Bitcoin compact size) — matches SDK's encodeVarUint. */
function leb128(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}

/** Build OP_RETURN script matching SDK's manual construction (avoids 520-byte push limit). */
function buildOpReturnScript(payload: Uint8Array): Uint8Array {
  const n = payload.length;
  let script: Uint8Array;
  if (n <= 75) {
    script = new Uint8Array(2 + n);
    script[0] = 0x6a; // OP_RETURN
    script[1] = n;
    script.set(payload, 2);
  } else if (n <= 255) {
    script = new Uint8Array(3 + n);
    script[0] = 0x6a;
    script[1] = 0x4c; // OP_PUSHDATA1
    script[2] = n;
    script.set(payload, 3);
  } else {
    script = new Uint8Array(4 + n);
    script[0] = 0x6a;
    script[1] = 0x4d; // OP_PUSHDATA2
    new DataView(script.buffer).setUint16(2, n, true);
    script.set(payload, 4);
  }
  return script;
}
