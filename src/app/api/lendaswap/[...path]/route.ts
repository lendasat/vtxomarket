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

// Only forward these safe headers to the upstream API
const FORWARDED_HEADERS = ["content-type", "accept", "accept-language"];

async function proxyRequest(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;

  // Block path traversal attempts
  if (path.some(segment => segment === ".." || segment === "." || segment === "")) {
    return new Response("Invalid path", { status: 400 });
  }

  const targetPath = path.join("/");

  // Only allow alphanumeric paths with hyphens, underscores, and dots
  if (!/^[\w\-./]+$/.test(targetPath)) {
    return new Response("Invalid path characters", { status: 400 });
  }

  const url = new URL(request.url);
  const targetUrl = `${LENDASWAP_API_URL}/${targetPath}${url.search}`;

  // Build a clean header set — never forward cookies, auth, or other sensitive headers
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const val = request.headers.get(name);
    if (val) headers.set(name, val);
  }
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
