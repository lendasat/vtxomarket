/**
 * Type declarations for @lendasat/lendaswap-sdk-pure.
 *
 * These declarations allow the integration to type-check without
 * installing the SDK. Once installed via `npm install @lendasat/lendaswap-sdk-pure`,
 * the real types from the package will take precedence.
 */
declare module "@lendasat/lendaswap-sdk-pure" {
  // ── Storage ─────────────────────────────────────────────────────────────

  export interface WalletStorage {
    getMnemonic(): Promise<string | null>;
    setMnemonic(mnemonic: string): Promise<void>;
    getKeyIndex(): Promise<number>;
    setKeyIndex(index: number): Promise<void>;
    incrementKeyIndex(): Promise<number>;
    clear(): Promise<void>;
  }

  export interface SwapStorage {
    get(swapId: string): Promise<StoredSwap | null>;
    store(swap: StoredSwap): Promise<void>;
    update(swapId: string, response: GetSwapResponse): Promise<void>;
    delete(swapId: string): Promise<void>;
    list(): Promise<string[]>;
    getAll(): Promise<StoredSwap[]>;
    clear(): Promise<void>;
  }

  export class IdbWalletStorage implements WalletStorage {
    getMnemonic(): Promise<string | null>;
    setMnemonic(mnemonic: string): Promise<void>;
    getKeyIndex(): Promise<number>;
    setKeyIndex(index: number): Promise<void>;
    incrementKeyIndex(): Promise<number>;
    clear(): Promise<void>;
  }

  export class IdbSwapStorage implements SwapStorage {
    get(swapId: string): Promise<StoredSwap | null>;
    store(swap: StoredSwap): Promise<void>;
    update(swapId: string, response: GetSwapResponse): Promise<void>;
    delete(swapId: string): Promise<void>;
    list(): Promise<string[]>;
    getAll(): Promise<StoredSwap[]>;
    clear(): Promise<void>;
  }

  // ── Types ───────────────────────────────────────────────────────────────

  export type Chain = "Arkade" | "Lightning" | "Bitcoin" | string;

  export type SwapStatus =
    | "pending"
    | "clientfundingseen"
    | "clientfunded"
    | "clientrefunded"
    | "serverfunded"
    | "clientredeeming"
    | "clientredeemed"
    | "serverredeemed"
    | "clientfundedserverrefunded"
    | "clientrefundedserverfunded"
    | "clientrefundedserverrefunded"
    | "expired"
    | "clientinvalidfunded"
    | "clientfundedtoolate"
    | "clientredeemedandclientrefunded";

  export interface QuoteResponse {
    exchange_rate: string;
    min_amount: number;
    max_amount: number;
    protocol_fee: number;
    protocol_fee_rate: number;
    network_fee: number;
    gasless_network_fee: number;
    source_amount: string;
    target_amount: string;
  }

  export interface ArkadeToEvmSwapResponse {
    id: string;
    status: SwapStatus;
    created_at: string;
    btc_vhtlc_address: string;
    evm_htlc_address: string;
    evm_coordinator_address: string;
    evm_chain_id: number;
    evm_expected_sats: number;
    source_amount: string;
    target_amount: string;
    fee_sats: number;
    hash_lock: string;
    sender_pk: string;
    receiver_pk: string;
    [key: string]: unknown;
  }

  export interface EvmToArkadeSwapResponse {
    id: string;
    status: SwapStatus;
    created_at: string;
    evm_htlc_address: string;
    evm_chain_id: number;
    /** SDK-derived EVM deposit address — show this as the receive address */
    client_evm_address: string;
    btc_vhtlc_address: string;
    target_arkade_address: string;
    source_amount: string;
    target_amount: string;
    fee_sats: number;
    hash_lock: string;
    sender_pk: string;
    receiver_pk: string;
    gasless: boolean;
    [key: string]: unknown;
  }

  export type GetSwapResponse = {
    id: string;
    status: SwapStatus;
    direction?: string;
    source_amount: string;
    target_amount: string;
    [key: string]: unknown;
  };

  export interface StoredSwap {
    version: number;
    swapId: string;
    keyIndex: number;
    response: GetSwapResponse;
    publicKey: string;
    preimage: string;
    preimageHash: string;
    secretKey: string;
    storedAt: number;
    updatedAt: number;
    targetAddress?: string;
  }

  export interface ClaimResult {
    success: boolean;
    message: string;
    txHash?: string;
    [key: string]: unknown;
  }

  export interface ClaimGaslessResult {
    id: string;
    status: string;
    txHash: string;
    message: string;
  }

  export interface RefundResult {
    success: boolean;
    message: string;
    txHex?: string;
    txId?: string;
    refundAmount?: bigint;
    fee?: bigint;
    broadcast?: boolean;
    [key: string]: unknown;
  }

  // ── Client ──────────────────────────────────────────────────────────────

  export class ClientBuilder {
    withBaseUrl(baseUrl: string): this;
    withApiKey(apiKey: string): this;
    withEsploraUrl(esploraUrl: string): this;
    withArkadeServerUrl(url: string): this;
    withSignerStorage(storage: WalletStorage): this;
    withSwapStorage(storage: SwapStorage): this;
    withMnemonic(mnemonic: string): this;
    build(): Promise<Client>;
  }

  export class Client {
    static builder(): ClientBuilder;

    healthCheck(): Promise<string>;
    getVersion(): Promise<{ tag: string; commit_hash: string }>;

    getTokens(): Promise<Record<string, unknown>>;
    getQuote(params: {
      sourceChain: Chain;
      sourceToken: string;
      targetChain: Chain;
      targetToken: string;
      sourceAmount?: number;
      targetAmount?: number;
    }): Promise<QuoteResponse>;

    getSwap(
      id: string,
      options?: { updateStorage?: boolean },
    ): Promise<GetSwapResponse>;

    createArkadeToEvmSwapGeneric(options: {
      targetAddress: string;
      tokenAddress: string;
      evmChainId: number;
      sourceAmount?: bigint;
      targetAmount?: bigint;
      referralCode?: string;
      gasless?: boolean;
    }): Promise<{ response: ArkadeToEvmSwapResponse; swapParams: unknown }>;

    createEvmToArkadeSwapGeneric(options: {
      targetAddress: string;
      tokenAddress: string;
      evmChainId: number;
      userAddress: string;
      sourceAmount?: bigint;
      targetAmount?: number;
      referralCode?: string;
      gasless?: boolean;
    }): Promise<{ response: EvmToArkadeSwapResponse; swapParams: unknown }>;

    claim(id: string, options?: { destination?: string }): Promise<ClaimResult>;

    claimViaGasless(
      id: string,
      destination: string,
      options?: { slippage?: number },
    ): Promise<ClaimGaslessResult>;

    claimArkade(
      id: string,
      options: { destinationAddress: string; arkadeServerUrl?: string },
    ): Promise<{ success: boolean; message: string; txId?: string }>;

    /** Fund an EVM-sourced swap via gasless relay (Permit2 signed internally) */
    fundSwapGasless(swapId: string): Promise<{ txHash: string }>;

    refundSwap(
      id: string,
      options?: { destinationAddress?: string; mode?: string },
    ): Promise<RefundResult>;

    listAllSwaps(): Promise<StoredSwap[]>;
    getStoredSwap(id: string): Promise<StoredSwap | null>;

    getMnemonic(): string;
    loadMnemonic(mnemonic: string): Promise<void>;
  }
}
