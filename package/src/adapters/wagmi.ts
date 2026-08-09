/**
 * uvd-x402-sdk - Wagmi/Viem Adapter
 *
 * Provides integration with wagmi/viem for projects using RainbowKit,
 * ConnectKit, or other wagmi-based wallet connection libraries.
 *
 * @example
 * ```tsx
 * import { useWalletClient } from 'wagmi';
 * import { createPaymentFromWalletClient } from 'uvd-x402-sdk/wagmi';
 *
 * function PayButton() {
 *   const { data: walletClient } = useWalletClient();
 *
 *   const handlePay = async () => {
 *     const paymentHeader = await createPaymentFromWalletClient(walletClient, {
 *       recipient: '0x...',
 *       amount: '1.00',
 *       chainName: 'base',
 *     });
 *
 *     // Use in your API request
 *     await fetch('/api/paid-endpoint', {
 *       headers: { 'X-PAYMENT': paymentHeader }
 *     });
 *   };
 *
 *   return <button onClick={handlePay}>Pay $1.00</button>;
 * }
 * ```
 */

import { getChainByName } from '../chains';
import { createX402V1Header, createX402V2Header, encodeX402Header, validateRecipient } from '../utils';
import { X402Error } from '../types';
import type { PaymentResult, X402Version } from '../types';

/**
 * Viem WalletClient interface (minimal type to avoid viem dependency)
 */
export interface WalletClient {
  account: {
    address: `0x${string}`;
  };
  signTypedData: (args: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: `0x${string}`;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
}

/**
 * Payment options for wagmi adapter
 */
export interface WagmiPaymentOptions {
  /** Recipient address */
  recipient: string;
  /** Amount in USDC (e.g., "1.00", "10.50") */
  amount: string;
  /** Chain name (default: 'base') */
  chainName?: string;
  /** Validity window in seconds (default: 300 = 5 minutes) */
  validitySeconds?: number;
  /**
   * x402 protocol version (default: 1)
   * - 1: Classic format with network as string (e.g., "base")
   * - 2: CAIP-2 format (e.g., "eip155:8453")
   */
  x402Version?: X402Version;
}

/**
 * Generate a random 32-byte nonce as hex string
 */
function generateNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    // Fallback for non-browser environments
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

/**
 * Parse amount string to atomic units (BigInt)
 */
function parseUnits(amount: string, decimals: number): bigint {
  const [integer, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(integer + paddedFraction);
}

/**
 * Create an x402 payment header using a wagmi/viem WalletClient
 *
 * This function allows you to use the x402 SDK with wagmi-based wallet
 * connections (RainbowKit, ConnectKit, etc.) instead of the built-in
 * wallet connection.
 *
 * @param walletClient - The WalletClient from wagmi's useWalletClient hook
 * @param options - Payment options (recipient, amount, chainName)
 * @returns Base64-encoded payment header ready for X-PAYMENT HTTP header
 *
 * @example
 * ```tsx
 * import { useWalletClient } from 'wagmi';
 * import { createPaymentFromWalletClient } from 'uvd-x402-sdk/wagmi';
 *
 * const { data: walletClient } = useWalletClient();
 *
 * const paymentHeader = await createPaymentFromWalletClient(walletClient, {
 *   recipient: '0xRecipientAddress',
 *   amount: '5.00',
 *   chainName: 'base',
 * });
 * ```
 */
export async function createPaymentFromWalletClient(
  walletClient: WalletClient | undefined | null,
  options: WagmiPaymentOptions
): Promise<string> {
  if (!walletClient) {
    throw new X402Error('WalletClient is not available. Make sure wallet is connected.', 'WALLET_NOT_CONNECTED');
  }

  const {
    recipient,
    amount,
    chainName = 'base',
    validitySeconds = 300,
    x402Version = 1,
  } = options;

  // Validate recipient address - prevents empty/invalid addresses
  validateRecipient(recipient, 'evm');

  // Get chain configuration
  const chain = getChainByName(chainName);
  if (!chain) {
    throw new X402Error(`Unsupported chain: ${chainName}`, 'CHAIN_NOT_SUPPORTED');
  }

  if (chain.networkType !== 'evm') {
    throw new X402Error(
      `wagmi adapter only supports EVM chains. For ${chain.networkType}, use the appropriate provider.`,
      'CHAIN_NOT_SUPPORTED'
    );
  }

  const from = walletClient.account.address;
  const to = recipient as `0x${string}`;
  const nonce = generateNonce();
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + validitySeconds;
  const value = parseUnits(amount, chain.usdc.decimals);

  // EIP-712 domain
  const domain = {
    name: chain.usdc.name,
    version: chain.usdc.version,
    chainId: chain.chainId,
    verifyingContract: chain.usdc.address as `0x${string}`,
  };

  // EIP-712 types for TransferWithAuthorization (ERC-3009)
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  // Message to sign
  const message = {
    from,
    to,
    value,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  // Sign with viem
  let signature: `0x${string}`;
  try {
    signature = await walletClient.signTypedData({
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message.includes('User rejected') || error.message.includes('denied')) {
        throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
      }
    }
    throw new X402Error(
      `Failed to sign payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PAYMENT_FAILED',
      error
    );
  }

  // Build the payload data
  // IMPORTANT: validAfter, validBefore, and value must be STRINGS
  const payloadData = {
    signature,
    authorization: {
      from,
      to: recipient,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };

  // Create x402 header with correct version format
  const header = x402Version === 2
    ? createX402V2Header(chainName, payloadData)
    : createX402V1Header(chainName, payloadData);

  return encodeX402Header(header);
}

/**
 * Create payment with full result object (includes metadata)
 *
 * Same as createPaymentFromWalletClient but returns a PaymentResult
 * object with additional metadata.
 *
 * @param walletClient - The WalletClient from wagmi
 * @param options - Payment options
 * @returns PaymentResult with paymentHeader and metadata
 */
export async function createPaymentWithResult(
  walletClient: WalletClient | undefined | null,
  options: WagmiPaymentOptions
): Promise<PaymentResult> {
  const paymentHeader = await createPaymentFromWalletClient(walletClient, options);

  return {
    success: true,
    paymentHeader,
    headers: {
      'X-PAYMENT': paymentHeader,
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    network: options.chainName || 'base',
    payer: walletClient?.account.address,
  };
}

/**
 * React hook helper for wagmi integration
 *
 * Returns a function that creates payments using the connected wallet.
 * This is a simple wrapper - for more control, use createPaymentFromWalletClient directly.
 *
 * @example
 * ```tsx
 * import { useWalletClient } from 'wagmi';
 * import { useX402Wagmi } from 'uvd-x402-sdk/wagmi';
 *
 * function PayButton() {
 *   const { data: walletClient } = useWalletClient();
 *   const { createPayment, isReady } = useX402Wagmi(walletClient);
 *
 *   return (
 *     <button
 *       disabled={!isReady}
 *       onClick={() => createPayment({ recipient: '0x...', amount: '1.00' })}
 *     >
 *       Pay
 *     </button>
 *   );
 * }
 * ```
 */
export function useX402Wagmi(walletClient: WalletClient | undefined | null) {
  const isReady = !!walletClient;

  const createPayment = async (options: WagmiPaymentOptions): Promise<string> => {
    return createPaymentFromWalletClient(walletClient, options);
  };

  const createPaymentFull = async (options: WagmiPaymentOptions): Promise<PaymentResult> => {
    return createPaymentWithResult(walletClient, options);
  };

  return {
    isReady,
    createPayment,
    createPaymentFull,
  };
}
