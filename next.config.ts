import type { NextConfig } from "next";

const LENDASWAP_API_URL = (
  process.env.NEXT_PUBLIC_LENDASWAP_API_URL || "https://api.lendaswap.com"
).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  serverExternalPackages: ["@arkade-os/sdk", "@arkade-os/boltz-swap"],
  async rewrites() {
    return [
      {
        source: "/api/lendaswap/:path*",
        destination: `${LENDASWAP_API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
