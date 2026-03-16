/**
 * Light swap fill — uses submitTx/finalizeTx instead of settle().
 *
 * The heavy path (settle) participates in a full ASP round: intent registration,
 * tree construction, forfeit exchange, finalization. This requires complex SDK
 * workarounds (PSBT field injection, sig stripping, forfeit construction,
 * connector parsing, event stream interception).
 *
 * The light path builds an offchain ark tx + checkpoints directly, gets
 * the introspector to validate arkade script conditions and co-sign,
 * then submits to the ASP via submitTx/finalizeTx. No rounds, no forfeits,
 * no connector trees.
 *
 * Flow:
 *   1. Build offchain tx: swap VTXO + taker funding VTXOs → maker payment + taker change
 *   2. Inject arkade script PSBT field on the swap VTXO's ark tx input
 *   3. Sign taker's inputs (taker identity)
 *   4. Send to introspector POST /v1/tx → validates arkade script, co-signs swap inputs
 *   5. Send to ASP submitTx → ASP co-signs, returns signed checkpoints
 *   6. Sign returned checkpoints with taker identity
 *   7. ASP finalizeTx → done
 */

import { hex as scureHex } from "@scure/base";
import { decodeSwapScript } from "./script";
import { getIntrospectorInfo } from "./introspector-client";
import type { SwapOffer, BuyOffer } from "./offers";

const hexToBytes = scureHex.decode;
const bytesToHex = scureHex.encode;

// ARK OP_RETURN extension constants
const ARKADE_MAGIC = new Uint8Array([0x41, 0x52, 0x4b]); // "ARK"
const ASSET_PACKET_TYPE = 0x00;
const INTROSPECTOR_PACKET_TYPE = 0x01;

/** LEB128 varint — matches SDK's encodeVarUint / Bitcoin wire format. */
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

/**
 * Build an IntrospectorPacket for the OP_RETURN extension.
 * Format: varint(count) + for each entry: u16_le(vin) + varint(script_len) + script + varint(witness_len) + witness
 */
function buildIntrospectorPacketBytes(entries: { vin: number; script: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(leb128(entries.length));
  for (const entry of entries) {
    // vin as u16 LE
    const vinBytes = new Uint8Array(2);
    vinBytes[0] = entry.vin & 0xff;
    vinBytes[1] = (entry.vin >> 8) & 0xff;
    parts.push(vinBytes);
    // script
    parts.push(leb128(entry.script.length));
    parts.push(entry.script);
    // witness (empty)
    parts.push(leb128(0));
  }
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/**
 * Build the combined OP_RETURN script containing both the asset packet (type 0x00)
 * and the introspector packet (type 0x01) in the ARK extension format.
 *
 * Format: OP_RETURN | <push> | "ARK" | type(0x00) | LEB128(len) | asset_data | type(0x01) | LEB128(len) | introspector_data
 */
function buildCombinedOpReturn(assetPacketBytes: Uint8Array, introspectorPacketBytes: Uint8Array): Uint8Array {
  const assetLenBytes = leb128(assetPacketBytes.length);
  const introspectorLenBytes = leb128(introspectorPacketBytes.length);

  const payloadLen =
    ARKADE_MAGIC.length +
    1 + assetLenBytes.length + assetPacketBytes.length +       // type(1) + len + data
    1 + introspectorLenBytes.length + introspectorPacketBytes.length; // type(1) + len + data

  const payload = new Uint8Array(payloadLen);
  let off = 0;
  payload.set(ARKADE_MAGIC, off); off += ARKADE_MAGIC.length;
  // Asset packet (type 0x00)
  payload[off++] = ASSET_PACKET_TYPE;
  payload.set(assetLenBytes, off); off += assetLenBytes.length;
  payload.set(assetPacketBytes, off); off += assetPacketBytes.length;
  // Introspector packet (type 0x01)
  payload[off++] = INTROSPECTOR_PACKET_TYPE;
  payload.set(introspectorLenBytes, off); off += introspectorLenBytes.length;
  payload.set(introspectorPacketBytes, off);

  // Build OP_RETURN script
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

/**
 * Fill a swap offer using the light offchain tx path (submitTx/finalizeTx).
 * No rounds, no forfeits — just build, sign, submit.
 *
 * Returns the ark transaction ID (string).
 */
export async function lightFillSwapOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: SwapOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  const log = eventCallback ?? ((e: unknown) => console.log("[lightFill]", e));
  const sdk = await import("@arkade-os/sdk");
  const { base64 } = await import("@scure/base");
  const { buildOffchainTx } = sdk;

  // ── 1. Decode swap script and prepare inputs ────────────────────────────

  const introspectorInfo = await getIntrospectorInfo();
  let introspectorPubkey = hexToBytes(introspectorInfo.signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const arkadeScriptBytes = hexToBytes(offer.arkadeScriptHex);
  const vtxoScript = await decodeSwapScript(
    hexToBytes(offer.swapScriptHex),
    arkadeScriptBytes,
    introspectorPubkey,
  );

  const swapLeaf = vtxoScript.leaves[0]; // MultisigClosure(introspectorTweaked, ASP)
  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || 330;

  // Swap VTXO input — uses swap leaf as its "forfeit" (collaborative closure)
  const swapInput = {
    txid,
    vout,
    value: vtxoSatsValue,
    tapTree: vtxoScript.encode(),
    tapLeafScript: swapLeaf,
    forfeitTapLeafScript: swapLeaf,
    assets: [{ assetId: offer.assetId, amount: offer.tokenAmount }],
  };

  // ── 2. Coin selection for taker's funding VTXOs ─────────────────────────

  const takerVtxos = await wallet.getVtxos();
  const spendable = takerVtxos.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) =>
      (v.virtualStatus?.state === "settled" || v.virtualStatus?.state === "preconfirmed") &&
      !v.isSpent &&
      `${v.txid}:${v.vout}` !== offer.offerOutpoint
  );
  const sorted = [...spendable].sort(
    (a: { value: number }, b: { value: number }) => b.value - a.value
  );

  const dustAmount = Number(wallet.dustAmount ?? 330);
  // Taker needs satAmount for the maker + at least dustAmount for their own change output
  const requiredSats = offer.satAmount + dustAmount;

  let fundedSats = vtxoSatsValue; // swap VTXO contributes its dust
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fundingInputs: any[] = [];
  for (const v of sorted) {
    if (fundedSats >= requiredSats) break;
    fundingInputs.push(v);
    fundedSats += v.value;
  }
  if (fundedSats < requiredSats) {
    throw new Error(
      `Insufficient funds: have ${fundedSats} sats, need ${requiredSats} sats (${offer.satAmount} + ${dustAmount} dust)`
    );
  }

  // ── 3. Build outputs ───────────────────────────────────────────────────

  const { ArkAddress } = sdk;
  const makerAddr = ArkAddress.decode(offer.makerArkAddress);
  const makerOutput = {
    script: makerAddr.pkScript,
    amount: BigInt(offer.satAmount),
  };

  // Taker change — always needed because the taker receives the tokens
  const takerAddress = await wallet.getAddress();
  const takerAddr = ArkAddress.decode(takerAddress);
  const changeSats = fundedSats - offer.satAmount;
  const takerOutputSats = Math.max(changeSats, dustAmount);
  const outputs = [
    makerOutput,
    { script: takerAddr.pkScript, amount: BigInt(takerOutputSats) },
  ];

  // ── 3b. Build asset extension (OP_RETURN with ARK asset packet) ────────
  //
  // The ASP requires an Extension output that describes how assets move
  // between inputs and outputs. Input 0 (swap VTXO) holds the tokens;
  // output 1 (taker) receives them.

  // Build asset extension OP_RETURN output.
  // ALL input assets must be accounted for — not just the swap VTXO.
  // Taker's funding VTXOs may also carry tokens from previous transactions.
  //
  // The ASP requires this to validate asset conservation. Format:
  //   OP_RETURN | <push> | "ARK" | type(0x00) | varint_len | packet_bytes
  const { asset } = sdk;

  // Collect all assets from all inputs, grouped by asset ID
  const allInputsWithAssets = [swapInput, ...fundingInputs];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputsByAssetId = new Map<string, { inputIndex: number; amount: bigint }[]>();
  const totalByAssetId = new Map<string, bigint>();

  for (let i = 0; i < allInputsWithAssets.length; i++) {
    const inp = allInputsWithAssets[i];
    if (!inp.assets) continue;
    for (const a of inp.assets) {
      const existing = inputsByAssetId.get(a.assetId) ?? [];
      existing.push({ inputIndex: i, amount: BigInt(a.amount) });
      inputsByAssetId.set(a.assetId, existing);
      totalByAssetId.set(a.assetId, (totalByAssetId.get(a.assetId) ?? 0n) + BigInt(a.amount));
    }
  }

  // Build asset groups: all tokens go to output 1 (taker)
  const groups = [];
  for (const [assetIdStr, inputs] of inputsByAssetId) {
    const assetIdObj = asset.AssetId.fromString(assetIdStr);
    const assetInputs = inputs.map(
      (inp: { inputIndex: number; amount: bigint }) => asset.AssetInput.create(inp.inputIndex, inp.amount)
    );
    const totalAmount = totalByAssetId.get(assetIdStr)!;
    const assetOutputs = [asset.AssetOutput.create(1, totalAmount)]; // all to taker
    groups.push(asset.AssetGroup.create(assetIdObj, null, assetInputs, assetOutputs, []));
  }

  const packetObj = asset.Packet.create(groups);
  const packetBytes = packetObj.serialize();

  // Build combined OP_RETURN with asset packet (type 0x00) + introspector packet (type 0x01)
  const introspectorPacketBytes = buildIntrospectorPacketBytes([
    { vin: 0, script: arkadeScriptBytes },
  ]);
  const opReturnScript = buildCombinedOpReturn(packetBytes, introspectorPacketBytes);

  outputs.push({ script: opReturnScript, amount: BigInt(0) });

  // ── 4. Build offchain tx (ark tx + checkpoints) ─────────────────────────

  // Get serverUnrollScript from the wallet (it's set during Wallet.create from ASP info)
  const serverUnrollScript = wallet.serverUnrollScript;
  if (!serverUnrollScript) {
    throw new Error(
      "wallet.serverUnrollScript not available — ensure the wallet is fully initialized"
    );
  }

  // Format all inputs with tapLeafScript set to their forfeit/collaborative closure
  const allInputs = [swapInput, ...fundingInputs].map((input) => ({
    ...input,
    tapLeafScript: input.forfeitTapLeafScript ?? input.tapLeafScript,
  }));

  const offchainTx = buildOffchainTx(allInputs, outputs, serverUnrollScript);
  log({ type: "offchain_tx_built", inputs: allInputs.length, outputs: outputs.length });

  // ── 5. Verify output[0] is the maker's payment ─────────────────────────
  // (Arkade script + introspector packet are already in the OP_RETURN output)

  const arkTx = offchainTx.arkTx;
  const makerPkScriptHex = bytesToHex(makerAddr.pkScript);
  const out0 = arkTx.getOutput(0);
  if (!out0?.script || bytesToHex(out0.script) !== makerPkScriptHex) {
    throw new Error(
      `Output[0] scriptPubKey mismatch — expected maker's address. ` +
      `Got ${out0?.script ? bytesToHex(out0.script) : "none"}, ` +
      `expected ${makerPkScriptHex}`
    );
  }
  if (out0.amount !== BigInt(offer.satAmount)) {
    throw new Error(
      `Output[0] amount ${out0.amount} !== expected ${offer.satAmount} sats`
    );
  }

  // ── 7. Sign taker's inputs ─────────────────────────────────────────────
  //
  // identity.sign() signs all inputs where the identity's key matches a
  // pubkey in the tapLeafScript. For the swap VTXO input, the taker's key
  // is NOT in the MultisigClosure(introspector, ASP), so it's skipped.
  // Only the taker's funding VTXO inputs get signed.

  const signedArkTx = await wallet.identity.sign(arkTx);
  log({ type: "taker_signed" });

  // ── 8. Send to introspector for arkade script validation + co-signing ──
  //
  // The introspector's SubmitTx (POST /v1/tx) iterates ark tx inputs:
  //   - Finds arkade script on input 0
  //   - Executes conditions against ark tx outputs
  //   - Co-signs ark tx input 0 AND checkpoint[0] input 0
  //   - Skips inputs without arkade script (taker's funding inputs)

  const introspectorUrl = process.env.NEXT_PUBLIC_INTROSPECTOR_URL || "http://localhost:7073";
  const checkpointPsbts = offchainTx.checkpoints.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => base64.encode(c.toPSBT())
  );

  log({ type: "submitting_to_introspector" });
  const introspectorResp = await fetch(`${introspectorUrl}/v1/tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ark_tx: base64.encode(signedArkTx.toPSBT()),
      checkpoint_txs: checkpointPsbts,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!introspectorResp.ok) {
    const text = await introspectorResp.text().catch(() => "");
    throw new Error(`Introspector /v1/tx failed (${introspectorResp.status}): ${text}`);
  }
  const introspectorResult = await introspectorResp.json();
  log({ type: "introspector_response_keys", keys: Object.keys(introspectorResult) });

  // gRPC-REST gateway may use camelCase (signedArkTx) or snake_case (signed_ark_tx)
  const signedArkTxB64: string = introspectorResult.signed_ark_tx ?? introspectorResult.signedArkTx;
  const signedCheckpointTxsFromIntrospector: string[] =
    introspectorResult.signed_checkpoint_txs ?? introspectorResult.signedCheckpointTxs;

  if (!signedArkTxB64) {
    throw new Error(
      `Introspector /v1/tx: missing signed_ark_tx in response. Keys: ${Object.keys(introspectorResult).join(", ")}`
    );
  }

  log({ type: "introspector_co_signed" });

  // ── 9. Merge introspector signatures with taker's signatures ───────────
  //
  // The introspector signed input 0 (swap VTXO) of the ark tx.
  // The taker signed inputs 1+ (funding VTXOs).
  // Use BIP-174 combine to merge both sets of signatures.

  const { Psbt } = await import("./psbt-combiner");
  const mergedArkTxB64 = Psbt.combine(
    signedArkTxB64,
    base64.encode(signedArkTx.toPSBT()),
  );

  // Merge checkpoint signatures too (introspector signed checkpoint[0])
  const mergedCheckpoints = checkpointPsbts.map((original: string, i: number) => {
    const fromIntrospector = signedCheckpointTxsFromIntrospector?.[i];
    if (fromIntrospector) {
      return Psbt.combine(fromIntrospector, original);
    }
    return original;
  });

  // ── 10. Submit to ASP ──────────────────────────────────────────────────

  log({ type: "submitting_to_asp" });
  const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
    mergedArkTxB64,
    mergedCheckpoints,
  );

  log({ type: "asp_accepted", arkTxid });

  // ── 11. Sign returned checkpoints with taker identity ──────────────────
  //
  // The ASP returns checkpoints with only its signature. We must:
  //   a) Merge the introspector's signatures back in (checkpoint[0])
  //   b) Counter-sign with the taker's identity (checkpoint[1+])

  const { Transaction } = await import("@scure/btc-signer");
  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (c: string, i: number) => {
      // Merge introspector signatures for checkpoint[0]
      let merged = c;
      if (mergedCheckpoints[i] && mergedCheckpoints[i] !== checkpointPsbts[i]) {
        // mergedCheckpoints[i] has introspector sigs — combine with ASP's
        merged = Psbt.combine(c, mergedCheckpoints[i]);
      }
      const tx = Transaction.fromPSBT(base64.decode(merged), { allowUnknown: true });
      const signed = await wallet.identity.sign(tx);
      return base64.encode(signed.toPSBT());
    })
  );

  // ── 12. Finalize ───────────────────────────────────────────────────────

  log({ type: "finalizing" });
  await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
  log({ type: "complete", arkTxid });

  return arkTxid;
}

/**
 * Fill a buy offer — seller provides tokens, receives sats.
 *
 * Input 0: buy VTXO (sats from buyer/maker)
 * Input 1+: seller's token VTXOs
 * Output 0: buyer gets tokens (validated by buy arkade script)
 * Output 1: seller gets sats
 * Output 2: OP_RETURN asset extension
 *
 * Same introspector → ASP → finalize flow as sell fill.
 */
export async function lightFillBuyOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  offer: BuyOffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventCallback?: (event: any) => void
): Promise<string> {
  const log = eventCallback ?? ((e: unknown) => console.log("[lightFillBuy]", e));
  const sdk = await import("@arkade-os/sdk");
  const { base64 } = await import("@scure/base");
  const { buildOffchainTx } = sdk;

  // ── 1. Decode swap script and prepare inputs ────────────────────────────

  const introspectorInfo = await getIntrospectorInfo();
  let introspectorPubkey = hexToBytes(introspectorInfo.signerPubkey);
  if (introspectorPubkey.length === 33) introspectorPubkey = introspectorPubkey.slice(1);

  const arkadeScriptBytes = hexToBytes(offer.arkadeScriptHex);
  const vtxoScript = await decodeSwapScript(
    hexToBytes(offer.swapScriptHex),
    arkadeScriptBytes,
    introspectorPubkey,
  );

  const swapLeaf = vtxoScript.leaves[0]; // MultisigClosure(introspectorTweaked, ASP)
  const [txid, voutStr] = offer.offerOutpoint.split(":");
  const vout = parseInt(voutStr, 10);
  const vtxoSatsValue = offer.vtxoSatsValue || offer.satAmount;

  // Buy VTXO input — holds sats (no assets)
  const swapInput = {
    txid,
    vout,
    value: vtxoSatsValue,
    tapTree: vtxoScript.encode(),
    tapLeafScript: swapLeaf,
    forfeitTapLeafScript: swapLeaf,
  };

  // ── 2. Coin selection for seller's token VTXOs ──────────────────────────

  const sellerVtxos = await wallet.getVtxos();
  const spendable = sellerVtxos.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) =>
      (v.virtualStatus?.state === "settled" || v.virtualStatus?.state === "preconfirmed") &&
      !v.isSpent &&
      `${v.txid}:${v.vout}` !== offer.offerOutpoint
  );

  // Find VTXOs that hold the required asset
  const tokenVtxos = spendable.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) => v.assets?.some((a: any) => a.assetId === offer.assetId)
  );

  let fundedTokens = 0n;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenInputs: any[] = [];
  for (const v of tokenVtxos) {
    if (fundedTokens >= BigInt(offer.tokenAmount)) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assetEntry = v.assets.find((a: any) => a.assetId === offer.assetId);
    if (assetEntry) {
      tokenInputs.push(v);
      fundedTokens += BigInt(assetEntry.amount);
    }
  }
  if (fundedTokens < BigInt(offer.tokenAmount)) {
    throw new Error(
      `Insufficient token balance: have ${fundedTokens} tokens, need ${offer.tokenAmount}`
    );
  }

  // Also need sats for dust output (buyer's token output)
  const dustAmount = Number(wallet.dustAmount ?? 330);

  // ── 3. Build outputs ───────────────────────────────────────────────────

  const { ArkAddress } = sdk;

  // Output 0: buyer (maker) gets tokens — must match arkade script's introspection
  const buyerAddr = ArkAddress.decode(offer.makerArkAddress);
  const buyerOutput = {
    script: buyerAddr.pkScript,
    amount: BigInt(dustAmount), // tokens are on asset layer; sats are dust
  };

  // Output 1: seller (taker) gets sats
  const sellerAddress = await wallet.getAddress();
  const sellerAddr = ArkAddress.decode(sellerAddress);
  // Seller receives the buy VTXO's sats minus what's needed for buyer's dust output
  let sellerSats = vtxoSatsValue - dustAmount;
  // Add sats from seller's token VTXOs
  for (const v of tokenInputs) {
    sellerSats += v.value;
  }
  const sellerOutputSats = Math.max(sellerSats, dustAmount);
  const outputs = [
    buyerOutput,
    { script: sellerAddr.pkScript, amount: BigInt(sellerOutputSats) },
  ];

  // ── 3b. Build asset extension (OP_RETURN with ARK asset packet) ────────

  const { asset } = sdk;

  // All token inputs carry the asset — map them
  const allInputsWithAssets = [swapInput, ...tokenInputs];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputsByAssetId = new Map<string, { inputIndex: number; amount: bigint }[]>();
  const totalByAssetId = new Map<string, bigint>();

  for (let i = 0; i < allInputsWithAssets.length; i++) {
    const inp = allInputsWithAssets[i];
    if (!inp.assets) continue;
    for (const a of inp.assets) {
      const existing = inputsByAssetId.get(a.assetId) ?? [];
      existing.push({ inputIndex: i, amount: BigInt(a.amount) });
      inputsByAssetId.set(a.assetId, existing);
      totalByAssetId.set(a.assetId, (totalByAssetId.get(a.assetId) ?? 0n) + BigInt(a.amount));
    }
  }

  // For buy offers, tokens go to output 0 (buyer).
  // IMPORTANT: The target asset (the one being bought) MUST be at group index 0
  // because the arkade script's OP_INSPECTOUTASSETLOOKUP uses group index 0.
  // Other assets carried by the seller's VTXOs go after.
  const groups = [];

  // First: add the target asset group (the one the buyer wants)
  const targetInputs = inputsByAssetId.get(offer.assetId);
  if (targetInputs) {
    const assetIdObj = asset.AssetId.fromString(offer.assetId);
    const assetInputs = targetInputs.map(
      (inp: { inputIndex: number; amount: bigint }) => asset.AssetInput.create(inp.inputIndex, inp.amount)
    );
    const totalAmount = totalByAssetId.get(offer.assetId)!;
    const requiredAmount = BigInt(offer.tokenAmount);
    const assetOutputs = [asset.AssetOutput.create(0, requiredAmount)]; // buyer gets requested amount
    // Return excess tokens to seller (output 1) if seller provided more than needed
    if (totalAmount > requiredAmount) {
      assetOutputs.push(asset.AssetOutput.create(1, totalAmount - requiredAmount));
    }
    groups.push(asset.AssetGroup.create(assetIdObj, null, assetInputs, assetOutputs, []));
  }

  // Then: add remaining asset groups (other tokens on the seller's VTXOs)
  for (const [assetIdStr, inputs] of inputsByAssetId) {
    if (assetIdStr === offer.assetId) continue; // already added as group 0
    const assetIdObj = asset.AssetId.fromString(assetIdStr);
    const assetInputs = inputs.map(
      (inp: { inputIndex: number; amount: bigint }) => asset.AssetInput.create(inp.inputIndex, inp.amount)
    );
    const totalAmount = totalByAssetId.get(assetIdStr)!;
    // Other assets go to seller (output 1)
    const assetOutputs = [asset.AssetOutput.create(1, totalAmount)];
    groups.push(asset.AssetGroup.create(assetIdObj, null, assetInputs, assetOutputs, []));
  }

  const packetObj = asset.Packet.create(groups);
  const packetBytes = packetObj.serialize();

  // Build combined OP_RETURN with asset packet (type 0x00) + introspector packet (type 0x01)
  const introspectorPacketBytes = buildIntrospectorPacketBytes([
    { vin: 0, script: arkadeScriptBytes },
  ]);
  const opReturnScript = buildCombinedOpReturn(packetBytes, introspectorPacketBytes);

  outputs.push({ script: opReturnScript, amount: BigInt(0) });

  // ── 4. Build offchain tx ───────────────────────────────────────────────

  const serverUnrollScript = wallet.serverUnrollScript;
  if (!serverUnrollScript) {
    throw new Error(
      "wallet.serverUnrollScript not available — ensure the wallet is fully initialized"
    );
  }

  const allInputs = [swapInput, ...tokenInputs].map((input) => ({
    ...input,
    tapLeafScript: input.forfeitTapLeafScript ?? input.tapLeafScript,
  }));

  const offchainTx = buildOffchainTx(allInputs, outputs, serverUnrollScript);
  log({ type: "offchain_tx_built", inputs: allInputs.length, outputs: outputs.length });

  // ── 5. Verify output[0] is the buyer's token output ────────────────────
  // (Arkade script + introspector packet are already in the OP_RETURN output)

  const arkTx = offchainTx.arkTx;
  const buyerPkScriptHex = bytesToHex(buyerAddr.pkScript);
  const out0 = arkTx.getOutput(0);
  if (!out0?.script || bytesToHex(out0.script) !== buyerPkScriptHex) {
    throw new Error(
      `Output[0] scriptPubKey mismatch — expected buyer's address. ` +
      `Got ${out0?.script ? bytesToHex(out0.script) : "none"}, ` +
      `expected ${buyerPkScriptHex}`
    );
  }

  // ── 7. Sign seller's inputs ────────────────────────────────────────────

  const signedArkTx = await wallet.identity.sign(arkTx);
  log({ type: "seller_signed" });

  // ── 8. Send to introspector ────────────────────────────────────────────

  const introspectorUrl = process.env.NEXT_PUBLIC_INTROSPECTOR_URL || "http://localhost:7073";
  const checkpointPsbts = offchainTx.checkpoints.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => base64.encode(c.toPSBT())
  );

  log({ type: "submitting_to_introspector" });
  const introspectorResp = await fetch(`${introspectorUrl}/v1/tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ark_tx: base64.encode(signedArkTx.toPSBT()),
      checkpoint_txs: checkpointPsbts,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!introspectorResp.ok) {
    const text = await introspectorResp.text().catch(() => "");
    throw new Error(`Introspector /v1/tx failed (${introspectorResp.status}): ${text}`);
  }
  const introspectorResult = await introspectorResp.json();
  log({ type: "introspector_response_keys", keys: Object.keys(introspectorResult) });

  const signedArkTxB64: string = introspectorResult.signed_ark_tx ?? introspectorResult.signedArkTx;
  const signedCheckpointTxsFromIntrospector: string[] =
    introspectorResult.signed_checkpoint_txs ?? introspectorResult.signedCheckpointTxs;

  if (!signedArkTxB64) {
    throw new Error(
      `Introspector /v1/tx: missing signed_ark_tx in response. Keys: ${Object.keys(introspectorResult).join(", ")}`
    );
  }

  log({ type: "introspector_co_signed" });

  // ── 9. Merge introspector + seller signatures ──────────────────────────

  const { Psbt } = await import("./psbt-combiner");
  const mergedArkTxB64 = Psbt.combine(
    signedArkTxB64,
    base64.encode(signedArkTx.toPSBT()),
  );

  const mergedCheckpoints = checkpointPsbts.map((original: string, i: number) => {
    const fromIntrospector = signedCheckpointTxsFromIntrospector?.[i];
    if (fromIntrospector) {
      return Psbt.combine(fromIntrospector, original);
    }
    return original;
  });

  // ── 10. Submit to ASP ──────────────────────────────────────────────────

  log({ type: "submitting_to_asp" });
  const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
    mergedArkTxB64,
    mergedCheckpoints,
  );

  log({ type: "asp_accepted", arkTxid });

  // ── 11. Sign returned checkpoints with seller identity ─────────────────

  const { Transaction } = await import("@scure/btc-signer");
  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (c: string, i: number) => {
      let merged = c;
      if (mergedCheckpoints[i] && mergedCheckpoints[i] !== checkpointPsbts[i]) {
        merged = Psbt.combine(c, mergedCheckpoints[i]);
      }
      const tx = Transaction.fromPSBT(base64.decode(merged), { allowUnknown: true });
      const signed = await wallet.identity.sign(tx);
      return base64.encode(signed.toPSBT());
    })
  );

  // ── 12. Finalize ───────────────────────────────────────────────────────

  log({ type: "finalizing" });
  await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
  log({ type: "complete", arkTxid });

  return arkTxid;
}
