/**
 * uvd-x402-sdk - XRPL (XRP Ledger) Provider
 *
 * Provides XRP Ledger wallet connection and payment creation using the t54
 * "pre-signed Payment blob" scheme. The client builds and FULLY signs a native
 * XRP Payment transaction off-chain (paying its own XRP fee) and sends a single
 * field to the facilitator:
 *
 *   payload = { signedTxBlob: "<hex-encoded fully-signed XRPL tx blob>" }
 *
 * The facilitator decodes the blob to re-derive payer/amount/destination and
 * submits it. All payment-level fields (destination, amount, InvoiceID,
 * SourceTag, Memo) come from PaymentRequirements/extra.
 *
 * The signed Payment MUST:
 *  - be TransactionType "Payment"
 *  - NOT set tfPartialPayment (flag 0x00020000)
 *  - NOT set SendMax (no cross-currency)
 *  - set LastLedgerSequence
 *  - have Destination == payTo and Amount matching the requirement
 *
 * The minimum supported signer is a seed/secret-based xrpl Wallet. A browser
 * wallet path (GemWallet/Xaman) may be layered on top in the future.
 *
 * @example
 * ```ts
 * import { X402Client } from 'uvd-x402-sdk';
 * import { XRPLProvider } from 'uvd-x402-sdk/xrpl';
 *
 * const client = new X402Client();
 * const xrpl = new XRPLProvider({ seed: process.env.XRPL_SEED });
 *
 * // Connect
 * const address = await xrpl.connect();
 *
 * // Create payment (returns JSON-encoded { signedTxBlob })
 * const paymentPayload = await xrpl.signPayment(paymentInfo, chainConfig);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  WalletAdapter,
  X402Version,
  XRPLPaymentPayload,
} from '../../types';
import { X402Error } from '../../types';
import { chainToCAIP2, encodeBase64Json } from '../../utils';

/**
 * XRP Ledger network configuration.
 *
 * Native XRP uses 6 decimals (1 XRP = 1,000,000 drops). The network ids are
 * plain strings ("xrpl-mainnet" / "xrpl-testnet") with no CAIP-2 form, so the
 * v1 and v2 network identifiers are identical.
 */
const XRPL_CONFIG = {
  mainnet: {
    rpcUrl: 'wss://xrplcluster.com',
    network: 'xrpl-mainnet',
    explorerUrl: 'https://livenet.xrpl.org',
    facilitatorWallet: 'rfADKkVXBNqK3z72tVSS3LVzAR3psYkonp',
  },
  testnet: {
    rpcUrl: 'wss://s.altnet.rippletest.net:51233',
    network: 'xrpl-testnet',
    explorerUrl: 'https://testnet.xrpl.org',
    facilitatorWallet: 'rGhTioKAFHe75KgVnQtacRiKFuPv28Wbwk',
  },
} as const;

/** XRP drops per whole XRP (6 decimals). */
const DROPS_PER_XRP = 1_000_000;

/** tfPartialPayment flag - MUST never be set on x402 XRPL payments. */
const TF_PARTIAL_PAYMENT = 0x00020000;

/**
 * Options for constructing an {@link XRPLProvider}.
 */
export interface XRPLProviderOptions {
  /**
   * XRPL family seed / secret (starts with `s...`) used to derive the signing
   * Wallet. Required for the seed-based signer (the minimum supported path).
   */
  seed?: string;
  /**
   * Override the rippled WebSocket endpoint. Defaults to the public cluster for
   * the selected network.
   */
  rpcUrl?: string;
  /** Use the XRPL testnet instead of mainnet. Defaults to false (mainnet). */
  testnet?: boolean;
}

/**
 * Minimal structural type for the parts of the `xrpl` package this provider
 * uses. Declared locally so the SDK type-checks without `xrpl` installed
 * (it is an optional dependency, loaded lazily via dynamic import).
 */
interface XrplModule {
  Client: new (url: string) => XrplClient;
  Wallet: {
    fromSeed(seed: string): XrplWallet;
  };
  xrpToDrops(xrp: string | number): string;
  convertStringToHex(value: string): string;
}

interface XrplClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  autofill<T extends Record<string, unknown>>(tx: T): Promise<T & { LastLedgerSequence?: number }>;
  getXrpBalance(account: string): Promise<string | number>;
}

interface XrplWallet {
  classicAddress: string;
  address: string;
  sign(tx: Record<string, unknown>): { tx_blob: string; hash: string };
}

/**
 * XRPLProvider - WalletAdapter for the XRP Ledger (t54 pre-signed Payment blob).
 */
export class XRPLProvider implements WalletAdapter {
  readonly id = 'xrpl-seed';
  readonly name = 'XRP Ledger';
  readonly networkType = 'xrpl' as const;

  private address: string | null = null;
  private wallet: XrplWallet | null = null;
  private readonly seed?: string;
  private readonly testnet: boolean;
  private readonly rpcUrl: string;

  constructor(options: XRPLProviderOptions = {}) {
    this.seed = options.seed;
    this.testnet = options.testnet ?? false;
    const net = this.testnet ? XRPL_CONFIG.testnet : XRPL_CONFIG.mainnet;
    this.rpcUrl = options.rpcUrl ?? net.rpcUrl;
  }

  /**
   * The seed-based signer is available whenever a seed was provided. Browser
   * wallet detection (GemWallet/Xaman) can extend this in the future.
   */
  isAvailable(): boolean {
    return typeof this.seed === 'string' && this.seed.length > 0;
  }

  /**
   * Connect by deriving the signing Wallet from the configured seed.
   * Returns the classic r-address of the signer.
   */
  async connect(): Promise<string> {
    if (!this.seed) {
      throw new X402Error(
        'XRPL seed not provided. Construct XRPLProvider({ seed }) with an XRPL family seed.',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      const xrpl = await this.getXrpl();
      this.wallet = xrpl.Wallet.fromSeed(this.seed);
      this.address = this.wallet.classicAddress ?? this.wallet.address;

      if (!this.address || !this.address.startsWith('r')) {
        throw new X402Error('Failed to derive XRPL classic address from seed', 'WALLET_CONNECTION_REJECTED');
      }

      return this.address;
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      throw new X402Error(
        `Failed to connect XRPL wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WALLET_CONNECTION_FAILED',
        error
      );
    }
  }

  /**
   * Disconnect (clears the in-memory signer).
   */
  async disconnect(): Promise<void> {
    this.address = null;
    this.wallet = null;
  }

  /**
   * Get current classic r-address.
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get native XRP balance (formatted to 2 decimals, in whole XRP).
   */
  async getBalance(_chainConfig: ChainConfig): Promise<string> {
    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const xrpl = await this.getXrpl();
    const client = new xrpl.Client(this.rpcUrl);
    try {
      await client.connect();
      const balance = await client.getXrpBalance(this.address);
      return parseFloat(String(balance)).toFixed(2);
    } catch {
      return '0.00';
    } finally {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }

  /**
   * Build and fully sign a native XRP Payment transaction off-chain, returning
   * a JSON-encoded {@link XRPLPaymentPayload} (`{ signedTxBlob }`).
   *
   * The client pays its own XRP network fee. The facilitator decodes the blob
   * to re-derive payer/amount/destination and submits it.
   */
  async signPayment(paymentInfo: PaymentInfo, _chainConfig: ChainConfig): Promise<string> {
    if (!this.wallet || !this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const recipient = paymentInfo.recipients?.xrpl || paymentInfo.recipient;
    if (!recipient || !recipient.startsWith('r')) {
      throw new X402Error('Invalid or missing XRPL recipient (payTo) address', 'INVALID_RECIPIENT');
    }

    const xrpl = await this.getXrpl();

    // Convert amount (whole XRP, e.g. "10.00") to integer drops (6 decimals).
    // Use xrpToDrops to avoid floating point issues with fractional XRP.
    let amountDrops: string;
    try {
      amountDrops = xrpl.xrpToDrops(paymentInfo.amount);
    } catch {
      // Fall back to manual integer-drops computation.
      amountDrops = String(Math.round(parseFloat(paymentInfo.amount) * DROPS_PER_XRP));
    }

    const client = new xrpl.Client(this.rpcUrl);
    try {
      await client.connect();

      // Build a native XRP Payment. Amount as a drops string => native XRP.
      // Flags=0 ensures tfPartialPayment is OFF and no SendMax is present.
      const payment: Record<string, unknown> = {
        TransactionType: 'Payment',
        Account: this.address,
        Destination: recipient,
        Amount: amountDrops,
        Flags: 0,
      };

      // Optional InvoiceID / SourceTag / Memo carried from paymentInfo.metadata.
      const extra = (paymentInfo as PaymentInfo & {
        metadata?: { invoiceId?: string; sourceTag?: number; memo?: string };
      }).metadata;

      if (extra?.invoiceId) {
        payment.InvoiceID = extra.invoiceId;
      }
      if (typeof extra?.sourceTag === 'number') {
        payment.SourceTag = extra.sourceTag;
      }
      if (extra?.memo) {
        payment.Memos = [
          {
            Memo: {
              MemoData: xrpl.convertStringToHex(extra.memo),
            },
          },
        ];
      }

      // Autofill Fee, Sequence and LastLedgerSequence via rippled.
      const prepared = await client.autofill(payment);

      // Defensive: ensure LastLedgerSequence is present and tfPartialPayment OFF.
      if (prepared.LastLedgerSequence === undefined) {
        throw new X402Error('Failed to set LastLedgerSequence on XRPL Payment', 'PAYMENT_FAILED');
      }
      const flags = Number(prepared.Flags ?? 0);
      if ((flags & TF_PARTIAL_PAYMENT) !== 0) {
        throw new X402Error('tfPartialPayment must not be set on x402 XRPL payments', 'PAYMENT_FAILED');
      }
      if ('SendMax' in prepared) {
        throw new X402Error('SendMax (cross-currency) is not allowed on x402 XRPL payments', 'PAYMENT_FAILED');
      }

      // Fully sign off-chain. The client pays its own XRP fee.
      const signed = this.wallet.sign(prepared);

      const payload: XRPLPaymentPayload = {
        signedTxBlob: signed.tx_blob,
      };

      return JSON.stringify(payload);
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      throw new X402Error(
        `Failed to create XRPL payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    } finally {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }

  /**
   * Encode an XRPL payment as an X-PAYMENT header value.
   *
   * @param paymentPayload - JSON-encoded payload from {@link signPayment}
   * @param version - x402 protocol version (1 or 2; defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(paymentPayload: string, version: X402Version = 1): string {
    const payload = JSON.parse(paymentPayload) as XRPLPaymentPayload;

    const payloadData = {
      signedTxBlob: payload.signedTxBlob,
    };

    // XRPL has no CAIP-2 form: the v1 string IS the network id, so v1 and v2
    // carry the same network identifier.
    const network = this.testnet ? 'xrpl-testnet' : 'xrpl-mainnet';

    const x402Payload =
      version === 2
        ? {
            x402Version: 2 as const,
            scheme: 'exact' as const,
            network: chainToCAIP2(network),
            payload: payloadData,
          }
        : {
            x402Version: 1 as const,
            scheme: 'exact' as const,
            network,
            payload: payloadData,
          };

    return encodeBase64Json(x402Payload);
  }

  // Private helpers

  private async getXrpl(): Promise<XrplModule> {
    try {
      // Lazy dynamic import so `xrpl` stays an optional dependency.
      const mod = (await import('xrpl')) as unknown as XrplModule;
      return mod;
    } catch {
      throw new X402Error(
        "The 'xrpl' package is required for XRPL payments. Install it with: npm install xrpl",
        'INVALID_CONFIG'
      );
    }
  }
}

export default XRPLProvider;
