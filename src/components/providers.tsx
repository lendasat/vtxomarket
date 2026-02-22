"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { useWallet } from "@/hooks/useWallet";

function WalletInit() {
  useWallet();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <WalletInit />
      {children}
    </TooltipProvider>
  );
}
