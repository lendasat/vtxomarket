/**
 * Upload an image to nostr.build using NIP-96 (HTTP file storage) with a
 * NIP-98 HTTP Auth header signed by the user's existing Nostr key.
 *
 * We use the same NDK signer that already powers all Nostr events in this app —
 * no extra API keys or accounts required.
 *
 * Why not embed base64? The Arkade SDK serialises the full `icon` string
 * verbatim into the OP_RETURN of the issuance transaction. A base64 data URI
 * can be hundreds of KB, which blows past the Bitcoin transaction weight limit
 * (TX_TOO_LARGE). A plain HTTPS URL (~60 bytes) is safe.
 */

import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "./nostr";

const NOSTR_BUILD_UPLOAD = "https://nostr.build/api/v2/upload/files";

/**
 * Build a NIP-98 HTTP Auth event signed with the user's Nostr key.
 * nostr.build uses this to associate the upload with the account.
 */
async function buildNip98AuthHeader(url: string, method: string): Promise<string> {
  const ndk = getNDK();
  if (!ndk.signer) {
    throw new Error("Nostr signer not ready");
  }

  const event = new NDKEvent(ndk);
  event.kind = 27235; // NDKKind.HttpAuth
  event.tags = [
    ["u", url],
    ["method", method],
  ];
  event.created_at = Math.floor(Date.now() / 1000);
  event.content = "";

  await event.sign();

  const rawEvent = event.rawEvent();
  return "Nostr " + btoa(JSON.stringify(rawEvent));
}

export async function uploadImage(file: File): Promise<string> {
  const authHeader = await buildNip98AuthHeader(NOSTR_BUILD_UPLOAD, "POST");

  const formData = new FormData();
  formData.append("fileToUpload", file);

  const res = await fetch(NOSTR_BUILD_UPLOAD, {
    method: "POST",
    headers: { Authorization: authHeader },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Image upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();

  // NIP-96 response shape: { nip94_event: { tags: [["url", "https://..."], ...] } }
  const url: string | undefined =
    json?.nip94_event?.tags?.find((t: string[]) => t[0] === "url")?.[1] ??
    // fallback shapes some servers use
    json?.data?.[0]?.url ??
    json?.url;

  if (!url) {
    throw new Error("Image upload succeeded but no URL was returned");
  }

  return url;
}
