import type { FeesResponse, PendingReverseSwap, PendingSubmarineSwap } from "@arkade-os/boltz-swap";

export type { FeesResponse, PendingReverseSwap, PendingSubmarineSwap };
export { getInvoiceSatoshis } from "@arkade-os/boltz-swap";

const BOLTZ_URL = process.env.NEXT_PUBLIC_BOLTZ_URL || "https://api.ark.boltz.exchange";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function initLightning(wallet: any) {
  const { ArkadeLightning, BoltzSwapProvider } = await import("@arkade-os/boltz-swap");
  const { RestArkProvider, RestIndexerProvider } = await import("@arkade-os/sdk");
  const { ARK_SERVER_URL } = await import("./ark-wallet");

  const arkProvider = new RestArkProvider(ARK_SERVER_URL);
  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_URL,
    network: "bitcoin",
  });
  const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

  return new ArkadeLightning({
    wallet,
    arkProvider,
    swapProvider,
    indexerProvider,
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
  return Math.ceil(
    (sats * percentage) / 100 + minerFees.claim + minerFees.lockup
  );
}
