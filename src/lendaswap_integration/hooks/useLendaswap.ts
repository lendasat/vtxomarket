"use client";

/**
 * useLendaswap — Core React hook for the Lendaswap integration.
 *
 * Manages the full swap lifecycle:
 *   1. Client initialization (lazy, IndexedDB-backed)
 *   2. Quote fetching (with debounce-friendly API)
 *   3. Swap creation (Arkade→EVM or EVM→Arkade)
 *   4. Status polling (auto-polls every 3s while swap is active)
 *   5. Auto-claim (gasless for Arkade→EVM, Arkade claim for EVM→Arkade)
 *   6. Error handling & refund support
 *
 * Follows the same patterns as useLightning.ts in this codebase.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { sendPayment, getBalance, getReceivingAddresses } from "@/lib/ark-wallet";
import { getLendaswapClient } from "../lib/client";
import {
  getTokenAddress,
  getChainId,
  fromSmallestUnit,
  type EvmChainKey,
  type StablecoinKey,
} from "../lib/constants";
import {
  INITIAL_SWAP_STATE,
  type SwapState,
  type QuoteInfo,
  type ActiveSwap,
  type SwapStep,
} from "../lib/types";

// ── Polling configuration ───────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1_000; // 30 min timeout

// ── Terminal statuses (stop polling when reached) ───────────────────────────

const TERMINAL_STATUSES = new Set([
  "serverredeemed",
  "clientredeemed",
  "expired",
  "clientrefunded",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
]);

const SUCCESS_STATUSES = new Set(["serverredeemed", "clientredeemed"]);

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLendaswap() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const addresses = useAppStore((s) => s.addresses);
  const setBalance = useAppStore((s) => s.setBalance);
  const setAddresses = useAppStore((s) => s.setAddresses);

  const [ready, setReady] = useState(false);
  const [state, setState] = useState<SwapState>(INITIAL_SWAP_STATE);

  // Refs for polling cleanup
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // ── Lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, []);

  // Lazily init the client when the hook first mounts
  useEffect(() => {
    let cancelled = false;
    getLendaswapClient()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => {
        console.error("[lendaswap] Client init failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Internal helpers ──────────────────────────────────────────────────

  const updateState = useCallback((patch: Partial<SwapState>) => {
    if (!mountedRef.current) return;
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!arkWallet) return;
    try {
      const [bal, addrs] = await Promise.all([
        getBalance(arkWallet),
        getReceivingAddresses(arkWallet),
      ]);
      setBalance(bal);
      setAddresses(addrs);
    } catch {
      // Non-critical — balance will refresh on next wallet interaction
    }
  }, [arkWallet, setBalance, setAddresses]);

  // ── Get quote ─────────────────────────────────────────────────────────

  const getQuote = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      /** For SEND: amount in sats. For RECEIVE: amount in stablecoin smallest unit. */
      amount: number;
      /** "send" = sats→stablecoin, "receive" = stablecoin→sats */
      direction: "send" | "receive";
    }): Promise<QuoteInfo | null> => {
      try {
        updateState({ step: "quoting", error: null });
        const client = await getLendaswapClient();
        const tokenAddress = getTokenAddress(params.coin, params.chain);
        const chainId = getChainId(params.chain);

        const isSend = params.direction === "send";

        const quote = await client.getQuote({
          sourceChain: isSend ? "Arkade" : String(chainId),
          sourceToken: isSend ? "btc" : tokenAddress,
          targetChain: isSend ? String(chainId) : "Arkade",
          targetToken: isSend ? tokenAddress : "btc",
          ...(isSend
            ? { sourceAmount: params.amount }
            : { sourceAmount: params.amount }),
        });

        const info: QuoteInfo = {
          exchangeRate: quote.exchange_rate,
          protocolFeeSats: quote.protocol_fee,
          networkFeeSats: quote.network_fee,
          sourceAmount: quote.source_amount,
          targetAmount: quote.target_amount,
          minAmountSats: quote.min_amount,
          maxAmountSats: quote.max_amount,
        };

        updateState({ step: "confirming", quote: info });
        return info;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Quote failed";
        updateState({ step: "error", error: msg });
        return null;
      }
    },
    [updateState],
  );

  // ── Poll swap status ──────────────────────────────────────────────────

  const startPolling = useCallback(
    (swapId: string, direction: "send" | "receive") => {
      stopPolling();
      const startTime = Date.now();

      pollingRef.current = setInterval(async () => {
        if (!mountedRef.current) {
          stopPolling();
          return;
        }

        // Timeout guard
        if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
          stopPolling();
          updateState({
            step: "error",
            error: "Swap timed out. Check swap history for status.",
          });
          return;
        }

        try {
          const client = await getLendaswapClient();
          const swapResp = await client.getSwap(swapId, { updateStorage: true });
          const status = swapResp.status as string;

          // Update the active swap's backend status
          setState((prev) => {
            if (!prev.swap || prev.swap.id !== swapId) return prev;
            return {
              ...prev,
              swap: { ...prev.swap, backendStatus: status },
            };
          });

          // Terminal? Stop polling.
          if (TERMINAL_STATUSES.has(status)) {
            stopPolling();

            if (SUCCESS_STATUSES.has(status)) {
              updateState({ step: "success" });
              // Refresh Ark balance after successful swap
              refreshBalance();
            } else {
              updateState({
                step: "error",
                error: `Swap ended with status: ${status}`,
              });
            }
            return;
          }

          // Auto-claim for Arkade→EVM (SEND) when server has funded
          if (direction === "send" && status === "serverfunded") {
            updateState({ step: "claiming" });
            try {
              const result = await client.claim(swapId);
              if (result.success) {
                setState((prev) => {
                  if (!prev.swap) return prev;
                  return {
                    ...prev,
                    swap: { ...prev.swap, claimTxHash: result.txHash },
                  };
                });
              }
            } catch (claimErr) {
              console.warn("[lendaswap] Auto-claim attempt failed, will retry:", claimErr);
              // Polling continues — claim will be retried next cycle
              updateState({ step: "processing" });
            }
          }

          // RECEIVE flow: auto-fund HTLC via gasless relay once tokens are deposited.
          // The backend transitions to "clientfundingseen" or "clientfunded" once it
          // sees tokens at client_evm_address. We try fundSwapGasless() to relay them.
          if (direction === "receive" && (status === "pending" || status === "clientfundingseen")) {
            try {
              await client.fundSwapGasless(swapId);
              updateState({ step: "processing" });
            } catch {
              // Tokens may not have arrived yet — keep polling silently
            }
          }

          // RECEIVE flow: auto-claim BTC when server has funded VHTLC
          if (direction === "receive" && status === "serverfunded") {
            updateState({ step: "claiming" });
            try {
              const offchainAddr = addresses?.offchainAddr;
              if (!offchainAddr) throw new Error("No Arkade address available");
              const result = await client.claimArkade(swapId, {
                destinationAddress: offchainAddr,
              });
              if (result.success) {
                setState((prev) => {
                  if (!prev.swap) return prev;
                  return {
                    ...prev,
                    swap: { ...prev.swap, claimTxHash: result.txId },
                  };
                });
              }
            } catch (claimErr) {
              console.warn("[lendaswap] Auto-claim Arkade attempt failed, will retry:", claimErr);
              updateState({ step: "processing" });
            }
          }
        } catch (err) {
          console.warn("[lendaswap] Poll error:", err);
          // Don't stop polling on transient errors
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, updateState, refreshBalance, addresses],
  );

  // ── Create SEND swap (Arkade BTC → EVM stablecoin) ────────────────────

  const createSendSwap = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      amountSats: number;
      destinationEvmAddress: string;
    }): Promise<boolean> => {
      if (!arkWallet) {
        updateState({ step: "error", error: "Wallet not connected" });
        return false;
      }

      try {
        updateState({ step: "funding", error: null });
        const client = await getLendaswapClient();
        const tokenAddress = getTokenAddress(params.coin, params.chain);
        const chainId = getChainId(params.chain);

        // Create the Arkade→EVM swap
        const result = await client.createArkadeToEvmSwapGeneric({
          targetAddress: params.destinationEvmAddress,
          tokenAddress,
          evmChainId: chainId,
          sourceAmount: BigInt(params.amountSats),
          gasless: true,
        });

        const resp = result.response;
        const swap: ActiveSwap = {
          id: resp.id,
          direction: "send",
          coin: params.coin,
          chain: params.chain,
          vhtlcAddress: resp.btc_vhtlc_address,
          satsRequired: resp.evm_expected_sats || params.amountSats,
          sourceDisplay: `${params.amountSats.toLocaleString()} sats`,
          targetDisplay: `${fromSmallestUnit(resp.target_amount, params.coin)} ${params.coin}`,
          backendStatus: resp.status,
          createdAt: Date.now(),
        };

        updateState({ swap });

        // Send BTC to the VHTLC address via Arkade wallet
        try {
          await sendPayment(arkWallet, resp.btc_vhtlc_address, swap.satsRequired!);
        } catch (sendErr) {
          const msg = sendErr instanceof Error ? sendErr.message : "Failed to send BTC";
          updateState({ step: "error", error: msg });
          return false;
        }

        // BTC sent — start polling for counterparty funding
        updateState({ step: "processing" });
        startPolling(resp.id, "send");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create swap";
        updateState({ step: "error", error: msg });
        return false;
      }
    },
    [arkWallet, updateState, startPolling],
  );

  // ── Create RECEIVE swap (EVM stablecoin → Arkade BTC) ─────────────────
  //
  // Gasless flow: the SDK derives an internal EVM address from the swap's
  // secret key. The sender deposits stablecoins to that address. Then we
  // call fundSwapGasless() which signs Permit2 internally and relays the
  // funding TX through the server (no ETH/gas needed on client side).

  const createReceiveSwap = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      amountSats: number;
    }): Promise<boolean> => {
      if (!addresses?.offchainAddr) {
        updateState({ step: "error", error: "Wallet not connected" });
        return false;
      }

      try {
        updateState({ step: "awaiting_deposit", error: null });
        const client = await getLendaswapClient();
        const tokenAddress = getTokenAddress(params.coin, params.chain);
        const chainId = getChainId(params.chain);

        // Create EVM→Arkade swap with gasless=true.
        // SDK auto-derives userAddress from secretKey — no user EVM input needed.
        const result = await client.createEvmToArkadeSwapGeneric({
          targetAddress: addresses.offchainAddr,
          tokenAddress,
          evmChainId: chainId,
          targetAmount: params.amountSats,
          gasless: true,
        });

        const resp = result.response;

        // client_evm_address is the SDK-derived deposit address where
        // the sender should send stablecoins. This is NOT the HTLC — it's
        // the intermediary address the SDK can sign for via Permit2.
        const swap: ActiveSwap = {
          id: resp.id,
          direction: "receive",
          coin: params.coin,
          chain: params.chain,
          evmDepositAddress: resp.client_evm_address,
          evmDepositAmount: resp.source_amount,
          sourceDisplay: `${fromSmallestUnit(resp.source_amount, params.coin)} ${params.coin}`,
          targetDisplay: `${params.amountSats.toLocaleString()} sats`,
          backendStatus: resp.status,
          createdAt: Date.now(),
        };

        updateState({ swap });

        // Start polling — when tokens arrive at client_evm_address,
        // we call fundSwapGasless() to relay them into the HTLC.
        startPolling(resp.id, "receive");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create swap";
        updateState({ step: "error", error: msg });
        return false;
      }
    },
    [addresses, updateState, startPolling],
  );

  // ── Seamless receive: quote + create in one shot ────────────────────
  //
  // Skips the "confirming" step entirely. Fetches a quote, immediately
  // creates the swap, and returns the deposit address — one tap.

  const getQuoteAndCreateReceive = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      amountSats: number;
    }): Promise<boolean> => {
      if (!addresses?.offchainAddr) {
        updateState({ step: "error", error: "Wallet not connected" });
        return false;
      }

      try {
        updateState({ step: "quoting", error: null });
        const client = await getLendaswapClient();
        const tokenAddress = getTokenAddress(params.coin, params.chain);
        const chainId = getChainId(params.chain);

        // 1. Fetch quote (for the details badge)
        const quoteResp = await client.getQuote({
          sourceChain: String(chainId),
          sourceToken: tokenAddress,
          targetChain: "Arkade",
          targetToken: "btc",
          targetAmount: params.amountSats,
        });

        const quoteInfo: QuoteInfo = {
          exchangeRate: quoteResp.exchange_rate,
          protocolFeeSats: quoteResp.protocol_fee,
          networkFeeSats: quoteResp.network_fee,
          sourceAmount: quoteResp.source_amount,
          targetAmount: quoteResp.target_amount,
          minAmountSats: quoteResp.min_amount,
          maxAmountSats: quoteResp.max_amount,
        };

        // 2. Create swap immediately (no confirm step)
        const result = await client.createEvmToArkadeSwapGeneric({
          targetAddress: addresses.offchainAddr,
          tokenAddress,
          evmChainId: chainId,
          targetAmount: params.amountSats,
          gasless: true,
        });

        const resp = result.response;
        const swap: ActiveSwap = {
          id: resp.id,
          direction: "receive",
          coin: params.coin,
          chain: params.chain,
          evmDepositAddress: resp.client_evm_address,
          evmDepositAmount: resp.source_amount,
          sourceDisplay: `${fromSmallestUnit(resp.source_amount, params.coin)} ${params.coin}`,
          targetDisplay: `${params.amountSats.toLocaleString()} sats`,
          backendStatus: resp.status,
          createdAt: Date.now(),
        };

        updateState({ step: "awaiting_deposit", quote: quoteInfo, swap });
        startPolling(resp.id, "receive");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create receive address";
        updateState({ step: "error", error: msg });
        return false;
      }
    },
    [addresses, updateState, startPolling],
  );

  // ── Refund ────────────────────────────────────────────────────────────

  const refundSwap = useCallback(
    async (swapId: string): Promise<{ success: boolean; message: string }> => {
      try {
        const client = await getLendaswapClient();
        const offchainAddr = addresses?.offchainAddr;

        const result = await client.refundSwap(swapId, offchainAddr ? {
          destinationAddress: offchainAddr,
        } : undefined);

        if (result.success) {
          refreshBalance();
        }
        return { success: result.success, message: result.message };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Refund failed";
        return { success: false, message: msg };
      }
    },
    [addresses, refreshBalance],
  );

  // ── Get swap history ──────────────────────────────────────────────────

  const getSwapHistory = useCallback(async () => {
    try {
      const client = await getLendaswapClient();
      const swaps = await client.listAllSwaps();
      return swaps;
    } catch {
      return [];
    }
  }, []);

  // ── Reset (back to idle) ──────────────────────────────────────────────

  const reset = useCallback(() => {
    stopPolling();
    setState(INITIAL_SWAP_STATE);
  }, [stopPolling]);

  // ── Manual step override (for back navigation) ────────────────────────

  const setStep = useCallback((step: SwapStep) => {
    updateState({ step });
  }, [updateState]);

  return {
    /** Whether the Lendaswap client has been initialized */
    ready,
    /** Current swap state (step, quote, active swap, error) */
    state,
    /** Fetch a price quote */
    getQuote,
    /** Create and execute a SEND swap (sats → stablecoins) */
    createSendSwap,
    /** Create a RECEIVE swap (stablecoins → sats) */
    createReceiveSwap,
    /** One-shot: quote + create receive swap (no confirm step) */
    getQuoteAndCreateReceive,
    /** Attempt to refund a swap */
    refundSwap,
    /** List all stored swaps */
    getSwapHistory,
    /** Reset to idle state */
    reset,
    /** Manually set the current step */
    setStep,
  };
}
