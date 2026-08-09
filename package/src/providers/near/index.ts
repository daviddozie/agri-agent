/**
 * uvd-x402-sdk - NEAR Provider
 *
 * Provides NEAR wallet connection and payment creation via MyNearWallet or Meteor.
 * Uses NEP-366 meta-transactions where the facilitator pays all gas fees.
 *
 * NEP-366 Flow:
 * 1. User creates a DelegateAction (ft_transfer on USDC contract)
 * 2. User signs the DelegateAction with their ED25519 key
 * 3. SignedDelegateAction is sent to facilitator
 * 4. Facilitator wraps it and submits to NEAR, paying all gas
 *
 * NEP-366 Wallet Support:
 * For apps that need wallet selector integration, call setupWalletSelector() early:
 *
 * ```ts
 * // In your app's initialization (e.g., App.tsx or main.ts)
 * await NEARProvider.setupWalletSelector({
 *   walletUrl: 'https://mynearwallet.ultravioletadao.xyz',
 *   contractId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
 * });
 * ```
 *
 * @example
 * ```ts
 * import { NEARProvider } from 'uvd-x402-sdk/near';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const near = new NEARProvider();
 *
 * // Connect
 * const accountId = await near.connect();
 *
 * // Create payment
 * const chainConfig = getChainByName('near')!;
 * const paymentPayload = await near.signPayment(paymentInfo, chainConfig);
 * const header = near.encodePaymentHeader(paymentPayload);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  NEARPaymentPayload,
  WalletAdapter,
  X402Version,
} from '../../types';
import { X402Error } from '../../types';
import { chainToCAIP2, encodeBase64Json } from '../../utils';

// NEAR configuration
const NEAR_CONFIG = {
  networkId: 'mainnet',
  nodeUrl: 'https://rpc.mainnet.near.org',
  walletUrl: 'https://wallet.mainnet.near.org',
  helperUrl: 'https://helper.mainnet.near.org',
};

// NEP-366 prefix: (2^30 + 366) as u32 little-endian
const NEP366_PREFIX = new Uint8Array([0x6e, 0x01, 0x00, 0x40]);

/**
 * Simple Borsh serializer for NEAR transactions
 */
class BorshSerializer {
  private buffer: number[] = [];

  writeU8(value: number): void {
    this.buffer.push(value & 0xff);
  }

  writeU32(value: number): void {
    this.buffer.push(value & 0xff);
    this.buffer.push((value >> 8) & 0xff);
    this.buffer.push((value >> 16) & 0xff);
    this.buffer.push((value >> 24) & 0xff);
  }

  writeU64(value: bigint | number): void {
    const val = BigInt(value);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(Number((val >> BigInt(i * 8)) & BigInt(0xff)));
    }
  }

  writeU128(value: bigint | number): void {
    const val = BigInt(value);
    for (let i = 0; i < 16; i++) {
      this.buffer.push(Number((val >> BigInt(i * 8)) & BigInt(0xff)));
    }
  }

  writeString(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.writeU32(encoded.length);
    this.buffer.push(...encoded);
  }

  writeFixedBytes(data: Uint8Array): void {
    this.buffer.push(...data);
  }

  writeBytes(data: Uint8Array): void {
    this.writeU32(data.length);
    this.buffer.push(...data);
  }

  getBytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

/**
 * Serialize a NonDelegateAction for ft_transfer (NEP-366)
 */
function serializeNonDelegateAction(
  receiverId: string,
  amount: bigint,
  memo?: string
): Uint8Array {
  const args: Record<string, string> = {
    receiver_id: receiverId,
    amount: amount.toString(),
  };
  if (memo) {
    args.memo = memo;
  }
  const argsJson = new TextEncoder().encode(JSON.stringify(args));

  const ser = new BorshSerializer();
  ser.writeU8(2); // FunctionCall action type
  ser.writeString('ft_transfer');
  ser.writeBytes(argsJson);
  ser.writeU64(BigInt(30_000_000_000_000)); // 30 TGas
  ser.writeU128(BigInt(1)); // 1 yoctoNEAR deposit (required for ft_transfer)
  return ser.getBytes();
}

/**
 * Serialize a DelegateAction for NEP-366 meta-transactions
 */
function serializeDelegateAction(
  senderId: string,
  receiverId: string,
  actionsBytes: Uint8Array,
  nonce: bigint,
  maxBlockHeight: bigint,
  publicKeyBytes: Uint8Array
): Uint8Array {
  const ser = new BorshSerializer();
  ser.writeString(senderId);
  ser.writeString(receiverId);
  ser.writeU32(1); // 1 action
  ser.writeFixedBytes(actionsBytes);
  ser.writeU64(nonce);
  ser.writeU64(maxBlockHeight);
  ser.writeU8(0); // ED25519 key type
  ser.writeFixedBytes(publicKeyBytes);
  return ser.getBytes();
}

/**
 * Serialize a SignedDelegateAction for NEP-366
 */
function serializeSignedDelegateAction(
  delegateActionBytes: Uint8Array,
  signatureBytes: Uint8Array
): Uint8Array {
  const ser = new BorshSerializer();
  ser.writeFixedBytes(delegateActionBytes);
  ser.writeU8(0); // ED25519 signature type
  ser.writeFixedBytes(signatureBytes);
  return ser.getBytes();
}

/**
 * SHA-256 hash function
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(hashBuffer);
}

/**
 * NEAR RPC call
 */
async function nearRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'dontcare',
      method,
      params,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`NEAR RPC error: ${JSON.stringify(data.error)}`);
  }
  return data.result as T;
}

/**
 * NEAR wallet selector interface
 */
interface NEARWalletSelector {
  isSignedIn(): boolean;
  getAccountId(): string | null;
  signIn(options?: { contractId?: string }): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * MyNearWallet interface
 */
interface MyNearWallet {
  isInstalled?: () => boolean;
  signIn?: (options?: { contractId?: string }) => Promise<{ accountId: string }>;
  signOut?: () => Promise<void>;
  getAccountId?: () => string | null;
  signMessage?: (params: {
    message: Uint8Array;
    recipient: string;
    nonce: Uint8Array;
  }) => Promise<{ signature: Uint8Array; publicKey: string }>;
}

/**
 * Options for configuring the NEAR wallet selector helper
 */
export interface WalletSelectorOptions {
  /** URL of the MyNearWallet instance (default: https://mynearwallet.ultravioletadao.xyz) */
  walletUrl?: string;
  /** USDC contract ID for NEAR (default: 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1) */
  contractId?: string;
  /** NEAR network ID (default: mainnet) */
  networkId?: string;
}

/**
 * NEARProvider - Wallet adapter for NEAR Protocol via MyNearWallet/Meteor
 */
export class NEARProvider implements WalletAdapter {
  readonly id = 'near-wallet';
  readonly name = 'NEAR Wallet';
  readonly networkType = 'near' as const;

  private accountId: string | null = null;
  private publicKey: Uint8Array | null = null;
  private rpcUrl: string = NEAR_CONFIG.nodeUrl;

  /**
   * Setup wallet selector for NEP-366 meta-transaction support.
   *
   * Call this once early in your app initialization (e.g., App.tsx or main.ts)
   * to configure the NEAR wallet selector before using NEARProvider.
   *
   * @param options - Configuration options for wallet selector
   * @example
   * ```ts
   * await NEARProvider.setupWalletSelector({
   *   walletUrl: 'https://mynearwallet.ultravioletadao.xyz',
   *   contractId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
   * });
   * ```
   */
  static async setupWalletSelector(options: WalletSelectorOptions = {}): Promise<void> {
    const {
      walletUrl = 'https://mynearwallet.ultravioletadao.xyz',
      contractId = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      networkId = 'mainnet',
    } = options;

    if (typeof window === 'undefined') {
      throw new X402Error(
        'setupWalletSelector() must be called in a browser environment',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      // Dynamic imports for wallet selector packages
      const [{ setupWalletSelector }, { setupMyNearWallet }] = await Promise.all([
        import('@near-wallet-selector/core'),
        import('@near-wallet-selector/my-near-wallet'),
      ]);

      // Setup the wallet selector with MyNearWallet module
      const selector = await setupWalletSelector({
        network: networkId as 'mainnet' | 'testnet',
        modules: [
          setupMyNearWallet({
            walletUrl,
          }),
        ],
      });

      // Expose to window for SDK compatibility
      const win = window as Window & { nearWalletSelector?: NEARWalletSelector };
      win.nearWalletSelector = {
        isSignedIn: () => selector.isSignedIn(),
        getAccountId: () => {
          const state = selector.store.getState();
          return state.accounts[0]?.accountId || null;
        },
        signIn: async (signInOptions?: { contractId?: string }) => {
          const wallet = await selector.wallet('my-near-wallet');
          // BrowserWallet only requires contractId, cast to bypass union type requirement
          const signInFn = wallet.signIn as unknown as (params: { contractId: string }) => Promise<void>;
          await signInFn({
            contractId: signInOptions?.contractId || contractId,
          });
        },
        signOut: async () => {
          const wallet = await selector.wallet('my-near-wallet');
          await wallet.signOut();
        },
      };
    } catch (error: unknown) {
      throw new X402Error(
        `Failed to setup wallet selector: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'Make sure @near-wallet-selector/core and @near-wallet-selector/my-near-wallet are installed.',
        'WALLET_NOT_FOUND',
        error
      );
    }
  }

  /**
   * Check if NEAR wallet is available
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    // Check for NEAR wallet selector or injected wallet
    const win = window as Window & {
      nearWalletSelector?: NEARWalletSelector;
      myNearWallet?: MyNearWallet;
      near?: { wallet?: NEARWalletSelector };
    };
    return !!(
      win.nearWalletSelector ||
      win.myNearWallet?.isInstalled?.() ||
      win.near?.wallet
    );
  }

  /**
   * Connect to NEAR wallet
   */
  async connect(): Promise<string> {
    // Try to get wallet from window
    const win = window as Window & {
      nearWalletSelector?: NEARWalletSelector;
      myNearWallet?: MyNearWallet;
      near?: { wallet?: NEARWalletSelector };
    };

    try {
      // Try NEAR wallet selector first
      if (win.nearWalletSelector) {
        if (!win.nearWalletSelector.isSignedIn()) {
          await win.nearWalletSelector.signIn();
        }
        const accountId = win.nearWalletSelector.getAccountId();
        if (!accountId) {
          throw new X402Error('Failed to get NEAR account ID', 'WALLET_CONNECTION_REJECTED');
        }
        this.accountId = accountId;
        await this.fetchPublicKey();
        return accountId;
      }

      // Try MyNearWallet
      if (win.myNearWallet?.signIn) {
        const result = await win.myNearWallet.signIn();
        this.accountId = result.accountId;
        await this.fetchPublicKey();
        return result.accountId;
      }

      // Try legacy near.wallet
      if (win.near?.wallet) {
        if (!win.near.wallet.isSignedIn()) {
          await win.near.wallet.signIn();
        }
        const accountId = win.near.wallet.getAccountId();
        if (!accountId) {
          throw new X402Error('Failed to get NEAR account ID', 'WALLET_CONNECTION_REJECTED');
        }
        this.accountId = accountId;
        await this.fetchPublicKey();
        return accountId;
      }

      throw new X402Error(
        'No NEAR wallet found. Call NEARProvider.setupWalletSelector() first, or install MyNearWallet/Meteor.',
        'WALLET_NOT_FOUND'
      );
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;

      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }

      throw new X402Error(
        `Failed to connect NEAR wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from NEAR wallet
   */
  async disconnect(): Promise<void> {
    const win = window as Window & {
      nearWalletSelector?: NEARWalletSelector;
      myNearWallet?: MyNearWallet;
      near?: { wallet?: NEARWalletSelector };
    };

    try {
      if (win.nearWalletSelector) {
        await win.nearWalletSelector.signOut();
      } else if (win.myNearWallet?.signOut) {
        await win.myNearWallet.signOut();
      } else if (win.near?.wallet) {
        await win.near.wallet.signOut();
      }
    } catch {
      // Ignore disconnect errors
    }

    this.accountId = null;
    this.publicKey = null;
  }

  /**
   * Get current account ID
   */
  getAddress(): string | null {
    return this.accountId;
  }

  /**
   * Get USDC balance on NEAR
   */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    if (!this.accountId) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    try {
      const args = JSON.stringify({ account_id: this.accountId });
      const argsBase64 = btoa(args);

      const result = await nearRpcCall<{ result: number[] }>(
        chainConfig.rpcUrl || this.rpcUrl,
        'query',
        {
          request_type: 'call_function',
          finality: 'final',
          account_id: chainConfig.usdc.address,
          method_name: 'ft_balance_of',
          args_base64: argsBase64,
        }
      );

      const resultBytes = new Uint8Array(result.result);
      const balanceStr = new TextDecoder().decode(resultBytes).replace(/"/g, '');
      const balance = Number(balanceStr) / Math.pow(10, chainConfig.usdc.decimals);

      return balance.toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create NEAR payment (NEP-366 SignedDelegateAction)
   *
   * User signs a DelegateAction that authorizes ft_transfer.
   * Facilitator wraps this and submits to NEAR, paying all gas fees.
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    if (!this.accountId || !this.publicKey) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    // Get recipient
    const recipient = paymentInfo.recipients?.near || paymentInfo.recipient;

    // Parse amount (6 decimals for USDC)
    const amount = BigInt(Math.floor(parseFloat(paymentInfo.amount) * 1_000_000));

    try {
      // Get access key nonce
      const accessKey = await this.getAccessKeyNonce();
      const nonce = BigInt(accessKey.nonce) + BigInt(1);

      // Get current block height
      const block = await this.getLatestBlock();
      const maxBlockHeight = BigInt(block.header.height) + BigInt(1000);

      // Serialize ft_transfer action
      const actionBytes = serializeNonDelegateAction(
        recipient,
        amount,
        'x402 payment via uvd-x402-sdk'
      );

      // Serialize DelegateAction
      const delegateActionBytes = serializeDelegateAction(
        this.accountId,
        chainConfig.usdc.address, // USDC contract
        actionBytes,
        nonce,
        maxBlockHeight,
        this.publicKey
      );

      // Create hash for signing (NEP-366 prefix + delegateAction)
      const hashInput = new Uint8Array(NEP366_PREFIX.length + delegateActionBytes.length);
      hashInput.set(NEP366_PREFIX, 0);
      hashInput.set(delegateActionBytes, NEP366_PREFIX.length);
      const delegateHash = await sha256(hashInput);

      // Sign the hash
      const signature = await this.signMessage(delegateHash);

      // Serialize SignedDelegateAction
      const signedDelegateActionBytes = serializeSignedDelegateAction(
        delegateActionBytes,
        signature
      );

      // Base64 encode
      const signedDelegateB64 = btoa(
        String.fromCharCode(...signedDelegateActionBytes)
      );

      const payload: NEARPaymentPayload = {
        signedDelegateAction: signedDelegateB64,
        network: 'near',
      };

      return JSON.stringify(payload);
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;

      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
        }
      }

      throw new X402Error(
        `Failed to create NEAR payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }
  }

  /**
   * Encode NEAR payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(paymentPayload: string, version: X402Version = 1): string {
    const payload = JSON.parse(paymentPayload) as NEARPaymentPayload;

    // Build the payload data
    const payloadData = {
      signedDelegateAction: payload.signedDelegateAction,
    };

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2('near'), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: 'near', // Plain chain name for v1
          payload: payloadData,
        };

    return encodeBase64Json(x402Payload);
  }

  // Private helpers

  /**
   * Fetch public key from NEAR RPC
   */
  private async fetchPublicKey(): Promise<void> {
    if (!this.accountId) return;

    try {
      const result = await nearRpcCall<{ keys: Array<{ public_key: string }> }>(
        this.rpcUrl,
        'query',
        {
          request_type: 'view_access_key_list',
          finality: 'final',
          account_id: this.accountId,
        }
      );

      if (result.keys && result.keys.length > 0) {
        // Get first full access key
        const keyStr = result.keys[0].public_key;
        // Remove ed25519: prefix and decode base58
        const keyB58 = keyStr.replace('ed25519:', '');
        this.publicKey = this.base58Decode(keyB58);
      }
    } catch {
      // Will be set during signing if not available
    }
  }

  /**
   * Get access key nonce from NEAR RPC
   */
  private async getAccessKeyNonce(): Promise<{ nonce: number }> {
    if (!this.accountId || !this.publicKey) {
      throw new Error('Account not connected');
    }

    const publicKeyB58 = this.base58Encode(this.publicKey);

    const result = await nearRpcCall<{ nonce: number }>(
      this.rpcUrl,
      'query',
      {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: this.accountId,
        public_key: `ed25519:${publicKeyB58}`,
      }
    );

    return result;
  }

  /**
   * Get latest block from NEAR RPC
   */
  private async getLatestBlock(): Promise<{ header: { height: number } }> {
    return nearRpcCall(this.rpcUrl, 'block', { finality: 'final' });
  }

  /**
   * Sign a message using the connected wallet
   */
  private async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const win = window as Window & {
      nearWalletSelector?: NEARWalletSelector & {
        wallet?: () => Promise<{
          signMessage?: (params: {
            message: Uint8Array;
            recipient: string;
            nonce: Uint8Array;
          }) => Promise<{ signature: Uint8Array; publicKey: string }>;
        }>;
      };
      myNearWallet?: MyNearWallet;
    };

    // Try wallet selector's wallet.signMessage() first (from setupWalletSelector)
    if (win.nearWalletSelector?.wallet) {
      try {
        const wallet = await win.nearWalletSelector.wallet();
        if (wallet?.signMessage) {
          const nonce = crypto.getRandomValues(new Uint8Array(32));
          const result = await wallet.signMessage({
            message,
            recipient: 'uvd-x402-sdk',
            nonce,
          });
          return result.signature;
        }
      } catch (e) {
        // Fall through to try other methods
        console.debug('Wallet selector signMessage failed:', e);
      }
    }

    // Try MyNearWallet browser extension signMessage
    if (win.myNearWallet?.signMessage) {
      const result = await win.myNearWallet.signMessage({
        message,
        recipient: 'uvd-x402-sdk',
        nonce: crypto.getRandomValues(new Uint8Array(32)),
      });
      return result.signature;
    }

    // For other wallets, we need to use the @near-js/crypto library
    // This will be handled by the wallet selector
    throw new X402Error(
      'Signing not supported. Please use MyNearWallet or install @near-wallet-selector/core',
      'PAYMENT_FAILED'
    );
  }

  /**
   * Base58 decode (NEAR style)
   */
  private base58Decode(str: string): Uint8Array {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP: Record<string, number> = {};
    for (let i = 0; i < ALPHABET.length; i++) {
      ALPHABET_MAP[ALPHABET[i]] = i;
    }

    let bytes: number[] = [0];
    for (let i = 0; i < str.length; i++) {
      const value = ALPHABET_MAP[str[i]];
      if (value === undefined) {
        throw new Error(`Invalid base58 character: ${str[i]}`);
      }

      for (let j = 0; j < bytes.length; j++) {
        bytes[j] *= 58;
      }
      bytes[0] += value;

      let carry = 0;
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] += carry;
        carry = bytes[j] >> 8;
        bytes[j] &= 0xff;
      }

      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }

    // Handle leading zeros
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
      bytes.push(0);
    }

    return new Uint8Array(bytes.reverse());
  }

  /**
   * Base58 encode (NEAR style)
   */
  private base58Encode(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    let digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      for (let j = 0; j < digits.length; j++) {
        digits[j] <<= 8;
      }
      digits[0] += bytes[i];

      let carry = 0;
      for (let j = 0; j < digits.length; j++) {
        digits[j] += carry;
        carry = (digits[j] / 58) | 0;
        digits[j] %= 58;
      }

      while (carry) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }

    // Handle leading zeros
    let str = '';
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
      str += '1';
    }

    for (let i = digits.length - 1; i >= 0; i--) {
      str += ALPHABET[digits[i]];
    }

    return str;
  }
}

export default NEARProvider;
