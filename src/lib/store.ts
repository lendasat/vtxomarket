import { create } from "zustand";
import type { NDKUser, NDKUserProfile } from "@nostr-dev-kit/ndk";
import type { BalanceInfo } from "./ark-wallet";

export interface Token {
  id: string;                    // Nostr event id
  assetId: string;               // Ark asset id
  name: string;
  ticker: string;
  description: string;
  image?: string;
  creator: string;               // pubkey hex
  creatorArkAddress: string;     // for trading
  createdAt: number;
  supply: number;
  // Bonding curve
  virtualTokenReserves: number;
  virtualSatReserves: number;
  realTokenReserves: number;
  // Derived
  price: number;
  marketCap: number;
  curveProgress: number;
  // Social
  replies: number;
  tradeCount: number;
  // Links
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface HeldAsset {
  assetId: string;
  amount: number;
}

interface AppState {
  // Wallet seed
  mnemonic: string | null;

  // Nostr
  user: NDKUser | null;
  profile: NDKUserProfile | null;
  connected: boolean;
  nostrReady: boolean;

  // Wallet
  walletReady: boolean;
  walletError: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arkWallet: any;
  balance: BalanceInfo | null;
  addresses: { offchainAddr: string; boardingAddr: string } | null;

  // Tokens
  tokens: Token[];
  tokensLoading: boolean;
  tokensLoaded: boolean;

  // Held assets
  heldAssets: HeldAsset[];

  // Actions
  setMnemonic: (mnemonic: string | null) => void;
  setUser: (user: NDKUser | null) => void;
  setProfile: (profile: NDKUserProfile | null) => void;
  setConnected: (connected: boolean) => void;
  setNostrReady: (ready: boolean) => void;
  setWalletReady: (ready: boolean) => void;
  setWalletError: (error: string | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setArkWallet: (wallet: any) => void;
  setBalance: (balance: BalanceInfo | null) => void;
  setAddresses: (addresses: { offchainAddr: string; boardingAddr: string } | null) => void;
  setTokens: (tokens: Token[]) => void;
  addToken: (token: Token) => void;
  upsertToken: (token: Token) => void;
  setTokensLoading: (loading: boolean) => void;
  setTokensLoaded: (loaded: boolean) => void;
  setHeldAssets: (assets: HeldAsset[]) => void;
}

export const useAppStore = create<AppState>((set) => ({
  mnemonic: null,
  user: null,
  profile: null,
  connected: false,
  nostrReady: false,
  walletReady: false,
  walletError: null,
  arkWallet: null,
  balance: null,
  addresses: null,
  tokens: [],
  tokensLoading: false,
  tokensLoaded: false,
  heldAssets: [],
  setMnemonic: (mnemonic) => set({ mnemonic }),
  setUser: (user) => set({ user }),
  setProfile: (profile) => set({ profile }),
  setConnected: (connected) => set({ connected }),
  setNostrReady: (nostrReady) => set({ nostrReady }),
  setWalletReady: (walletReady) => set({ walletReady }),
  setWalletError: (walletError) => set({ walletError }),
  setArkWallet: (arkWallet) => set({ arkWallet }),
  setBalance: (balance) => set({ balance }),
  setAddresses: (addresses) => set({ addresses }),
  setTokens: (tokens) => set({ tokens }),
  addToken: (token) => set((state) => ({ tokens: [token, ...state.tokens] })),
  upsertToken: (token) =>
    set((state) => {
      const idx = state.tokens.findIndex(
        (t) => t.ticker === token.ticker || t.id === token.id
      );
      if (idx >= 0) {
        const updated = [...state.tokens];
        updated[idx] = token;
        return { tokens: updated };
      }
      return { tokens: [...state.tokens, token] };
    }),
  setTokensLoading: (tokensLoading) => set({ tokensLoading }),
  setTokensLoaded: (tokensLoaded) => set({ tokensLoaded }),
  setHeldAssets: (heldAssets) => set({ heldAssets }),
}));
