/**
 * EVM chain configuration and token address registry.
 *
 * All addresses are checksummed. Chain IDs follow EIP-155.
 * Only tokens supported by the Lendaswap backend are listed.
 */

// ── Chain keys (used in UI selectors) ───────────────────────────────────────

export type EvmChainKey = "arbitrum" | "ethereum" | "polygon";
export type StablecoinKey = "USDC" | "USDT";

// ── Chain metadata ──────────────────────────────────────────────────────────

export interface EvmChainInfo {
  key: EvmChainKey;
  chainId: number;
  label: string;
  /** Lendaswap SDK chain identifier */
  sdkChain: string;
  blockExplorerUrl: string;
}

export const EVM_CHAINS: Record<EvmChainKey, EvmChainInfo> = {
  arbitrum: {
    key: "arbitrum",
    chainId: 42161,
    label: "Arbitrum",
    sdkChain: "42161",
    blockExplorerUrl: "https://arbiscan.io",
  },
  ethereum: {
    key: "ethereum",
    chainId: 1,
    label: "Ethereum",
    sdkChain: "1",
    blockExplorerUrl: "https://etherscan.io",
  },
  polygon: {
    key: "polygon",
    chainId: 137,
    label: "Polygon",
    sdkChain: "137",
    blockExplorerUrl: "https://polygonscan.com",
  },
};

// ── Token addresses per chain ───────────────────────────────────────────────

export interface StablecoinInfo {
  key: StablecoinKey;
  name: string;
  decimals: number;
  /** Mapping from chain key → ERC-20 contract address */
  addresses: Record<EvmChainKey, string>;
}

export const SUPPORTED_STABLECOINS: Record<StablecoinKey, StablecoinInfo> = {
  USDC: {
    key: "USDC",
    name: "USD Coin",
    decimals: 6,
    addresses: {
      arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    },
  },
  USDT: {
    key: "USDT",
    name: "Tether USD",
    decimals: 6,
    addresses: {
      arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    },
  },
};

// ── Helper functions ────────────────────────────────────────────────────────

export function getTokenAddress(coin: StablecoinKey, chain: EvmChainKey): string {
  return SUPPORTED_STABLECOINS[coin].addresses[chain];
}

export function getChainId(chain: EvmChainKey): number {
  return EVM_CHAINS[chain].chainId;
}

export function getChainName(chain: EvmChainKey): string {
  return EVM_CHAINS[chain].label;
}

export function getTokenDecimals(coin: StablecoinKey): number {
  return SUPPORTED_STABLECOINS[coin].decimals;
}

/**
 * Convert a human-readable stablecoin amount (e.g. "50.25") to the
 * smallest unit as bigint (e.g. 50_250_000n for 6-decimal USDC).
 */
export function toSmallestUnit(amount: string, coin: StablecoinKey): bigint {
  const decimals = getTokenDecimals(coin);
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(paddedFrac);
}

/**
 * Convert smallest-unit amount to human-readable string.
 */
export function fromSmallestUnit(amount: string | bigint, coin: StablecoinKey): string {
  const decimals = getTokenDecimals(coin);
  const str = amount.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
