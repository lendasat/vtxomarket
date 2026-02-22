/**
 * Constant-product bonding curve engine (pump.fun style).
 *
 * virtualTokenReserves * virtualSatReserves = k (invariant)
 *
 * All values are integers (sats / raw token units). No decimals.
 */

// ── Constants ────────────────────────────────────────────────────────

export const TOKEN_TOTAL_SUPPLY = 1_000_000_000;
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000;
export const INITIAL_VIRTUAL_SAT_RESERVES = 30_000_000; // 0.3 BTC
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000;

// ── Types ────────────────────────────────────────────────────────────

export interface CurveState {
  virtualTokenReserves: number;
  virtualSatReserves: number;
  realTokenReserves: number;
}

export interface BuyResult {
  tokensOut: number;
  newState: CurveState;
  effectivePrice: number; // sats per token
}

export interface SellResult {
  satsOut: number;
  newState: CurveState;
  effectivePrice: number; // sats per token
}

// ── Functions ────────────────────────────────────────────────────────

export function initialCurveState(): CurveState {
  return {
    virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualSatReserves: INITIAL_VIRTUAL_SAT_RESERVES,
    realTokenReserves: INITIAL_REAL_TOKEN_RESERVES,
  };
}

/**
 * Calculate how many tokens a buyer receives for `satAmount` sats.
 * Uses constant-product formula: (vT - tokensOut) * (vS + satAmount) = vT * vS
 */
export function calculateBuyTokens(state: CurveState, satAmount: number): BuyResult {
  if (satAmount <= 0) {
    return { tokensOut: 0, newState: { ...state }, effectivePrice: getPrice(state) };
  }

  const { virtualTokenReserves: vT, virtualSatReserves: vS, realTokenReserves: rT } = state;
  const k = vT * vS;
  const newVirtualSatReserves = vS + satAmount;
  const newVirtualTokenReserves = Math.ceil(k / newVirtualSatReserves);
  let tokensOut = vT - newVirtualTokenReserves;

  // Can't buy more than remaining real tokens
  tokensOut = Math.min(tokensOut, rT);
  if (tokensOut <= 0) {
    return { tokensOut: 0, newState: { ...state }, effectivePrice: getPrice(state) };
  }

  const newState: CurveState = {
    virtualTokenReserves: vT - tokensOut,
    virtualSatReserves: newVirtualSatReserves,
    realTokenReserves: rT - tokensOut,
  };

  return {
    tokensOut,
    newState,
    effectivePrice: satAmount / tokensOut,
  };
}

/**
 * Calculate how many sats a seller receives for `tokenAmount` tokens.
 * Inverse of buy: (vT + tokenAmount) * (vS - satsOut) = vT * vS
 */
export function calculateSellSats(state: CurveState, tokenAmount: number): SellResult {
  if (tokenAmount <= 0) {
    return { satsOut: 0, newState: { ...state }, effectivePrice: getPrice(state) };
  }

  const { virtualTokenReserves: vT, virtualSatReserves: vS, realTokenReserves: rT } = state;
  const k = vT * vS;
  const newVirtualTokenReserves = vT + tokenAmount;
  const newVirtualSatReserves = Math.ceil(k / newVirtualTokenReserves);
  const satsOut = vS - newVirtualSatReserves;

  if (satsOut <= 0) {
    return { satsOut: 0, newState: { ...state }, effectivePrice: getPrice(state) };
  }

  const newState: CurveState = {
    virtualTokenReserves: newVirtualTokenReserves,
    virtualSatReserves: newVirtualSatReserves,
    realTokenReserves: rT + tokenAmount,
  };

  return {
    satsOut,
    newState,
    effectivePrice: satsOut / tokenAmount,
  };
}

/** Current spot price: sats per token */
export function getPrice(state: CurveState): number {
  return state.virtualSatReserves / state.virtualTokenReserves;
}

/** Market cap in sats (spot price * total supply) */
export function getMarketCap(state: CurveState): number {
  return Math.floor(getPrice(state) * TOKEN_TOTAL_SUPPLY);
}

/** Percentage of real tokens sold (0–100) */
export function getCurveProgress(state: CurveState): number {
  const sold = INITIAL_REAL_TOKEN_RESERVES - state.realTokenReserves;
  return Math.min(100, (sold / INITIAL_REAL_TOKEN_RESERVES) * 100);
}

/** True when all real tokens have been sold */
export function isCurveComplete(state: CurveState): boolean {
  return state.realTokenReserves <= 0;
}

/** Estimate slippage percentage for a buy of `satAmount` sats */
export function calculateSlippage(state: CurveState, satAmount: number): number {
  if (satAmount <= 0) return 0;
  const spotPrice = getPrice(state);
  const { effectivePrice } = calculateBuyTokens(state, satAmount);
  if (spotPrice <= 0) return 0;
  return ((effectivePrice - spotPrice) / spotPrice) * 100;
}
