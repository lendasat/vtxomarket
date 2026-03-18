import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  serverExternalPackages: ["@arkade-os/sdk", "@arkade-os/boltz-swap"],
};

export default nextConfig;
