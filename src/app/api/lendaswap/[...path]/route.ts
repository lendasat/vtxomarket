/**
 * Server-side proxy for Lendaswap API.
 * Injects the API key header so it never reaches the client bundle.
 */

const LENDASWAP_API_URL = (
  process.env.LENDASWAP_API_URL ||
  process.env.NEXT_PUBLIC_LENDASWAP_API_URL ||
  "https://api.lendaswap.com"
).replace(/\/+$/, "");

const LENDASWAP_API_KEY = process.env.LENDASWAP_API_KEY || "";

async function proxyRequest(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const targetPath = path.join("/");
  const url = new URL(request.url);
  const targetUrl = `${LENDASWAP_API_URL}/${targetPath}${url.search}`;

  const headers = new Headers(request.headers);
  // Remove host header (will be set by fetch to the target)
  headers.delete("host");
  // Inject API key server-side
  if (LENDASWAP_API_KEY) {
    headers.set("x-api-key", LENDASWAP_API_KEY);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  // Forward body for non-GET/HEAD requests
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error -- needed for streaming body forwarding in Node
    init.duplex = "half";
  }

  const resp = await fetch(targetUrl, init);

  // Forward the response back, stripping hop-by-hop headers
  const respHeaders = new Headers(resp.headers);
  respHeaders.delete("transfer-encoding");

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const DELETE = proxyRequest;
export const PATCH = proxyRequest;
