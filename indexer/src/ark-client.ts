/**
 * Thin HTTP client for the arkd REST API.
 * No SDK dependency — just fetch().
 */

import { config } from "./config";
import { log } from "./logger";
import type { IndexerVtxo, AssetMetadata } from "./types";

const BASE = config.arkServerUrl;

/**
 * Batch-fetch VTXOs by outpoints from the arkd indexer.
 * Returns VTXOs that include the `assets[]` field (asset holdings).
 *
 * arkd endpoint: GET /v1/indexer/vtxos?outpoints=txid:vout&outpoints=txid:vout...
 */
export async function fetchVtxosByOutpoints(outpoints: string[]): Promise<IndexerVtxo[]> {
  if (outpoints.length === 0) return [];

  const url = new URL(`${BASE}/v1/indexer/vtxos`);
  for (const op of outpoints) {
    url.searchParams.append("outpoints", op);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      log.warn("fetchVtxosByOutpoints: non-OK response", {
        status: res.status,
        outpointsCount: outpoints.length,
      });
      return [];
    }

    const json = (await res.json()) as { vtxos?: IndexerVtxo[] };
    return json.vtxos ?? [];
  } catch (err) {
    log.error("fetchVtxosByOutpoints: fetch failed", { error: String(err) });
    return [];
  }
}

/**
 * Fetch asset metadata from GET /v1/indexer/asset/:id
 *
 * Actual response shape:
 *   { assetId: string, supply: string, controlAsset?: string, metadata?: string }
 *
 * `metadata` is a hex-encoded TLV binary blob (MetadataList format):
 *   - varint count of items
 *   - for each item: varint-length key bytes + varint-length value bytes
 *   Keys are UTF-8 strings: "name", "ticker", "decimals", "icon"
 */
export async function fetchAssetMetadata(assetId: string): Promise<AssetMetadata | null> {
  try {
    const res = await fetch(`${BASE}/v1/indexer/asset/${encodeURIComponent(assetId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      assetId?: string;
      supply?: string;
      controlAsset?: string;
      metadata?: string;
    };

    // Decode the TLV metadata blob to extract name/ticker/decimals
    const meta = json.metadata ? decodeMetadataList(json.metadata) : {};

    return {
      assetId: json.assetId ?? assetId,
      name: meta["name"],
      ticker: meta["ticker"],
      decimals: meta["decimals"] !== undefined ? Number(meta["decimals"]) : undefined,
      supply: json.supply,
      icon: meta["icon"],
    };
  } catch (err) {
    log.warn("fetchAssetMetadata: failed", { assetId, error: String(err) });
    return null;
  }
}

/**
 * Decode a hex-encoded MetadataList TLV blob into a plain key→value map.
 *
 * Format (mirrors SDK asset/metadata.ts):
 *   varint(count) [ varint(keyLen) key varint(valLen) val ] ...
 *   varints are LEB128 (7 bits per byte, MSB continuation flag).
 */
function decodeMetadataList(hexStr: string): Record<string, string> {
  let buf: Uint8Array;
  try {
    buf = hexToBytes(hexStr);
  } catch {
    return {};
  }

  let offset = 0;

  function readVarUint(): number {
    let result = 0;
    let shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return result;
  }

  function readVarSlice(): Uint8Array {
    const len = readVarUint();
    const slice = buf.subarray(offset, offset + len);
    offset += len;
    return slice;
  }

  const td = new TextDecoder();
  const result: Record<string, string> = {};
  try {
    const count = readVarUint();
    for (let i = 0; i < count; i++) {
      const key = td.decode(readVarSlice());
      const value = td.decode(readVarSlice());
      result[key] = value;
    }
  } catch {
    // partial decode is fine — return whatever we got
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
