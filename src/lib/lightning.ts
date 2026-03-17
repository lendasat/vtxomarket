import type { FeesResponse, PendingReverseSwap, PendingSubmarineSwap } from "@arkade-os/boltz-swap";

export type { FeesResponse, PendingReverseSwap, PendingSubmarineSwap };
export { getInvoiceSatoshis } from "@arkade-os/boltz-swap";

const BOLTZ_URL = process.env.NEXT_PUBLIC_BOLTZ_URL || "https://api.ark.boltz.exchange";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function initLightning(wallet: any) {
  const { ArkadeSwaps, BoltzSwapProvider } = await import("@arkade-os/boltz-swap");
  const { RestArkProvider, RestIndexerProvider } = await import("@arkade-os/sdk");
  const { ARK_SERVER_URL } = await import("./ark-wallet");

  const arkProvider = new RestArkProvider(ARK_SERVER_URL);
  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_URL,
    network: "bitcoin",
  });
  const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

  return new ArkadeSwaps({
    wallet,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arkProvider: arkProvider as any,
    swapProvider,
    indexerProvider,
    swapManager: true, // Enable SwapManager for auto-claim, auto-refund, and persistence
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getLightningFees(lightning: any): Promise<FeesResponse> {
  return lightning.getFees();
}

export function calcSendFee(fees: FeesResponse, sats: number): number {
  const { percentage, minerFees } = fees.submarine;
  return Math.ceil((sats * percentage) / 100 + minerFees);
}

export function calcReceiveFee(fees: FeesResponse, sats: number): number {
  const { percentage, minerFees } = fees.reverse;
  return Math.ceil((sats * percentage) / 100 + minerFees.claim + minerFees.lockup);
}

// -- Swap history & recovery --

export type SwapStatus = "Pending" | "Successful" | "Failed" | "Refunded";

export interface SwapHistoryItem {
  id: string;
  type: "send" | "receive";
  status: SwapStatus;
  amount: number;
  createdAt: number;
  refundable: boolean;
}

// Map Boltz statuses to simple UI statuses
const STATUS_MAP: Record<string, SwapStatus> = {
  "invoice.expired": "Failed",
  "invoice.failedToPay": "Failed",
  "invoice.paid": "Successful",
  "invoice.pending": "Pending",
  "invoice.set": "Pending",
  "invoice.settled": "Successful",
  "swap.created": "Pending",
  "swap.expired": "Failed",
  "transaction.claim.pending": "Pending",
  "transaction.claimed": "Successful",
  "transaction.confirmed": "Successful",
  "transaction.failed": "Failed",
  "transaction.lockupFailed": "Failed",
  "transaction.mempool": "Pending",
  "transaction.refunded": "Refunded",
  "transaction.server.mempool": "Pending",
  "transaction.server.confirmed": "Successful",
};

const REFUNDABLE_STATUSES = new Set([
  "invoice.failedToPay",
  "transaction.lockupFailed",
  "swap.expired",
]);

/**
 * Get swap history from the SwapManager's persisted storage.
 * Returns both submarine (send) and reverse (receive) swaps.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSwapHistory(lightning: any): Promise<SwapHistoryItem[]> {
  try {
    const history = await lightning.getSwapHistory();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return history
      .map((swap: any) => {
        const isReverse = swap.type === "reverse";
        const status = STATUS_MAP[swap.status] ?? "Pending";
        const refundable =
          !isReverse &&
          REFUNDABLE_STATUSES.has(swap.status) &&
          swap.refundable !== false &&
          swap.refunded !== true;

        return {
          id: swap.id ?? swap.response?.id ?? "",
          type: isReverse ? ("receive" as const) : ("send" as const),
          status,
          amount: isReverse
            ? (swap.response?.onchainAmount ?? swap.request?.invoiceAmount ?? 0)
            : (swap.response?.expectedAmount ?? 0),
          createdAt: swap.createdAt ?? 0,
          refundable,
        };
      })
      .sort((a: SwapHistoryItem, b: SwapHistoryItem) => b.createdAt - a.createdAt);
  } catch (e) {
    console.warn("[lightning] Failed to get swap history:", e);
    return [];
  }
}

/**
 * Attempt to refund a failed submarine swap (send that failed).
 * The SwapManager handles this automatically for most cases,
 * but this allows manual refund triggering from the UI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function refundSwap(lightning: any, swapId: string): Promise<void> {
  const history = await lightning.getSwapHistory();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const swap = history.find((s: any) => (s.id ?? s.response?.id) === swapId);
  if (!swap) throw new Error("Swap not found");
  if (swap.type === "reverse") throw new Error("Cannot refund a receive swap");
  if (!REFUNDABLE_STATUSES.has(swap.status)) throw new Error("Swap is not refundable");
  if (swap.refunded) throw new Error("Swap already refunded");

  await lightning.refundVHTLC(swap);
  console.log("[lightning] Refund completed for swap:", swapId);
}

/**
 * Restore swaps from Boltz API that might not be in local storage.
 * Call this on startup to recover any swaps from previous sessions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function restoreSwaps(lightning: any): Promise<number> {
  try {
    const result = await lightning.restoreSwaps();
    const total = (result.reverseSwaps?.length ?? 0) + (result.submarineSwaps?.length ?? 0);
    if (total > 0) {
      console.log("[lightning] Restored %d swaps from Boltz API", total);
    }
    return total;
  } catch (e) {
    console.warn("[lightning] Swap restoration failed:", e);
    return 0;
  }
}
