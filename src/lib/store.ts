import { create } from "zustand";
import type { NDKUser, NDKUserProfile } from "@nostr-dev-kit/ndk";
import type { BalanceInfo } from "./ark-wallet";
import type { StablecoinTxItem } from "@/lendaswap_integration/lib/types";

export interface Token {
  id: string; // Nostr event id
  assetId: string; // Ark asset id
  name: string;
  ticker: string;
  description: string;
  image?: string;
  creator: string; // pubkey hex
  creatorArkAddress: string; // for trading
  createdAt: number;
  supply: number;
  decimals?: number; // 0–18, default 0 (whole units)
  controlAssetId?: string; // present when token is reissuable
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
  // Nostr
  user: NDKUser | null;
  profile: NDKUserProfile | null;
  connected: boolean;
  nostrReady: boolean;

  // Wallet
  walletReady: boolean;
  walletError: string | null;
  hasCachedData: boolean; // true when showing stale localStorage data before live connect
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

  // Stablecoin swap transactions (survives navigation)
  stablecoinTxs: StablecoinTxItem[];

  // Actions
  setUser: (user: NDKUser | null) => void;
  setProfile: (profile: NDKUserProfile | null) => void;
  setConnected: (connected: boolean) => void;
  setNostrReady: (ready: boolean) => void;
  setWalletReady: (ready: boolean) => void;
  setWalletError: (error: string | null) => void;
  setHasCachedData: (cached: boolean) => void;
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
  upsertStablecoinTx: (tx: StablecoinTxItem) => void;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  profile: null,
  connected: false,
  nostrReady: false,
  walletReady: false,
  walletError: null,
  hasCachedData: false,
  arkWallet: null,
  balance: null,
  addresses: null,
  tokens: [],
  tokensLoading: false,
  tokensLoaded: false,
  heldAssets: [],
  stablecoinTxs: [],
  setUser: (user) => set({ user }),
  setProfile: (profile) => set({ profile }),
  setConnected: (connected) => set({ connected }),
  setNostrReady: (nostrReady) => set({ nostrReady }),
  setWalletReady: (walletReady) => set({ walletReady }),
  setWalletError: (walletError) => set({ walletError }),
  setHasCachedData: (hasCachedData) => set({ hasCachedData }),
  setArkWallet: (arkWallet) => set({ arkWallet }),
  setBalance: (balance) => set({ balance }),
  setAddresses: (addresses) => set({ addresses }),
  setTokens: (tokens) => set({ tokens }),
  addToken: (token) => set((state) => ({ tokens: [token, ...state.tokens] })),
  upsertToken: (token) =>
    set((state) => {
      const idx = state.tokens.findIndex((t) => t.ticker === token.ticker || t.id === token.id);
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
  upsertStablecoinTx: (tx) =>
    set((state) => {
      const idx = state.stablecoinTxs.findIndex((t) => t.swapId === tx.swapId);
      if (idx >= 0) {
        const updated = [...state.stablecoinTxs];
        updated[idx] = tx;
        return { stablecoinTxs: updated };
      }
      return { stablecoinTxs: [tx, ...state.stablecoinTxs] };
    }),
}));
