/**
 * uvd-x402-sdk - EVM Provider
 *
 * Provides EVM wallet connection and payment creation.
 * Uses EIP-712 typed data signing for ERC-3009 TransferWithAuthorization.
 *
 * Supports MetaMask, Rabby, and other injected EVM wallets.
 * WalletConnect support is available for mobile wallets.
 *
 * @example
 * ```ts
 * import { EVMProvider } from 'uvd-x402-sdk/evm';
 *
 * const evm = new EVMProvider();
 *
 * // Connect to Base
 * const address = await evm.connect('base');
 *
 * // Create payment
 * const paymentHeader = await evm.signPayment(paymentInfo, chainConfig);
 * ```
 */

import { ethers } from 'ethers';
import type {
  ChainConfig,
  PaymentInfo,
  EVMPaymentPayload,
  WalletAdapter,
  TokenType,
  TokenConfig,
  X402EVMPayload,
} from '../../types';
import { X402Error } from '../../types';
import { getChainByName, getChainById, getTokenConfig } from '../../chains';
import {
  validateRecipient,
  chainToCAIP2,
  encodeBase64Json,
  buildTokenMetadata,
} from '../../utils';
import type { X402Version } from '../../types';

/**
 * Ethereum provider interface
 */
interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

/**
 * EVMProvider - Wallet adapter for EVM chains
 */
export class EVMProvider implements WalletAdapter {
  readonly id = 'injected';
  readonly name = 'EVM Wallet';
  readonly networkType = 'evm' as const;

  private provider: ethers.BrowserProvider | null = null;
  private signer: ethers.Signer | null = null;
  private address: string | null = null;
  private chainId: number | null = null;
  private chainName: string | null = null;

  /**
   * Check if an EVM wallet is available
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    return typeof (window as Window & { ethereum?: EthereumProvider }).ethereum !== 'undefined';
  }

  /**
   * Connect to an EVM wallet
   */
  async connect(chainName?: string): Promise<string> {
    const targetChainName = chainName || 'base';
    const chain = getChainByName(targetChainName);

    if (!chain) {
      throw new X402Error(`Unsupported chain: ${targetChainName}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (chain.networkType !== 'evm') {
      throw new X402Error(`${targetChainName} is not an EVM chain`, 'CHAIN_NOT_SUPPORTED');
    }

    const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum) {
      throw new X402Error(
        'No Ethereum wallet found. Please install MetaMask or another EVM wallet.',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      this.provider = new ethers.BrowserProvider(ethereum);

      // Request account access
      await this.provider.send('eth_requestAccounts', []);

      // Switch to target chain
      await this.switchChain(targetChainName);

      // Get signer and address
      this.signer = await this.provider.getSigner();
      this.address = await this.signer.getAddress();

      return this.address;
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('User rejected') || (error as { code?: number }).code === 4001) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from wallet
   */
  async disconnect(): Promise<void> {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.chainName = null;
  }

  /**
   * Switch to a different EVM chain
   */
  async switchChain(chainName: string): Promise<void> {
    const chain = getChainByName(chainName);

    if (!chain) {
      throw new X402Error(`Unsupported chain: ${chainName}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (!this.provider) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    try {
      await this.provider.send('wallet_switchEthereumChain', [{ chainId: chain.chainIdHex }]);
    } catch (switchError: unknown) {
      // Chain not added - try to add it
      if ((switchError as { code?: number }).code === 4902) {
        try {
          await this.provider.send('wallet_addEthereumChain', [
            {
              chainId: chain.chainIdHex,
              chainName: chain.displayName,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.explorerUrl],
            },
          ]);
        } catch (addError) {
          throw new X402Error(
            `Failed to add ${chain.displayName} network`,
            'CHAIN_SWITCH_REJECTED',
            addError
          );
        }
      } else if ((switchError as { code?: number }).code === 4001) {
        throw new X402Error('Network switch rejected by user', 'CHAIN_SWITCH_REJECTED');
      } else {
        throw new X402Error(
          `Failed to switch to ${chain.displayName}`,
          'CHAIN_SWITCH_REJECTED',
          switchError
        );
      }
    }

    this.chainId = chain.chainId;
    this.chainName = chain.name;
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get current chain ID
   */
  getChainId(): number | null {
    return this.chainId;
  }

  /**
   * Get current chain name
   */
  getChainName(): string | null {
    return this.chainName;
  }

  /**
   * Get token balance (defaults to USDC for backward compatibility)
   *
   * @param chainConfig - Chain configuration
   * @param tokenType - Token type to check balance for (defaults to 'usdc')
   * @returns Formatted balance string
   */
  async getBalance(chainConfig: ChainConfig, tokenType: TokenType = 'usdc'): Promise<string> {
    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    // Get token config for the specified token type
    const tokenConfig = getTokenConfig(chainConfig.name, tokenType);
    if (!tokenConfig) {
      // Fall back to USDC config for backward compatibility
      const fallbackConfig = chainConfig.usdc;
      if (!fallbackConfig) {
        throw new X402Error(`Token ${tokenType} not supported on ${chainConfig.name}`, 'INVALID_CONFIG');
      }
      return this.getBalanceWithConfig(chainConfig.rpcUrl, fallbackConfig);
    }

    return this.getBalanceWithConfig(chainConfig.rpcUrl, tokenConfig);
  }

  /**
   * Internal helper to get balance using a token config
   */
  private async getBalanceWithConfig(rpcUrl: string, tokenConfig: TokenConfig): Promise<string> {
    if (!this.address) {
      return '0.00';
    }

    // Use public RPC for balance check
    const publicProvider = new ethers.JsonRpcProvider(rpcUrl);

    const tokenAbi = ['function balanceOf(address owner) view returns (uint256)'];
    const tokenContract = new ethers.Contract(tokenConfig.address, tokenAbi, publicProvider);

    try {
      const balance = await tokenContract.balanceOf(this.address);
      const formatted = ethers.formatUnits(balance, tokenConfig.decimals);
      return parseFloat(formatted).toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create EVM payment (EIP-712 TransferWithAuthorization)
   *
   * Supports multi-token payments. If paymentInfo.tokenType is specified,
   * it will use the appropriate token configuration. Defaults to USDC
   * for backward compatibility.
   *
   * @param paymentInfo - Payment details including amount and recipient
   * @param chainConfig - Chain configuration
   * @returns JSON-encoded payment payload
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    if (!this.signer || !this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    // Determine token type (default to 'usdc' for backward compatibility)
    const tokenType: TokenType = paymentInfo.tokenType || 'usdc';

    // Get token configuration for the specified token type
    const tokenConfig = getTokenConfig(chainConfig.name, tokenType);
    if (!tokenConfig) {
      throw new X402Error(
        `Token ${tokenType} not supported on ${chainConfig.name}`,
        'CHAIN_NOT_SUPPORTED'
      );
    }

    // Get recipient
    const recipient = paymentInfo.recipients?.evm || paymentInfo.recipient;

    // Validate recipient address - prevents empty/invalid addresses
    validateRecipient(recipient, 'evm');

    // Generate random nonce
    const nonceBytes = new Uint8Array(32);
    if (typeof window !== 'undefined' && window.crypto) {
      window.crypto.getRandomValues(nonceBytes);
    } else {
      for (let i = 0; i < 32; i++) {
        nonceBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const nonce = ethers.hexlify(nonceBytes);

    // Set validity window
    const validAfter = 0;
    const validityWindowSeconds = chainConfig.name === 'base' ? 300 : 60;
    const validBefore = Math.floor(Date.now() / 1000) + validityWindowSeconds;

    // EIP-712 domain using the selected token's configuration
    const domain = {
      name: tokenConfig.name,
      version: tokenConfig.version,
      chainId: chainConfig.chainId,
      verifyingContract: tokenConfig.address,
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

    // Parse amount using the token's decimals
    const value = ethers.parseUnits(paymentInfo.amount, tokenConfig.decimals);
    const from = this.address;
    const to = ethers.getAddress(recipient);

    // Message to sign
    const message = {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    // Sign the EIP-712 message
    let signature: string;
    try {
      signature = await this.signer.signTypedData(domain, types, message);
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('User rejected') || (error as { code?: number }).code === 4001)) {
        throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
      }
      throw new X402Error(
        `Failed to sign payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }

    const sig = ethers.Signature.from(signature);

    // Construct payload with the selected token address
    const payload: EVMPaymentPayload = {
      from,
      to,
      value: value.toString(),
      validAfter,
      validBefore,
      nonce,
      v: sig.v,
      r: sig.r,
      s: sig.s,
      chainId: chainConfig.chainId,
      token: tokenConfig.address,
    };

    return JSON.stringify(payload);
  }

  /**
   * Encode EVM payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param chainConfig - Chain configuration
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @param options - Encoding options
   * @param options.includeTokenMetadata - Add a `token` block naming the asset,
   *   its decimals and its EIP-712 domain. Required when the resource accepts
   *   more than one stablecoin on the same chain, since the signature alone
   *   does not say which one was paid. Off by default: the emitted header stays
   *   byte-identical to previous versions.
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(
    paymentPayload: string,
    chainConfig: ChainConfig,
    version: X402Version = 1,
    options: { includeTokenMetadata?: boolean } = {}
  ): string {
    const payload = JSON.parse(paymentPayload) as EVMPaymentPayload;

    // Reconstruct full signature
    const fullSignature = payload.r + payload.s.slice(2) + payload.v.toString(16).padStart(2, '0');

    // Build the payload data
    const payloadData: X402EVMPayload = {
      signature: fullSignature,
      authorization: {
        from: payload.from,
        to: payload.to,
        value: payload.value,
        validAfter: payload.validAfter.toString(),
        validBefore: payload.validBefore.toString(),
        nonce: payload.nonce,
      },
    };

    if (options.includeTokenMetadata) {
      const token = buildTokenMetadata(chainConfig.name, payload.token);
      if (!token) {
        throw new X402Error(
          `Token ${payload.token} is not in the registry for ${chainConfig.name}; cannot build token metadata`,
          'CHAIN_NOT_SUPPORTED'
        );
      }
      payloadData.token = token;
    }

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2(chainConfig.name), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: chainConfig.name, // Plain chain name for v1
          payload: payloadData,
        };

    return encodeBase64Json(x402Payload);
  }

  /**
   * Setup event listeners for wallet events
   */
  setupEventListeners(
    onAccountsChanged?: (accounts: string[]) => void,
    onChainChanged?: (chainId: number) => void
  ): () => void {
    const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum?.on || !ethereum?.removeListener) {
      return () => {};
    }

    const handleAccountsChanged = (accounts: unknown) => {
      if (Array.isArray(accounts)) {
        if (accounts.length === 0) {
          this.disconnect();
        } else if (accounts[0] !== this.address) {
          this.address = accounts[0] as string;
        }
        onAccountsChanged?.(accounts as string[]);
      }
    };

    const handleChainChanged = (chainIdHex: unknown) => {
      if (typeof chainIdHex === 'string') {
        const chainId = parseInt(chainIdHex, 16);
        const chain = getChainById(chainId);
        if (chain) {
          this.chainId = chainId;
          this.chainName = chain.name;
        }
        onChainChanged?.(chainId);
      }
    };

    ethereum.on('accountsChanged', handleAccountsChanged);
    ethereum.on('chainChanged', handleChainChanged);

    // Return cleanup function
    return () => {
      ethereum.removeListener!('accountsChanged', handleAccountsChanged);
      ethereum.removeListener!('chainChanged', handleChainChanged);
    };
  }
}

export default EVMProvider;
