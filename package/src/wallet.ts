/**
 * uvd-x402-sdk - Signing Wallet Adapter
 *
 * Abstract interface for wallet signing operations.
 * Decouples the SDK from any specific wallet implementation,
 * allowing agents and apps to bring their own signer.
 *
 * Implementations:
 * - EnvKeyAdapter: Raw private key (from env var or constructor param)
 * - OWSWalletAdapter: Open Wallet Standard (browser/agent wallets)
 *
 * Note: This is distinct from the existing `WalletAdapter` interface
 * in `types/index.ts`, which handles full wallet connection lifecycle
 * (connect, disconnect, signPayment). `SigningWalletAdapter` is a
 * lower-level primitive for raw signing operations.
 *
 * @example EnvKeyAdapter (server-side / CLI agents)
 * ```ts
 * import { EnvKeyAdapter } from 'uvd-x402-sdk';
 *
 * const wallet = new EnvKeyAdapter(); // reads WALLET_PRIVATE_KEY
 * const address = wallet.getAddress();
 * const auth = await wallet.signEIP3009({
 *   to: '0xRecipient...',
 *   amountUsdc: 1.00,
 *   network: 'base',
 * });
 * ```
 *
 * @example OWSWalletAdapter (Open Wallet Standard)
 * ```ts
 * import { OWSWalletAdapter } from 'uvd-x402-sdk';
 *
 * const wallet = new OWSWalletAdapter(owsWalletInstance);
 * const auth = await wallet.signEIP3009({
 *   to: '0xRecipient...',
 *   amountUsdc: 0.50,
 *   network: 'base',
 * });
 * ```
 */

// ============================================================================
// EIP-3009 TYPES
// ============================================================================

/**
 * Parameters for signing an EIP-3009 ReceiveWithAuthorization
 */
export interface EIP3009Params {
  /** Recipient address (EVM 0x...) */
  to: string;
  /** Amount in USDC (human-readable, e.g. 1.50) */
  amountUsdc: number;
  /** Network name (e.g. 'base', 'ethereum', 'polygon') */
  network: string;
  /** Unix timestamp after which the authorization is valid (default: 0 = immediately) */
  validAfter?: number;
  /** Unix timestamp before which the authorization must be used (default: now + 300s) */
  validBefore?: number;
  /** USDC contract address override (auto-resolved from network if omitted) */
  usdcContract?: string;
  /** Chain ID override (auto-resolved from network if omitted) */
  chainId?: number;
}

/**
 * Signed EIP-3009 ReceiveWithAuthorization result
 */
export interface EIP3009Authorization {
  /** Sender address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount in atomic units (string to avoid precision loss) */
  value: string;
  /** Valid after timestamp (string) */
  validAfter: string;
  /** Valid before timestamp (string) */
  validBefore: string;
  /** Random 32-byte nonce (hex) */
  nonce: string;
  /** ECDSA v component */
  v: number;
  /** ECDSA r component (hex) */
  r: string;
  /** ECDSA s component (hex) */
  s: string;
  /** Full concatenated signature (hex) */
  signature: string;
}

// ============================================================================
// SIGNING WALLET ADAPTER INTERFACE
// ============================================================================

/**
 * SigningWalletAdapter -- abstract interface for wallet signing operations.
 *
 * This is a low-level signing primitive. Implementations must provide
 * EIP-191 personal_sign, EIP-712 typed data signing, and EIP-3009
 * ReceiveWithAuthorization signing for USDC gasless transfers.
 */
export interface SigningWalletAdapter {
  /** Get the EVM wallet address (checksummed) */
  getAddress(): string;

  /** Sign a message using EIP-191 personal_sign */
  signMessage(message: string): Promise<string>;

  /**
   * Sign EIP-712 typed structured data.
   *
   * @param typedData - JSON string of the full EIP-712 typed data
   *   (must include `domain`, `types`, `primaryType`, and `message` fields)
   * @returns Object with the full signature and its v/r/s components
   */
  signTypedData(typedData: string): Promise<{
    signature: string;
    v: number;
    r: string;
    s: string;
  }>;

  /**
   * Sign an EIP-3009 ReceiveWithAuthorization for USDC.
   *
   * Builds the EIP-712 typed data for `TransferWithAuthorization`
   * and signs it. The returned authorization can be relayed to a
   * facilitator for gasless on-chain execution.
   *
   * @param params - EIP-3009 parameters (recipient, amount, network)
   * @returns Signed authorization with v/r/s components
   */
  signEIP3009(params: EIP3009Params): Promise<EIP3009Authorization>;

  /**
   * Sign a serialized EVM transaction.
   *
   * Used by AdvancedEscrowClient for on-chain operations (release, refund,
   * charge) where the transaction must be signed by the wallet before
   * broadcast. The unsigned transaction is built by ethers and serialized
   * to hex; the adapter signs it and returns the signed raw transaction.
   *
   * @param unsignedTx - Hex-encoded unsigned transaction (ethers serialized)
   * @returns Hex-encoded signed raw transaction, ready for broadcast
   */
  signTransaction(unsignedTx: string): Promise<string>;
}
