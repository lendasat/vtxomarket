import { create } from "zustand";
import type { NDKUser } from "@nostr-dev-kit/ndk";
import type { BalanceInfo } from "./ark-wallet";

export interface Token {
  id: string;
  name: string;
  ticker: string;
  description: string;
  image?: string;
  creator: string;
  createdAt: number;
  marketCap: number;
  replies: number;
}

interface AppState {
  // Wallet seed
  mnemonic: string | null;

  // Nostr
  user: NDKUser | null;
  connected: boolean;

  // Wallet
  walletReady: boolean;
  walletError: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arkWallet: any;
  balance: BalanceInfo | null;
  addresses: { offchainAddr: string; boardingAddr: string } | null;

  // Tokens
  tokens: Token[];

  // Actions
  setMnemonic: (mnemonic: string | null) => void;
  setUser: (user: NDKUser | null) => void;
  setConnected: (connected: boolean) => void;
  setWalletReady: (ready: boolean) => void;
  setWalletError: (error: string | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setArkWallet: (wallet: any) => void;
  setBalance: (balance: BalanceInfo | null) => void;
  setAddresses: (addresses: { offchainAddr: string; boardingAddr: string } | null) => void;
  setTokens: (tokens: Token[]) => void;
  addToken: (token: Token) => void;
}

export const useAppStore = create<AppState>((set) => ({
  mnemonic: null,
  user: null,
  connected: false,
  walletReady: false,
  walletError: null,
  arkWallet: null,
  balance: null,
  addresses: null,
  tokens: [],
  setMnemonic: (mnemonic) => set({ mnemonic }),
  setUser: (user) => set({ user }),
  setConnected: (connected) => set({ connected }),
  setWalletReady: (walletReady) => set({ walletReady }),
  setWalletError: (walletError) => set({ walletError }),
  setArkWallet: (arkWallet) => set({ arkWallet }),
  setBalance: (balance) => set({ balance }),
  setAddresses: (addresses) => set({ addresses }),
  setTokens: (tokens) => set({ tokens }),
  addToken: (token) => set((state) => ({ tokens: [token, ...state.tokens] })),
}));
