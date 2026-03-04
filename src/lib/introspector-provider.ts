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
 *   provider.setSwapContext({ offerOutpoint, arkadeScriptHex });
 *   await wallet.settle(params); // uses the wrapped provider
 *   provider.clearSwapContext();
 */

import { hex as scureHex } from "@scure/base";
import {
  submitIntent as introspectorSubmitIntent,
  submitFinalization as introspectorSubmitFinalization,
  type TxTreeNode,
} from "./introspector-client";

// PSBT custom field key for arkade script (matches introspector's expectation)
const ARK_PSBT_KEY_TYPE = 0xDE;
const ARKADE_SCRIPT_FIELD_KEY = new TextEncoder().encode("arkadescript");

interface SwapContext {
  offerOutpoint: string;
  arkadeScriptHex: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArkProvider = any;

export class IntrospectorArkProvider {
  private inner: ArkProvider;
  private swapContext: SwapContext | null = null;
  // Saved from registerIntent for use in submitFinalization
  private lastSignedIntentProof: string | null = null;
  private lastIntentMessage: string | null = null;
  // Collected from TreeTx events during batch
  private connectorTreeChunks: TxTreeNode[] = [];

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
    this.lastIntentMessage = null;
    this.connectorTreeChunks = [];
  }

  clearSwapContext(): void {
    this.swapContext = null;
    this.lastSignedIntentProof = null;
    this.lastIntentMessage = null;
    this.connectorTreeChunks = [];
  }

  // ── Intercepted methods ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async registerIntent(intent: any): Promise<string> {
    if (!this.swapContext) {
      // No swap context — pass through without introspector
      return this.inner.registerIntent(intent);
    }

    const arkadeScriptBytes = scureHex.decode(this.swapContext.arkadeScriptHex);

    // Inject arkadescript PSBT field into the intent proof
    const modifiedProof = await this.injectArkadeScriptField(
      intent.proof,
      arkadeScriptBytes
    );

    // Send to introspector for validation and co-signing
    console.log("[IntrospectorProvider] Submitting intent to introspector...");
    const result = await introspectorSubmitIntent(modifiedProof, intent.message);

    // Save the co-signed intent for SubmitFinalization later
    this.lastSignedIntentProof = result.signedProof;
    this.lastIntentMessage = intent.message;

    // Forward to ASP with the co-signed proof
    const modifiedIntent = { ...intent, proof: result.signedProof };
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

    // Send to introspector for co-signing
    console.log(
      "[IntrospectorProvider] Submitting finalization to introspector...",
      `forfeits=${signedForfeitTxs.length}, connectorChunks=${this.connectorTreeChunks.length}`
    );

    const finalizationResult = await introspectorSubmitFinalization({
      signedIntent: {
        proof: this.lastSignedIntentProof,
        message: this.lastIntentMessage,
      },
      forfeits: signedForfeitTxs,
      connectorTree: this.connectorTreeChunks,
      commitmentTx: signedCommitmentTx,
    });

    // When swap context is active, introspector MUST co-sign forfeits.
    // An empty response means the introspector failed to validate — do not
    // fall back to unsigned forfeits as the ASP would reject them anyway.
    if (finalizationResult.signedForfeits.length === 0 && signedForfeitTxs.length > 0) {
      throw new Error(
        "Introspector returned empty signedForfeits — co-signing failed. " +
        "The swap cannot proceed without introspector signatures."
      );
    }

    // Forward the introspector-signed versions to ASP
    return this.inner.submitSignedForfeitTxs(
      finalizationResult.signedForfeits,
      finalizationResult.signedCommitmentTx || signedCommitmentTx
    );
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
          // TreeTx events with batchIndex === 1 are connector tree chunks
          if (event.type === "treeTx" && event.batchIndex === 1) {
            self.connectorTreeChunks.push(event.chunk);
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

  // ── PSBT manipulation ──────────────────────────────────────────────────

  /**
   * Inject the arkadescript PSBT custom field into the intent proof.
   *
   * The SDK's intent PSBT layout: input 0 = message input, input 1+ = VTXO inputs.
   * We add the arkade script field to all VTXO inputs. The introspector skips
   * inputs that don't have the field.
   */
  private async injectArkadeScriptField(
    base64Proof: string,
    arkadeScript: Uint8Array
  ): Promise<string> {
    const { Transaction } = await import("@scure/btc-signer");
    const { base64 } = await import("@scure/base");

    const psbtBytes = base64.decode(base64Proof);
    const tx = Transaction.fromPSBT(psbtBytes);

    const inputCount = tx.inputsLength;
    if (inputCount < 2) {
      throw new Error(
        `PSBT has ${inputCount} input(s), expected at least 2 (message + VTXO). ` +
        `Cannot inject arkade script field.`
      );
    }

    // Skip input 0 (message), inject into all VTXO inputs (1+)
    for (let i = 1; i < inputCount; i++) {
      tx.updateInput(i, {
        unknown: [[{ type: ARK_PSBT_KEY_TYPE, key: ARKADE_SCRIPT_FIELD_KEY }, arkadeScript]],
      });
    }

    return base64.encode(tx.toPSBT());
  }
}
