/**
 * REST client for the Arkade Introspector service.
 *
 * The introspector is a standalone gRPC/REST co-signer that validates Arkade Script
 * conditions (introspection opcodes) and co-signs PSBTs. It exposes an HTTP REST gateway.
 *
 * @see https://github.com/ArkLabsHQ/introspector
 */

const INTROSPECTOR_URL =
  process.env.NEXT_PUBLIC_INTROSPECTOR_URL || "http://localhost:7073";

export interface IntrospectorInfo {
  version: string;
  signerPubkey: string; // hex compressed pubkey — must be tweaked with arkade script hash
}

export interface SubmitIntentRequest {
  intent: {
    proof: string;   // base64 PSBT
    message: string; // base64 register message
  };
}

export interface SubmitIntentResponse {
  signedProof: string; // base64 PSBT with introspector's co-signature
}

export interface TxTreeNode {
  txid: string;
  tx: string;
  children: Record<number, string>;
}

export interface SubmitFinalizationRequest {
  signedIntent: {
    proof: string;
    message: string;
  };
  forfeits: string[];        // base64 PSBTs
  connectorTree: TxTreeNode[];
  commitmentTx?: string;     // base64 PSBT
}

export interface SubmitFinalizationResponse {
  signedForfeits: string[];    // base64 PSBTs
  signedCommitmentTx?: string; // base64 PSBT
}

async function introspectorFetch<T>(
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  };
  if (body) {
    opts.method = "POST";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${INTROSPECTOR_URL}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Introspector ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

/** Get introspector info (base signer pubkey). */
export async function getIntrospectorInfo(): Promise<IntrospectorInfo> {
  return introspectorFetch<IntrospectorInfo>("/v1/info");
}

/** Submit intent proof for arkade script validation and co-signing. */
export async function submitIntent(
  proof: string,
  message: string
): Promise<SubmitIntentResponse> {
  return introspectorFetch<SubmitIntentResponse>("/v1/intent", {
    intent: { proof, message },
  });
}

/** Submit forfeits for co-signing (introspector verifies its sig exists in intent). */
export async function submitFinalization(
  req: SubmitFinalizationRequest
): Promise<SubmitFinalizationResponse> {
  return introspectorFetch<SubmitFinalizationResponse>(
    "/v1/finalization",
    req
  );
}
