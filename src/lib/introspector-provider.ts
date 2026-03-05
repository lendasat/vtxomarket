/**
 * IntrospectorArkProvider — wraps an ArkProvider to add Arkade Introspector co-signing.
 *
 * Intercepts:
 *   1. registerIntent() — injects arkadescript PSBT field, sends to introspector for co-signing
 *   2. getEventStream() — captures connector tree chunks for finalization
 *   3. submitSignedForfeitTxs() — sends to introspector SubmitFinalization for co-signing
 *
 * Usage:
 *   const provider = new IntrospectorArkProvider(realProvider);
 *   // Before calling wallet.settle() for a swap fill:
 *   provider.setSwapContext({ offerOutpoint, arkadeScriptHex, tapTreeHex });
 *   await wallet.settle(params); // uses the wrapped provider
 *   provider.clearSwapContext();
 */

import { hex as scureHex } from "@scure/base";
import {
  submitIntent as introspectorSubmitIntent,
  submitFinalization as introspectorSubmitFinalization,
  type TxTreeNode,
} from "./introspector-client";

// PSBT custom field keys (type 0xDE = 222, matching Ark SDK's ArkPsbtFieldKeyType)
const ARK_PSBT_KEY_TYPE = 0xDE;
const ARKADE_SCRIPT_FIELD_KEY = new TextEncoder().encode("arkadescript");
const TAPTREE_FIELD_KEY = new TextEncoder().encode("taptree");

interface SwapContext {
  offerOutpoint: string;
  arkadeScriptHex: string;
  tapTreeHex: string; // VtxoScript.encode() as hex — the SDK's craftToSignTx drops this
  // Extra info needed to create the swap VTXO's forfeit (SDK can't sign it — wrong key)
  vtxoSatsValue: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forfeitTapLeafScript: any; // TapLeafScript = [{ version, internalKey, merklePath }, script]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArkProvider = any;

export class IntrospectorArkProvider {
  private inner: ArkProvider;
  private swapContext: SwapContext | null = null;
  // Saved from registerIntent for use in submitFinalization
  private lastSignedIntentProof: string | null = null;       // full proof (all sigs) — for ASP
  private lastStrippedIntentProof: string | null = null;     // stripped proof (swap sig only) — for introspector
  private lastIntentMessage: string | null = null;
  // Collected from tree_tx events during batch
  private connectorTreeChunks: TxTreeNode[] = [];
  // Captured from batch_finalization event (SDK may not pass it to submitSignedForfeitTxs)
  private capturedCommitmentTx: string | null = null;

  constructor(inner: ArkProvider) {
    this.inner = inner;
  }

  /** Set swap context before calling wallet.settle(). Throws if a swap is already in progress. */
  setSwapContext(ctx: SwapContext): void {
    if (this.swapContext) {
      throw new Error(
        `IntrospectorProvider: swap already in progress for ${this.swapContext.offerOutpoint}. ` +
        `Call clearSwapContext() first or wait for the current swap to complete.`
      );
    }
    this.swapContext = ctx;
    this.lastSignedIntentProof = null;
    this.lastStrippedIntentProof = null;
    this.lastIntentMessage = null;
    this.connectorTreeChunks = [];
    this.capturedCommitmentTx = null;
  }

  clearSwapContext(): void {
    this.swapContext = null;
    this.lastSignedIntentProof = null;
    this.lastStrippedIntentProof = null;
    this.lastIntentMessage = null;
    this.connectorTreeChunks = [];
    this.capturedCommitmentTx = null;
  }

  // ── Intercepted methods ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async registerIntent(intent: any): Promise<string> {
    if (!this.swapContext) {
      // No swap context — pass through without introspector
      return this.inner.registerIntent(intent);
    }

    const arkadeScriptBytes = scureHex.decode(this.swapContext.arkadeScriptHex);
    const tapTreeBytes = scureHex.decode(this.swapContext.tapTreeHex);

    // ── STEP 1: Raw SDK proof (before our modifications)
    await this.dumpPsbtFields("STEP1: raw SDK intent.proof", intent.proof);

    // Inject taptree + arkadescript PSBT fields into the intent proof.
    const modifiedProof = await this.injectSwapPsbtFields(
      intent.proof,
      arkadeScriptBytes,
      tapTreeBytes
    );

    // ── STEP 2: After injecting taptree + arkadescript
    await this.dumpPsbtFields("STEP2: after injectSwapPsbtFields", modifiedProof);

    const encodedMessage =
      typeof intent.message === "string"
        ? intent.message
        : JSON.stringify(intent.message, (_, v) =>
            typeof v === "bigint" ? Number(v) : v
          );

    // Strip tapscript signatures from non-swap inputs before sending to introspector.
    const introspectorProof = await this.stripNonSwapSigs(modifiedProof);

    // ── STEP 3: After stripping non-swap sigs (sent to introspector)
    await this.dumpPsbtFields("STEP3: introspectorProof (sent to /v1/intent)", introspectorProof);

    // Send to introspector for validation and co-signing
    console.log("[IntrospectorProvider] Submitting intent to introspector...");
    const result = await introspectorSubmitIntent(introspectorProof, encodedMessage);

    // ── STEP 4: Introspector's returned PSBT (after Go round-trip)
    await this.dumpPsbtFields("STEP4: result.signedProof (returned by introspector)", result.signedProof);

    // Merge the introspector's signature into the full original proof
    const finalProof = await this.mergeIntrospectorSig(modifiedProof, result.signedProof);

    // ── STEP 5: Final merged proof (sent to ASP)
    await this.dumpPsbtFields("STEP5: finalProof (merged, sent to ASP)", finalProof);

    // Save both versions for SubmitFinalization
    this.lastSignedIntentProof = finalProof;
    this.lastStrippedIntentProof = result.signedProof; // <-- THIS IS WHAT WE SEND TO FINALIZATION
    this.lastIntentMessage = encodedMessage;

    console.log(
      "[IntrospectorProvider] ⚠️ lastStrippedIntentProof = result.signedProof " +
      "(introspector's Go round-trip output — check STEP4 for arkadescript presence)"
    );

    // Forward to ASP with the co-signed proof
    const modifiedIntent = { ...intent, proof: finalProof };
    return this.inner.registerIntent(modifiedIntent);
  }

  async submitSignedForfeitTxs(
    signedForfeitTxs: string[],
    signedCommitmentTx?: string
  ): Promise<void> {
    if (!this.swapContext || !this.lastSignedIntentProof || this.lastIntentMessage === null) {
      // No swap context — pass through
      return this.inner.submitSignedForfeitTxs(
        signedForfeitTxs,
        signedCommitmentTx
      );
    }

    // ── STEP 6: The proof we're about to send to introspector finalization
    await this.dumpPsbtFields(
      "STEP6: lastStrippedIntentProof (sent to /v1/finalization)",
      this.lastStrippedIntentProof!
    );

    // ── Build the missing swap VTXO forfeit ──────────────────────────────
    // The SDK can't create this forfeit because the swap VTXO isn't in the
    // taker's getVirtualCoins() (it's the maker's VTXO). The SDK treats it
    // as a "boarding input" and silently skips forfeit creation. But the ASP
    // knows it's a VTXO and requires a forfeit. We build it here and let
    // the introspector co-sign it via /v1/finalization.
    const swapVtxoForfeit = await this.buildSwapVtxoForfeit();

    const allForfeits = swapVtxoForfeit
      ? [swapVtxoForfeit, ...signedForfeitTxs]
      : signedForfeitTxs;

    console.log(
      "[IntrospectorProvider] Submitting finalization to introspector...",
      `forfeits=${allForfeits.length} (${swapVtxoForfeit ? "swap+taker" : "taker only"}),`,
      `connectorChunks=${this.connectorTreeChunks.length}`
    );

    // Use SDK-provided commitment tx, or fall back to the one we captured from the event stream
    const commitmentTx = signedCommitmentTx || this.capturedCommitmentTx || undefined;
    console.log(
      "[IntrospectorProvider] commitmentTx source:",
      signedCommitmentTx ? "SDK" : this.capturedCommitmentTx ? "captured from event" : "NONE"
    );

    const finalizationResult = await introspectorSubmitFinalization({
      signedIntent: {
        proof: this.lastStrippedIntentProof!,
        message: this.lastIntentMessage,
      },
      forfeits: allForfeits,
      connectorTree: this.connectorTreeChunks,
      commitmentTx,
    });

    // The introspector co-signs the swap VTXO forfeit and returns it in signedForfeits.
    // The taker's original forfeits are NOT returned (no matching signed input).
    // We must always include BOTH: introspector's swap forfeit + taker's original forfeits.
    const introspectorForfeits = finalizationResult.signedForfeits.length > 0
      ? finalizationResult.signedForfeits
      : (swapVtxoForfeit ? [swapVtxoForfeit] : []);
    const forfeitsToSubmit = [...introspectorForfeits, ...signedForfeitTxs];

    // Merge introspector's commitment tx signature with SDK's
    let finalCommitmentTx = signedCommitmentTx;
    if (finalizationResult.signedCommitmentTx && signedCommitmentTx) {
      const { Psbt } = await import("./psbt-combiner");
      finalCommitmentTx = Psbt.combine(
        finalizationResult.signedCommitmentTx,
        signedCommitmentTx
      );
      console.log("[IntrospectorProvider] Merged introspector + SDK commitment tx signatures");
    } else if (finalizationResult.signedCommitmentTx) {
      finalCommitmentTx = finalizationResult.signedCommitmentTx;
    }

    console.log(
      "[IntrospectorProvider] Forwarding to ASP:",
      `forfeits=${forfeitsToSubmit.length},`,
      `commitmentTx=${finalCommitmentTx ? "yes" : "none"}`
    );

    return this.inner.submitSignedForfeitTxs(forfeitsToSubmit, finalCommitmentTx);
  }

  getEventStream(
    signal: AbortSignal,
    topics: string[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncIterableIterator<any> {
    const innerIterator = this.inner.getEventStream(signal, topics);

    if (!this.swapContext) {
      return innerIterator;
    }

    // Wrap to capture connector tree chunks from TreeTx events
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const result = await innerIterator.next();
        if (!result.done && result.value) {
          const event = result.value;
          // tree_tx events with batchIndex === 1 are connector tree chunks
          if (event.type === "tree_tx" && event.batchIndex === 1) {
            self.connectorTreeChunks.push(event.chunk);
          }
          // Capture commitment tx from batch_finalization event
          if (event.type === "batch_finalization" && event.commitmentTx) {
            self.capturedCommitmentTx = event.commitmentTx;
          }
        }
        return result;
      },
      async return(value?: unknown) {
        if (innerIterator.return) {
          return innerIterator.return(value);
        }
        return { done: true as const, value: undefined };
      },
      async throw(e?: unknown) {
        if (innerIterator.throw) {
          return innerIterator.throw(e);
        }
        throw e;
      },
    };
  }

  // ── Pass-through methods ────────────────────────────────────────────────

  getInfo() {
    return this.inner.getInfo();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submitTx(...args: any[]) {
    return this.inner.submitTx(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalizeTx(...args: any[]) {
    return this.inner.finalizeTx(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteIntent(...args: any[]) {
    return this.inner.deleteIntent(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirmRegistration(...args: any[]) {
    return this.inner.confirmRegistration(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submitTreeNonces(...args: any[]) {
    return this.inner.submitTreeNonces(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submitTreeSignatures(...args: any[]) {
    return this.inner.submitTreeSignatures(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTransactionsStream(...args: any[]) {
    return this.inner.getTransactionsStream(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPendingTxs(...args: any[]) {
    return this.inner.getPendingTxs(...args);
  }


  // ── PSBT diagnostics ──────────────────────────────────────────────────

  /**
   * Log unknown fields and tapScriptSig presence for each input in a PSBT.
   * Used to trace where arkadescript/taptree fields get dropped.
   */
  private async dumpPsbtFields(label: string, base64Proof: string): Promise<void> {
    try {
      const { Transaction } = await import("@scure/btc-signer");
      const { base64 } = await import("@scure/base");
      const tx = Transaction.fromPSBT(base64.decode(base64Proof), { allowUnknown: true });
      const lines: string[] = [`[PSBT-DUMP] ${label} — ${tx.inputsLength} inputs`];
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        const unknowns = inp.unknown ?? [];
        const unknownKeys = unknowns.map((u: [{ type: number; key: Uint8Array }, Uint8Array]) => {
          const keyType = u[0].type;
          const keyName = new TextDecoder().decode(u[0].key);
          const valLen = u[1].length;
          return `{type=0x${keyType.toString(16)},key="${keyName}",valLen=${valLen}}`;
        });
        const hasTapScriptSig = inp.tapScriptSig && inp.tapScriptSig.length > 0;
        const hasTapLeafScript = inp.tapLeafScript && inp.tapLeafScript.length > 0;
        lines.push(
          `  input[${i}]: tapScriptSig=${hasTapScriptSig ? inp.tapScriptSig.length + " entries" : "NONE"}, ` +
          `tapLeafScript=${hasTapLeafScript ? "YES" : "NONE"}, ` +
          `unknowns=[${unknownKeys.join(", ") || "EMPTY"}]`
        );
      }
      console.log(lines.join("\n"));
    } catch (e) {
      console.log(`[PSBT-DUMP] ${label} — ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── PSBT manipulation ──────────────────────────────────────────────────

  /**
   * Inject taptree + arkadescript PSBT fields into the intent proof.
   *
   * The SDK's intent PSBT layout: input 0 = message input, input 1+ = VTXO inputs.
   *
   * Why we inject taptree here:
   *   The SDK's craftToSignTx (intent/index.js) creates `new Transaction({ version, lockTime })`
   *   WITHOUT `allowUnknown: true`. When it then calls `tx.updateInput(i, { unknown: [...] })`,
   *   @scure/btc-signer's mergeKeyMap silently deletes the unknown fields. This is an SDK bug —
   *   prepareCoinAsIntentProofInput correctly sets VtxoTaprootTree but craftToSignTx drops it.
   *   We re-inject it here after the SDK produces the PSBT.
   */
  private async injectSwapPsbtFields(
    base64Proof: string,
    arkadeScript: Uint8Array,
    tapTree: Uint8Array
  ): Promise<string> {
    const { Transaction } = await import("@scure/btc-signer");
    const { base64 } = await import("@scure/base");

    const psbtBytes = base64.decode(base64Proof);
    const tx = Transaction.fromPSBT(psbtBytes, { allowUnknown: true });

    const inputCount = tx.inputsLength;
    if (inputCount < 2) {
      throw new Error(
        `PSBT has ${inputCount} input(s), expected at least 2 (message + VTXO). ` +
        `Cannot inject swap PSBT fields.`
      );
    }

    // Input 0 = message, input 1 = swap VTXO, inputs 2+ = taker's funding VTXOs.
    // Only inject swap fields into the swap VTXO (input 1) — taker's VTXOs have their own taptree.
    tx.updateInput(1, {
      unknown: [
        [{ type: ARK_PSBT_KEY_TYPE, key: TAPTREE_FIELD_KEY }, tapTree],
        [{ type: ARK_PSBT_KEY_TYPE, key: ARKADE_SCRIPT_FIELD_KEY }, arkadeScript],
      ],
    });

    return base64.encode(tx.toPSBT());
  }

  /**
   * Merge the introspector's signed PSBT with the original full proof.
   *
   * Strategy: start from the introspector's response (which has the co-sig on input 1)
   * and restore what's missing from the original:
   *   - Taker's tapScriptSig on inputs 2+ (were stripped before sending to introspector)
   *   - Unknown fields (taptree, arkadescript) the Go PSBT lib may have dropped
   *
   * We work at the raw PSBT bytes level by splicing input sections.
   */
  private async mergeIntrospectorSig(
    originalBase64: string,
    signedBase64: string
  ): Promise<string> {
    // BIP-174 PSBT Combiner: merge introspector's co-sig (input 1) into
    // the original proof (has taker's sigs on all inputs + unknown fields).
    const { Psbt } = await import("./psbt-combiner");
    return Psbt.combine(originalBase64, signedBase64);
  }

  /**
   * Strip tapscript signatures from non-swap inputs (inputs 2+) so the introspector
   * skips them. The introspector's getSignedInputs() iterates inputs with
   * TaprootScriptSpendSig and requires arkadescript on each — but only input 1
   * (the swap VTXO) has it. Removing sigs from taker's funding inputs avoids
   * "input does not specify any ArkadeScript" errors.
   *
   * Uses raw PSBT byte manipulation because @scure/btc-signer's
   * updateInput({ tapScriptSig: [] }) is a no-op and doesn't actually clear entries.
   *
   * Returns a NEW base64 PSBT for the introspector (the original is untouched).
   */
  private async stripNonSwapSigs(base64Proof: string): Promise<string> {
    const { Transaction } = await import("@scure/btc-signer");
    const { base64 } = await import("@scure/base");

    // Count inputs to know which indices to strip (2+)
    const tx = Transaction.fromPSBT(base64.decode(base64Proof), { allowUnknown: true });
    const inputCount = tx.inputsLength;
    if (inputCount <= 2) return base64Proof; // nothing to strip

    const indicesToStrip = Array.from({ length: inputCount - 2 }, (_, i) => i + 2);

    const { Psbt } = await import("./psbt-combiner");
    return Psbt.stripTapScriptSig(base64Proof, indicesToStrip);
  }

  /**
   * Build a forfeit PSBT for the swap VTXO.
   *
   * The SDK's handleSettlementFinalizationEvent skips creating this forfeit because
   * the swap VTXO isn't in the taker's getVirtualCoins() (it's the maker's VTXO).
   * The SDK treats it as a "boarding input", but the ASP knows it's a VTXO and
   * requires a forfeit. We construct it here using the same format as the SDK's
   * buildForfeitTx (forfeit.js): input 0 = VTXO, input 1 = connector, output = ASP forfeit address.
   *
   * The forfeit is UNSIGNED — the introspector will co-sign it via /v1/finalization
   * (the introspector's tweaked key is in the swap leaf's MultisigClosure).
   */
  private async buildSwapVtxoForfeit(): Promise<string | null> {
    if (!this.swapContext) return null;

    try {
      const { Transaction, SigHash } = await import("@scure/btc-signer");
      const { base64 } = await import("@scure/base");

      // Parse the connector tree to find an available connector leaf
      const connector = await this.getConnectorLeaf();
      if (!connector) {
        console.warn("[IntrospectorProvider] No connector available for swap VTXO forfeit");
        return null;
      }

      // Get the forfeit output script from the ASP info
      const forfeitOutputScript = await this.getForfeitOutputScript();
      if (!forfeitOutputScript) {
        console.warn("[IntrospectorProvider] Could not get forfeit output script from ASP");
        return null;
      }

      // Derive the swap VTXO's pkScript from its tapTree
      const sdk = await import("@arkade-os/sdk");
      const tapTreeBytes = scureHex.decode(this.swapContext.tapTreeHex);
      const vtxoScript = sdk.VtxoScript.decode(tapTreeBytes);
      const pkScript = vtxoScript.pkScript;

      const [txid, voutStr] = this.swapContext.offerOutpoint.split(":");
      const vout = parseInt(voutStr, 10);
      const vtxoAmount = BigInt(this.swapContext.vtxoSatsValue);

      // Build forfeit tx: same structure as SDK's buildForfeitTx (forfeit.js)
      const tx = new Transaction({ version: 3 });

      // Input 0: swap VTXO (with forfeit tapLeafScript for introspector to sign)
      tx.addInput({
        txid,
        index: vout,
        witnessUtxo: {
          amount: vtxoAmount,
          script: pkScript,
        },
        sighashType: SigHash.DEFAULT,
        tapLeafScript: [this.swapContext.forfeitTapLeafScript],
      });

      // Input 1: connector from the connector tree
      tx.addInput({
        txid: connector.txid,
        index: 0,
        witnessUtxo: {
          amount: connector.amount,
          script: connector.script,
        },
      });

      // Output: total value → ASP's forfeit address
      tx.addOutput({
        script: forfeitOutputScript,
        amount: vtxoAmount + connector.amount,
      });

      // P2A anchor output (standard for Ark forfeits)
      tx.addOutput({
        script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]),
        amount: 0n,
      });

      const psbtBase64 = base64.encode(tx.toPSBT());
      console.log(
        "[IntrospectorProvider] Built swap VTXO forfeit PSBT:",
        `vtxo=${this.swapContext.offerOutpoint}, connector=${connector.txid}:0`
      );
      return psbtBase64;
    } catch (e) {
      console.error("[IntrospectorProvider] Failed to build swap VTXO forfeit:", e);
      return null;
    }
  }

  /**
   * Parse the connector tree chunks and return the first leaf connector.
   * The SDK assigns connectors in input order, skipping boarding inputs.
   * Since the SDK treats the swap VTXO as boarding, connector[0] went to the
   * taker's VTXO. We use the next available connector (index 1+) for the swap VTXO.
   */
  private async getConnectorLeaf(): Promise<{
    txid: string;
    amount: bigint;
    script: Uint8Array;
  } | null> {
    if (this.connectorTreeChunks.length === 0) return null;

    try {
      const { Transaction } = await import("@scure/btc-signer");
      const { base64 } = await import("@scure/base");

      // Build the tree structure like the SDK does (TxTree.create)
      // Parse all chunks into transactions
      interface DecodedChunk {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx: any; // Transaction
        children: Record<number, string>;
      }
      const chunksByTxid = new Map<string, DecodedChunk>();
      for (const chunk of this.connectorTreeChunks) {
        const tx = Transaction.fromPSBT(base64.decode(chunk.tx));
        chunksByTxid.set(tx.id, { tx, children: chunk.children });
      }

      // Collect leaf connectors (nodes with no children in the tree)
      const leaves: { txid: string; amount: bigint; script: Uint8Array }[] = [];
      for (const [, chunk] of chunksByTxid) {
        if (Object.keys(chunk.children).length > 0) continue;
        const output = chunk.tx.getOutput(0);
        if (output?.amount && output?.script) {
          leaves.push({ txid: chunk.tx.id, amount: output.amount, script: output.script });
        }
      }

      console.log(`[IntrospectorProvider] Connector tree: ${leaves.length} leaves found`);

      // The SDK used leaf[0] for the taker's VTXO forfeit.
      // We need a different leaf for the swap VTXO.
      // If there's only 1 leaf, use it (the ASP may have created just enough).
      // If there are 2+, use leaf[1] since the SDK took leaf[0].
      if (leaves.length === 0) return null;
      // Use the last leaf — the SDK assigns from index 0 upward
      return leaves[leaves.length > 1 ? leaves.length - 1 : 0];
    } catch (e) {
      console.error("[IntrospectorProvider] Failed to parse connector tree:", e);
      return null;
    }
  }

  /**
   * Get the ASP's forfeit output script (the address forfeits pay to).
   */
  private async getForfeitOutputScript(): Promise<Uint8Array | null> {
    try {
      const info = await this.inner.getInfo();
      if (!info.forfeitAddress) {
        console.warn("[IntrospectorProvider] ASP info has no forfeitAddress");
        return null;
      }

      const { Address, OutScript } = await import("@scure/btc-signer");
      const { TEST_NETWORK } = await import("@scure/btc-signer/utils.js");
      // Mutinynet/testnet/signet all use TEST_NETWORK (bech32: "tb")
      const decoded = Address(TEST_NETWORK).decode(info.forfeitAddress as string);
      return OutScript.encode(decoded);
    } catch (e) {
      console.error("[IntrospectorProvider] Failed to get forfeit output script:", e);
      return null;
    }
  }
}
