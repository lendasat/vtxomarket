"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/auth-gate";
import { useWallet } from "@/hooks/useWallet";

function WalletInit() {
  useWallet();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <AuthGate>
        <WalletInit />
        {children}
      </AuthGate>
    </TooltipProvider>
  );
}
