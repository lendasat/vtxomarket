import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NODE_ENV === "production" && { output: "export" }),
  serverExternalPackages: ["@arkade-os/sdk", "@arkade-os/boltz-swap"],
};

export default nextConfig;
