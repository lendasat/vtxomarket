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

// Warn if non-localhost HTTP is used (PSBTs contain partial signatures)
if (
  typeof window !== "undefined" &&
  INTROSPECTOR_URL.startsWith("http://") &&
  !INTROSPECTOR_URL.includes("localhost") &&
  !INTROSPECTOR_URL.includes("127.0.0.1")
) {
  console.warn(
    "[introspector-client] WARNING: Using unencrypted HTTP for a remote introspector URL. " +
    "PSBTs contain partial signatures. Use HTTPS in production: " + INTROSPECTOR_URL
  );
}

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
    signal: AbortSignal.timeout(30_000),
  };
  // Only set Content-Type and method for POST requests
  if (body) {
    opts.method = "POST";
    opts.headers = { "Content-Type": "application/json" };
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
  const data = await introspectorFetch<Record<string, unknown>>("/v1/info");
  // Validate response shape
  if (typeof data.signerPubkey !== "string" || !data.signerPubkey) {
    throw new Error("Introspector /v1/info: missing or invalid signerPubkey");
  }
  return data as unknown as IntrospectorInfo;
}

/** Submit intent proof for arkade script validation and co-signing. */
export async function submitIntent(
  proof: string,
  message: string
): Promise<SubmitIntentResponse> {
  const data = await introspectorFetch<Record<string, unknown>>("/v1/intent", {
    intent: { proof, message },
  });
  // Validate response — signedProof must be a non-empty base64 string
  if (typeof data.signedProof !== "string" || !data.signedProof) {
    throw new Error("Introspector /v1/intent: missing or invalid signedProof in response");
  }
  return data as unknown as SubmitIntentResponse;
}

/** Submit forfeits for co-signing (introspector verifies its sig exists in intent). */
export async function submitFinalization(
  req: SubmitFinalizationRequest
): Promise<SubmitFinalizationResponse> {
  const data = await introspectorFetch<Record<string, unknown>>(
    "/v1/finalization",
    req
  );
  // Validate response — signedForfeits must be an array
  if (!Array.isArray(data.signedForfeits)) {
    throw new Error("Introspector /v1/finalization: missing or invalid signedForfeits in response");
  }
  return data as unknown as SubmitFinalizationResponse;
}
