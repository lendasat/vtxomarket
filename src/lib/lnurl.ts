/**
 * LNURL-pay & Lightning Address support
 * Handles: lnurl1... bech32 strings and user@domain.com Lightning Addresses
 */

import { bech32 } from "@scure/base";

const TIMEOUT = 30_000;

// ── Types ──────────────────────────────────────────────────────────

export interface LnurlPayParams {
  callback: string;
  minSendable: number; // millisatoshis
  maxSendable: number; // millisatoshis
  metadata: string | null;
  description: string | null;
  domain: string;
}

export interface LnurlInvoiceResult {
  pr: string; // BOLT11 invoice
  routes: unknown[];
}

// ── Detection ──────────────────────────────────────────────────────

export function isLnurl(input: string): boolean {
  const cleaned = input.toLowerCase().trim().replace(/^lightning:/, "");
  return cleaned.startsWith("lnurl");
}

export function isLightningAddress(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.includes("@")) return false;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  const [user, domain] = parts;
  if (!user || !domain || !domain.includes(".")) return false;
  return true;
}

export function isLnurlOrLightningAddress(input: string): boolean {
  return isLnurl(input) || isLightningAddress(input);
}

// ── Decoding ───────────────────────────────────────────────────────

/** Decode bech32-encoded LNURL to a URL string */
export function decodeLnurl(lnurl: string): string | null {
  try {
    const cleaned = lnurl.toLowerCase().trim().replace(/^lightning:/, "");
    const decoded = bech32.decodeToBytes(cleaned);
    return new TextDecoder().decode(decoded.bytes);
  } catch {
    return null;
  }
}

/** Convert user@domain.com to https://domain/.well-known/lnurlp/user */
export function lightningAddressToUrl(address: string): string {
  const [user, domain] = address.trim().split("@");
  return `https://${domain}/.well-known/lnurlp/${user}`;
}

// ── Fetch pay params ───────────────────────────────────────────────

/** Fetch LNURL-pay parameters from an LNURL string or Lightning Address */
export async function fetchPayParams(
  input: string
): Promise<LnurlPayParams | null> {
  try {
    let url: string;

    if (isLightningAddress(input)) {
      url = lightningAddressToUrl(input);
    } else if (isLnurl(input)) {
      const decoded = decodeLnurl(input);
      if (!decoded) return null;
      url = decoded;
    } else {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return null;

    const json = await response.json();

    // Error response
    if (json.status === "ERROR") return null;

    // Must be a payRequest
    if (json.tag !== "payRequest") return null;

    // Parse description from metadata
    let description: string | null = null;
    const metadata = (json.metadata as string) ?? null;
    if (metadata) {
      try {
        const metadataList = JSON.parse(metadata) as unknown[][];
        for (const item of metadataList) {
          if (
            Array.isArray(item) &&
            item.length >= 2 &&
            item[0] === "text/plain"
          ) {
            description = item[1] as string;
            break;
          }
        }
      } catch {
        // ignore metadata parse errors
      }
    }

    const uri = new URL(url);

    return {
      callback: json.callback as string,
      minSendable: json.minSendable as number,
      maxSendable: json.maxSendable as number,
      metadata,
      description,
      domain: uri.host,
    };
  } catch {
    return null;
  }
}

// ── Request invoice ────────────────────────────────────────────────

/** Request a BOLT11 invoice from LNURL callback. Amount in satoshis. */
export async function requestInvoice(
  callback: string,
  amountSats: number
): Promise<LnurlInvoiceResult | null> {
  try {
    const amountMsat = amountSats * 1000;
    const separator = callback.includes("?") ? "&" : "?";
    const url = `${callback}${separator}amount=${amountMsat}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return null;

    const json = await response.json();

    if (json.status === "ERROR") return null;

    const pr = json.pr as string | undefined;
    if (!pr) return null;

    return { pr, routes: json.routes ?? [] };
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

export function minSats(params: LnurlPayParams): number {
  return Math.ceil(params.minSendable / 1000);
}

export function maxSats(params: LnurlPayParams): number {
  return Math.floor(params.maxSendable / 1000);
}
