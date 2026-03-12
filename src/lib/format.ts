/**
 * Centralized amount formatting for vtxo.market.
 */

/**
 * Format a raw token amount respecting the token's decimals field.
 * e.g., formatTokenAmount(1000000, 6) => "1"
 *       formatTokenAmount(1500000, 6) => "1.5"
 *       formatTokenAmount(1000000, 0) => "1,000,000"
 *       formatTokenAmount(50, 2) => "0.5"
 * When decimals is undefined or 0, treats as whole units with comma separators.
 */
export function formatTokenAmount(rawAmount: number, decimals?: number): string {
  if (!decimals || decimals <= 0) {
    return rawAmount.toLocaleString();
  }

  const divisor = 10 ** decimals;
  const value = rawAmount / divisor;

  // Format with up to `decimals` fractional digits, then trim trailing zeros.
  const formatted = value.toFixed(decimals);

  // If there's a decimal point, trim trailing zeros but keep at least one
  // decimal digit when the value has a fractional part.
  if (formatted.includes(".")) {
    const trimmed = formatted.replace(/0+$/, "");
    // If we trimmed everything after the dot, drop the dot too
    if (trimmed.endsWith(".")) {
      return Number(trimmed.slice(0, -1)).toLocaleString();
    }
    // Split so we can add comma separators to the integer part
    const [intPart, fracPart] = trimmed.split(".");
    return `${Number(intPart).toLocaleString()}.${fracPart}`;
  }

  return Number(formatted).toLocaleString();
}

/**
 * Parse a user-entered decimal string back to raw integer amount.
 * Inverse of formatTokenAmount.
 * e.g., parseTokenInput("1.5", 6) => 1500000
 *       parseTokenInput("100", 0) => 100
 */
export function parseTokenInput(input: string, decimals?: number): number {
  const cleaned = input.replace(/,/g, "");
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
 * This consolidates the 4 duplicate formatSats functions across the codebase.
 */
export function formatSats(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/**
 * Format a price as sat per display-unit token.
 * When decimals > 0, adjusts so the price reflects "per 1.0 display token"
 * not "per 1 raw unit".
 * e.g., 1000 sats for 1000000 raw tokens with decimals=6 => "1,000 sat/token"
 *       1000 sats for 100 raw tokens with decimals=0 => "10 sat/token"
 */
export function formatPrice(
  satAmount: number,
  tokenAmount: number,
  decimals?: number,
): string {
  if (tokenAmount === 0) return "0 sat/token";

  const displayTokens =
    decimals && decimals > 0
      ? tokenAmount / 10 ** decimals
      : tokenAmount;

  const price = satAmount / displayTokens;

  // Format with up to 2 decimal places, trimming trailing zeros
  const fixed = price.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");

  // Add comma separators to the integer part
  const [intPart, fracPart] = trimmed.split(".");
  const intFormatted = Number(intPart).toLocaleString();

  return fracPart
    ? `${intFormatted}.${fracPart} sat/token`
    : `${intFormatted} sat/token`;
}
