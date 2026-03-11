"use client";

import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { mainnet, arbitrum, polygon } from "@reown/appkit/networks";
import { createAppKit } from "@reown/appkit/react";

const projectId = "a15c535db177c184c98bdbdc5ff12590";

const networks = [arbitrum, mainnet, polygon];

const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: false,
});

createAppKit({
  adapters: [wagmiAdapter],
  networks: [networks[0], ...networks.slice(1)],
  projectId,
  metadata: {
    name: "vtxo.market",
    description: "Token marketplace on Arkade",
    url: typeof window !== "undefined" ? window.location.origin : "",
    icons: [],
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
