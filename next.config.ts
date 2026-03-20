import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.STATIC_EXPORT === "true" && { output: "export" }),
  serverExternalPackages: ["@arkade-os/sdk", "@arkade-os/boltz-swap"],
};

export default nextConfig;
