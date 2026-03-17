/**
 * Centralized amount formatting for vtxo.market.
 *
 * Convention (international/financial):
 *   Thousands separator: comma (,)
 *   Decimal separator:   dot (.)
 *   e.g., 1,000,000.50
 *
 * We use explicit Intl.NumberFormat("en-US") to avoid locale-dependent
 * behavior (German locales use dots for thousands which clashes with
 * decimal dots and makes amounts unreadable).
 */

const intFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatInt(n: number): string {
  return intFormatter.format(n);
}

/**
 * Format a raw token amount respecting the token's decimals field.
 * e.g., formatTokenAmount(1000000, 6) => "1"
 *       formatTokenAmount(1500000, 6) => "1.5"
 *       formatTokenAmount(1000000, 0) => "1,000,000"
 *       formatTokenAmount(9999999999, 8) => "99.99999999"
 * When decimals is undefined or 0, treats as whole units with comma separators.
 */
export function formatTokenAmount(rawAmount: number, decimals?: number): string {
  if (!decimals || decimals <= 0) {
    return formatInt(rawAmount);
  }

  const divisor = 10 ** decimals;
  const value = rawAmount / divisor;

  // Format with up to `decimals` fractional digits, then trim trailing zeros.
  const formatted = value.toFixed(decimals);

  if (formatted.includes(".")) {
    const trimmed = formatted.replace(/0+$/, "");
    if (trimmed.endsWith(".")) {
      return formatInt(Number(trimmed.slice(0, -1)));
    }
    const [intPart, fracPart] = trimmed.split(".");
    return `${formatInt(Number(intPart))}.${fracPart}`;
  }

  return formatInt(Number(formatted));
}

/**
 * Parse a user-entered decimal string back to raw integer amount.
 * Inverse of formatTokenAmount.
 * Accepts both comma and dot as decimal separator for user convenience.
 * Strips thousand separators (commas when dot is decimal, dots when comma is decimal).
 *
 * e.g., parseTokenInput("1.5", 6)   => 1500000
 *       parseTokenInput("1,5", 6)   => 1500000
 *       parseTokenInput("1,000", 0) => 1000
 *       parseTokenInput("100", 0)   => 100
 */
export function parseTokenInput(input: string, decimals?: number): number {
  let cleaned = input.trim();

  // Detect format: if both comma and dot are present, the last one is the decimal sep.
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma > lastDot) {
    // European format: 1.000,50 → remove dots (thousands), replace comma with dot
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // International format: 1,000.50 → remove commas (thousands)
    cleaned = cleaned.replace(/,/g, "");
  }

  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) return 0;

  if (!decimals || decimals <= 0) {
    return Math.round(parsed);
  }

  return Math.round(parsed * 10 ** decimals);
}

/**
 * Format sats for compact display.
 * e.g., 1500000000 => "1.5B", 1500000 => "1.5M", 1500 => "1.5K", 500 => "500"
 */
export function formatSats(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return formatInt(n);
}

/**
 * Format a price as sat per display-unit token.
 * When decimals > 0, adjusts so the price reflects "per 1.0 display token"
 * not "per 1 raw unit".
 * e.g., 1000 sats for 1000000 raw tokens with decimals=6 => "1,000 sat/token"
 *       1000 sats for 100 raw tokens with decimals=0 => "10 sat/token"
 */
export function formatPrice(satAmount: number, tokenAmount: number, decimals?: number): string {
  if (tokenAmount === 0) return "0 sat/token";

  const displayTokens = decimals && decimals > 0 ? tokenAmount / 10 ** decimals : tokenAmount;

  const price = satAmount / displayTokens;

  // Format with up to 2 decimal places, trimming trailing zeros
  const fixed = price.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");

  const [intPart, fracPart] = trimmed.split(".");
  const intFormatted = formatInt(Number(intPart));

  return fracPart ? `${intFormatted}.${fracPart} sat/token` : `${intFormatted} sat/token`;
}
