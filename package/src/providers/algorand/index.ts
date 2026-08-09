/**
 * uvd-x402-sdk - Algorand Provider
 *
 * Provides wallet connection and payment creation for Algorand.
 * Supports both Lute Wallet (desktop browser extension) and Pera Wallet (mobile).
 * Uses ASA (Algorand Standard Assets) transfers for USDC payments.
 *
 * Wallet Priority:
 * 1. Lute Wallet - Desktop browser extension (preferred for desktop)
 * 2. Pera Wallet - Mobile via WalletConnect (fallback/mobile)
 *
 * USDC ASA IDs:
 * - Mainnet: 31566704
 * - Testnet: 10458941
 *
 * @example
 * ```ts
 * import { AlgorandProvider } from 'uvd-x402-sdk/algorand';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const algorand = new AlgorandProvider();
 *
 * // Connect to Lute (desktop) or Pera (mobile) automatically
 * const address = await algorand.connect();
 *
 * // Create Algorand payment
 * const chainConfig = getChainByName('algorand')!;
 * const paymentPayload = await algorand.signPayment(paymentInfo, chainConfig);
 * const header = algorand.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  AlgorandPaymentPayload,
  WalletAdapter,
  X402Version,
} from '../../types';
import { X402Error } from '../../types';
import { getChainByName } from '../../chains';
import { chainToCAIP2, encodeBase64Json } from '../../utils';
import { getFacilitatorAddress } from '../../facilitator';

/**
 * Browser-compatible base64 encoding for Uint8Array
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Lazy import Algorand dependencies
let algosdk: typeof import('algosdk') | null = null;
let PeraWalletConnect: typeof import('@perawallet/connect').PeraWalletConnect | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LuteConnect: any = null;

async function loadAlgorandDeps() {
  if (!algosdk) {
    algosdk = await import('algosdk');
  }
}

async function loadPeraWallet() {
  if (!PeraWalletConnect) {
    const peraModule = await import('@perawallet/connect');
    PeraWalletConnect = peraModule.PeraWalletConnect;
  }
}

async function loadLuteWallet() {
  if (!LuteConnect) {
    try {
      const luteModule = await import('lute-connect');
      LuteConnect = luteModule.default;
    } catch {
      // Lute not installed, will fall back to Pera
      LuteConnect = null;
    }
  }
}

/**
 * Check if Lute wallet extension is installed
 */
function isLuteAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  // Lute injects itself into window.algorand or window.lute
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  return !!(win.algorand || win.lute);
}

/**
 * AlgorandProvider - Wallet adapter for Algorand
 *
 * Supports Lute Wallet (desktop) and Pera Wallet (mobile).
 * Automatically detects and uses the best available wallet.
 */
export class AlgorandProvider implements WalletAdapter {
  readonly id = 'algorand';
  readonly name = 'Algorand Wallet';
  readonly networkType = 'algorand' as const;

  // Active wallet type
  private walletType: 'lute' | 'pera' | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private luteWallet: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private peraWallet: any = null;
  private address: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private algodClients: Map<string, any> = new Map();

  /**
   * Check if any Algorand wallet is available
   * Returns true if Lute extension is installed OR we can use Pera (always available via WalletConnect)
   */
  isAvailable(): boolean {
    return typeof window !== 'undefined';
  }

  /**
   * Get the name of the currently connected wallet
   */
  getWalletName(): string {
    if (this.walletType === 'lute') return 'Lute Wallet';
    if (this.walletType === 'pera') return 'Pera Wallet';
    return 'Algorand Wallet';
  }

  /**
   * Connect to Algorand wallet
   * Priority: Lute (desktop extension) > Pera (mobile via WalletConnect)
   */
  async connect(_chainName?: string): Promise<string> {
    await loadAlgorandDeps();

    // Try Lute first (better desktop UX)
    if (isLuteAvailable()) {
      try {
        return await this.connectLute();
      } catch (error) {
        // Lute failed, try Pera
        console.warn('Lute connection failed, falling back to Pera:', error);
      }
    }

    // Fall back to Pera (mobile/WalletConnect)
    return await this.connectPera();
  }

  /**
   * Connect to Lute Wallet (desktop browser extension)
   */
  private async connectLute(): Promise<string> {
    await loadLuteWallet();

    if (!LuteConnect) {
      throw new X402Error('Lute Wallet SDK not available', 'WALLET_NOT_FOUND');
    }

    try {
      this.luteWallet = new LuteConnect('402milly');

      // Get Algorand genesis ID for mainnet
      const genesisId = 'mainnet-v1.0';

      // Connect and get accounts
      const accounts = await this.luteWallet.connect(genesisId);

      if (!accounts || accounts.length === 0) {
        throw new X402Error('No accounts returned from Lute Wallet', 'WALLET_CONNECTION_REJECTED');
      }

      this.address = accounts[0];
      this.walletType = 'lute';

      return accounts[0];
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Lute Wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Connect to Pera Wallet (mobile via WalletConnect)
   */
  private async connectPera(): Promise<string> {
    await loadPeraWallet();

    if (!PeraWalletConnect) {
      throw new X402Error('Failed to load Pera Wallet SDK', 'WALLET_NOT_FOUND');
    }

    try {
      // Create Pera Wallet instance
      this.peraWallet = new PeraWalletConnect!();

      // Try to reconnect from previous session
      const accounts = await this.peraWallet.reconnectSession();

      if (accounts.length > 0) {
        this.address = accounts[0];
        this.walletType = 'pera';
        return accounts[0];
      }

      // If no previous session, connect fresh
      const newAccounts = await this.peraWallet.connect();

      if (newAccounts.length === 0) {
        throw new X402Error('No accounts returned from Pera Wallet', 'WALLET_CONNECTION_REJECTED');
      }

      this.address = newAccounts[0];
      this.walletType = 'pera';

      // Set up disconnect handler
      this.peraWallet.connector?.on('disconnect', () => {
        this.address = null;
        this.walletType = null;
      });

      return newAccounts[0];
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Pera Wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from wallet
   */
  async disconnect(): Promise<void> {
    if (this.walletType === 'lute' && this.luteWallet) {
      try {
        // Lute doesn't have a disconnect method, just clear state
      } catch {
        // Ignore disconnect errors
      }
      this.luteWallet = null;
    }
    if (this.walletType === 'pera' && this.peraWallet) {
      try {
        await this.peraWallet.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.peraWallet = null;
    }
    this.address = null;
    this.walletType = null;
    this.algodClients.clear();
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get USDC (ASA) balance
   *
   * Uses direct fetch with CORS-friendly RPC endpoints for browser compatibility.
   * Falls back through multiple endpoints for reliability.
   */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const assetId = parseInt(chainConfig.usdc.address, 10);

    // Use direct fetch with CORS-friendly RPC endpoints
    // The SDK's algod client has CORS issues in browser environments
    const rpcEndpoints = [
      chainConfig.rpcUrl,
      'https://mainnet-api.4160.nodely.io',
      'https://mainnet-api.algonode.cloud',
    ];

    for (const rpcUrl of rpcEndpoints) {
      try {
        const response = await fetch(`${rpcUrl}/v2/accounts/${this.address}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) continue;

        const data = await response.json();
        const assets = data.assets || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usdcAsset = assets.find((asset: any) =>
          asset['asset-id'] === assetId
        );

        if (!usdcAsset) return '0.00'; // Account not opted into USDC

        const balance = Number(usdcAsset.amount) / Math.pow(10, chainConfig.usdc.decimals);
        return balance.toFixed(2);
      } catch {
        // Continue to next endpoint
      }
    }

    return '0.00';
  }

  /**
   * Create Algorand atomic group payment (GoPlausible x402-avm spec)
   *
   * Transaction structure (atomic group):
   * - Transaction 0: Fee payment (UNSIGNED) - facilitator -> facilitator, covers all fees
   * - Transaction 1: ASA transfer (SIGNED) - client -> merchant
   *
   * The facilitator signs transaction 0 and submits the complete atomic group.
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    await loadAlgorandDeps();

    if (!this.address || !this.walletType) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    if (!algosdk) {
      throw new X402Error('Algorand SDK not loaded', 'UNKNOWN_ERROR');
    }

    const algodClient = await this.getAlgodClient(chainConfig);

    // Get recipient address (use algorand-specific or fallback to default)
    const recipient = paymentInfo.recipients?.algorand || paymentInfo.recipient;
    const assetId = parseInt(chainConfig.usdc.address, 10);

    // Get facilitator address (fee payer) - automatically from SDK config
    // Priority: paymentInfo.facilitator > SDK default for chain
    const chainName = chainConfig?.name || 'algorand';
    const facilitatorAddress =
      paymentInfo.facilitator || getFacilitatorAddress(chainName, 'algorand');

    if (!facilitatorAddress) {
      throw new X402Error(
        'Facilitator address not configured for Algorand',
        'PAYMENT_FAILED'
      );
    }

    // Parse amount (6 decimals for USDC)
    const amount = Math.floor(parseFloat(paymentInfo.amount) * 1_000_000);

    try {
      // Get suggested transaction parameters
      const suggestedParams = await algodClient.getTransactionParams().do();

      // Transaction 0: Fee payment (facilitator -> facilitator, 0 amount)
      // This transaction pays fees for both txns in the group (fee pooling)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: facilitatorAddress,
        receiver: facilitatorAddress, // self-transfer
        amount: 0,
        suggestedParams: {
          ...suggestedParams,
          fee: 2000, // Covers both transactions (1000 each)
          flatFee: true,
        },
      } as any);

      // Transaction 1: ASA transfer (client -> merchant)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const paymentTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: this.address,
        receiver: recipient,
        amount: BigInt(amount),
        assetIndex: assetId,
        suggestedParams: {
          ...suggestedParams,
          fee: 0, // Fee paid by transaction 0
          flatFee: true,
        },
        note: new TextEncoder().encode('x402 payment via uvd-x402-sdk'),
      } as any);

      // Assign group ID to both transactions (creates atomic group)
      const txnGroup = algosdk.assignGroupID([feeTxn, paymentTxn]);

      // Encode fee transaction (UNSIGNED - facilitator will sign)
      const unsignedFeeTxnBytes = algosdk.encodeUnsignedTransaction(txnGroup[0]);
      const unsignedFeeTxnBase64 = uint8ArrayToBase64(unsignedFeeTxnBytes);

      // Sign the payment transaction (index 1) with the active wallet
      let signedPaymentTxnBytes: Uint8Array;

      if (this.walletType === 'lute' && this.luteWallet) {
        // Lute uses signTxns with base64 encoded transactions
        // For atomic groups, pass both txns but only sign the one we control
        const feeTxnBase64 = uint8ArrayToBase64(txnGroup[0].toByte());
        const paymentTxnBase64 = uint8ArrayToBase64(txnGroup[1].toByte());

        // Sign only the payment transaction (index 1), leave fee txn unsigned
        const signedTxns = await this.luteWallet.signTxns([
          { txn: feeTxnBase64, signers: [] }, // Don't sign - facilitator will
          { txn: paymentTxnBase64 }, // Sign this one
        ]);

        if (!signedTxns || signedTxns.length < 2 || !signedTxns[1]) {
          throw new X402Error('No signed transaction returned', 'SIGNATURE_REJECTED');
        }

        // Get the signed payment transaction (index 1)
        const signedResult = signedTxns[1];
        signedPaymentTxnBytes = this.decodeSignedTxn(signedResult);
      } else if (this.walletType === 'pera' && this.peraWallet) {
        // Pera uses signTransaction with transaction objects
        // For atomic groups, pass both txns but only sign the one we control
        const signedTxns = await this.peraWallet.signTransaction([
          [
            { txn: txnGroup[0], signers: [] }, // Don't sign - facilitator will
            { txn: txnGroup[1] }, // Sign this one
          ],
        ]);

        if (!signedTxns || signedTxns.length < 2 || !signedTxns[1]) {
          throw new X402Error('No signed transaction returned', 'SIGNATURE_REJECTED');
        }

        signedPaymentTxnBytes = signedTxns[1];
      } else {
        throw new X402Error('No wallet available for signing', 'WALLET_NOT_CONNECTED');
      }

      const signedPaymentTxnBase64 = uint8ArrayToBase64(signedPaymentTxnBytes);

      // Build payload following GoPlausible x402-avm spec
      const payload: AlgorandPaymentPayload = {
        paymentIndex: 1, // Index of the payment transaction in the group
        paymentGroup: [
          unsignedFeeTxnBase64,   // Transaction 0: unsigned fee tx
          signedPaymentTxnBase64, // Transaction 1: signed payment tx
        ],
      };

      return JSON.stringify(payload);
    } catch (error: unknown) {
      if (error instanceof X402Error) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to sign transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }
  }

  /**
   * Decode signed transaction from wallet response (handles various formats)
   */
  private decodeSignedTxn(signedResult: unknown): Uint8Array {
    if (signedResult instanceof Uint8Array) {
      return signedResult;
    } else if (typeof signedResult === 'string') {
      // Try to decode as base64
      try {
        return Uint8Array.from(atob(signedResult), c => c.charCodeAt(0));
      } catch {
        // If standard base64 fails, try URL-safe base64
        const standardBase64 = signedResult.replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(standardBase64), c => c.charCodeAt(0));
      }
    } else if (ArrayBuffer.isView(signedResult)) {
      return new Uint8Array(
        (signedResult as ArrayBufferView).buffer,
        (signedResult as ArrayBufferView).byteOffset,
        (signedResult as ArrayBufferView).byteLength
      );
    } else {
      throw new X402Error('Unexpected signed transaction format', 'PAYMENT_FAILED');
    }
  }

  /**
   * Encode Algorand payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param chainConfig - Chain configuration
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(
    paymentPayload: string,
    chainConfig?: ChainConfig,
    version: X402Version = 1
  ): string {
    const payload = JSON.parse(paymentPayload) as AlgorandPaymentPayload;

    // Determine network name for x402
    // Use "algorand" or "algorand-testnet" format for facilitator
    let networkName: string;
    if (chainConfig?.name === 'algorand-testnet') {
      networkName = 'algorand-testnet';
    } else {
      networkName = 'algorand'; // Default to mainnet
    }

    // Build the payload data (GoPlausible x402-avm spec)
    const payloadData = {
      paymentIndex: payload.paymentIndex,
      paymentGroup: payload.paymentGroup,
    };

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2(networkName), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: networkName,
          payload: payloadData,
        };

    return encodeBase64Json(x402Payload);
  }

  // Private helpers

  /**
   * Get or create an Algod client for a specific chain
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getAlgodClient(chainConfig?: ChainConfig): Promise<any> {
    await loadAlgorandDeps();

    if (!algosdk) {
      throw new X402Error('Algorand SDK not loaded', 'UNKNOWN_ERROR');
    }

    const config = chainConfig || getChainByName('algorand');
    if (!config) {
      throw new X402Error('Chain config not found', 'CHAIN_NOT_SUPPORTED');
    }

    // Cache by RPC URL
    const cacheKey = config.rpcUrl;

    if (this.algodClients.has(cacheKey)) {
      return this.algodClients.get(cacheKey)!;
    }

    // Create new Algod client
    // Algonode.cloud doesn't require auth token
    const client = new algosdk.Algodv2('', config.rpcUrl, '');
    this.algodClients.set(cacheKey, client);

    return client;
  }
}

// Default export
export default AlgorandProvider;
