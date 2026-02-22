/**
 * Trade engine: coordinates Ark transfers with Nostr events.
 *
 * Creator-as-Market-Maker (CMM) model:
 * - Buy:  Buyer sends sats to creator → Creator sends tokens to buyer
 * - Sell: Seller sends tokens to creator → Creator sends sats to seller
 */

import { calculateBuyTokens, calculateSellSats, type CurveState } from "./bonding-curve";
import { sendPayment, sendAsset, getReceivingAddresses, type ArkWallet } from "./ark-wallet";
import {
  publishOrderEvent,
  publishTradeReceipt,
  publishCurveState,
  type OrderData,
  type TradeReceiptData,
} from "./nostr-market";

// ── Buy flow ────────────────────────────────────────────────────────

export interface ExecuteBuyParams {
  ticker: string;
  satAmount: number;
  creatorArkAddress: string;
  curveState: CurveState;
  buyerPubkey: string;
}

export interface ExecuteBuyResult {
  arkTxId: string;
  expectedTokens: number;
}

/**
 * Execute the buyer side of a trade:
 * 1. Calculate expected tokens from bonding curve
 * 2. Send sats to creator's Ark address
 * 3. Publish order event to Nostr
 */
export async function executeBuy(
  wallet: ArkWallet,
  params: ExecuteBuyParams
): Promise<ExecuteBuyResult> {
  const { ticker, satAmount, creatorArkAddress, curveState, buyerPubkey } = params;

  // Calculate expected tokens
  const { tokensOut } = calculateBuyTokens(curveState, satAmount);
  if (tokensOut <= 0) {
    throw new Error("Trade too small or curve complete");
  }

  // Send sats to creator
  const arkTxId = await sendPayment(wallet, creatorArkAddress, satAmount);

  // Get buyer's address for the order
  const addrs = await getReceivingAddresses(wallet);

  // Publish order event
  await publishOrderEvent({
    ticker,
    arkTxId,
    type: "buy",
    sats: satAmount,
    expectedTokens: tokensOut,
    buyerPubkey,
    buyerArkAddress: addrs.offchainAddr,
    timestamp: Math.floor(Date.now() / 1000),
  });

  return { arkTxId, expectedTokens: tokensOut };
}

// ── Creator fill (buy order) ────────────────────────────────────────

export interface FillBuyOrderResult {
  success: boolean;
  fillTxId: string;
  newCurveState: CurveState;
}

/**
 * Creator fills a buy order:
 * 1. Verify the order
 * 2. Recalculate tokens from current curve state
 * 3. Send tokens to buyer
 * 4. Publish trade receipt + updated curve state
 */
export async function fillBuyOrder(
  wallet: ArkWallet,
  order: OrderData,
  curveState: CurveState,
  assetId: string
): Promise<FillBuyOrderResult> {
  const { tokensOut, newState } = calculateBuyTokens(curveState, order.sats);
  if (tokensOut <= 0) {
    throw new Error("Curve cannot fill this order");
  }

  // Verify the creator has enough of this specific token
  const assets = await import("./ark-wallet").then((m) => m.getAssets(wallet));
  const asset = assets.find((a) => a.assetId === assetId);
  if (!asset || asset.amount < tokensOut) {
    throw new Error(`Insufficient ${order.ticker} balance to fill order (have ${asset?.amount ?? 0}, need ${tokensOut})`);
  }

  // Send tokens to buyer
  const fillTxId = await sendAsset(wallet, order.buyerArkAddress, assetId, tokensOut);

  // Publish trade receipt
  const user = await import("./nostr").then((m) => m.getNDK().signer?.user());
  await publishTradeReceipt({
    ticker: order.ticker,
    arkTxId: fillTxId,
    type: "buy",
    sats: order.sats,
    tokens: tokensOut,
    buyer: order.buyerPubkey,
    seller: user?.pubkey ?? "",
    price: order.sats / tokensOut,
    timestamp: Math.floor(Date.now() / 1000),
  });

  // Publish updated curve state
  await publishCurveState(order.ticker, newState);

  return { success: true, fillTxId, newCurveState: newState };
}

// ── Sell flow ────────────────────────────────────────────────────────

export interface ExecuteSellParams {
  ticker: string;
  tokenAmount: number;
  assetId: string;
  creatorArkAddress: string;
  curveState: CurveState;
  sellerPubkey: string;
}

export interface ExecuteSellResult {
  arkTxId: string;
  expectedSats: number;
}

/**
 * Execute the seller side of a trade:
 * 1. Calculate expected sats from bonding curve
 * 2. Send tokens to creator's Ark address
 * 3. Publish order event to Nostr
 */
export async function executeSell(
  wallet: ArkWallet,
  params: ExecuteSellParams
): Promise<ExecuteSellResult> {
  const { ticker, tokenAmount, assetId, creatorArkAddress, curveState, sellerPubkey } = params;

  // Calculate expected sats
  const { satsOut } = calculateSellSats(curveState, tokenAmount);
  if (satsOut <= 0) {
    throw new Error("Trade too small");
  }

  // Send tokens to creator
  const arkTxId = await sendAsset(wallet, creatorArkAddress, assetId, tokenAmount);

  // Get seller's address for the order
  const addrs = await getReceivingAddresses(wallet);

  // Publish order event
  await publishOrderEvent({
    ticker,
    arkTxId,
    type: "sell",
    sats: satsOut,
    expectedTokens: tokenAmount,
    buyerPubkey: sellerPubkey,
    buyerArkAddress: addrs.offchainAddr,
    timestamp: Math.floor(Date.now() / 1000),
  });

  return { arkTxId, expectedSats: satsOut };
}

// ── Creator fill (sell order) ───────────────────────────────────────

export interface FillSellOrderResult {
  success: boolean;
  fillTxId: string;
  newCurveState: CurveState;
}

/**
 * Creator fills a sell order:
 * 1. Recalculate sats from current curve state
 * 2. Send sats to seller
 * 3. Publish trade receipt + updated curve state
 */
export async function fillSellOrder(
  wallet: ArkWallet,
  order: OrderData,
  curveState: CurveState
): Promise<FillSellOrderResult> {
  const { satsOut, newState } = calculateSellSats(curveState, order.expectedTokens);
  if (satsOut <= 0) {
    throw new Error("Curve cannot fill this sell order");
  }

  // Send sats to seller
  const fillTxId = await sendPayment(wallet, order.buyerArkAddress, satsOut);

  // Publish trade receipt
  const user = await import("./nostr").then((m) => m.getNDK().signer?.user());
  await publishTradeReceipt({
    ticker: order.ticker,
    arkTxId: fillTxId,
    type: "sell",
    sats: satsOut,
    tokens: order.expectedTokens,
    buyer: user?.pubkey ?? "",
    seller: order.buyerPubkey,
    price: satsOut / order.expectedTokens,
    timestamp: Math.floor(Date.now() / 1000),
  });

  // Publish updated curve state
  await publishCurveState(order.ticker, newState);

  return { success: true, fillTxId, newCurveState: newState };
}
