"use client";

/**
 * EvmConnectButton — Minimal WalletConnect button for stablecoin flows.
 *
 * Shows "Connect Wallet" when disconnected, truncated address when connected.
 * Uses @reown/appkit modal for wallet selection.
 */

import { useAppKit } from "@reown/appkit/react";
import { useAccount, useDisconnect } from "wagmi";

export function EvmConnectButton() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  const truncated = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => open().catch(console.error)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.1] text-xs font-medium text-muted-foreground/70 hover:bg-white/[0.1] transition-all"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <code>{truncated}</code>
        </button>
        <button
          onClick={() => disconnect()}
          className="text-[10px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => open().catch(console.error)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.1] text-xs font-medium text-muted-foreground/50 hover:bg-white/[0.1] hover:text-muted-foreground/70 transition-all"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3.5 w-3.5"
      >
        <path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1H2V4Zm0 3v5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H2Zm7 2a1 1 0 1 1 2 0 1 1 0 0 1-2 0Z" />
      </svg>
      Connect Wallet
    </button>
  );
}

/** Hook to get the connected EVM address (or undefined). */
export function useEvmAddress(): string | undefined {
  const { address, isConnected } = useAccount();
  return isConnected ? address : undefined;
}
