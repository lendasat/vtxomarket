"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/auth-gate";
import { useWallet } from "@/hooks/useWallet";
import { useCreatorMarketMaker } from "@/hooks/useCreatorMarketMaker";

function WalletInit() {
  useWallet();
  return null;
}

function CreatorMarketMaker() {
  useCreatorMarketMaker();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <AuthGate>
        <WalletInit />
        <CreatorMarketMaker />
        {children}
      </AuthGate>
    </TooltipProvider>
  );
}
