"use client";

/**
 * Coin & chain selector toggles — shared by Send and Receive flows.
 *
 * Matches the existing CoinChainSelectors in wallet/page.tsx but is
 * self-contained with its own SVG icons (no external dependencies).
 */

import type { EvmChainKey, StablecoinKey } from "../lib/constants";

// ── Coin metadata ───────────────────────────────────────────────────────────

const COINS: { key: StablecoinKey; color: string; icon: React.ReactNode }[] = [
  {
    key: "USDC",
    color: "text-blue-400",
    icon: (
      <svg viewBox="0 0 2000 2000" className="h-4 w-4 shrink-0">
        <path
          d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
          fill="#2775ca"
        />
        <path
          d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
          fill="#fff"
        />
        <path
          d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
          fill="#fff"
        />
      </svg>
    ),
  },
  {
    key: "USDT",
    color: "text-emerald-400",
    icon: (
      <svg viewBox="0 0 339.43 295.27" className="h-4 w-4 shrink-0">
        <path
          d="M62.15,1.45l-61.89,130a2.52,2.52,0,0,0,.54,2.94L167.95,294.56a2.55,2.55,0,0,0,3.53,0L338.63,134.4a2.52,2.52,0,0,0,.54-2.94l-61.89-130A2.5,2.5,0,0,0,275,0H64.45a2.5,2.5,0,0,0-2.3,1.45h0Z"
          fill="#50af95"
          fillRule="evenodd"
        />
        <path
          d="M191.19,144.8v0c-1.2.09-7.4,0.46-21.23,0.46-11,0-18.81-.33-21.55-0.46v0c-42.51-1.87-74.24-9.27-74.24-18.13s31.73-16.25,74.24-18.15v28.91c2.78,0.2,10.74.67,21.74,0.67,13.2,0,19.81-.55,21-0.66v-28.9c42.42,1.89,74.08,9.29,74.08,18.13s-31.65,16.24-74.08,18.12h0Zm0-39.25V79.68h59.2V40.23H89.21V79.68H148.4v25.86c-48.11,2.21-84.29,11.74-84.29,23.16s36.18,20.94,84.29,23.16v82.9h42.78V151.83c48-2.21,84.12-11.73,84.12-23.14s-36.09-20.93-84.12-23.15h0Zm0,0h0Z"
          fill="#fff"
          fillRule="evenodd"
        />
      </svg>
    ),
  },
];

// ── Chain metadata ──────────────────────────────────────────────────────────

const CHAINS: { key: EvmChainKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "arbitrum",
    label: "Arbitrum",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#213147" />
        <path
          d="M10.87 6.22 13.5 12.3l-1.12.65-2.63-6.08 1.12-.65Zm2.63 6.08.94 2.18-1.12.65-.94-2.18 1.12-.65Z"
          fill="#28A0F0"
        />
        <path
          d="M9.13 6.22 6.5 12.3l1.12.65 2.63-6.08-1.12-.65Zm-2.63 6.08-.94 2.18 1.12.65.94-2.18-1.12-.65Z"
          fill="white"
        />
      </svg>
    ),
  },
  {
    key: "ethereum",
    label: "Ethereum",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#627EEA" />
        <path d="M10 3v5.25l4.38 1.96L10 3Z" fill="white" fillOpacity="0.6" />
        <path d="M10 3 5.62 10.21 10 8.25V3Z" fill="white" />
        <path d="M10 13.47v3.52l4.38-6.06L10 13.47Z" fill="white" fillOpacity="0.6" />
        <path d="M10 16.99v-3.52l-4.38-2.54L10 17Z" fill="white" />
        <path d="M10 12.66l4.38-2.45L10 8.25v4.41Z" fill="white" fillOpacity="0.2" />
        <path d="M5.62 10.21 10 12.66V8.25l-4.38 1.96Z" fill="white" fillOpacity="0.6" />
      </svg>
    ),
  },
  {
    key: "polygon",
    label: "Polygon",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        <circle cx="10" cy="10" r="10" fill="#8247E5" />
        <path
          d="M13.05 8.36a.77.77 0 0 0-.76 0l-1.35.8-1.21.69-1.35.8a.77.77 0 0 1-.76 0l-1.06-.63a.77.77 0 0 1-.38-.66v-1.2a.73.73 0 0 1 .38-.65l1.06-.6a.77.77 0 0 1 .76 0l1.06.62a.77.77 0 0 1 .38.65v.8l1.21-.7v-.83a.73.73 0 0 0-.38-.66l-2.24-1.3a.77.77 0 0 0-.76 0l-2.3 1.33a.73.73 0 0 0-.38.65v2.62a.73.73 0 0 0 .38.65l2.27 1.31a.77.77 0 0 0 .76 0l1.35-.77 1.21-.72 1.35-.77a.77.77 0 0 1 .76 0l1.06.6a.77.77 0 0 1 .38.66v1.2a.73.73 0 0 1-.38.65l-1.03.63a.77.77 0 0 1-.76 0l-1.06-.6a.77.77 0 0 1-.38-.66v-.77l-1.21.7v.8a.73.73 0 0 0 .38.66l2.27 1.3a.77.77 0 0 0 .76 0l2.27-1.3a.77.77 0 0 0 .38-.66V9.64a.73.73 0 0 0-.38-.65l-2.3-1.32Z"
          fill="white"
        />
      </svg>
    ),
  },
];

// ── Component ───────────────────────────────────────────────────────────────

interface CoinChainSelectorsProps {
  coin: StablecoinKey;
  setCoin: (v: StablecoinKey) => void;
  chain: EvmChainKey;
  setChain: (v: EvmChainKey) => void;
  disabled?: boolean;
  /** Restrict which coins are shown (default: all) */
  allowedCoins?: StablecoinKey[];
}

export function CoinChainSelectors({
  coin,
  setCoin,
  chain,
  setChain,
  disabled,
  allowedCoins,
}: CoinChainSelectorsProps) {
  const visibleCoins = allowedCoins ? COINS.filter((c) => allowedCoins.includes(c.key)) : COINS;

  return (
    <div className="flex gap-2">
      {/* Coin toggle */}
      <div className="flex rounded-lg bg-white/[0.04] border border-white/[0.07] p-0.5">
        {visibleCoins.map(({ key, color, icon }) => (
          <button
            key={key}
            onClick={() => setCoin(key)}
            disabled={disabled}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
              coin === key
                ? `bg-white/[0.1] ${color}`
                : "text-muted-foreground/40 hover:text-muted-foreground/60 opacity-50 hover:opacity-70"
            } disabled:cursor-not-allowed`}
          >
            {icon}
            {key}
          </button>
        ))}
      </div>

      {/* Chain icons */}
      <div className="flex items-center gap-1 ml-auto">
        {CHAINS.map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setChain(key)}
            disabled={disabled}
            title={label}
            className={`h-8 w-8 rounded-lg flex items-center justify-center transition-all ${
              chain === key
                ? "bg-white/[0.1] border border-white/[0.14] ring-1 ring-white/[0.06]"
                : "bg-white/[0.04] border border-transparent hover:bg-white/[0.07] opacity-40 hover:opacity-70"
            } disabled:cursor-not-allowed`}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}
