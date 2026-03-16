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
  toSmallestUnit,
  fromSmallestUnit,
  type EvmChainKey,
  type StablecoinKey,
} from "../lib/constants";
import {
  INITIAL_SWAP_STATE,
  TERMINAL_STATUSES,
  SUCCESS_STATUSES,
  mapBackendStatus,
  type SwapState,
  type QuoteInfo,
  type ActiveSwap,
  type SwapStep,
} from "../lib/types";

// ── Polling configuration ───────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1_000; // 30 min timeout
const MAX_CLAIM_RETRIES = 10;

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLendaswap() {
  const arkWallet = useAppStore((s) => s.arkWallet);
  const addresses = useAppStore((s) => s.addresses);
  const setBalance = useAppStore((s) => s.setBalance);
  const setAddresses = useAppStore((s) => s.setAddresses);
  const upsertStablecoinTx = useAppStore((s) => s.upsertStablecoinTx);

  const [ready, setReady] = useState(false);
  const [state, setState] = useState<SwapState>(INITIAL_SWAP_STATE);

  // Refs for polling cleanup + concurrent claim guard
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const isClaimingRef = useRef(false);

  // ── Lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, []);

  // Lazily init the client (history loading is handled by useLendaswapHistory)
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
    const wallet = arkWallet;
    const doRefresh = async () => {
      if (!mountedRef.current) return;
      try {
        const [bal, addrs] = await Promise.all([
          getBalance(wallet),
          getReceivingAddresses(wallet),
        ]);
        if (!mountedRef.current) return;
        setBalance(bal);
        setAddresses(addrs);
      } catch (err) {
        console.warn("[lendaswap] Balance refresh failed:", err instanceof Error ? err.message : err);
      }
    };
    // Refresh immediately, then retry after short delays to catch settlement
    await doRefresh();
    setTimeout(doRefresh, 3_000);
    setTimeout(doRefresh, 8_000);
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
          sourceAmount: params.amount,
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
      let claimRetries = 0;

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

          console.log(`[lendaswap] Poll ${swapId.slice(0, 8)}: status=${status}, direction=${direction}`);

          // Update the active swap's backend status
          setState((prev) => {
            if (!prev.swap || prev.swap.id !== swapId) return prev;
            // Defer store sync out of setState to avoid updating another component mid-render
            // Only update status fields — don't spread ActiveSwap which lacks StablecoinTxItem fields
            queueMicrotask(() => {
              const existing = useAppStore.getState().stablecoinTxs.find((t) => t.swapId === swapId);
              if (existing) {
                upsertStablecoinTx({
                  ...existing,
                  backendStatus: status,
                  status: mapBackendStatus(status),
                  claimTxHash: prev.swap!.claimTxHash ?? existing.claimTxHash,
                });
              }
            });
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

          // Auto-claim when server has funded (both SEND and RECEIVE)
          if (status === "serverfunded" && !isClaimingRef.current) {
            if (claimRetries >= MAX_CLAIM_RETRIES) {
              stopPolling();
              updateState({
                step: "error",
                error: "Failed to claim after multiple attempts. Please try again or contact support.",
              });
              return;
            }
            isClaimingRef.current = true;
            updateState({ step: "claiming" });
            try {
              console.log(`[lendaswap] Attempting claim for ${swapId.slice(0, 8)} (attempt ${claimRetries + 1})`);
              const result = await client.claim(swapId);
              console.log(`[lendaswap] Claim result:`, result);
              if (result.success) {
                setState((prev) => {
                  if (!prev.swap) return prev;
                  return {
                    ...prev,
                    swap: { ...prev.swap, claimTxHash: result.txHash },
                  };
                });
              } else {
                claimRetries++;
                console.warn(`[lendaswap] Claim returned success=false (attempt ${claimRetries}):`, result);
                updateState({ step: "processing" });
              }
            } catch (claimErr) {
              claimRetries++;
              console.warn(`[lendaswap] Auto-claim attempt ${claimRetries} failed:`, claimErr);
              updateState({ step: "processing" });
            } finally {
              isClaimingRef.current = false;
            }
          }
        } catch (err) {
          console.warn("[lendaswap] Poll error:", err);
          // Don't stop polling on transient errors
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, updateState, refreshBalance, upsertStablecoinTx],
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
        console.log("[lendaswap] Swap created:", JSON.stringify(resp, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));

        // IMPORTANT: send source_amount (the full amount), NOT evm_expected_sats (post-fee).
        // The backend watcher checks received_sats >= expected source_amount.
        const satsToSend = Number(resp.source_amount);

        const swap: ActiveSwap = {
          id: resp.id,
          direction: "send",
          coin: params.coin,
          chain: params.chain,
          vhtlcAddress: resp.btc_vhtlc_address,
          satsRequired: satsToSend,
          sourceDisplay: `${satsToSend.toLocaleString()} sats`,
          targetDisplay: `${fromSmallestUnit(resp.target_amount, params.coin)} ${params.coin}`,
          backendStatus: resp.status,
          createdAt: Date.now(),
        };

        console.log(`[lendaswap] Sending ${swap.satsRequired} sats to VHTLC: ${resp.btc_vhtlc_address}`);
        updateState({ swap });

        // Push to store so it appears in transaction history immediately
        upsertStablecoinTx({
          swapId: resp.id,
          direction: "send",
          coin: params.coin,
          chain: params.chain,
          stablecoinDisplay: swap.targetDisplay,
          satsAmount: satsToSend,
          destinationAddress: params.destinationEvmAddress,
          status: "pending",
          backendStatus: resp.status,
          createdAt: Date.now(),
        });

        // Send BTC to the VHTLC address via Arkade wallet
        try {
          await sendPayment(arkWallet, resp.btc_vhtlc_address, swap.satsRequired!);
          console.log("[lendaswap] BTC sent successfully to VHTLC");
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
    [arkWallet, updateState, startPolling, upsertStablecoinTx],
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

        upsertStablecoinTx({
          swapId: resp.id,
          direction: "receive",
          coin: params.coin,
          chain: params.chain,
          stablecoinDisplay: swap.sourceDisplay,
          satsAmount: params.amountSats,
          destinationAddress: addresses.offchainAddr,
          status: "pending",
          backendStatus: resp.status,
          createdAt: Date.now(),
        });

        // Start polling — tracks backend status transitions.
        // The UI component handles fundSwapGasless() after balance detection.
        startPolling(resp.id, "receive");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create swap";
        updateState({ step: "error", error: msg });
        return false;
      }
    },
    [addresses, updateState, startPolling, upsertStablecoinTx],
  );

  // ── Seamless receive: quote + create in one shot ────────────────────
  //
  // Skips the "confirming" step entirely. Fetches a quote, immediately
  // creates the swap, and returns the deposit address — one tap.

  const getQuoteAndCreateReceive = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      /** Stablecoin amount as a human-readable string (e.g. "50.25") */
      amountUsd: string;
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
        const sourceSmallest = toSmallestUnit(params.amountUsd, params.coin);

        // 1. Fetch quote using sourceAmount (stablecoin smallest unit)
        const quoteResp = await client.getQuote({
          sourceChain: String(chainId),
          sourceToken: tokenAddress,
          targetChain: "Arkade",
          targetToken: "btc",
          sourceAmount: Number(sourceSmallest),
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
          sourceAmount: sourceSmallest,
          gasless: true,
        });

        const resp = result.response;
        const targetSats = parseInt(resp.target_amount, 10);
        const swap: ActiveSwap = {
          id: resp.id,
          direction: "receive",
          coin: params.coin,
          chain: params.chain,
          evmDepositAddress: resp.client_evm_address,
          evmDepositAmount: resp.source_amount,
          sourceDisplay: `${params.amountUsd} ${params.coin}`,
          targetDisplay: `${(targetSats || 0).toLocaleString()} sats`,
          backendStatus: resp.status,
          createdAt: Date.now(),
        };

        updateState({ step: "awaiting_deposit", quote: quoteInfo, swap });

        upsertStablecoinTx({
          swapId: resp.id,
          direction: "receive",
          coin: params.coin,
          chain: params.chain,
          stablecoinDisplay: `${params.amountUsd} ${params.coin}`,
          satsAmount: targetSats || 0,
          destinationAddress: addresses.offchainAddr,
          status: "pending",
          backendStatus: resp.status,
          createdAt: Date.now(),
        });

        startPolling(resp.id, "receive");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create receive address";
        updateState({ step: "error", error: msg });
        return false;
      }
    },
    [addresses, updateState, startPolling, upsertStablecoinTx],
  );

  // ── Fund gasless (RECEIVE flow) ──────────────────────────────────────
  //
  // Called explicitly from the UI once on-chain balance polling confirms
  // that stablecoins have arrived at client_evm_address. This signs
  // Permit2 internally and relays the funding TX through the server.
  // Matches the reference app's DepositEvmGaslessStep "Fund Swap" button.

  const fundGasless = useCallback(
    async (swapId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        updateState({ step: "processing" });
        const client = await getLendaswapClient();
        console.log(`[lendaswap] Funding swap gasless: ${swapId.slice(0, 8)}`);
        const result = await client.fundSwapGasless(swapId);
        console.log(`[lendaswap] fundSwapGasless result:`, result);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Gasless funding failed";
        console.error("[lendaswap] fundSwapGasless failed:", err);
        return { success: false, error: msg };
      }
    },
    [updateState],
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
    } catch (err) {
      console.warn("[lendaswap] Failed to load swap history:", err instanceof Error ? err.message : err);
      return [];
    }
  }, []);

  // ── Lightweight sats estimate (no state changes, for live preview) ────

  const getReceiveEstimate = useCallback(
    async (params: {
      coin: StablecoinKey;
      chain: EvmChainKey;
      amountUsd: string;
    }): Promise<number | null> => {
      try {
        const client = await getLendaswapClient();
        const tokenAddress = getTokenAddress(params.coin, params.chain);
        const chainId = getChainId(params.chain);
        const sourceSmallest = toSmallestUnit(params.amountUsd, params.coin);

        const quoteResp = await client.getQuote({
          sourceChain: String(chainId),
          sourceToken: tokenAddress,
          targetChain: "Arkade",
          targetToken: "btc",
          sourceAmount: Number(sourceSmallest),
        });

        return parseInt(quoteResp.target_amount, 10) || null;
      } catch (err) {
        console.warn("[lendaswap] Quote estimate failed:", err instanceof Error ? err.message : err);
        return null;
      }
    },
    [],
  );

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
    /** Lightweight sats estimate for a given stablecoin amount (no side effects) */
    getReceiveEstimate,
    /** Fund a gasless EVM swap (call after tokens arrive at deposit address) */
    fundGasless,
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
