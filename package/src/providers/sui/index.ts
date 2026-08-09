/**
 * uvd-x402-sdk - Sui Provider
 *
 * Provides wallet connection and payment creation for Sui blockchain.
 * Uses sponsored transactions where the facilitator pays gas fees.
 *
 * @example Sui Mainnet
 * ```ts
 * import { SuiProvider } from 'uvd-x402-sdk/sui';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const sui = new SuiProvider();
 *
 * // Connect
 * const address = await sui.connect();
 *
 * // Create payment
 * const chainConfig = getChainByName('sui')!;
 * const paymentPayload = await sui.signPayment(paymentInfo, chainConfig);
 * const header = sui.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 *
 * @example Sui Testnet
 * ```ts
 * import { SuiProvider } from 'uvd-x402-sdk/sui';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const sui = new SuiProvider();
 *
 * // Connect
 * const address = await sui.connect();
 *
 * // Create testnet payment
 * const chainConfig = getChainByName('sui-testnet')!;
 * const paymentPayload = await sui.signPayment(paymentInfo, chainConfig);
 * const header = sui.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  SuiPaymentPayload,
  WalletAdapter,
  X402Version,
} from '../../types';
import { X402Error } from '../../types';
import { getChainByName } from '../../chains';
import { chainToCAIP2, encodeBase64Json } from '../../utils';

// Lazy import Sui dependencies to avoid bundling when not used
let SuiClient: typeof import('@mysten/sui/client').SuiClient;
let Transaction: typeof import('@mysten/sui/transactions').Transaction;

async function loadSuiDeps() {
  if (!SuiClient) {
    const clientModule = await import('@mysten/sui/client');
    const txModule = await import('@mysten/sui/transactions');
    SuiClient = clientModule.SuiClient;
    Transaction = txModule.Transaction;
  }
}

/**
 * Sui wallet provider interface (for Sui Wallet, Suiet, etc.)
 */
interface SuiWalletProvider {
  hasPermissions?: () => Promise<boolean>;
  requestPermissions?: () => Promise<boolean>;
  getAccounts: () => Promise<string[]>;
  signTransactionBlock?: (input: {
    transactionBlock: Uint8Array;
    account: string;
    chain: string;
  }) => Promise<{
    signature: string;
    transactionBlockBytes: string;
  }>;
  signTransaction?: (input: {
    transaction: Uint8Array;
    account: string;
    chain: string;
  }) => Promise<{
    signature: string;
    bytes: string;
  }>;
}

/**
 * SuiProvider - Wallet adapter for Sui blockchain
 *
 * Uses sponsored transactions where:
 * 1. User creates a programmable transaction for token transfer
 * 2. User signs the transaction
 * 3. Facilitator sponsors (pays gas) and submits
 */
export class SuiProvider implements WalletAdapter {
  readonly id = 'sui-wallet';
  readonly name = 'Sui Wallet';
  readonly networkType = 'sui' as const;

  private provider: SuiWalletProvider | null = null;
  private clients: Map<string, InstanceType<typeof SuiClient>> = new Map();
  private address: string | null = null;

  /**
   * Check if Sui wallet is available
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    const win = window as Window & { suiWallet?: SuiWalletProvider };
    return !!win.suiWallet;
  }

  /**
   * Connect to Sui wallet
   */
  async connect(): Promise<string> {
    await loadSuiDeps();

    // Get Sui wallet provider
    this.provider = await this.getSuiWalletProvider();
    if (!this.provider) {
      throw new X402Error(
        'Sui wallet not installed. Please install Sui Wallet or Suiet from Chrome Web Store',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      // Request permissions if needed
      if (this.provider.requestPermissions) {
        await this.provider.requestPermissions();
      }

      // Get accounts
      const accounts = await this.provider.getAccounts();
      if (!accounts || accounts.length === 0) {
        throw new X402Error('No Sui accounts found', 'WALLET_CONNECTION_FAILED');
      }

      this.address = accounts[0];
      return this.address;
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('rejected')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Sui wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from Sui wallet
   */
  async disconnect(): Promise<void> {
    this.provider = null;
    this.clients.clear();
    this.address = null;
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get USDC balance
   */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    await loadSuiDeps();

    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const client = await this.getClient(chainConfig);

    try {
      // Get all USDC coins for this address
      const coins = await client.getCoins({
        owner: this.address,
        coinType: chainConfig.usdc.address,
      });

      if (!coins.data || coins.data.length === 0) {
        return '0.00';
      }

      // Sum all USDC balances
      const totalBalance = coins.data.reduce((sum, coin) => {
        return sum + BigInt(coin.balance);
      }, BigInt(0));

      const balance = Number(totalBalance) / Math.pow(10, chainConfig.usdc.decimals);
      return balance.toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create Sui payment (sponsored transaction)
   *
   * Transaction structure:
   * 1. User creates a programmable transaction for USDC transfer
   * 2. Transaction is signed by the user
   * 3. Facilitator sponsors the transaction (pays gas in SUI)
   * 4. Facilitator adds sponsor signature and submits
   *
   * User pays: ZERO SUI
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    await loadSuiDeps();

    if (!this.provider || !this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const client = await this.getClient(chainConfig);

    // Get recipient address
    const recipient = paymentInfo.recipients?.sui || paymentInfo.recipient;
    const facilitatorAddress = paymentInfo.facilitator;

    if (!facilitatorAddress) {
      throw new X402Error('Facilitator address not provided', 'INVALID_CONFIG');
    }

    // Parse amount (6 decimals for USDC)
    const amount = BigInt(Math.floor(parseFloat(paymentInfo.amount) * 1_000_000));

    // Find USDC coins for transfer
    const usdcCoins = await client.getCoins({
      owner: this.address,
      coinType: chainConfig.usdc.address,
    });

    if (!usdcCoins.data || usdcCoins.data.length === 0) {
      throw new X402Error('No USDC coins found in wallet', 'INSUFFICIENT_BALANCE');
    }

    // Check total balance
    const totalBalance = usdcCoins.data.reduce((sum, coin) => sum + BigInt(coin.balance), BigInt(0));
    if (totalBalance < amount) {
      throw new X402Error(
        `Insufficient USDC balance. Have: ${Number(totalBalance) / 1_000_000}, Need: ${Number(amount) / 1_000_000}`,
        'INSUFFICIENT_BALANCE'
      );
    }

    // Build the programmable transaction
    const tx = new Transaction();

    // Set the gas sponsor (facilitator pays)
    tx.setSender(this.address);
    tx.setGasOwner(facilitatorAddress);

    // Find a coin with enough balance or merge coins
    let coinToUse: string;
    const sufficientCoin = usdcCoins.data.find(c => BigInt(c.balance) >= amount);

    if (sufficientCoin) {
      coinToUse = sufficientCoin.coinObjectId;
    } else {
      // Need to merge coins - use the first coin as base
      const baseCoin = usdcCoins.data[0];
      coinToUse = baseCoin.coinObjectId;

      // Merge other coins into the first one
      const otherCoins = usdcCoins.data.slice(1).map(c => c.coinObjectId);
      if (otherCoins.length > 0) {
        tx.mergeCoins(tx.object(coinToUse), otherCoins.map(id => tx.object(id)));
      }
    }

    // Split the exact amount and transfer to recipient
    const [paymentCoin] = tx.splitCoins(tx.object(coinToUse), [amount]);
    tx.transferObjects([paymentCoin], recipient);

    // Build transaction bytes
    const txBytes = await tx.build({ client });

    // Sign the transaction
    let signedTx: { signature: string; bytes: string };

    try {
      // Try new API first (signTransaction)
      if (this.provider.signTransaction) {
        signedTx = await this.provider.signTransaction({
          transaction: txBytes,
          account: this.address,
          chain: chainConfig.name === 'sui-testnet' ? 'sui:testnet' : 'sui:mainnet',
        });
      }
      // Fall back to old API (signTransactionBlock)
      else if (this.provider.signTransactionBlock) {
        const result = await this.provider.signTransactionBlock({
          transactionBlock: txBytes,
          account: this.address,
          chain: chainConfig.name === 'sui-testnet' ? 'sui:testnet' : 'sui:mainnet',
        });
        signedTx = {
          signature: result.signature,
          bytes: result.transactionBlockBytes,
        };
      } else {
        throw new X402Error('Wallet does not support transaction signing', 'WALLET_NOT_SUPPORTED');
      }
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('rejected')) {
          throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to sign transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }

    // Build the payload for the facilitator
    // CRITICAL: coinObjectId is REQUIRED by the facilitator for deserialization
    const payload: SuiPaymentPayload = {
      transactionBytes: signedTx.bytes,
      senderSignature: signedTx.signature,
      from: this.address,
      to: recipient,
      amount: amount.toString(),
      coinObjectId: coinToUse,
    };

    return JSON.stringify(payload);
  }

  /**
   * Encode Sui payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param chainConfig - Chain configuration (optional, defaults to 'sui')
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(
    paymentPayload: string,
    chainConfig?: ChainConfig,
    version: X402Version = 1
  ): string {
    const payload = JSON.parse(paymentPayload) as SuiPaymentPayload;

    // Use chain name from config, or default to 'sui' for backward compatibility
    const networkName = chainConfig?.name || 'sui';

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2(networkName), // CAIP-2 format for v2
          payload: payload,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: networkName, // Plain chain name for v1
          payload: payload,
        };

    return encodeBase64Json(x402Payload);
  }

  // Private helpers

  private async getSuiWalletProvider(): Promise<SuiWalletProvider | null> {
    if (typeof window === 'undefined') return null;

    const win = window as Window & { suiWallet?: SuiWalletProvider };

    // Check for Sui Wallet
    if (win.suiWallet) {
      return win.suiWallet;
    }

    // Wait a bit for wallet to inject itself
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (win.suiWallet) {
        return win.suiWallet;
      }
    }

    return null;
  }

  /**
   * Get or create a Sui client for a specific chain
   */
  private async getClient(chainConfig?: ChainConfig): Promise<InstanceType<typeof SuiClient>> {
    await loadSuiDeps();

    const config = chainConfig || getChainByName('sui');
    if (!config) {
      throw new X402Error('Chain config not found', 'CHAIN_NOT_SUPPORTED');
    }

    // Cache by RPC URL
    const cacheKey = config.rpcUrl;

    if (this.clients.has(cacheKey)) {
      return this.clients.get(cacheKey)!;
    }

    const client = new SuiClient({ url: config.rpcUrl });
    this.clients.set(cacheKey, client);

    return client;
  }
}

// Default export
export default SuiProvider;
