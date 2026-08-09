/**
 * uvd-x402-sdk - Type Definitions
 *
 * Core TypeScript interfaces for the x402 payment SDK.
 * These types define the contract between the SDK and consuming applications.
 */

// ============================================================================
// CHAIN CONFIGURATION TYPES
// ============================================================================

/**
 * Network type categorization
 * - 'evm': Ethereum Virtual Machine compatible chains (use EIP-712)
 * - 'svm': Solana Virtual Machine chains (Solana, Fogo) (use SPL tokens)
 * - 'stellar': Stellar network (use Soroban)
 * - 'near': NEAR Protocol (use NEP-366)
 * - 'algorand': Algorand network (use ASA transfers with atomic transactions)
 * - 'sui': Sui blockchain (use sponsored transactions)
 * - 'xrpl': XRP Ledger (use pre-signed Payment transaction blobs)
 *
 * @deprecated 'solana' type is deprecated, use 'svm' instead
 */
export type NetworkType = 'evm' | 'svm' | 'solana' | 'stellar' | 'near' | 'algorand' | 'sui' | 'xrpl';

/**
 * Supported x402 payment schemes
 * - 'exact': Standard one-shot payment (default)
 * - 'escrow': Escrow-based payment with verify/settle/refund
 * - 'commerce': Commerce alias for escrow (marketplace integrations)
 */
export type X402Scheme = 'exact' | 'escrow' | 'commerce';

/**
 * Supported stablecoin token types
 * - usdc: USD Coin (Circle) - 6 decimals
 * - eurc: Euro Coin (Circle) - 6 decimals
 * - ausd: Agora USD (Agora Finance) - 6 decimals
 * - pyusd: PayPal USD (PayPal/Paxos) - 6 decimals
 * - usdt: Tether USD (USDT0 omnichain via LayerZero) - 6 decimals
 * - usdg: Global Dollar (Paxos) - 6 decimals; settlement stablecoin on Robinhood Chain
 */
export type TokenType = 'usdc' | 'eurc' | 'ausd' | 'pyusd' | 'usdt' | 'usdg';

/**
 * Token configuration for EIP-712 signing and transfers
 */
export interface TokenConfig {
  /** Contract/mint address */
  address: string;
  /** Token decimals (6 for all supported stablecoins) */
  decimals: number;
  /** Token name for EIP-712 domain (e.g., "USD Coin" or "USDC") */
  name: string;
  /** Token version for EIP-712 domain */
  version: string;
}

/**
 * USDC token configuration for a specific chain
 * @deprecated Use TokenConfig instead. This is kept for backward compatibility.
 */
export interface USDCConfig {
  /** Contract/mint address */
  address: string;
  /** Token decimals (6 for most chains, 7 for Stellar) */
  decimals: number;
  /** Token name for EIP-712 domain (e.g., "USD Coin" or "USDC") */
  name: string;
  /** Token version for EIP-712 domain */
  version: string;
}

/**
 * Native currency configuration
 */
export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Complete chain configuration
 */
export interface ChainConfig {
  /** Numeric chain ID (0 for non-EVM chains) */
  chainId: number;
  /** Hex-encoded chain ID for wallet_switchEthereumChain */
  chainIdHex: string;
  /** Internal chain identifier (e.g., 'base', 'solana') */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Network type for routing */
  networkType: NetworkType;
  /** Primary RPC endpoint URL */
  rpcUrl: string;
  /** Block explorer base URL */
  explorerUrl: string;
  /** Native currency info */
  nativeCurrency: NativeCurrency;
  /** USDC token configuration */
  usdc: USDCConfig;
  /**
   * Multi-token configurations (EVM chains only)
   * Maps token type to its configuration for this chain.
   * Not all tokens are available on all chains.
   */
  tokens?: Partial<Record<TokenType, TokenConfig>>;
  /** x402 facilitator configuration */
  x402: {
    facilitatorUrl: string;
    enabled: boolean;
  };
}

// ============================================================================
// WALLET TYPES
// ============================================================================

/**
 * Current wallet connection state
 */
export interface WalletState {
  /** Whether a wallet is currently connected */
  connected: boolean;
  /** Connected wallet address (null if not connected) */
  address: string | null;
  /** Current chain ID (null for non-EVM or disconnected) */
  chainId: number | null;
  /** Current network name */
  network: string | null;
  /** Network type of connected wallet */
  networkType: NetworkType | null;
  /** USDC balance on current chain (null if unknown) */
  balance: string | null;
}

/**
 * Wallet adapter interface for different wallet types
 */
export interface WalletAdapter {
  /** Unique identifier for this wallet type */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Network type this adapter supports */
  readonly networkType: NetworkType;

  /** Check if this wallet is available/installed */
  isAvailable(): boolean;

  /** Connect to the wallet */
  connect(chainName?: string): Promise<string>;

  /** Disconnect from the wallet */
  disconnect(): Promise<void>;

  /** Switch to a different chain (EVM only) */
  switchChain?(chainName: string): Promise<void>;

  /**
   * Sign a payment payload
   * For EVM chains, supports multi-token via paymentInfo.tokenType
   */
  signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string>;

  /**
   * Check token balance (defaults to USDC for backward compatibility)
   * EVM providers may accept optional tokenType parameter
   */
  getBalance(chainConfig: ChainConfig, tokenType?: TokenType): Promise<string>;

  /** Get current address */
  getAddress(): string | null;

  /** Get current chain ID (EVM only) */
  getChainId?(): number | null;
}

/**
 * EIP-712 domain for typed data signing
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/**
 * EIP-712 type definitions
 */
export interface EIP712Types {
  [typeName: string]: Array<{ name: string; type: string }>;
}

// ============================================================================
// PAYMENT TYPES
// ============================================================================

/**
 * Payment information returned by backend on 402 response
 */
export interface PaymentInfo {
  /** Default recipient address */
  recipient: string;
  /** Network-specific recipient addresses */
  recipients?: {
    evm?: string;
    solana?: string;
    near?: string;
    stellar?: string;
    algorand?: string;
    sui?: string;
    xrpl?: string;
  };
  /** Facilitator address (for Solana fee payer) */
  facilitator?: string;
  /** Amount in USD (e.g., "10.00") */
  amount: string;
  /** Token symbol (usually "USDC") */
  token?: string;
  /**
   * Token type for multi-token support
   * Defaults to 'usdc' if not specified for backward compatibility
   */
  tokenType?: TokenType;
  /** Network hint from backend */
  network?: string;
  /** Supported chain IDs */
  supportedChains?: number[];
}

/**
 * Simple payment request from application
 */
export interface PaymentRequest {
  /** Amount in USDC (e.g., "10.00") */
  amount: string;
  /** Override recipient address (optional) */
  recipient?: string;
  /** Application-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * x402 payment header names
 *
 * - 'X-PAYMENT': v1 header name (default, most compatible)
 * - 'PAYMENT-SIGNATURE': v2 header name (newer standard)
 *
 * Both headers use the same base64-encoded JSON payload format.
 * The facilitator accepts both headers.
 */
export type X402HeaderName = 'X-PAYMENT' | 'PAYMENT-SIGNATURE';

/**
 * Payment headers object containing both v1 and v2 header formats
 */
export interface PaymentHeaders {
  /** v1 header: X-PAYMENT */
  'X-PAYMENT': string;
  /** v2 header: PAYMENT-SIGNATURE (same value, different header name) */
  'PAYMENT-SIGNATURE': string;
}

/**
 * Result of a payment operation
 */
export interface PaymentResult {
  /** Whether payment was successful */
  success: boolean;
  /** Base64-encoded X-PAYMENT header value */
  paymentHeader: string;
  /**
   * Payment headers object for easy use with fetch/axios
   *
   * @example
   * ```ts
   * // Use v1 header
   * fetch(url, { headers: { 'X-PAYMENT': result.headers['X-PAYMENT'] } });
   *
   * // Use v2 header
   * fetch(url, { headers: { 'PAYMENT-SIGNATURE': result.headers['PAYMENT-SIGNATURE'] } });
   * ```
   */
  headers: PaymentHeaders;
  /** Transaction hash (if available) */
  transactionHash?: string;
  /** Network where payment was made */
  network: string;
  /** Payer address */
  payer?: string;
  /** Error message (if success is false) */
  error?: string;
}

// ============================================================================
// PAYLOAD TYPES (Internal)
// ============================================================================

/**
 * EVM payment payload (ERC-3009 TransferWithAuthorization)
 */
export interface EVMPaymentPayload {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  v: number;
  r: string;
  s: string;
  chainId: number;
  token: string;
}

/**
 * Token info for non-USDC stablecoins (e.g., Token2022 like AUSD)
 * Required in payload for facilitator to verify Token2022 transfers correctly.
 */
export interface TokenInfo {
  /** Token mint address */
  address: string;
  /** Token symbol (e.g., 'AUSD') */
  symbol: string;
  /** Token decimals (e.g., 6) */
  decimals: number;
}

/**
 * Solana payment payload (partially-signed transaction)
 */
export interface SolanaPaymentPayload {
  /** Base64-encoded serialized transaction */
  transaction: string;
  /**
   * Token info for non-USDC tokens (e.g., Token2022 like AUSD)
   * CRITICAL: Must be included for Token2022 tokens for facilitator verification
   */
  token?: TokenInfo;
}

/**
 * Stellar payment payload (Soroban authorization)
 */
export interface StellarPaymentPayload {
  /** Sender G... public key */
  from: string;
  /** Recipient G... public key */
  to: string;
  /** Amount in stroops (7 decimals) */
  amount: string;
  /** USDC SAC contract address */
  tokenContract: string;
  /** Base64 XDR-encoded SorobanAuthorizationEntry */
  authorizationEntryXdr: string;
  /** Random 64-bit nonce */
  nonce: number;
  /** Ledger when authorization expires */
  signatureExpirationLedger: number;
}

/**
 * NEAR payment payload (NEP-366 meta-transaction)
 */
export interface NEARPaymentPayload {
  /** Base64 Borsh-encoded SignedDelegateAction */
  signedDelegateAction: string;
  network: 'near';
}

/**
 * Algorand payment payload (atomic transaction group)
 *
 * Follows the GoPlausible x402-avm spec for atomic groups:
 * - Transaction 0: Fee payment (UNSIGNED) - facilitator -> facilitator, covers all fees
 * - Transaction 1: ASA transfer (SIGNED) - client -> merchant
 *
 * The facilitator signs transaction 0 and submits the complete atomic group.
 */
export interface AlgorandPaymentPayload {
  /** Index of the payment transaction in the group (always 1) */
  paymentIndex: number;
  /**
   * Array of base64-encoded msgpack transactions forming the atomic group:
   * - [0]: Unsigned fee transaction (facilitator signs)
   * - [1]: Signed ASA transfer (client signed)
   */
  paymentGroup: string[];
}

/**
 * Sui payment payload (sponsored transaction)
 *
 * Uses Sui sponsored transactions where:
 * - User creates a programmable transaction for USDC transfer
 * - User signs the transaction
 * - Facilitator sponsors (pays gas in SUI) and submits
 *
 * User pays: ZERO SUI
 */
export interface SuiPaymentPayload {
  /** Base64-encoded BCS serialized TransactionData */
  transactionBytes: string;
  /** Base64-encoded user signature */
  senderSignature: string;
  /** Sender address (0x + 64 hex chars) */
  from: string;
  /** Recipient address (0x + 64 hex chars) */
  to: string;
  /** Amount in base units (string to handle large numbers) */
  amount: string;
  /** Coin object ID used for the transfer (REQUIRED by facilitator) */
  coinObjectId: string;
}

/**
 * XRPL payment payload (pre-signed Payment transaction blob)
 *
 * Uses the t54 "pre-signed Payment blob" scheme on the XRP Ledger:
 * - The client builds and FULLY signs a Payment transaction off-chain,
 *   paying its own XRP network fee.
 * - The single `signedTxBlob` field (hex-encoded fully-signed XRPL tx blob)
 *   is sent to the facilitator, which decodes it to re-derive payer/amount/
 *   destination and submits it.
 *
 * All payment-level fields (destination, amount, InvoiceID, SourceTag, etc.)
 * come from PaymentRequirements/extra, NOT from this payload.
 *
 * XRP is the native asset (6 decimals / drops). There is no token contract.
 *
 * The JSON field name is EXACTLY `signedTxBlob` (camelCase).
 */
export interface XRPLPaymentPayload {
  /** Hex-encoded fully-signed XRPL Payment transaction blob (tx_blob) */
  signedTxBlob: string;
}

/**
 * Union type for all payment payloads
 */
export type PaymentPayload =
  | EVMPaymentPayload
  | SolanaPaymentPayload
  | StellarPaymentPayload
  | NEARPaymentPayload
  | AlgorandPaymentPayload
  | SuiPaymentPayload
  | XRPLPaymentPayload;

// ============================================================================
// X402 HEADER TYPES (v1 and v2)
// ============================================================================

/**
 * x402 protocol version
 */
export type X402Version = 1 | 2;

/**
 * CAIP-2 chain identifiers for x402 v2
 * @see https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md
 */
export const CAIP2_IDENTIFIERS: Record<string, string> = {
  // EVM chains
  base: 'eip155:8453',
  ethereum: 'eip155:1',
  polygon: 'eip155:137',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  avalanche: 'eip155:43114',
  celo: 'eip155:42220',
  hyperevm: 'eip155:999',
  unichain: 'eip155:130',
  monad: 'eip155:143',
  bsc: 'eip155:56',
  scroll: 'eip155:534352',
  'skale-base': 'eip155:1187947933',
  'skale-base-sepolia': 'eip155:324705682',
  robinhood: 'eip155:4663',
  'robinhood-testnet': 'eip155:46630',
  // SVM chains
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  fogo: 'svm:fogo',
  // Stellar
  stellar: 'stellar:pubnet',
  // NEAR
  near: 'near:mainnet',
  // Algorand
  algorand: 'algorand:mainnet',
  'algorand-testnet': 'algorand:testnet',
  // Sui
  sui: 'sui:mainnet',
  'sui-testnet': 'sui:testnet',
  // XRPL (XRP Ledger has no CAIP-2 form - the v1 string IS the network id)
  'xrpl-mainnet': 'xrpl-mainnet',
  'xrpl-testnet': 'xrpl-testnet',
};

/**
 * Reverse mapping from CAIP-2 to chain name
 */
export const CAIP2_TO_CHAIN: Record<string, string> = Object.fromEntries(
  Object.entries(CAIP2_IDENTIFIERS).map(([k, v]) => [v, k])
);

/**
 * x402 v1 header structure (network as string)
 */
export interface X402HeaderV1 {
  x402Version: 1;
  scheme: X402Scheme;
  network: string;
  payload: X402PayloadData;
}

/**
 * x402 v2 payment option
 */
export interface X402PaymentOption {
  network: string; // CAIP-2 format
  asset: string;
  amount: string;
  facilitator?: string;
}

/**
 * x402 v2 header structure (CAIP-2 network, accepts array)
 */
export interface X402HeaderV2 {
  x402Version: 2;
  scheme: X402Scheme;
  network: string; // CAIP-2 format
  payload: X402PayloadData;
  accepts?: X402PaymentOption[];
}

/**
 * Union type for both v1 and v2 headers
 */
export type X402Header = X402HeaderV1 | X402HeaderV2;

/**
 * EVM-specific payload in x402 header
 */
export interface X402EVMPayload {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
  /**
   * Which token was actually paid.
   *
   * Only present when the payment is created with `includeTokenMetadata`. The
   * signature alone does not say which stablecoin it authorizes — a server that
   * accepts several tokens on the same chain cannot rebuild the payment
   * requirements without this. Omitted by default so existing v1 wire formats
   * stay byte-identical.
   */
  token?: PaymentTokenMetadata;
}

/**
 * Token identification carried inside an x402 payload.
 *
 * Mirrors what a resource server needs to build `paymentRequirements`: the
 * `asset` it must charge and the `extra` EIP-712 domain the facilitator needs
 * to recover the signature.
 */
export interface PaymentTokenMetadata {
  /** Token contract address (the `asset` of the payment requirements) */
  address: string;
  /** Uppercase token symbol, e.g. `USDC`, `EURC`, `USDT` */
  symbol: string;
  /** Token decimals — the amount in the authorization is in these units */
  decimals: number;
  /** EIP-712 domain of the token contract (the `extra` of the requirements) */
  eip712: {
    name: string;
    version: string;
  };
}

/**
 * Solana-specific payload in x402 header
 */
export interface X402SolanaPayload {
  transaction: string;
}

/**
 * Settlement account payload for Crossmint and other custodial wallets
 * that can only sendTransaction (not signTransaction).
 *
 * In this mode, the client already submitted the transaction on-chain.
 * The facilitator verifies the on-chain tx, then sweeps USDC from the
 * settlement account to the payTo address.
 *
 * Used by: Crossmint smart wallets via @faremeter/wallet-crossmint
 */
export interface X402SettlementAccountPayload {
  /** On-chain transaction signature (already submitted) */
  transactionSignature: string;
  /** Base58 secret key for sweeping settlement account (optional) */
  settleSecretKey?: string;
  /** Address to receive rent from closed settlement ATA (optional) */
  settlementRentDestination?: string;
}

/**
 * Stellar-specific payload in x402 header
 */
export interface X402StellarPayload {
  from: string;
  to: string;
  amount: string;
  tokenContract: string;
  authorizationEntryXdr: string;
  nonce: number;
  signatureExpirationLedger: number;
}

/**
 * NEAR-specific payload in x402 header
 */
export interface X402NEARPayload {
  signedDelegateAction: string;
}

/**
 * Algorand-specific payload in x402 header (atomic group format)
 */
export interface X402AlgorandPayload {
  /** Index of the payment transaction in the group (always 1) */
  paymentIndex: number;
  /** Array of base64-encoded msgpack transactions */
  paymentGroup: string[];
}

/**
 * Sui-specific payload in x402 header (sponsored transaction)
 */
export interface X402SuiPayload {
  /** BCS-encoded transaction bytes (base64) */
  transactionBytes: string;
  /** User's signature on the transaction (base64) */
  senderSignature: string;
  /** Sender's Sui address (0x...) */
  from: string;
  /** Recipient's Sui address (0x...) */
  to: string;
  /** Amount in smallest unit (string to avoid precision issues) */
  amount: string;
  /** Coin object ID used for the transfer (REQUIRED by facilitator) */
  coinObjectId: string;
}

/**
 * XRPL-specific payload in x402 header (t54 pre-signed Payment blob)
 *
 * The JSON field name is EXACTLY `signedTxBlob` (camelCase). The facilitator
 * decodes the blob to re-derive payer/amount/destination; no other fields are
 * carried in the payload.
 */
export interface X402XRPLPayload {
  /** Hex-encoded fully-signed XRPL Payment transaction blob (tx_blob) */
  signedTxBlob: string;
}

/**
 * Union of all x402 payload types
 */
export type X402PayloadData =
  | X402EVMPayload
  | X402SolanaPayload
  | X402SettlementAccountPayload
  | X402StellarPayload
  | X402NEARPayload
  | X402AlgorandPayload
  | X402SuiPayload
  | X402XRPLPayload;

// ============================================================================
// CLIENT CONFIGURATION
// ============================================================================

/**
 * Multi-payment configuration for supporting multiple networks
 */
export interface MultiPaymentConfig {
  /** Networks to support (e.g., ['base', 'solana', 'stellar', 'near']) */
  networks: string[];
  /** Default network if user hasn't selected one */
  defaultNetwork?: string;
  /** Whether to auto-detect user's preferred network based on wallet */
  autoDetect?: boolean;
}

/**
 * SDK client configuration options
 */
export interface X402ClientConfig {
  /** Facilitator URL (default: https://facilitator.ultravioletadao.xyz) */
  facilitatorUrl?: string;
  /** Default chain to connect to */
  defaultChain?: string;
  /** Auto-connect on initialization */
  autoConnect?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom chain configurations (override defaults) */
  customChains?: Record<string, Partial<ChainConfig>>;
  /** Wallet preference order */
  walletPreference?: string[];
  /** Custom RPC URLs (override defaults) */
  rpcOverrides?: Record<string, string>;
  /**
   * x402 protocol version to use
   * - 1: Classic format with network as string (e.g., "base")
   * - 2: CAIP-2 format with accepts array (e.g., "eip155:8453")
   * - 'auto': Auto-detect from 402 response (default)
   */
  x402Version?: X402Version | 'auto';
  /** Multi-payment configuration for supporting multiple networks */
  multiPayment?: MultiPaymentConfig;
  /**
   * Include a `token` block in the payload naming the asset, its decimals and
   * its EIP-712 domain.
   *
   * Needed when the resource accepts more than one stablecoin on the same
   * chain: the signature alone does not say which one was paid, so the server
   * cannot rebuild `paymentRequirements`. Off by default — the emitted header
   * stays byte-identical to previous versions.
   */
  includeTokenMetadata?: boolean;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<Pick<X402ClientConfig, 'facilitatorUrl' | 'defaultChain' | 'autoConnect' | 'debug' | 'x402Version'>> = {
  facilitatorUrl: 'https://facilitator.ultravioletadao.xyz',
  defaultChain: 'base',
  autoConnect: false,
  debug: false,
  x402Version: 'auto',
};

// ============================================================================
// BALANCE TYPES
// ============================================================================

/**
 * Balance information for a single network
 */
export interface NetworkBalance {
  /** Chain name */
  chainName: string;
  /** Human-readable display name */
  displayName: string;
  /** Formatted balance (e.g., "15.50") or null if loading/error */
  balance: string | null;
  /** Whether balance is currently being fetched */
  isLoading: boolean;
  /** Error message if fetch failed */
  error: string | null;
}

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * Events emitted by the SDK client
 */
export type X402Event =
  | 'connect'
  | 'disconnect'
  | 'chainChanged'
  | 'accountChanged'
  | 'balanceChanged'
  | 'paymentStarted'
  | 'paymentSigned'
  | 'paymentCompleted'
  | 'paymentFailed';

/**
 * Event data types
 */
export interface X402EventData {
  connect: WalletState;
  disconnect: void;
  chainChanged: { chainId: number; chainName: string };
  accountChanged: { address: string };
  balanceChanged: { balance: string };
  paymentStarted: { amount: string; network: string };
  paymentSigned: { paymentHeader: string };
  paymentCompleted: PaymentResult;
  paymentFailed: { error: string; code: X402ErrorCode };
}

/**
 * Event handler type
 */
export type X402EventHandler<E extends X402Event> = (data: X402EventData[E]) => void;

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Error codes for categorizing errors
 */
export type X402ErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'WALLET_NOT_CONNECTED'
  | 'WALLET_NOT_SUPPORTED'
  | 'WALLET_CONNECTION_FAILED'
  | 'WALLET_CONNECTION_REJECTED'
  | 'WALLET_CONNECTION_TIMEOUT'
  | 'CHAIN_NOT_SUPPORTED'
  | 'CHAIN_SWITCH_REJECTED'
  | 'INSUFFICIENT_BALANCE'
  | 'SIGNATURE_REJECTED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECIPIENT'
  | 'UNKNOWN_ERROR';

/**
 * SDK-specific error class
 */
export class X402Error extends Error {
  public readonly code: X402ErrorCode;
  public readonly details?: unknown;

  constructor(message: string, code: X402ErrorCode, details?: unknown) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, X402Error);
    }
  }
}
