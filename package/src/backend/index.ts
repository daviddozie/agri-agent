/**
 * uvd-x402-sdk - Backend Utilities
 *
 * Server-side utilities for building x402 payment APIs.
 * These utilities help backend developers:
 * - Build verify/settle requests for the facilitator
 * - Parse X-PAYMENT headers from incoming requests
 * - Configure CORS for x402 payment flows
 * - Create atomic payment handlers
 * - Discover and register resources via Bazaar Discovery API
 * - Manage escrow payments with refund and dispute resolution
 *
 * @example Basic payment flow
 * ```ts
 * import {
 *   parsePaymentHeader,
 *   FacilitatorClient,
 *   X402_CORS_HEADERS,
 * } from 'uvd-x402-sdk/backend';
 *
 * // Parse payment from request header
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 *
 * // Verify with facilitator
 * const client = new FacilitatorClient();
 * const verifyResult = await client.verify(payment, paymentRequirements);
 *
 * // If valid, provide service then settle
 * const settleResult = await client.settle(payment, paymentRequirements);
 * ```
 *
 * @example Escrow payment with refund support
 * ```ts
 * import { EscrowClient } from 'uvd-x402-sdk/backend';
 *
 * const escrow = new EscrowClient();
 *
 * // Hold payment in escrow
 * const escrowPayment = await escrow.createEscrow({
 *   paymentHeader: req.headers['x-payment'],
 *   requirements: paymentRequirements,
 *   escrowDuration: 86400, // 24 hours
 * });
 *
 * // After service delivered, release to recipient
 * await escrow.release(escrowPayment.id);
 *
 * // Or if service failed, request refund
 * await escrow.requestRefund({
 *   escrowId: escrowPayment.id,
 *   reason: 'Service not delivered',
 * });
 * ```
 *
 * @example Resource discovery
 * ```ts
 * import { BazaarClient } from 'uvd-x402-sdk/backend';
 *
 * const bazaar = new BazaarClient();
 * const resources = await bazaar.discover({
 *   category: 'ai',
 *   network: 'base',
 *   maxPrice: '0.10',
 * });
 * ```
 */

import type {
  X402Header,
  X402PayloadData,
  X402Version,
} from '../types';
import { decodeX402Header, chainToCAIP2, parseNetworkIdentifier } from '../utils';
import { getChainByName } from '../chains';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Payment requirements sent to the facilitator
 */
export interface PaymentRequirements {
  /** Payment scheme */
  scheme: 'exact' | 'escrow' | 'commerce';
  /** Network name (v1) or CAIP-2 identifier (v2) */
  network: string;
  /** Maximum amount required in atomic units (e.g., "1000000" for 1 USDC) */
  maxAmountRequired: string;
  /** Resource URL being paid for */
  resource: string;
  /** Description of what's being paid for */
  description: string;
  /** MIME type of the resource */
  mimeType: string;
  /** Recipient address for payment */
  payTo: string;
  /** Maximum timeout in seconds */
  maxTimeoutSeconds: number;
  /** Token contract address */
  asset: string;
  /** Optional output schema for the resource */
  outputSchema?: unknown;
  /** Optional extra data */
  extra?: unknown;
}

/**
 * Verify request body for the facilitator /verify endpoint
 */
export interface VerifyRequest {
  x402Version: X402Version;
  paymentPayload: X402Header;
  paymentRequirements: PaymentRequirements;
}

/**
 * Settle request body for the facilitator /settle endpoint
 */
export interface SettleRequest {
  x402Version: X402Version;
  paymentPayload: X402Header;
  paymentRequirements: PaymentRequirements;
}

/**
 * Verify response from the facilitator
 */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  network?: string;
}

/**
 * Settle response from the facilitator
 */
export interface SettleResponse {
  success: boolean;
  transactionHash?: string;
  network?: string;
  error?: string;
}

/**
 * Options for building payment requirements
 */
export interface PaymentRequirementsOptions {
  /** Amount in human-readable format (e.g., "1.00") */
  amount: string;
  /** Recipient address */
  recipient: string;
  /** Resource URL being protected */
  resource: string;
  /** Chain name (e.g., "base") */
  chainName?: string;
  /** Description of the resource */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
  /** Timeout in seconds (default: 300) */
  timeoutSeconds?: number;
  /** x402 version to use */
  x402Version?: X402Version;
}

/**
 * x402 payment option advertised in a 402 response.
 *
 * The SDK keeps the response shape richer than the minimal protocol fields so
 * servers can preserve settlement-critical metadata such as payTo and extra.
 */
export interface PaymentAcceptance {
  network: string;
  asset: string;
  amount: string;
  /**
   * Payment scheme. REQUIRED by the facilitator's v2 `PaymentRequirementsV2`.
   *
   * Optional here only so existing callers keep compiling — when it is absent,
   * `buildRequirementFromAcceptance` defaults it to `'exact'`. Do not treat its
   * optionality as "the facilitator does not need it": an accepts[] entry that
   * reaches a v2 client without a scheme is unpayable.
   */
  scheme?: string;
  payTo?: string;
  facilitator?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  outputSchema?: unknown;
  extra?: unknown;
}

/**
 * Verified payment context attached by server middleware.
 */
export interface VerifiedPaymentState {
  payment: X402Header;
  requirements: PaymentRequirements;
  verifyResult: VerifyResponse;
  settle: () => Promise<SettleResponse>;
}

/**
 * Shared server middleware options.
 */
export interface PaymentMiddlewareOptions extends FacilitatorClientOptions {
  /** Alias for baseUrl to keep middleware options ergonomic */
  facilitatorUrl?: string;
  /**
   * Settlement behavior after verification.
   * - manual: verify only; caller settles explicitly
   * - before-handler: settle immediately before calling next()
   */
  settlementStrategy?: 'manual' | 'before-handler';
}

/**
 * Custom resolver for selecting the correct payment requirement when multiple
 * accepts are advertised.
 */
export type PaymentRequirementResolver = (
  payment: X402Header,
  requirements: PaymentRequirements[]
) => PaymentRequirements | null | Promise<PaymentRequirements | null>;

// ============================================================================
// HEADER PARSING
// ============================================================================

/**
 * Parse X-PAYMENT or PAYMENT-SIGNATURE header value
 *
 * @param headerValue - Base64-encoded header value (or undefined/null)
 * @returns Parsed x402 header object, or null if invalid
 *
 * @example
 * ```ts
 * // Express.js
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 * if (!payment) {
 *   return res.status(400).json({ error: 'Invalid payment header' });
 * }
 * ```
 */
export function parsePaymentHeader(
  headerValue: string | undefined | null
): X402Header | null {
  if (!headerValue) {
    return null;
  }

  try {
    return decodeX402Header(headerValue);
  } catch {
    return null;
  }
}

/**
 * Extract payment header from request headers object
 *
 * Checks both X-PAYMENT and PAYMENT-SIGNATURE headers.
 *
 * @param headers - Request headers object (case-insensitive)
 * @returns Parsed x402 header object, or null if not found/invalid
 *
 * @example
 * ```ts
 * const payment = extractPaymentFromHeaders(req.headers);
 * ```
 */
export function extractPaymentFromHeaders(
  headers: Record<string, string | string[] | undefined>
): X402Header | null {
  // Normalize header keys to lowercase
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalizedHeaders[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalizedHeaders[key.toLowerCase()] = value[0];
    }
  }

  // Try X-PAYMENT first, then PAYMENT-SIGNATURE
  const headerValue =
    normalizedHeaders['x-payment'] ||
    normalizedHeaders['payment-signature'];

  return parsePaymentHeader(headerValue);
}

// ============================================================================
// REQUEST BUILDERS
// ============================================================================

/**
 * Build payment requirements for the facilitator
 *
 * @param options - Payment requirements options
 * @returns PaymentRequirements object ready for verify/settle
 *
 * @example
 * ```ts
 * const requirements = buildPaymentRequirements({
 *   amount: '1.00',
 *   recipient: '0x1234...',
 *   resource: 'https://api.example.com/premium-data',
 *   chainName: 'base',
 * });
 * ```
 */
export function buildPaymentRequirements(
  options: PaymentRequirementsOptions
): PaymentRequirements {
  const {
    amount,
    recipient,
    resource,
    chainName = 'base',
    description = 'Payment for resource access',
    mimeType = 'application/json',
    timeoutSeconds = 300,
    x402Version = 1,
  } = options;

  const chain = getChainByName(chainName);
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }

  // Convert amount to atomic units
  const atomicAmount = Math.floor(
    parseFloat(amount) * Math.pow(10, chain.usdc.decimals)
  ).toString();

  // Use CAIP-2 for v2, chain name for v1
  const network = x402Version === 2 ? chainToCAIP2(chainName) : chainName;

  return {
    scheme: 'exact',
    network,
    maxAmountRequired: atomicAmount,
    resource,
    description,
    mimeType,
    payTo: recipient,
    maxTimeoutSeconds: timeoutSeconds,
    asset: chain.usdc.address,
  };
}

/**
 * Build a verify request for the facilitator /verify endpoint
 *
 * @param paymentHeader - Parsed x402 payment header
 * @param requirements - Payment requirements
 * @returns VerifyRequest body ready for fetch/axios
 *
 * @example
 * ```ts
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 * const verifyBody = buildVerifyRequest(payment, requirements);
 *
 * const response = await fetch('https://facilitator.uvd.xyz/verify', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(verifyBody),
 * });
 * ```
 */
export function buildVerifyRequest(
  paymentHeader: X402Header,
  requirements: PaymentRequirements
): VerifyRequest {
  return {
    x402Version: paymentHeader.x402Version,
    paymentPayload: paymentHeader,
    paymentRequirements: requirements,
  };
}

/**
 * Build a settle request for the facilitator /settle endpoint
 *
 * @param paymentHeader - Parsed x402 payment header
 * @param requirements - Payment requirements
 * @returns SettleRequest body ready for fetch/axios
 */
/**
 * Describes the protected resource, as x402 v2 expects it.
 *
 * Note this is an OBJECT in v2. Sending a bare URL string here is the single
 * most common v2 mistake and it fails as an unhelpful "no variant matched"
 * deserialization error at the facilitator, naming no field.
 */
export interface ResourceInfoV2 {
  url: string;
  description: string;
  mimeType: string;
}

/**
 * Payment requirements in x402 v2 form.
 *
 * Differences from v1 that actually bite:
 * - `network` is CAIP-2 (`eip155:8453`), NOT a plain name (`base`). Mixing a v1
 *   name into a v2 request fails deserialization, and vice versa.
 * - `maxAmountRequired` is renamed to `amount`.
 * - `resource` / `description` / `mimeType` moved out to {@link ResourceInfoV2}.
 */
export interface PaymentRequirementsV2 {
  scheme: string;
  /** CAIP-2 chain id, e.g. `eip155:8453`. */
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: unknown;
}

/** The v2 payment payload — note it carries no top-level scheme/network. */
export interface PaymentPayloadV2 {
  x402Version: 2;
  resource: ResourceInfoV2;
  accepted: PaymentRequirementsV2;
  payload: X402PayloadData;
  extensions?: Record<string, unknown>;
}

/**
 * Verify request body in x402 v2 form.
 *
 * There is deliberately NO `paymentRequirements` key: that is the v1 envelope.
 * v2 carries `resource` and `accepted` at the top level instead.
 */
export interface VerifyRequestV2 {
  x402Version: 2;
  paymentPayload: PaymentPayloadV2;
  resource: ResourceInfoV2;
  accepted: PaymentRequirementsV2;
}

/** Settle request body in x402 v2 form. Same shape as {@link VerifyRequestV2}. */
export type SettleRequestV2 = VerifyRequestV2;

function buildV2Envelope(
  payload: X402PayloadData,
  resource: ResourceInfoV2,
  accepted: PaymentRequirementsV2
): VerifyRequestV2 {
  return {
    x402Version: 2,
    // The facilitator reads the payload from here; `resource` and `accepted` are
    // repeated at the top level because the v2 envelope declares both.
    paymentPayload: { x402Version: 2, resource, accepted, payload },
    resource,
    accepted,
  };
}

/**
 * Build a verify request for the facilitator `/verify` endpoint, in **v2** form.
 *
 * Use this whenever your 402 advertises CAIP-2 networks. {@link buildVerifyRequest}
 * emits the v1 envelope `{x402Version, paymentPayload, paymentRequirements}` and
 * cannot express v2 — putting a v2 payload inside it matches no variant at the
 * facilitator and fails with an error that names no field.
 *
 * @example
 * ```ts
 * const body = buildVerifyRequestV2(
 *   payment.payload,
 *   { url: 'https://api.example.com/thing', description: 'Thing', mimeType: 'application/json' },
 *   { scheme: 'exact', network: 'eip155:8453', asset: '0x8335...', amount: '100000',
 *     payTo: '0xabc...', maxTimeoutSeconds: 300 }
 * );
 * ```
 */
export function buildVerifyRequestV2(
  payload: X402PayloadData,
  resource: ResourceInfoV2,
  accepted: PaymentRequirementsV2
): VerifyRequestV2 {
  return buildV2Envelope(payload, resource, accepted);
}

/**
 * Build a settle request for the facilitator `/settle` endpoint, in **v2** form.
 *
 * See {@link buildVerifyRequestV2} — the envelope is identical.
 */
export function buildSettleRequestV2(
  payload: X402PayloadData,
  resource: ResourceInfoV2,
  accepted: PaymentRequirementsV2
): SettleRequestV2 {
  return buildV2Envelope(payload, resource, accepted);
}

export function buildSettleRequest(
  paymentHeader: X402Header,
  requirements: PaymentRequirements
): SettleRequest {
  return {
    x402Version: paymentHeader.x402Version,
    paymentPayload: paymentHeader,
    paymentRequirements: requirements,
  };
}

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Recommended CORS headers for x402 payment APIs
 *
 * These headers allow browsers to send payment headers in cross-origin requests.
 */
export const X402_CORS_HEADERS = {
  'Access-Control-Allow-Headers':
    'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Authorization',
  'Access-Control-Expose-Headers':
    'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const;

/**
 * All x402 custom header names that should be allowed in CORS
 */
export const X402_HEADER_NAMES = [
  'X-PAYMENT',
  'PAYMENT-SIGNATURE',
  'X-PAYMENT-RESPONSE',
  'PAYMENT-RESPONSE',
  'PAYMENT-REQUIRED',
] as const;

/**
 * Get CORS headers with custom origin
 *
 * @param origin - Allowed origin (use '*' for any, or specific domain)
 * @returns Complete CORS headers object
 *
 * @example
 * ```ts
 * // Express.js middleware
 * app.use((req, res, next) => {
 *   const corsHeaders = getCorsHeaders('https://myapp.com');
 *   Object.entries(corsHeaders).forEach(([key, value]) => {
 *     res.setHeader(key, value);
 *   });
 *   if (req.method === 'OPTIONS') {
 *     return res.status(204).end();
 *   }
 *   next();
 * });
 * ```
 */
export function getCorsHeaders(origin: string = '*'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    ...X402_CORS_HEADERS,
  };
}

// ============================================================================
// FACILITATOR CLIENT
// ============================================================================

/**
 * Options for the FacilitatorClient
 */
export interface FacilitatorClientOptions {
  /** Base URL of the facilitator (default: https://facilitator.ultravioletadao.xyz) */
  baseUrl?: string;
  /**
   * Request timeout in milliseconds (default: auto per network).
   * When not set, the client uses per-network defaults from ESCROW_TIMEOUT_MS
   * (960s for Ethereum L1, 90s for L2s, 30s for others).
   * Set explicitly to override per-network auto-detection.
   */
  timeout?: number;
}

/**
 * Client for interacting with the x402 facilitator API
 *
 * @example
 * ```ts
 * const client = new FacilitatorClient();
 *
 * // Verify a payment
 * const verifyResult = await client.verify(paymentHeader, requirements);
 * if (!verifyResult.isValid) {
 *   return res.status(402).json({ error: verifyResult.invalidReason });
 * }
 *
 * // Provide the service, then settle
 * const settleResult = await client.settle(paymentHeader, requirements);
 * if (!settleResult.success) {
 *   // Handle settlement failure (maybe refund or retry)
 * }
 * ```
 */
export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly explicitTimeout: boolean;

  constructor(options: FacilitatorClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://facilitator.ultravioletadao.xyz';
    this.explicitTimeout = options.timeout !== undefined;
    this.timeout = options.timeout || 30000;
  }

  /**
   * Get timeout for a specific network, using per-chain defaults when no explicit timeout was set.
   */
  private getTimeout(network?: string): number {
    if (this.explicitTimeout) return this.timeout;
    if (!network) return this.timeout;
    // Extract chainId from CAIP-2 format (eip155:1) or legacy names
    const match = network.match(/^eip155:(\d+)$/);
    if (match) {
      const chainId = parseInt(match[1], 10);
      return ESCROW_TIMEOUT_MS[chainId] || this.timeout;
    }
    // Legacy network name mapping for Ethereum
    if (network === 'ethereum' || network === 'ethereum-mainnet') return ESCROW_TIMEOUT_MS[1];
    return this.timeout;
  }

  /**
   * Verify a payment with the facilitator
   *
   * Call this before providing the paid resource to validate the payment.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Verification result
   */
  async verify(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    const body = buildVerifyRequest(paymentHeader, requirements);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          isValid: false,
          invalidReason: `Facilitator error: ${response.status} - ${errorText}`,
        };
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Settle a payment with the facilitator
   *
   * Call this after providing the paid resource to execute the on-chain transfer.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Settlement result with transaction hash
   */
  async settle(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<SettleResponse> {
    const body = buildSettleRequest(paymentHeader, requirements);
    const settleTimeout = this.getTimeout(requirements.network);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), settleTimeout);

    try {
      const response = await fetch(`${this.baseUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Facilitator error: ${response.status} - ${errorText}`,
        };
      }

      const result = await response.json();
      // Read all three spellings. The facilitator's canonical name for this
      // field is `transaction`, and this client used to read only the two
      // camel/snake variants — so it silently returned `undefined` for the
      // most important field a settle produces. A consumer failed closed on
      // that and revoked access to a payment that had already settled
      // on-chain: the money moved, the receipt was unreadable.
      //
      // The server now emits all three, but this fallback stays: it makes the
      // client work against facilitators that have not deployed that yet, and
      // against any that only ever emitted the canonical name.
      const transactionHash =
        result.transaction ?? result.transactionHash ?? result.transaction_hash;
      if (result.success && !transactionHash) {
        // Never let a missing hash pass as a normal success. A caller that
        // gates access on the receipt needs to know the receipt is absent,
        // not infer it from an undefined field.
        console.warn(
          '[x402] settle reported success but carried no transaction hash under ' +
            'transaction/transactionHash/transaction_hash — treat delivery as unconfirmed'
        );
      }
      return {
        success: true,
        transactionHash,
        network: result.network,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify and settle atomically
   *
   * Convenience method that verifies first, then settles if valid.
   * Use this for simple payment flows where you don't need custom logic between verify and settle.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Combined result with verify and settle status
   */
  async verifyAndSettle(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<{
    verified: boolean;
    settled: boolean;
    transactionHash?: string;
    error?: string;
  }> {
    // Verify first
    const verifyResult = await this.verify(paymentHeader, requirements);
    if (!verifyResult.isValid) {
      return {
        verified: false,
        settled: false,
        error: verifyResult.invalidReason,
      };
    }

    // Settle
    const settleResult = await this.settle(paymentHeader, requirements);
    return {
      verified: true,
      settled: settleResult.success,
      transactionHash: settleResult.transactionHash,
      error: settleResult.error,
    };
  }

  /**
   * Check if the facilitator is healthy
   *
   * @returns True if the facilitator is responding
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get the facilitator version info
   *
   * @returns Version info (e.g., { version: "1.37.0" })
   */
  async getVersion(): Promise<{ version: string; [key: string]: unknown }> {
    const response = await fetch(`${this.baseUrl}/version`, {
      method: 'GET',
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GET /version failed: ${response.status} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * Get the facilitator's supported networks and payment schemes
   *
   * @returns Supported networks/schemes with 'kinds' array
   *
   * @example
   * ```ts
   * const supported = await client.getSupported();
   * for (const kind of supported.kinds) {
   *   console.log(`${kind.network} - ${kind.scheme}`);
   * }
   * ```
   */
  async getSupported(): Promise<{
    kinds: Array<{ network: string; scheme: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }> {
    const response = await fetch(`${this.baseUrl}/supported`, {
      method: 'GET',
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GET /supported failed: ${response.status} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * Aggregated totals per network and asset (`GET /api/stats`).
   *
   * **An index, not a ledger.** Records are written best-effort AFTER
   * settlement, so an outage loses rows while payments proceed — verify
   * anything that matters against the transaction hash. Counting starts when
   * the operator enabled the store, so earlier operations are UNKNOWN, not
   * zero. And unless `X402_EVENTS_PUBLISH_FAILURES=true`, operations that ERROR
   * are not recorded at all: a 100% success rate means "no failures were
   * recorded".
   *
   * `volumeAtomic` is a STRING (u256-shaped; a JS number loses precision above
   * 2^53) and each row carries its own `decimals`. **Use that, never a
   * constant** — USDC is 6 decimals nearly everywhere and 18 on BSC, so scaling
   * by 6 there overstates volume by 10^12. `decimals` is null when the asset is
   * unrecognised; render the atomic value rather than guessing a scale.
   */
  async getStats(): Promise<{
    totals: { settlesOk: number; settlesFailed: number; verifies: number; networks: number };
    byNetworkAndAsset: Array<{
      network: string;
      asset: string;
      settlesOk: number;
      settlesFailed: number;
      verifies: number;
      volumeAtomic: string;
      decimals: number | null;
      lastTs: number;
    }>;
    [key: string]: unknown;
  }> {
    const response = await fetch(`${this.baseUrl}/api/stats`, { method: 'GET' });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GET /api/stats failed: ${response.status} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * Recent recorded operations, newest first (`GET /transactions`).
   *
   * There is **no pagination and no cursor**: this returns the newest N,
   * walking back at most 30 days. With 10,000 rows you get the newest 200, not
   * page one of fifty. `limit` is clamped to 200 by the facilitator.
   *
   * `network` matches the canonical slug `/supported` uses, which is not always
   * the alias you may send — `skale` is accepted inbound but records say
   * `skale-base`.
   */
  async getTransactions(options: { limit?: number; network?: string } = {}): Promise<{
    transactions: Array<Record<string, unknown>>;
    count: number;
    [key: string]: unknown;
  }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.network) params.set('network', options.network);
    const query = params.toString();
    const response = await fetch(
      `${this.baseUrl}/transactions${query ? `?${query}` : ''}`,
      { method: 'GET' }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GET /transactions failed: ${response.status} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * Get the facilitator's blocked/sanctioned addresses
   *
   * @returns Blacklist info (totalBlocked, loadedAtStartup, addresses)
   *
   * @example
   * ```ts
   * const bl = await client.getBlacklist();
   * console.log(`Blocked: ${bl.totalBlocked} addresses`);
   * ```
   */
  async getBlacklist(): Promise<{
    totalBlocked: number;
    loadedAtStartup: boolean;
    [key: string]: unknown;
  }> {
    const response = await fetch(`${this.baseUrl}/blacklist`, {
      method: 'GET',
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GET /blacklist failed: ${response.status} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * Negotiate payment requirements with the facilitator via POST /accepts.
   *
   * Sends merchant payment requirements to the facilitator, which matches
   * them against its supported capabilities and returns enriched requirements
   * with facilitator data (feePayer, tokens, escrow configuration).
   *
   * This is used by Faremeter middleware and clients that need to discover
   * what the facilitator can settle before constructing payment authorizations.
   *
   * @param paymentRequirements - List of payment requirement objects
   * @param x402Version - x402 protocol version (default: 2)
   * @returns List of enriched payment requirements with facilitator extras
   *
   * @example
   * ```ts
   * const enriched = await client.accepts([
   *   {
   *     scheme: 'exact',
   *     network: 'base-mainnet',
   *     maxAmountRequired: '1000000',
   *     resource: 'https://api.example.com/data',
   *     payTo: '0xMerchant...',
   *   },
   * ]);
   * // enriched[0].extra.feePayer is now set
   * ```
   */
  async accepts(
    paymentRequirements: PaymentRequirements[],
    x402Version: number = 2
  ): Promise<PaymentRequirements[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/accepts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version,
          accepts: paymentRequirements,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Facilitator /accepts error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return data.accepts || [];
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

// ============================================================================
// ATOMIC PAYMENT HELPERS
// ============================================================================

/**
 * Create a 402 Payment Required response
 *
 * @param requirements - Payment requirements
 * @param options - Additional response options
 * @returns Object with status code, headers, and body for the 402 response
 *
 * @example
 * ```ts
 * // Express.js
 * app.get('/premium-data', (req, res) => {
 *   const payment = extractPaymentFromHeaders(req.headers);
 *
 *   if (!payment) {
 *     const { status, headers, body } = create402Response({
 *       amount: '1.00',
 *       recipient: '0x...',
 *       resource: 'https://api.example.com/premium-data',
 *     });
 *     return res.status(status).set(headers).json(body);
 *   }
 *
 *   // Verify and serve...
 * });
 * ```
 */
export function create402Response(
  requirements: PaymentRequirementsOptions,
  options: {
    accepts?: PaymentAcceptance[];
  } = {}
): {
  status: 402;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const primaryRequirement = buildPaymentRequirements(requirements);
  const version = requirements.x402Version
    || ((options.accepts && options.accepts.length > 0)
      || primaryRequirement.network.includes(':')
      || (options.accepts || []).some((accept) => accept.network.includes(':'))
      ? 2
      : 1);
  const advertisedRequirements = [
    normalizeRequirementForVersion(primaryRequirement, version),
    ...(options.accepts || []).map((accept) =>
      buildRequirementFromAcceptance(accept, primaryRequirement.resource, version, primaryRequirement)
    ),
  ];
  const body = create402ResponseBody(advertisedRequirements[0], advertisedRequirements, version);

  return {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      ...X402_CORS_HEADERS,
    },
    body,
  };
}

const DEFAULT_PAYMENT_DESCRIPTION = 'Payment required';
const DEFAULT_PAYMENT_MIME_TYPE = 'application/json';
const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 300;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveAdvertisedVersion(
  accepts: PaymentAcceptance[],
  requestedVersion?: X402Version | 'auto'
): X402Version {
  if (requestedVersion && requestedVersion !== 'auto') {
    return requestedVersion;
  }

  if (accepts.length > 1 || accepts.some((accept) => accept.network.includes(':'))) {
    return 2;
  }

  return 1;
}

function normalizeRequirementForVersion(
  requirements: PaymentRequirements,
  version: X402Version
): PaymentRequirements {
  return {
    ...requirements,
    network: version === 2
      ? (requirements.network.includes(':') ? requirements.network : chainToCAIP2(requirements.network))
      : (requirements.network.includes(':') ? parseNetworkIdentifier(requirements.network) : requirements.network),
  };
}

function buildRequirementFromAcceptance(
  accept: PaymentAcceptance,
  resource: string,
  version: X402Version,
  defaults?: PaymentRequirements
): PaymentRequirements {
  const payTo = accept.payTo ?? defaults?.payTo;
  if (!payTo) {
    throw new Error('Payment accepts entries must include payTo');
  }

  return normalizeRequirementForVersion({
    // Honour a caller-supplied scheme; 'exact' is the default, not an override.
    // Hardcoding it silently discarded 'escrow' / 'commerce' accepts.
    scheme: (accept.scheme as PaymentRequirements['scheme']) ?? 'exact',
    network: accept.network,
    maxAmountRequired: accept.amount,
    resource: accept.resource ?? defaults?.resource ?? resource,
    description: accept.description ?? defaults?.description ?? DEFAULT_PAYMENT_DESCRIPTION,
    mimeType: accept.mimeType ?? defaults?.mimeType ?? DEFAULT_PAYMENT_MIME_TYPE,
    payTo,
    asset: accept.asset,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? defaults?.maxTimeoutSeconds ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS,
    ...(accept.outputSchema !== undefined
      ? { outputSchema: accept.outputSchema }
      : defaults?.outputSchema !== undefined
        ? { outputSchema: defaults.outputSchema }
        : {}),
    ...(accept.extra !== undefined
      ? { extra: accept.extra }
      : defaults?.extra !== undefined
        ? { extra: defaults.extra }
        : {}),
  }, version);
}

function toPaymentAcceptance(
  requirements: PaymentRequirements,
  facilitator?: string
): PaymentAcceptance {
  return {
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.maxAmountRequired,
    // scheme is REQUIRED by the facilitator's v2 PaymentRequirementsV2. Dropping it
    // here produced an accepts[] entry that no v2 client could pay: the spec makes
    // the client echo the accept verbatim, so the omission travelled downstream and
    // died in deserialization with an error naming no field.
    scheme: requirements.scheme,
    payTo: requirements.payTo,
    resource: requirements.resource,
    description: requirements.description,
    mimeType: requirements.mimeType,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    ...(facilitator ? { facilitator } : {}),
    ...(requirements.outputSchema !== undefined ? { outputSchema: requirements.outputSchema } : {}),
    ...(requirements.extra !== undefined ? { extra: requirements.extra } : {}),
  };
}

function create402ResponseBody(
  primaryRequirement: PaymentRequirements,
  advertisedRequirements: PaymentRequirements[],
  version: X402Version,
  facilitator?: string
): Record<string, unknown> {
  const normalizedPrimary = normalizeRequirementForVersion(primaryRequirement, version);
  const normalizedAdvertised = advertisedRequirements.map((requirements) =>
    normalizeRequirementForVersion(requirements, version)
  );

  const body: Record<string, unknown> = {
    x402Version: version,
    ...normalizedPrimary,
  };

  if (version === 2 && normalizedAdvertised.length > 1) {
    body.accepts = normalizedAdvertised.map((requirements) =>
      toPaymentAcceptance(requirements, facilitator)
    );
  }

  return body;
}

function getComparableNetwork(network: string): string {
  return parseNetworkIdentifier(network).toLowerCase();
}

function getPaymentRecipient(payment: X402Header): string | undefined {
  const payload = payment.payload as unknown;
  if (!isObject(payload)) {
    return undefined;
  }
  const authorization = payload.authorization;

  if (isObject(authorization) && typeof authorization.to === 'string') {
    return authorization.to.toLowerCase();
  }

  if (typeof payload.to === 'string') {
    return payload.to.toLowerCase();
  }

  return undefined;
}

function getPaymentAmount(payment: X402Header): string | undefined {
  const payload = payment.payload as unknown;
  if (!isObject(payload)) {
    return undefined;
  }
  const authorization = payload.authorization;

  if (isObject(authorization) && typeof authorization.value === 'string') {
    return authorization.value;
  }

  if (typeof payload.amount === 'string') {
    return payload.amount;
  }

  return undefined;
}

function getPaymentAsset(payment: X402Header): string | undefined {
  const payload = payment.payload as unknown;
  if (!isObject(payload)) {
    return undefined;
  }

  if (typeof payload.tokenContract === 'string') {
    return payload.tokenContract.toLowerCase();
  }

  return undefined;
}

async function resolvePaymentRequirement(
  payment: X402Header,
  requirements: PaymentRequirements[],
  resolver?: PaymentRequirementResolver
): Promise<{ requirement: PaymentRequirements | null; reason?: string }> {
  const normalizedRequirements = requirements.map((requirements) =>
    normalizeRequirementForVersion(requirements, payment.x402Version)
  );

  if (resolver) {
    const resolved = await resolver(payment, normalizedRequirements);
    return {
      requirement: resolved
        ? normalizeRequirementForVersion(resolved, payment.x402Version)
        : null,
      ...(resolved ? {} : { reason: 'Custom requirement resolver did not return a matching requirement.' }),
    };
  }

  const networkMatches = normalizedRequirements.filter((requirements) =>
    getComparableNetwork(requirements.network) === getComparableNetwork(payment.network)
  );

  if (networkMatches.length === 0) {
    return {
      requirement: null,
      reason: `No advertised payment requirement matched network ${payment.network}.`,
    };
  }

  let matches = networkMatches;

  const paymentRecipient = getPaymentRecipient(payment);
  if (paymentRecipient) {
    const recipientMatches = matches.filter((requirements) =>
      requirements.payTo.toLowerCase() === paymentRecipient
    );
    if (recipientMatches.length === 0) {
      return {
        requirement: null,
        reason: 'Payment recipient does not match any advertised requirement.',
      };
    }
    matches = recipientMatches;
  }

  const paymentAmount = getPaymentAmount(payment);
  if (paymentAmount) {
    const amountMatches = matches.filter((requirements) =>
      requirements.maxAmountRequired === paymentAmount
    );
    if (amountMatches.length === 0) {
      return {
        requirement: null,
        reason: 'Payment amount does not match any advertised requirement.',
      };
    }
    matches = amountMatches;
  }

  const paymentAsset = getPaymentAsset(payment);
  if (paymentAsset) {
    const assetMatches = matches.filter((requirements) =>
      requirements.asset.toLowerCase() === paymentAsset
    );
    if (assetMatches.length === 0) {
      return {
        requirement: null,
        reason: 'Payment asset does not match any advertised requirement.',
      };
    }
    matches = assetMatches;
  }

  if (matches.length !== 1) {
    return {
      requirement: null,
      reason: 'Payment matched multiple advertised requirements. Advertise unique network/payTo/amount combinations or provide resolveRequirement().',
    };
  }

  return { requirement: matches[0] };
}

function createVerifiedPaymentState(
  client: FacilitatorClient,
  payment: X402Header,
  requirements: PaymentRequirements,
  verifyResult: VerifyResponse
): VerifiedPaymentState {
  let settlePromise: Promise<SettleResponse> | null = null;
  return {
    payment,
    requirements,
    verifyResult,
    settle: () => {
      if (!settlePromise) {
        settlePromise = client.settle(payment, requirements);
      }
      return settlePromise;
    },
  };
}

/**
 * Create an Express-compatible middleware for x402 payments
 *
 * @param getRequirements - Function to get payment requirements for a request
 * @param options - Middleware options
 * @returns Express middleware function
 *
 * @example
 * ```ts
 * const paymentMiddleware = createPaymentMiddleware(
 *   (req) => ({
 *     amount: '1.00',
 *     recipient: process.env.PAYMENT_RECIPIENT,
 *     resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
 *   }),
 *   { facilitatorUrl: 'https://facilitator.uvd.xyz' }
 * );
 *
 * app.get('/premium/*', paymentMiddleware, async (req, res) => {
 *   const settleResult = await req.x402?.settle();
 *   if (!settleResult?.success) {
 *     return res.status(500).json({ error: settleResult?.error });
 *   }
 *
 *   res.json({ premium: 'data' });
 * });
 * ```
 */
export function createPaymentMiddleware(
  getRequirements: (req: { headers: Record<string, string | string[] | undefined> }) => PaymentRequirementsOptions,
  options: PaymentMiddlewareOptions = {}
): (
  req: { headers: Record<string, string | string[] | undefined>; x402?: VerifiedPaymentState },
  res: { status: (code: number) => { json: (body: unknown) => void; set: (headers: Record<string, string>) => { json: (body: unknown) => void } } },
  next: () => void
) => Promise<void> {
  const client = new FacilitatorClient({
    baseUrl: options.facilitatorUrl || options.baseUrl,
    timeout: options.timeout,
  });
  const settlementStrategy = options.settlementStrategy || 'before-handler';

  return async (req, res, next) => {
    // Extract payment header
    const payment = extractPaymentFromHeaders(req.headers);

    // If no payment, return 402
    if (!payment) {
      const reqOptions = getRequirements(req);
      const { status, headers, body } = create402Response(reqOptions);
      res.status(status).set(headers).json(body);
      return;
    }

    // Build requirements and verify
    const reqOptions = getRequirements(req);
    const requirements = buildPaymentRequirements(reqOptions);
    const verifyResult = await client.verify(payment, requirements);

    if (!verifyResult.isValid) {
      res.status(402).json({
        error: 'Payment verification failed',
        reason: verifyResult.invalidReason,
      });
      return;
    }

    req.x402 = createVerifiedPaymentState(client, payment, requirements, verifyResult);

    if (settlementStrategy === 'before-handler') {
      const settleResult = await req.x402.settle();
      if (!settleResult.success) {
        res.status(500).json({
          error: 'Payment settlement failed',
          reason: settleResult.error || 'Unknown settlement error',
        });
        return;
      }
    }

    next();
  };
}

// ============================================================================
// HONO MIDDLEWARE
// ============================================================================

/**
 * Options for creating a Hono x402 payment middleware
 */
export interface HonoMiddlewareOptions extends PaymentMiddlewareOptions {
  /** Payment requirements to advertise */
  accepts: PaymentAcceptance[];
  /** Response version to advertise (defaults to auto) */
  x402Version?: X402Version | 'auto';
  /** Custom requirement resolver for ambiguous multi-accept flows */
  resolveRequirement?: PaymentRequirementResolver;
}

/**
 * Create a Hono-compatible middleware for x402 payments.
 *
 * Handles the x402 payment flow:
 * 1. Returns 402 with payment requirements if no X-PAYMENT header
 * 2. Verifies the payment with the facilitator
 * 3. Optionally settles before the handler when settlementStrategy is set
 * 4. Passes control to the next handler on success
 *
 * @param options - Middleware options with facilitator URL and payment accepts
 * @returns Hono middleware function
 *
 * @example
 * ```ts
 * import { createHonoMiddleware } from 'uvd-x402-sdk';
 *
 * const paywall = createHonoMiddleware({
 *   accepts: [{
 *     network: 'skale-base',
 *     asset: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
 *     amount: '1000000',
 *     payTo: '0xYourWallet',
 *     extra: { name: 'Bridged USDC (SKALE Bridge)', version: '2' },
 *   }],
 * });
 *
 * app.get('/api/premium', paywall, (c) => {
 *   return c.json({ message: 'Premium content!' });
 * });
 * ```
 */
export function createHonoMiddleware(options: HonoMiddlewareOptions) {
  const client = new FacilitatorClient({
    baseUrl: options.facilitatorUrl || options.baseUrl,
    timeout: options.timeout,
  });
  const settlementStrategy = options.settlementStrategy || 'before-handler';

  if (!options.accepts[0]) {
    throw new Error('At least one accept entry is required');
  }

  return async (
    c: {
      req: { header: (name: string) => string | undefined; url: string };
      json: (body: unknown, status?: number) => unknown;
      set?: (key: string, value: unknown) => void;
    },
    next: () => Promise<void>
  ) => {
    const paymentHeader = c.req.header('X-PAYMENT') || c.req.header('x-payment');
    const advertisedVersion = resolveAdvertisedVersion(options.accepts, options.x402Version);
    const advertisedRequirements = options.accepts.map((accept) =>
      buildRequirementFromAcceptance(accept, c.req.url, advertisedVersion)
    );

    if (!paymentHeader) {
      return c.json(
        create402ResponseBody(
          advertisedRequirements[0],
          advertisedRequirements,
          advertisedVersion,
          options.facilitatorUrl
        ),
        402
      );
    }

    const parsed = parsePaymentHeader(paymentHeader);
    if (!parsed) {
      return c.json({ error: 'Invalid X-PAYMENT header' }, 400);
    }

    const { requirement, reason } = await resolvePaymentRequirement(
      parsed,
      advertisedRequirements,
      options.resolveRequirement
    );

    if (!requirement) {
      return c.json({
        error: 'Payment verification failed',
        reason,
      }, 402);
    }

    const verifyResult = await client.verify(parsed, requirement);
    if (!verifyResult.isValid) {
      return c.json({
        error: 'Payment verification failed',
        reason: verifyResult.invalidReason,
      }, 402);
    }

    const verifiedPayment = createVerifiedPaymentState(client, parsed, requirement, verifyResult);
    c.set?.('x402', verifiedPayment);

    if (settlementStrategy === 'before-handler') {
      const settleResult = await verifiedPayment.settle();
      if (!settleResult.success) {
        return c.json({
          error: 'Payment settlement failed',
          reason: settleResult.error || 'Unknown error',
        }, 500);
      }
    }

    await next();
  };
}

// ============================================================================
// BAZAAR DISCOVERY API
// ============================================================================
//
// The Bazaar is the discovery registry served by the facilitator itself, under
// `/discovery/*`. There is no separate Bazaar host.

/**
 * Maximum length of the free-text `q` filter.
 *
 * Mirrors the facilitator's `MAX_SEARCH_LEN`; a longer needle is rejected
 * server-side with a 400.
 */
export const MAX_SEARCH_LEN = 128;

/**
 * Liveness of a registered resource, as measured by the facilitator's prober.
 *
 * Resources that stop answering are quarantined rather than deleted, so filter
 * on this before paying anyone.
 */
export type DiscoveryHealthStatus =
  | 'alive'
  | 'degraded'
  | 'auth_gated'
  | 'quarantined'
  | 'unknown'
  | 'unprobeable';

/** Values accepted by the `health` filter, including the `any` escape hatch. */
export const HEALTH_FILTERS = [
  'alive',
  'degraded',
  'auth_gated',
  'quarantined',
  'unknown',
  'unprobeable',
  'any',
] as const;

/** Curated tier, in descending order of trust. */
export type DiscoveryTier = 'first_party' | 'vip' | 'verified' | 'listed';

/** Values accepted by the `tier` filter. */
export const TIER_FILTERS = [
  'first_party',
  'vip',
  'verified',
  'listed',
] as const;

/** How a resource got into the registry. */
export type DiscoverySource =
  | 'self_registered'
  | 'settlement'
  | 'crawled'
  | 'aggregated';

/** Health of a single resource, as reported by the registry's prober. */
export interface DiscoveryHealth {
  /** Last observed liveness */
  status?: DiscoveryHealthStatus;
  /** Unix epoch seconds of the last probe */
  lastChecked?: number;
  /** HTTP status the probe got back (402 is the healthy answer for x402) */
  httpStatus?: number;
  /** Round-trip time of the last probe, in milliseconds */
  latencyMs?: number;
}

/** Curation metadata attached to a resource. */
export interface DiscoveryCuration {
  /** Curated tier */
  tier?: DiscoveryTier;
  /** Human-readable name of the curated set */
  label?: string;
}

/** One payment method a resource declares. */
export interface DiscoveryAccepts {
  /** Payment scheme ("exact", "escrow", "commerce") */
  scheme: string;
  /** CAIP-2 network id, e.g. "eip155:8453" */
  network: string;
  /** Token contract address */
  asset?: string;
  /** Price in atomic units of `asset` */
  amount?: string;
  /** Recipient address */
  payTo?: string;
  /** Settlement deadline in seconds */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extras (EIP-712 domain, etc.) */
  extra?: Record<string, unknown>;
  /** Anything the registry adds later */
  [key: string]: unknown;
}

/**
 * A discoverable paid resource, exactly as `GET /discovery/resources` serves it.
 *
 * Timestamps are Unix epoch **seconds**, not ISO strings and not milliseconds.
 */
export interface DiscoveryResource {
  /** Resource URL. This is the registry's primary key -- there is no `id` */
  url: string;
  /** Resource type ("http", "mcp", "a2a") */
  type: string;
  /** x402 protocol version the resource speaks */
  x402Version: number;
  /** Human-readable description */
  description?: string;
  /** Payment methods the resource accepts */
  accepts: DiscoveryAccepts[];
  /** Free-form metadata (category, provider, tags) */
  metadata?: Record<string, unknown>;
  /** How this resource entered the registry */
  source?: DiscoverySource;
  /** Facilitator this resource was aggregated from */
  sourceFacilitator?: string;
  /** Unix epoch seconds when the registry first saw this resource */
  firstSeen?: number;
  /** Unix epoch seconds when the registry last saw this resource */
  lastSeen?: number;
  /** Unix epoch seconds of the last change to this record */
  lastUpdated?: number;
  /** Liveness, when the resource has been probed */
  health?: DiscoveryHealth;
  /** Curation tier, when the resource has been curated */
  curation?: DiscoveryCuration;
  /** Anything the registry adds later */
  [key: string]: unknown;
}

/** Pagination envelope of `GET /discovery/resources`. */
export interface DiscoveryPagination {
  /** Page size that was applied */
  limit: number;
  /** Offset that was applied */
  offset: number;
  /** Total number of resources matching the filters, across all pages */
  total: number;
}

/** Paginated response from `GET /discovery/resources`. */
export interface DiscoveryResponse {
  /** x402 protocol version of the response envelope */
  x402Version: number;
  /** Resources on this page */
  items: DiscoveryResource[];
  /** Pagination state */
  pagination: DiscoveryPagination;
}

/**
 * Filters for `listResources()`.
 *
 * Every one of these is applied server-side over the whole catalog, so
 * `pagination.total` reflects the filtered set. Filtering a page after the
 * fact is not the same thing and will under-report.
 */
export interface DiscoveryListOptions {
  /** Page size (default: 10, max: 100) */
  limit?: number;
  /** Number of resources to skip */
  offset?: number;
  /** Filter by category */
  category?: string;
  /** Filter by network, CAIP-2 or v1 name */
  network?: string;
  /** Filter by provider name */
  provider?: string;
  /** Filter by tag */
  tag?: string;
  /** Filter by how the resource was discovered */
  source?: DiscoverySource;
  /** Filter by originating facilitator */
  sourceFacilitator?: string;
  /** Filter by liveness, or 'any' to opt out of the default visibility rules */
  health?: DiscoveryHealthStatus | 'any';
  /** Filter by curated tier */
  tier?: DiscoveryTier;
  /** Free-text search over url / description / provider / category / tags */
  q?: string;
}

/** Options for `registerResource()`. */
export interface DiscoveryRegisterOptions {
  /** URL of the paid resource. Doubles as its identity in the registry */
  url: string;
  /** Resource type (default: "http") */
  type?: string;
  /** Human-readable description */
  description?: string;
  /** Payment methods the resource accepts */
  accepts?: DiscoveryAccepts[];
  /** Free-form metadata (category, provider, tags) */
  metadata?: Record<string, unknown>;
}

/** Aggregate catalog metrics from `GET /discovery/stats`. */
export interface DiscoveryStats {
  /** Every record the registry holds, including quarantined ones */
  total: number;
  /** Records served by default listings */
  visible: number;
  /** Counts by discovery source */
  bySource: Record<string, number>;
  /** Counts by originating facilitator */
  bySourceFacilitator: Record<string, number>;
  /** Counts by CAIP-2 network */
  byNetwork: Record<string, number>;
  /** Counts by curated tier */
  byTier: Record<string, number>;
  /** Counts by liveness */
  byHealth: Record<string, number>;
  /** Unix epoch seconds this snapshot was computed (60s cache) */
  generatedAt?: number;
}

/** Options for the {@link BazaarClient}. */
export interface BazaarClientOptions {
  /** Facilitator base URL (default: https://facilitator.ultravioletadao.xyz) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/** Render an epoch-seconds field as a `Date`. */
export function epochToDate(seconds?: number): Date | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000);
}

/** True when the last probe reached this resource. */
export function isAlive(resource: DiscoveryResource): boolean {
  return resource.health?.status === 'alive';
}

/**
 * Client for the x402 Bazaar Discovery API.
 *
 * The Bazaar is the facilitator's own registry of x402-enabled resources.
 * Providers register their endpoints and consumers discover them, with a
 * liveness probe and a curation tier attached to every record.
 *
 * @example
 * ```ts
 * const bazaar = new BazaarClient();
 *
 * // Only endpoints a probe actually reached, best-curated first
 * const page = await bazaar.listResources({ limit: 20, health: 'alive', tier: 'vip' });
 * for (const r of page.items) {
 *   console.log(r.url, r.health?.status, r.health?.latencyMs, r.curation?.label);
 * }
 *
 * // Free-text search runs server-side over the whole catalog
 * const hits = await bazaar.listResources({ q: 'logs' });
 * console.log(hits.pagination.total);
 *
 * // Register your own
 * await bazaar.registerResource({
 *   url: 'https://api.example.com/v1/generate',
 *   description: 'Generate images with AI',
 *   accepts: [{
 *     scheme: 'exact',
 *     network: 'eip155:8453',
 *     asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
 *     amount: '10000',
 *     payTo: '0xYourWallet...',
 *     maxTimeoutSeconds: 60,
 *   }],
 *   metadata: { category: 'ai', tags: ['image'] },
 * });
 * ```
 */
export class BazaarClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: BazaarClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl || 'https://facilitator.ultravioletadao.xyz'
    ).replace(/\/+$/, '');
    this.timeout = options.timeout || 30000;
  }

  /**
   * Issue a request against the facilitator with the configured timeout.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers || {}) },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Bazaar API error: ${response.status} - ${errorText}`
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List resources from the discovery registry.
   *
   * @param options - Server-side filters and pagination
   * @returns One page of resources plus the total across all pages
   *
   * @example
   * ```ts
   * const page = await bazaar.listResources({ network: 'eip155:8453', health: 'alive' });
   * ```
   */
  async listResources(
    options: DiscoveryListOptions = {}
  ): Promise<DiscoveryResponse> {
    if (options.q !== undefined && options.q.length > MAX_SEARCH_LEN) {
      throw new Error(`q must be at most ${MAX_SEARCH_LEN} characters`);
    }

    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 10));
    params.set('offset', String(options.offset ?? 0));
    if (options.category) params.set('category', options.category);
    if (options.network) params.set('network', options.network);
    if (options.provider) params.set('provider', options.provider);
    if (options.tag) params.set('tag', options.tag);
    if (options.source) params.set('source', options.source);
    if (options.sourceFacilitator)
      params.set('sourceFacilitator', options.sourceFacilitator);
    if (options.health) params.set('health', options.health);
    if (options.tier) params.set('tier', options.tier);
    if (options.q) params.set('q', options.q);

    return this.request<DiscoveryResponse>(
      `/discovery/resources?${params.toString()}`
    );
  }

  /**
   * Walk the whole filtered catalog, one page at a time.
   *
   * Pages are fetched in sequence rather than in parallel: the read routes are
   * rate limited, and a burst of parallel pages is how a legitimate catalog
   * walk turns into a wall of 429s.
   *
   * @param options - Same filters as {@link listResources}; `limit` is the page size
   *
   * @example
   * ```ts
   * for await (const r of bazaar.iterateResources({ health: 'alive' })) {
   *   console.log(r.url);
   * }
   * ```
   */
  async *iterateResources(
    options: DiscoveryListOptions = {}
  ): AsyncGenerator<DiscoveryResource, void, undefined> {
    const pageSize = options.limit ?? 100;
    let offset = options.offset ?? 0;

    for (;;) {
      const page = await this.listResources({
        ...options,
        limit: pageSize,
        offset,
      });
      if (page.items.length === 0) return;

      for (const item of page.items) yield item;

      offset += page.items.length;
      if (offset >= page.pagination.total) return;
    }
  }

  /**
   * Look up a single resource by its URL.
   *
   * The registry keys on URL and has no by-id lookup, so this searches and
   * then matches exactly.
   *
   * @param resourceUrl - Exact URL of the resource
   * @returns The resource, or null when it is not registered
   */
  async getResourceByUrl(
    resourceUrl: string
  ): Promise<DiscoveryResource | null> {
    const page = await this.listResources({
      q: resourceUrl.slice(0, MAX_SEARCH_LEN),
      limit: 100,
      health: 'any',
    });
    return page.items.find((item) => item.url === resourceUrl) ?? null;
  }

  /**
   * Register a paid resource in the discovery registry.
   *
   * Registration is open and rate limited; re-registering a known URL updates
   * the existing record rather than creating a duplicate.
   *
   * @param options - Resource details
   * @returns The registry's acknowledgement
   */
  async registerResource(
    options: DiscoveryRegisterOptions
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      url: options.url,
      type: options.type || 'http',
      description: options.description || '',
    };
    if (options.accepts) payload.accepts = options.accepts;
    if (options.metadata) payload.metadata = options.metadata;

    return this.request<Record<string, unknown>>('/discovery/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Aggregate catalog metrics (60s cached server-side).
   *
   * @returns Counts by source, facilitator, network, tier and liveness
   */
  async getStats(): Promise<DiscoveryStats> {
    return this.request<DiscoveryStats>('/discovery/stats');
  }

  /**
   * Check that the facilitator serving the registry is up.
   *
   * @returns True when the facilitator answers its health check
   */
  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * @deprecated Renamed to {@link listResources}, which returns the registry's
   * real `{ items, pagination }` envelope. The old `discover()` returned a
   * `{ resources, page, totalPages }` shape that no endpoint ever served.
   */
  async discover(options: DiscoveryListOptions = {}): Promise<DiscoveryResponse> {
    return this.listResources(options);
  }
}

/**
 * @deprecated Use {@link DiscoveryResource}. The old shape (`id`, `name`,
 * `pricePerRequest`, `isActive`, ISO `createdAt`) described an API that was
 * never deployed.
 */
export type BazaarResource = DiscoveryResource;

/** @deprecated Use {@link DiscoveryResponse}. */
export type BazaarDiscoverResponse = DiscoveryResponse;

/** @deprecated Use {@link DiscoveryListOptions}. */
export type BazaarDiscoverOptions = DiscoveryListOptions;

/** @deprecated Use {@link DiscoveryRegisterOptions}. */
export type BazaarRegisterOptions = DiscoveryRegisterOptions;

// ============================================================================
// ESCROW & REFUND EXTENSION
// ============================================================================

/**
 * Escrow payment status
 */
export type EscrowStatus =
  | 'pending'        // Payment initiated, awaiting confirmation
  | 'held'           // Funds held in escrow
  | 'released'       // Funds released to recipient
  | 'refunded'       // Funds returned to payer
  | 'disputed'       // Dispute in progress
  | 'expired';       // Escrow expired without resolution

/**
 * Refund request status
 */
export type RefundStatus =
  | 'pending'        // Refund requested, awaiting processing
  | 'approved'       // Refund approved
  | 'rejected'       // Refund rejected
  | 'processed'      // Refund completed on-chain
  | 'disputed';      // Under dispute review

/**
 * Dispute resolution outcome
 */
export type DisputeOutcome =
  | 'pending'        // Dispute under review
  | 'payer_wins'     // Payer gets refund
  | 'recipient_wins' // Recipient keeps funds
  | 'split';         // Funds split between parties

/**
 * Escrow payment record
 */
export interface EscrowPayment {
  /** Unique escrow ID */
  id: string;
  /** Original payment header (base64 encoded) */
  paymentHeader: string;
  /** Current status */
  status: EscrowStatus;
  /** Network where payment was made */
  network: string;
  /** Payer address */
  payer: string;
  /** Recipient address */
  recipient: string;
  /** Amount in atomic units */
  amount: string;
  /** Token/asset contract */
  asset: string;
  /** Resource URL being paid for */
  resource: string;
  /** Escrow expiration timestamp (ISO) */
  expiresAt: string;
  /** Release conditions (optional) */
  releaseConditions?: {
    /** Minimum time before release (seconds) */
    minHoldTime?: number;
    /** Required confirmations */
    confirmations?: number;
    /** Custom condition metadata */
    custom?: unknown;
  };
  /** Transaction hash if released/refunded */
  transactionHash?: string;
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
}

/**
 * Refund request record
 */
export interface RefundRequest {
  /** Unique refund request ID */
  id: string;
  /** Related escrow ID */
  escrowId: string;
  /** Current status */
  status: RefundStatus;
  /** Reason for refund request */
  reason: string;
  /** Additional evidence/details */
  evidence?: string;
  /** Amount requested (may be partial) */
  amountRequested: string;
  /** Amount approved (if any) */
  amountApproved?: string;
  /** Requester (payer) address */
  requester: string;
  /** Transaction hash if processed */
  transactionHash?: string;
  /** Response from recipient/facilitator */
  response?: {
    status: 'approved' | 'rejected';
    reason?: string;
    respondedAt: string;
  };
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
}

/**
 * Dispute record
 */
export interface Dispute {
  /** Unique dispute ID */
  id: string;
  /** Related escrow ID */
  escrowId: string;
  /** Related refund request ID (if any) */
  refundRequestId?: string;
  /** Dispute outcome */
  outcome: DisputeOutcome;
  /** Initiator (payer or recipient) */
  initiator: 'payer' | 'recipient';
  /** Reason for dispute */
  reason: string;
  /** Evidence from payer */
  payerEvidence?: string;
  /** Evidence from recipient */
  recipientEvidence?: string;
  /** Arbitration notes */
  arbitrationNotes?: string;
  /** Amount resolved to payer */
  payerAmount?: string;
  /** Amount resolved to recipient */
  recipientAmount?: string;
  /** Transaction hash(es) for resolution */
  transactionHashes?: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Resolution timestamp (ISO) */
  resolvedAt?: string;
}

/**
 * Options for creating an escrow payment
 */
export interface CreateEscrowOptions {
  /** Payment header (from client SDK) */
  paymentHeader: string;
  /** Payment requirements */
  requirements: PaymentRequirements;
  /** Escrow duration in seconds (default: 86400 = 24h) */
  escrowDuration?: number;
  /** Release conditions */
  releaseConditions?: {
    minHoldTime?: number;
    confirmations?: number;
    custom?: unknown;
  };
}

/**
 * Options for requesting a refund
 */
export interface RequestRefundOptions {
  /** Escrow ID to refund */
  escrowId: string;
  /** Reason for refund */
  reason: string;
  /** Amount to refund (full amount if not specified) */
  amount?: string;
  /** Supporting evidence */
  evidence?: string;
}

/**
 * Options for the EscrowClient
 */
export interface EscrowClientOptions {
  /** Base URL of the Escrow API (default: https://escrow.ultravioletadao.xyz) */
  baseUrl?: string;
  /** API key for authenticated operations */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Client for x402 Escrow & Refund operations
 *
 * The Escrow system holds payments until service is verified,
 * enabling refunds and dispute resolution.
 *
 * @example
 * ```ts
 * // Create escrow payment (backend)
 * const escrow = new EscrowClient();
 * const escrowPayment = await escrow.createEscrow({
 *   paymentHeader: req.headers['x-payment'],
 *   requirements: paymentRequirements,
 *   escrowDuration: 86400, // 24 hours
 * });
 *
 * // After service is provided, release the escrow
 * await escrow.release(escrowPayment.id);
 *
 * // If service not provided, payer can request refund
 * await escrow.requestRefund({
 *   escrowId: escrowPayment.id,
 *   reason: 'Service not delivered within expected timeframe',
 * });
 * ```
 */
export class EscrowClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: EscrowClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://escrow.ultravioletadao.xyz';
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 30000;
  }

  private getHeaders(authenticated: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (authenticated && this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Create an escrow payment
   *
   * Holds the payment in escrow until released or refunded.
   *
   * @param options - Escrow creation options
   * @returns Created escrow payment
   */
  async createEscrow(options: CreateEscrowOptions): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          paymentHeader: options.paymentHeader,
          paymentRequirements: options.requirements,
          escrowDuration: options.escrowDuration || 86400,
          releaseConditions: options.releaseConditions,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get escrow payment by ID
   *
   * @param escrowId - Escrow payment ID
   * @returns Escrow payment details
   */
  async getEscrow(escrowId: string): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Release escrow funds to recipient
   *
   * Call this after service has been successfully provided.
   *
   * @param escrowId - Escrow payment ID
   * @returns Updated escrow payment with transaction hash
   */
  async release(escrowId: string): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}/release`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Request a refund for an escrow payment
   *
   * Initiates a refund request that must be approved.
   *
   * @param options - Refund request options
   * @returns Created refund request
   */
  async requestRefund(options: RequestRefundOptions): Promise<RefundRequest> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(options.escrowId)}/refund`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          reason: options.reason,
          amount: options.amount,
          evidence: options.evidence,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Approve a refund request (for recipients)
   *
   * @param refundId - Refund request ID
   * @param amount - Amount to approve (may be less than requested)
   * @returns Updated refund request
   */
  async approveRefund(refundId: string, amount?: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}/approve`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ amount }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Reject a refund request (for recipients)
   *
   * @param refundId - Refund request ID
   * @param reason - Reason for rejection
   * @returns Updated refund request
   */
  async rejectRefund(refundId: string, reason: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}/reject`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ reason }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get refund request by ID
   *
   * @param refundId - Refund request ID
   * @returns Refund request details
   */
  async getRefund(refundId: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Open a dispute for an escrow payment
   *
   * Initiates arbitration when payer and recipient disagree.
   *
   * @param escrowId - Escrow payment ID
   * @param reason - Reason for dispute
   * @param evidence - Supporting evidence
   * @returns Created dispute
   */
  async openDispute(
    escrowId: string,
    reason: string,
    evidence?: string
  ): Promise<Dispute> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}/dispute`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ reason, evidence }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Submit evidence to a dispute
   *
   * @param disputeId - Dispute ID
   * @param evidence - Evidence to submit
   * @returns Updated dispute
   */
  async submitEvidence(disputeId: string, evidence: string): Promise<Dispute> {
    const url = `${this.baseUrl}/dispute/${encodeURIComponent(disputeId)}/evidence`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ evidence }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get dispute by ID
   *
   * @param disputeId - Dispute ID
   * @returns Dispute details
   */
  async getDispute(disputeId: string): Promise<Dispute> {
    const url = `${this.baseUrl}/dispute/${encodeURIComponent(disputeId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * List escrow payments (with filters)
   *
   * @param options - Filter and pagination options
   * @returns Paginated list of escrow payments
   */
  async listEscrows(options: {
    status?: EscrowStatus;
    payer?: string;
    recipient?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<{
    escrows: EscrowPayment[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.payer) params.set('payer', options.payer);
    if (options.recipient) params.set('recipient', options.recipient);
    if (options.page) params.set('page', options.page.toString());
    if (options.limit) params.set('limit', options.limit.toString());

    const url = `${this.baseUrl}/escrow${params.toString() ? `?${params}` : ''}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(true),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Query on-chain escrow state from the facilitator
   *
   * Calls POST /escrow/state to read current escrow state without settlement.
   *
   * @param options - Escrow state query parameters
   * @returns On-chain escrow state (status, balance, timestamps)
   *
   * @example
   * ```ts
   * const state = await escrow.getEscrowState({
   *   network: 'base-mainnet',
   *   payer: '0xPayer...',
   *   recipient: '0xRecipient...',
   *   nonce: '0x1234...',
   * });
   * console.log(`Status: ${state.status}`);
   * ```
   */
  async getEscrowState(options: {
    network: string;
    payer: string;
    recipient: string;
    nonce: string;
  }): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/escrow/state`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(options),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Check Escrow API health
   *
   * @returns True if healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// ESCROW HELPER FUNCTIONS
// ============================================================================

/**
 * Check if an escrow can be released
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow can be released
 */
export function canReleaseEscrow(escrow: EscrowPayment): boolean {
  if (escrow.status !== 'held') {
    return false;
  }

  // Check expiration
  if (new Date(escrow.expiresAt) < new Date()) {
    return false;
  }

  // Check minimum hold time if specified
  if (escrow.releaseConditions?.minHoldTime) {
    const createdAt = new Date(escrow.createdAt);
    const minReleaseTime = new Date(
      createdAt.getTime() + escrow.releaseConditions.minHoldTime * 1000
    );
    if (new Date() < minReleaseTime) {
      return false;
    }
  }

  return true;
}

/**
 * Check if an escrow can be refunded
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow can be refunded
 */
export function canRefundEscrow(escrow: EscrowPayment): boolean {
  // Can only refund held or pending escrows
  return escrow.status === 'held' || escrow.status === 'pending';
}

/**
 * Check if an escrow is expired
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow is expired
 */
export function isEscrowExpired(escrow: EscrowPayment): boolean {
  return new Date(escrow.expiresAt) < new Date();
}

/**
 * Calculate time remaining until escrow expires
 *
 * @param escrow - Escrow payment to check
 * @returns Milliseconds until expiration (negative if expired)
 */
export function escrowTimeRemaining(escrow: EscrowPayment): number {
  return new Date(escrow.expiresAt).getTime() - Date.now();
}

// ============================================================================
// ERC-8004 TRUSTLESS AGENTS
// ============================================================================

/**
 * ERC-8004 extension identifier
 */
export const ERC8004_EXTENSION_ID = '8004-reputation';

/**
 * Agent ID type: EVM uses sequential uint256 (number), Solana uses base58 pubkey (string)
 */
export type AgentId = number | string;

/**
 * ERC-8004 contract addresses per network
 */
// Mainnet addresses (CREATE2 deterministic - same on all mainnets)
const MAINNET_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MAINNET_REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

// Testnet addresses (same on all testnets)
const TESTNET_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const TESTNET_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const TESTNET_VALIDATION = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

// Solana program IDs (QuantuLabs 8004-solana)
const SOLANA_AGENT_REGISTRY = '8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ';
const SOLANA_ATOM_ENGINE = 'AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb';

/**
 * ERC-8004 contract addresses per network (20 networks: 18 EVM + 2 Solana)
 */
export const ERC8004_CONTRACTS: Record<string, {
  identityRegistry?: string;
  reputationRegistry?: string;
  validationRegistry?: string;
  agentRegistryProgram?: string;
  atomEngineProgram?: string;
}> = {
  // Mainnets (10)
  ethereum: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  'base-mainnet': {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  polygon: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  arbitrum: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  optimism: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  celo: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  bsc: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  monad: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  avalanche: {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  'skale-base': {
    identityRegistry: MAINNET_IDENTITY,
    reputationRegistry: MAINNET_REPUTATION,
  },
  // Testnets (8)
  'ethereum-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'base-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'polygon-amoy': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'arbitrum-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'optimism-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'celo-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'avalanche-fuji': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  'skale-base-sepolia': {
    identityRegistry: TESTNET_IDENTITY,
    reputationRegistry: TESTNET_REPUTATION,
    validationRegistry: TESTNET_VALIDATION,
  },
  // Solana (2) - uses QuantuLabs 8004-solana Anchor program + ATOM Engine
  solana: {
    agentRegistryProgram: SOLANA_AGENT_REGISTRY,
    atomEngineProgram: SOLANA_ATOM_ENGINE,
  },
  'solana-devnet': {
    agentRegistryProgram: SOLANA_AGENT_REGISTRY,
    atomEngineProgram: SOLANA_ATOM_ENGINE,
  },
};

/**
 * Network type for ERC-8004 operations (20 networks: 18 EVM + 2 Solana)
 */
export type Erc8004Network =
  // EVM Mainnets
  | 'ethereum' | 'base-mainnet' | 'polygon' | 'arbitrum' | 'optimism' | 'celo' | 'bsc' | 'monad' | 'avalanche' | 'skale-base'
  // EVM Testnets
  | 'ethereum-sepolia' | 'base-sepolia' | 'polygon-amoy' | 'arbitrum-sepolia' | 'optimism-sepolia' | 'celo-sepolia' | 'avalanche-fuji' | 'skale-base-sepolia'
  // Solana (uses QuantuLabs 8004-solana Anchor program + ATOM Engine)
  | 'solana' | 'solana-devnet';

/**
 * Proof of payment returned when settling with ERC-8004 extension
 */
export interface ProofOfPayment {
  /** Transaction hash of the settled payment */
  transactionHash: string;
  /** Block number where the transaction was included */
  blockNumber: number;
  /** Network where the payment was settled */
  network: string;
  /** The payer (consumer/client) address */
  payer: string;
  /** The payee (agent/resource owner) address */
  payee: string;
  /** Amount paid in token base units */
  amount: string;
  /** Token contract address */
  token: string;
  /** Unix timestamp of the block */
  timestamp: number;
  /** Keccak256 hash of the payment data for verification */
  paymentHash: string;
}

/**
 * Extended settle response with ERC-8004 proof of payment
 */
export interface SettleResponseWithProof extends SettleResponse {
  /** Proof of payment for ERC-8004 reputation submission */
  proofOfPayment?: ProofOfPayment;
}

/**
 * Agent identity from the Identity Registry
 */
export interface AgentIdentity {
  /** The agent's ID (EVM: sequential uint256, Solana: base58 pubkey string) */
  agentId: AgentId;
  /** Owner address of the agent NFT */
  owner: string;
  /** URI pointing to agent registration file */
  agentUri: string;
  /** Payment wallet address (if set) */
  agentWallet?: string;
  /** Network where the agent is registered */
  network: Erc8004Network;
}

/**
 * Agent registration file structure (resolved from agentURI)
 */
export interface AgentRegistrationFile {
  /** Type identifier */
  type: string;
  /** Agent name */
  name: string;
  /** Agent description */
  description: string;
  /** Image URL */
  image?: string;
  /** List of services the agent provides */
  services: AgentService[];
  /** Whether x402 payments are supported */
  x402Support: boolean;
  /** Whether the agent is active */
  active: boolean;
  /** List of registrations across chains */
  registrations: AgentRegistration[];
  /** Supported trust models */
  supportedTrust: string[];
}

/**
 * Agent service entry
 */
export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}

/**
 * Agent registration reference
 */
export interface AgentRegistration {
  agentId: AgentId;
  agentRegistry: string; // Format: {namespace}:{chainId}:{address}
}

/**
 * Reputation summary for an agent
 */
export interface ReputationSummary {
  /** Agent ID (EVM: number, Solana: string) */
  agentId: AgentId;
  /** Number of feedback entries */
  count: number;
  /** Aggregated value */
  summaryValue: number;
  /** Decimal places for summaryValue */
  summaryValueDecimals: number;
  /** Network */
  network: Erc8004Network;
}

/**
 * Individual feedback entry
 */
export interface FeedbackEntry {
  /** Client who submitted the feedback */
  client: string;
  /** Feedback index (1-indexed) */
  feedbackIndex: number;
  /** Feedback value */
  value: number;
  /** Value decimals */
  valueDecimals: number;
  /** Primary tag */
  tag1: string;
  /** Secondary tag */
  tag2: string;
  /** Whether this feedback was revoked */
  isRevoked: boolean;
}

/**
 * Parameters for submitting reputation feedback
 */
export interface FeedbackParams {
  /** The agent's ID (EVM: tokenId number, Solana: base58 pubkey string) */
  agentId: AgentId;
  /** Feedback value (e.g., 87 for 87/100) */
  value: number;
  /** Decimal places for value interpretation (0-18) */
  valueDecimals?: number;
  /** Primary categorization tag (e.g., "starred", "uptime") */
  tag1?: string;
  /** Secondary categorization tag */
  tag2?: string;
  /** Service endpoint that was used */
  endpoint?: string;
  /** URI to off-chain feedback file (IPFS, HTTPS) */
  feedbackUri?: string;
  /** Keccak256 hash of feedback content (for integrity) */
  feedbackHash?: string;
  /**
   * Quality score 0-100.
   *
   * Solana only, and effectively required there: the ATOM Engine ignores an
   * unscored feedback. It is written to the agent but contributes nothing to
   * reputation, and the program reports `had_impact=false`. This is not
   * retroactive — reputation stays at zero however much unscored feedback
   * accumulates.
   */
  score?: number;
  /** Proof of payment (required for authorized feedback) */
  proof?: ProofOfPayment;
}

/**
 * Feedback request body for POST /feedback
 */
export interface FeedbackRequest {
  /** x402 protocol version */
  x402Version: 1 | 2;
  /** Network where feedback will be submitted */
  network: Erc8004Network;
  /** Feedback parameters */
  feedback: FeedbackParams;
}

/**
 * Feedback response from POST /feedback
 */
export interface FeedbackResponse {
  /** Whether the feedback was successfully submitted */
  success: boolean;
  /** Transaction hash of the feedback submission */
  transaction?: string;
  /** Feedback index assigned (1-indexed) */
  feedbackIndex?: number;
  /** Error message (if failed) */
  error?: string;
  /** Network where feedback was submitted */
  network: Erc8004Network;
}

/**
 * Reputation query response
 */
/**
 * Error from an ERC-8004 lookup, carrying the HTTP status as a field.
 *
 * `notFound` and `retryable` are mutually exclusive and must stay that way in
 * calling code: the facilitator answers 404 for "this address owns no agent"
 * and 503 for "I could not find out", usually an RPC failure behind it.
 * Treating a 503 as absence is how a transient failure becomes a permanent
 * wrong answer — on a registration path it mints a second agent for an owner
 * who already has one, burning gas and leaving an orphan.
 */
export class Erc8004LookupError extends Error {
  /** HTTP status returned by the facilitator */
  readonly status: number;
  /** Raw response body, for debugging */
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'Erc8004LookupError';
    this.status = status;
    this.body = body;
  }

  /** The address genuinely owns no agent on this network. */
  get notFound(): boolean {
    return this.status === 404;
  }

  /** The lookup reached no verdict. Retry; never read as "owns nothing". */
  get retryable(): boolean {
    return this.status === 503;
  }
}

/**
 * ATOM Engine reputation analytics (Solana only).
 *
 * Present only when the agent's `atom_stats` account has been initialized. The
 * facilitator does that during `registerAgent`; agents registered elsewhere may
 * never have it, in which case their feedback is never scored.
 *
 * The engine measures quality through EMA scores, so there are no
 * positive/negative tallies.
 */
export interface AtomStats {
  /** Trust tier 0-4 */
  trustTier: number;
  /** Human-readable trust tier */
  trustTierName: string;
  /** Cached quality score */
  qualityScore: number;
  /** Cached loyalty score */
  loyaltyScore: number;
  /** Statistical confidence */
  confidence: number;
  /** Risk assessment (lower is better) */
  riskScore: number;
  /** Client diversity from HyperLogLog */
  diversityRatio: number;
  /** Lowest score ever recorded */
  minScore: number;
  /** Highest score ever recorded */
  maxScore: number;
  /** Most recent score recorded */
  lastScore: number;
  /** Total feedback counted by the engine */
  feedbackCount: number;
  /** Slot of the most recent feedback */
  lastFeedbackSlot: number;
}

export interface ReputationResponse {
  agentId: AgentId;
  summary: ReputationSummary;
  feedback?: FeedbackEntry[];
  /** ATOM Engine analytics; absent when the agent has no initialized stats */
  atomStats?: AtomStats | null;
  network: Erc8004Network;
}

/**
 * Key-value metadata entry for agent registration
 */
export interface MetadataEntryParam {
  /** Metadata key */
  key: string;
  /** Metadata value (hex-encoded bytes or UTF-8 string) */
  value: string;
}

/**
 * Request body for POST /register
 */
export interface RegisterAgentRequest {
  /** x402 protocol version */
  x402Version: 1 | 2;
  /** Network where agent will be registered */
  network: Erc8004Network;
  /** URI pointing to agent registration file (IPFS, HTTPS) */
  agentUri: string;
  /** Optional metadata key-value pairs */
  metadata?: MetadataEntryParam[];
  /** Optional recipient address - NFT is transferred to this address after minting */
  recipient?: string;
}

/**
 * Response from POST /register
 */
export interface RegisterAgentResponse {
  /** Whether registration succeeded */
  success: boolean;
  /** The newly assigned agent ID (EVM: tokenId number, Solana: base58 pubkey string) */
  agentId?: AgentId;
  /** Registration transaction hash */
  transaction?: string;
  /** Transfer transaction hash (if recipient was specified) */
  transferTransaction?: string;
  /** Owner address of the agent NFT */
  owner?: string;
  /** Error message if failed */
  error?: string;
  /** Network where agent was registered */
  network: string;
}

/**
 * Response from GET /identity/{network}/owner/{address}
 */
export interface IdentityByOwnerResponse {
  /** First (lowest) token ID owned by this address */
  agentId: AgentId;
  /** The queried address (checksummed) */
  owner: string;
  /** Agent's registration URI (may be empty) */
  agentUri: string;
  /** Network name */
  network: string;
  /** Total number of agent NFTs owned (as string) */
  balance: string;
}

/**
 * Response from GET /identity/{network}/{agent_id}/metadata/{key}
 */
/**
 * Lifecycle of an async registration. `mint_confirmed` and `done` carry an
 * `agentId`; `failed` carries an `error`.
 */
export type RegisterJobStatus = 'pending' | 'mint_confirmed' | 'done' | 'failed';

/**
 * Status of an asynchronous registration.
 *
 * Returned by `POST /register` with `Prefer: respond-async` (HTTP 202) and by
 * `GET /register/status/{jobId}`.
 *
 * Terminal jobs are retained for one hour and then age out, after which the
 * status endpoint 404s. Read the agent id before then, or it is only
 * recoverable from the chain.
 */
export interface RegisterJobResponse {
  jobId: string;
  status: RegisterJobStatus;
  network?: string;
  agentId?: AgentId;
  transaction?: string;
  transferTransaction?: string;
  owner?: string;
  error?: string;
}

/** Whether polling can stop: the job either finished or failed. */
export function isRegisterJobTerminal(job: RegisterJobResponse): boolean {
  return job.status === 'done' || job.status === 'failed';
}

/**
 * Thrown when a registration is still running after the wait elapsed.
 *
 * This is emphatically **not** a failure. The mint may still land. `jobId` is a
 * field rather than only part of the message, because the correct recovery is to
 * keep polling `getRegisterStatus(jobId)` — and a caller who cannot reach the id
 * without parsing a string will re-register instead, minting a duplicate agent.
 * That is the exact sequence that once produced five duplicate mints.
 *
 * Never map this to "registration failed".
 */
export class RegistrationPendingError extends Error {
  readonly jobId: string;
  readonly lastStatus: RegisterJobStatus;
  readonly timeoutMs: number;
  readonly retryable = true;

  constructor(jobId: string, lastStatus: RegisterJobStatus, timeoutMs: number) {
    super(
      `Registration job ${jobId} still '${lastStatus}' after ${Math.round(
        timeoutMs / 1000,
      )}s. It may still complete: poll getRegisterStatus('${jobId}') rather than registering again.`,
    );
    this.name = 'RegistrationPendingError';
    this.jobId = jobId;
    this.lastStatus = lastStatus;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Present a finished async job in the shape the synchronous call returns.
 *
 * Keeping the return type identical is the whole point of `asyncTransport`:
 * switching transports must not force callers to rewrite anything downstream.
 */
function jobToRegisterResponse(
  job: RegisterJobResponse,
  network: Erc8004Network,
): RegisterAgentResponse {
  return {
    success: job.status !== 'failed',
    agentId: job.agentId,
    transaction: job.transaction,
    transferTransaction: job.transferTransaction,
    owner: job.owner,
    error: job.error,
    network: (job.network as Erc8004Network) ?? network,
  };
}

export interface IdentityMetadataResponse {
  /** Agent ID (EVM: number, Solana: string) */
  agentId: AgentId;
  /** Metadata key */
  key: string;
  /**
   * Raw hex-encoded value. The facilitator sends this as `value`; this field
   * used to be declared as `valueHex`, which no response ever carried, so it
   * was always undefined at runtime.
   */
  value: string;
  /** UTF-8 decoded value (if decodable) */
  valueUtf8?: string;
  /** Whether the entry can still be changed */
  immutable?: boolean;
  /** Network */
  network: string;
}

/**
 * Response from GET /identity/{network}/total-supply
 *
 * On Solana the counts come from the Metaplex Core collection, not the registry,
 * which keeps no counter of its own.
 */
export interface IdentityTotalSupplyResponse {
  /** Registered agents, net of burns */
  totalSupply: number;
  /** All-time mint count (Solana) */
  numMinted?: number;
  /** Metaplex Core collection backing the count (Solana) */
  collection?: string;
  /** Network */
  network: string;
}

/**
 * Options for the ERC8004Client
 */
export interface Erc8004ClientOptions {
  /** Base URL of the facilitator (default: https://facilitator.ultravioletadao.xyz) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Client for ERC-8004 Trustless Agents API
 *
 * Provides methods for:
 * - Registering new agents (gasless, facilitator pays gas)
 * - Registering agents on behalf of users (gasless delegation)
 * - Querying agent identity, metadata, and total supply
 * - Querying agent reputation
 * - Submitting reputation feedback
 * - Revoking feedback
 *
 * @example
 * ```ts
 * const client = new Erc8004Client();
 *
 * // Get agent identity
 * const identity = await client.getIdentity('ethereum', 42);
 * console.log(identity.agentUri);
 *
 * // Get agent reputation
 * const reputation = await client.getReputation('ethereum', 42);
 * console.log(`Score: ${reputation.summary.summaryValue}`);
 *
 * // Submit feedback after payment
 * const result = await client.submitFeedback({
 *   x402Version: 1,
 *   network: 'ethereum',
 *   feedback: {
 *     agentId: 42,
 *     value: 95,
 *     valueDecimals: 0,
 *     tag1: 'quality',
 *     proof: settleResponse.proofOfPayment,
 *   },
 * });
 * ```
 */
export class Erc8004Client {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: Erc8004ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://facilitator.ultravioletadao.xyz';
    this.timeout = options.timeout || 30000;
  }

  /**
   * Get agent identity from the Identity Registry
   *
   * @param network - Network where agent is registered
   * @param agentId - Agent's tokenId
   * @returns Agent identity information
   */
  async getIdentity(network: Erc8004Network, agentId: AgentId): Promise<AgentIdentity> {
    const url = `${this.baseUrl}/identity/${network}/${agentId}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ERC-8004 API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get agent identity by owner address
   *
   * Resolves the first ERC-8004 agent ID owned by a wallet address on a given network.
   *
   * @param network - Network to query
   * @param address - Owner wallet address
   * @returns Agent identity information including balance
   *
   * @example
   * ```ts
   * const identity = await client.getIdentityByOwner('base-mainnet', '0x52E0...');
   * console.log(`Agent #${identity.agentId}, balance: ${identity.balance}`);
   * ```
   */
  async getIdentityByOwner(network: Erc8004Network, address: string): Promise<IdentityByOwnerResponse> {
    const url = `${this.baseUrl}/identity/${network}/owner/${address}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        // 404 and 503 are different answers: "owns nothing" versus "could not
        // find out". Reading the status out of a message string is how they get
        // collapsed, and collapsing them mints a duplicate agent for an owner
        // who already has one. Carry the status as a field.
        throw new Erc8004LookupError(
          `ERC-8004 API error: ${response.status} - ${errorText}`,
          response.status,
          errorText,
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Resolve agent registration file from agentURI
   *
   * @param agentUri - URI pointing to agent registration file
   * @returns Resolved agent registration file
   */
  async resolveAgentUri(agentUri: string): Promise<AgentRegistrationFile> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Handle IPFS URIs
      let url = agentUri;
      if (agentUri.startsWith('ipfs://')) {
        const cid = agentUri.replace('ipfs://', '');
        url = `https://ipfs.io/ipfs/${cid}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to resolve agentURI: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get agent reputation from the Reputation Registry
   *
   * @param network - Network where agent is registered
   * @param agentId - Agent's tokenId
   * @param options - Query options (tag filters, include individual feedback, client addresses)
   * @param options.clientAddresses - Comma-separated client addresses to filter by.
   *   If omitted, the facilitator auto-discovers all clients via getClients().
   * @returns Reputation summary and optionally individual feedback entries
   */
  async getReputation(
    network: Erc8004Network,
    agentId: AgentId,
    options: {
      tag1?: string;
      tag2?: string;
      includeFeedback?: boolean;
      clientAddresses?: string;
    } = {}
  ): Promise<ReputationResponse> {
    const params = new URLSearchParams();
    if (options.tag1) params.set('tag1', options.tag1);
    if (options.tag2) params.set('tag2', options.tag2);
    if (options.includeFeedback) params.set('includeFeedback', 'true');
    if (options.clientAddresses) params.set('clientAddresses', options.clientAddresses);

    const url = `${this.baseUrl}/reputation/${network}/${agentId}${params.toString() ? `?${params}` : ''}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ERC-8004 API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Submit reputation feedback for an agent
   *
   * Requires proof of payment for authorized feedback submission.
   *
   * @param request - Feedback request with agent ID, value, and proof
   * @returns Feedback response with transaction hash
   *
   * @example
   * ```ts
   * // After settling a payment with ERC-8004 extension
   * const settleResult = await facilitator.settle(payment, {
   *   ...requirements,
   *   extra: { '8004-reputation': { includeProof: true } },
   * });
   *
   * // Submit feedback with proof of payment
   * const feedback = await erc8004.submitFeedback({
   *   x402Version: 1,
   *   network: 'ethereum',
   *   feedback: {
   *     agentId: 42,
   *     value: 95,  // 95/100
   *     valueDecimals: 0,
   *     tag1: 'quality',
   *     tag2: 'response-time',
   *     proof: settleResult.proofOfPayment,
   *   },
   * });
   * ```
   */
  async submitFeedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    const url = `${this.baseUrl}/feedback`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Facilitator error: ${response.status} - ${errorText}`,
          network: request.network,
        };
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        network: request.network,
      };
    }
  }

  /**
   * Revoke previously submitted feedback
   *
   * Only the original submitter can revoke their feedback.
   *
   * @param network - Network where feedback was submitted
   * @param agentId - Agent ID
   * @param feedbackIndex - Index of feedback to revoke
   * @returns Revocation result
   */
  async revokeFeedback(
    network: Erc8004Network,
    agentId: AgentId,
    feedbackIndex: number,
    options?: { sealHash?: string; originalFeedback?: Omit<FeedbackParams, 'agentId' | 'proof'> }
  ): Promise<FeedbackResponse> {
    const url = `${this.baseUrl}/feedback/revoke`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const payload: Record<string, unknown> = {
      x402Version: 1,
      network,
      agentId,
      feedbackIndex,
    };
    // Solana revocations need the SEAL hash of the feedback being revoked. Pass
    // originalFeedback and the facilitator derives it; computing it yourself
    // means reimplementing the program's keccak256 layout exactly.
    if (options?.sealHash) {
      payload.sealHash = options.sealHash;
    } else if (options?.originalFeedback) {
      payload.originalFeedback = options.originalFeedback;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Facilitator error: ${response.status} - ${errorText}`,
          network,
        };
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        network,
      };
    }
  }

  /**
   * Get ERC-8004 contract addresses for a network
   *
   * @param network - Network to get contracts for
   * @returns Contract addresses or undefined if not deployed
   */
  getContracts(network: Erc8004Network): typeof ERC8004_CONTRACTS[Erc8004Network] | undefined {
    return ERC8004_CONTRACTS[network];
  }

  /**
   * Check if ERC-8004 is available on a network
   *
   * @param network - Network to check
   * @returns True if ERC-8004 contracts are deployed
   */
  isAvailable(network: string): network is Erc8004Network {
    return network in ERC8004_CONTRACTS;
  }

  /**
   * Get feedback endpoint metadata
   *
   * @returns Endpoint information for /feedback
   */
  async getFeedbackMetadata(): Promise<{
    endpoint: string;
    supportedNetworks: Erc8004Network[];
    version: string;
  }> {
    const url = `${this.baseUrl}/feedback`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to get feedback metadata: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Append a response to existing feedback
   *
   * Allows agents to respond to feedback they received.
   * Only the agent (identity owner) can append responses.
   *
   * @param network - Network where feedback was submitted
   * @param agentId - Agent ID
   * @param feedbackIndex - Index of feedback to respond to
   * @param response - Response content
   * @param responseUri - Optional URI to off-chain response file
   * @returns Response result
   *
   * @example
   * ```ts
   * // Agent responds to feedback
   * const result = await erc8004.appendResponse(
   *   'ethereum',
   *   42,
   *   1,
   *   'Thank you for your feedback! We have addressed the issue.',
   * );
   * ```
   */
  async appendResponse(
    network: Erc8004Network,
    agentId: AgentId,
    feedbackIndex: number,
    response: string,
    options?: { responseUri?: string; sealHash?: string }
  ): Promise<FeedbackResponse> {
    const url = `${this.baseUrl}/feedback/response`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const payload: Record<string, unknown> = {
      x402Version: 1,
      network,
      agentId,
      feedbackIndex,
      response,
    };
    if (options?.responseUri) {
      payload.responseUri = options.responseUri;
    }
    if (options?.sealHash) {
      payload.sealHash = options.sealHash;
    }

    try {
      const fetchResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        return {
          success: false,
          error: `Facilitator error: ${fetchResponse.status} - ${errorText}`,
          network,
        };
      }

      return await fetchResponse.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        network,
      };
    }
  }

  /**
   * Register an agent on the Identity Registry (idempotent)
   *
   * If the recipient already owns an agent on the target network, returns the
   * existing one instead of minting a duplicate. The facilitator pays gas fees.
   * Optionally transfer the NFT to a recipient address (gasless delegation).
   *
   * @param request - Registration request
   * @returns Registration response with agent ID and transaction hash
   *
   * @example
   * ```ts
   * // Register agent owned by facilitator
   * const result = await client.registerAgent({
   *   x402Version: 1,
   *   network: 'ethereum',
   *   agentUri: 'ipfs://QmYourAgentFile',
   * });
   * console.log(`Agent #${result.agentId} registered`);
   *
   * // Register agent and transfer to user
   * const result = await client.registerAgent({
   *   x402Version: 1,
   *   network: 'ethereum',
   *   agentUri: 'ipfs://QmYourAgentFile',
   *   recipient: '0xUserAddress...',
   * });
   * console.log(`Agent #${result.agentId} transferred to user`);
   * ```
   */
  async registerAgent(
    request: RegisterAgentRequest,
    options?: { asyncTransport?: boolean; pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<RegisterAgentResponse> {
    // asyncTransport changes how the wait is carried out, not what comes back.
    // The synchronous call holds one HTTP request open for the whole mint, which
    // on a congested chain outlives proxy timeouts; each poll here is short, so
    // nothing in the path can time out ambiguously.
    if (options?.asyncTransport) {
      const job = await this.registerAgentAsync(request);
      const terminal = await this.waitForRegistration(job.jobId, {
        pollIntervalMs: options.pollIntervalMs,
        timeoutMs: options.timeoutMs,
      });
      return jobToRegisterResponse(terminal, request.network);
    }

    const url = `${this.baseUrl}/register`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        // The facilitator answers 4xx with a structured RegisterAgentResponse,
        // and on 409 - a registration for this agent is ALREADY IN FLIGHT -
        // that body carries the agent id and tx of the run already underway,
        // plus an explicit "poll GET /register/status/{jobId}" hint.
        //
        // Flattening it into a bare string threw away the only thing that lets
        // a caller resolve instead of re-POSTing, and re-POSTing a mint is
        // exactly how duplicate agents get created. Keep the body.
        try {
          const parsed = JSON.parse(errorText) as RegisterAgentResponse;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
              ...parsed,
              // Never let a 4xx body claim success, whatever it says.
              success: false,
              error: parsed.error ?? `Facilitator error: ${response.status}`,
              network: parsed.network ?? request.network,
            };
          }
        } catch {
          // Not JSON - fall through to the flattened error.
        }
        return {
          success: false,
          error: `Facilitator error: ${response.status} - ${errorText}`,
          network: request.network,
        };
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        network: request.network,
      };
    }
  }

  /**
   * Start a registration without waiting for the chain to confirm it.
   *
   * Registration waits on a mint receipt, which on a congested chain outlives
   * client and proxy timeouts. A timed-out synchronous call is genuinely
   * ambiguous — the mint may well have landed — and retrying it is how five
   * duplicate agents once got minted. This returns immediately with a job id
   * instead; poll {@link getRegisterStatus} or use {@link waitForRegistration}.
   *
   * On Solana, `recipient` is a base58 address: the facilitator mints,
   * initializes the ATOM stats and transfers, paying every fee.
   */
  async registerAgentAsync(request: RegisterAgentRequest): Promise<RegisterJobResponse> {
    const url = `${this.baseUrl}/register`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Prefer': 'respond-async',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Erc8004LookupError(
          `ERC-8004 API error: ${response.status} - ${errorText}`,
          response.status,
          errorText,
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Read the current state of an asynchronous registration.
   *
   * Throws {@link Erc8004LookupError} with `notFound` when the job is unknown or
   * has aged out — terminal jobs are kept for one hour.
   */
  async getRegisterStatus(jobId: string): Promise<RegisterJobResponse> {
    const url = `${this.baseUrl}/register/status/${encodeURIComponent(jobId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Erc8004LookupError(
          `ERC-8004 API error: ${response.status} - ${errorText}`,
          response.status,
          errorText,
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Poll an asynchronous registration until it finishes.
   *
   * Rejects on timeout rather than resolving with the last non-terminal status,
   * so "still pending" is never mistaken for "did not happen": the mint may
   * still land afterwards, and treating a timeout as failure is what leads to
   * registering the same agent twice. Keep the job id and poll again rather
   * than re-registering.
   */
  async waitForRegistration(
    jobId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<RegisterJobResponse> {
    const pollIntervalMs = options?.pollIntervalMs ?? 2000;
    const timeoutMs = options?.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await this.getRegisterStatus(jobId);
      if (isRegisterJobTerminal(job)) {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new RegistrationPendingError(jobId, job.status, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Get registration endpoint metadata
   *
   * @returns Endpoint information for POST /register
   */
  async getRegisterInfo(): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/register`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ERC-8004 API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get a specific metadata entry for an agent
   *
   * @param network - Network where agent is registered
   * @param agentId - Agent's tokenId
   * @param key - Metadata key to retrieve
   * @returns Metadata value (hex-encoded and UTF-8 decoded if possible)
   */
  async getIdentityMetadata(
    network: Erc8004Network,
    agentId: AgentId,
    key: string,
  ): Promise<IdentityMetadataResponse> {
    const url = `${this.baseUrl}/identity/${network}/${agentId}/metadata/${encodeURIComponent(key)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ERC-8004 API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get total number of registered agents on a network
   *
   * @param network - Network to query
   * @returns Total supply count
   */
  async getIdentityTotalSupply(network: Erc8004Network): Promise<IdentityTotalSupplyResponse> {
    const url = `${this.baseUrl}/identity/${network}/total-supply`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ERC-8004 API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

/**
 * Build payment requirements with ERC-8004 extension
 *
 * Adds the 8004-reputation extension to include proof of payment
 * in settlement responses for reputation submission.
 *
 * @param options - Base payment requirements options
 * @returns Payment requirements with ERC-8004 extension
 *
 * @example
 * ```ts
 * const requirements = buildErc8004PaymentRequirements({
 *   amount: '1.00',
 *   recipient: '0x...',
 *   resource: 'https://api.example.com/service',
 *   chainName: 'ethereum',
 * });
 *
 * // Settlement will include proofOfPayment
 * const result = await facilitator.settle(payment, requirements);
 * console.log(result.proofOfPayment);
 * ```
 */
export function buildErc8004PaymentRequirements(
  options: PaymentRequirementsOptions
): PaymentRequirements & { extra: { '8004-reputation': { includeProof: boolean } } } {
  const base = buildPaymentRequirements(options);
  return {
    ...base,
    extra: {
      [ERC8004_EXTENSION_ID]: {
        includeProof: true,
      },
    },
  };
}

// ============================================================================
// ADVANCED ESCROW (PaymentOperator - On-Chain Escrow)
// ============================================================================
//
// The 5 Advanced Escrow flows via the PaymentOperator contract:
// 1. AUTHORIZE          - Lock funds in escrow (via facilitator)
// 2. RELEASE            - Capture escrowed funds to receiver (on-chain)
// 3. REFUND IN ESCROW   - Return escrowed funds to payer (on-chain)
// 4. CHARGE             - Direct instant payment without escrow (on-chain)
// 5. REFUND POST ESCROW - Dispute refund after release (on-chain)
//
// Contract mapping:
//   operator.authorize()        -> escrow.authorize()   (lock funds)
//   operator.release()          -> escrow.capture()      (pay receiver)
//   operator.refundInEscrow()   -> escrow.partialVoid()  (refund payer)
//   operator.charge()           -> escrow.charge()       (direct payment)
//   operator.refundPostEscrow() -> escrow.refund()       (dispute refund)
// ============================================================================

/**
 * PAYMENT_INFO_TYPEHASH used for nonce computation.
 * Must match the on-chain AuthCaptureEscrow contract.
 */
export const PAYMENT_INFO_TYPEHASH =
  '0xae68ac7ce30c86ece8196b61a7c486d8f0061f575037fbd34e7fe4e2820c6591';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Contract deposit limit (enforced by PaymentOperator condition).
 * As of 2026-02-03, commerce-payments contracts enforce $100 max per deposit.
 */
export const DEPOSIT_LIMIT_USDC = '100000000'; // $100 in atomic units (6 decimals)

/**
 * Default facilitator request timeout per chain in milliseconds.
 * Ethereum L1 (~12s blocks) needs much longer than L2s (~2s blocks).
 * Timeout chain: Client > SDK > Facilitator. The facilitator uses 900s for Ethereum L1.
 */
export const ESCROW_TIMEOUT_MS: Record<number, number> = {
  1: 960_000,         // Ethereum L1: 960s (facilitator uses 900s TxWatcher)
  11155111: 960_000,  // Ethereum Sepolia: same as L1
  137: 90_000,        // Polygon: 90s
  8453: 90_000,       // Base: 90s
  84532: 90_000,      // Base Sepolia: 90s
  42161: 90_000,      // Arbitrum: 90s
  10: 90_000,         // Optimism: 90s
  43114: 90_000,      // Avalanche: 90s
  42220: 90_000,      // Celo: 90s
  143: 90_000,        // Monad: 90s
};

/** Default timeout when chain is not in ESCROW_TIMEOUT_MS */
const DEFAULT_ESCROW_TIMEOUT_MS = 30_000;

/**
 * USDC EIP-712 domain name per chain.
 * Most chains use "USD Coin", but some (Celo, Monad, HyperEVM) use "USDC".
 * This must match the on-chain token's name() for EIP-712 signing to work.
 */
export const USDC_DOMAIN_NAME: Record<number, string> = {
  8453: 'USD Coin',       // Base Mainnet
  84532: 'USD Coin',      // Base Sepolia
  1: 'USD Coin',          // Ethereum Mainnet
  11155111: 'USD Coin',   // Ethereum Sepolia
  137: 'USD Coin',        // Polygon
  42161: 'USD Coin',      // Arbitrum
  43114: 'USD Coin',      // Avalanche
  42220: 'USDC',          // Celo
  143: 'USDC',            // Monad
};

/**
 * Multi-chain escrow contract addresses for the Advanced Escrow system.
 * Keyed by EVM chain ID. Source: x402r-sdk A1igator/multichain-config deployment.
 */
export const ESCROW_CONTRACTS: Record<number, AdvancedEscrowContracts> = {
  // Base Sepolia (testnet, chain 84532)
  84532: {
    operator: '0x97d53e63A9CB97556c00BeFd325AF810c9b267B2',
    escrow: '0x29025c0E9D4239d438e169570818dB9FE0A80873',
    tokenCollector: '0x5cA789000070DF15b4663DB64a50AeF5D49c5Ee0',
    protocolFeeConfig: '0x8F96C493bAC365E41f0315cf45830069EBbDCaCe',
    refundRequest: '0x1C2Ab244aC8bDdDB74d43389FF34B118aF2E90F4',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // Base Mainnet (chain 8453)
  8453: {
    operator: '0x3D0837fF8Ea36F417261577b9BA568400A840260',
    escrow: '0xb9488351E48b23D798f24e8174514F28B741Eb4f',
    tokenCollector: '0x48ADf6E37F9b31dC2AAD0462C5862B5422C736B8',
    protocolFeeConfig: '0x59314674BAbb1a24Eb2704468a9cCdD50668a1C6',
    refundRequest: '0x35fb2EFEfAc3Ee9f6E52A9AAE5C9655bC08dEc00',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  // Ethereum Sepolia (testnet, chain 11155111)
  11155111: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  // Ethereum Mainnet (chain 1) - Updated from Ali's redeploy (commit e6cf29d)
  1: {
    operator: '0x69B67962ffb7c5C7078ff348a87DF604dfA8001b',
    escrow: '0x9D4146EF898c8E60B3e865AE254ef438E7cEd2A0',
    tokenCollector: '0x206D4DbB6E7b876e4B5EFAAD2a04e7d7813FB6ba',
    protocolFeeConfig: '0x5b3e33791C1764cF7e2573Bf8116F1D361FD97Cd',
    refundRequest: '0xFa8C4Cb156053b867Ae7489220A29b5939E3Df70',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  // Polygon (chain 137)
  137: {
    operator: '0xb33D6502EdBbC47201cd1E53C49d703EC0a660b8',
    escrow: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    tokenCollector: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    protocolFeeConfig: '0xE78648e7af7B1BaDE717FF6E410B922F92adE80f',
    refundRequest: '0xed02d3E5167BCc9582D851885A89b050AB816a56',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  // Arbitrum (chain 42161)
  42161: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  // Celo (chain 42220)
  42220: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  },
  // Monad (chain 143)
  143: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x754704Bc059F8C67012fEd69BC8a327a5aafb603',
  },
  // Avalanche (chain 43114)
  43114: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  // Optimism (chain 10)
  10: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  // SKALE Base (chain 1187947933) - CREATE3 deployment, operator via factory
  1187947933: {
    operator: '0x28c23AE8f55aDe5Ea10a5353FC40418D0c1B3d33',
    escrow: '0xBC151792f80C0EB1973d56b0235e6bee2A60e245',
    tokenCollector: '0x9A12A116a44636F55c9e135189A1321Abcfe2f30',
    protocolFeeConfig: '0xf62788834C99B2E85a6891C0b46D1EB996f8f596',
    refundRequest: '0x69e9BF2b40Ed472b55E47e9D4205d93Ed673093F',
    usdc: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  },
};

/**
 * Base Mainnet contract addresses for the Advanced Escrow system.
 * @deprecated Use ESCROW_CONTRACTS[8453] or getEscrowContractsByChainId(8453) instead.
 */
export const BASE_MAINNET_CONTRACTS: AdvancedEscrowContracts = ESCROW_CONTRACTS[8453];

/**
 * Get escrow contract addresses for a given chain ID.
 *
 * @param chainId - EVM chain ID (e.g., 8453 for Base, 1 for Ethereum)
 * @returns Contract addresses or undefined if chain is not supported
 */
export function getEscrowContractsByChainId(chainId: number): AdvancedEscrowContracts | undefined {
  return ESCROW_CONTRACTS[chainId];
}

/**
 * Get all chain IDs that have escrow contracts deployed.
 *
 * @returns Array of chain IDs with escrow support
 */
export function getEscrowSupportedChainIds(): number[] {
  return Object.keys(ESCROW_CONTRACTS).map(Number);
}

/**
 * Check if escrow contracts are deployed on a given chain.
 *
 * @param chainId - EVM chain ID
 * @returns True if escrow is supported on this chain
 */
export function isEscrowSupportedOnChain(chainId: number): boolean {
  return chainId in ESCROW_CONTRACTS;
}

/**
 * Task tiers determine timing parameters for escrow operations.
 */
export type AdvancedEscrowTaskTier = 'micro' | 'standard' | 'premium' | 'enterprise';

/**
 * Timing configuration per task tier (in seconds).
 */
export const TIER_TIMINGS: Record<AdvancedEscrowTaskTier, { pre: number; auth: number; refund: number }> = {
  micro:      { pre: 3600,   auth: 7200,    refund: 86400 },
  standard:   { pre: 7200,   auth: 86400,   refund: 604800 },
  premium:    { pre: 14400,  auth: 172800,  refund: 1209600 },
  enterprise: { pre: 86400,  auth: 604800,  refund: 2592000 },
};

/**
 * PaymentInfo struct matching the on-chain PaymentOperator contract.
 */
export interface AdvancedPaymentInfo {
  operator: string;
  receiver: string;
  token: string;
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string;
  salt: string;
}

/**
 * Result of an AUTHORIZE operation.
 */
export interface AdvancedAuthorizationResult {
  success: boolean;
  transactionHash?: string;
  paymentInfo?: AdvancedPaymentInfo;
  salt?: string;
  error?: string;
}

/**
 * Result of an on-chain transaction (release, refund, charge).
 */
export interface AdvancedTransactionResult {
  success: boolean;
  transactionHash?: string;
  gasUsed?: number;
  error?: string;
}

/**
 * Response from the facilitator's /escrow/state endpoint.
 * Represents the on-chain state of an escrow for a given paymentInfo + payer.
 */
export interface EscrowStateResponse {
  /** Whether the payment has already been collected (released) */
  hasCollectedPayment: boolean;
  /** Amount that can still be captured/released (in atomic units) */
  capturableAmount: string;
  /** Amount that can still be refunded to the payer (in atomic units) */
  refundableAmount: string;
  /** Keccak256 hash of the paymentInfo struct */
  paymentInfoHash: string;
  /** Network in CAIP-2 format (e.g., "eip155:8453") */
  network: string;
}

/**
 * Contract addresses configuration for AdvancedEscrowClient.
 *
 * Maps to the on-chain x402r escrow contracts:
 * - operator: PaymentOperatorFactory
 * - escrow: AuthCaptureEscrow
 * - tokenCollector: TokenCollector
 * - protocolFeeConfig: ProtocolFeeConfig
 * - refundRequest: RefundRequest
 * - usdc: USDC token contract
 */
export interface AdvancedEscrowContracts {
  /** PaymentOperatorFactory contract address */
  operator: string;
  /** AuthCaptureEscrow contract address */
  escrow: string;
  /** TokenCollector contract address */
  tokenCollector: string;
  /** ProtocolFeeConfig contract address */
  protocolFeeConfig: string;
  /** RefundRequest contract address */
  refundRequest: string;
  /** USDC token contract address */
  usdc: string;
}

/**
 * Configuration options for AdvancedEscrowClient.
 */
export interface AdvancedEscrowClientOptions {
  /** Facilitator URL for AUTHORIZE operations */
  facilitatorUrl?: string;
  /** JSON-RPC URL for on-chain operations (required when using SigningWalletAdapter) */
  rpcUrl?: string;
  /**
   * Chain ID (default: 8453 for Base Mainnet).
   * Supported chains: 8453 (Base), 84532 (Base Sepolia), 1 (Ethereum),
   * 11155111 (Ethereum Sepolia), 137 (Polygon), 42161 (Arbitrum),
   * 10 (Optimism), 42220 (Celo), 143 (Monad), 43114 (Avalanche).
   */
  chainId?: number;
  /** Contract addresses (auto-resolved from chainId if not provided) */
  contracts?: AdvancedEscrowContracts;
  /** Gas limit for transactions (default: 300000) */
  gasLimit?: number;
  /**
   * Request timeout in milliseconds for facilitator HTTP calls (authorize, gasless release/refund).
   * Default is per-network: 960s for Ethereum L1, 90s for L2s.
   * Ethereum L1 confirmations can take several minutes under congestion.
   */
  timeout?: number;
  /**
   * SigningWalletAdapter for OWS wallet signing (v2.36.0+).
   *
   * When provided, the client uses the adapter for all signing operations
   * instead of requiring a raw ethers.Signer. The first constructor argument
   * is ignored when `wallet` is set.
   *
   * Requires `rpcUrl` to be set for on-chain transaction building.
   *
   * @example
   * ```typescript
   * import { OWSWalletAdapter, AdvancedEscrowClient } from 'uvd-x402-sdk/backend';
   *
   * const wallet = new OWSWalletAdapter(owsWallet);
   * const client = new AdvancedEscrowClient(null, {
   *   wallet,
   *   rpcUrl: 'https://mainnet.base.org',
   *   chainId: 8453,
   * });
   * ```
   */
  wallet?: import('../wallet').SigningWalletAdapter;
}

/**
 * Minimal PaymentOperator ABI for the 4 on-chain functions.
 * (AUTHORIZE goes through the facilitator, not directly on-chain)
 */
export const OPERATOR_ABI = [
  'function release(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount)',
  'function refundInEscrow(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint120 amount)',
  'function charge(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)',
  'function refundPostEscrow(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)',
];

/**
 * CREATE3-deployed operators (SKALE, future chains) use updated ABI with extra `bytes data` param
 * on release() and refundInEscrow(). Pass empty bytes (0x) for the data parameter.
 */
export const OPERATOR_ABI_CREATE3 = [
  'function release(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount, bytes data)',
  'function refundInEscrow(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint120 amount, bytes data)',
  'function charge(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)',
  'function refundPostEscrow(tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)',
];

/** Chain IDs using CREATE3-deployed operators with updated ABI */
const CREATE3_CHAIN_IDS = new Set([1187947933]);

/**
 * AdvancedEscrowClient provides the 5 Advanced Escrow flows via the
 * PaymentOperator contract on 9 supported EVM networks.
 *
 * Supported chains: Base (8453), Base Sepolia (84532), Ethereum (1),
 * Ethereum Sepolia (11155111), Polygon (137), Arbitrum (42161),
 * Optimism (10), Celo (42220), Monad (143), Avalanche (43114).
 *
 * Contract addresses are auto-resolved from the chain ID.
 * Pass custom contracts to override.
 *
 * Two signer modes (v2.36.0+):
 * - **Legacy**: Pass an ethers.Signer as the first argument.
 * - **OWS Wallet**: Pass a SigningWalletAdapter via `options.wallet`.
 *   The adapter signs transactions offline (no raw private key needed).
 *   Requires `rpcUrl` for transaction building and broadcast.
 *
 * @example Legacy mode (ethers.Signer)
 * ```typescript
 * import { ethers } from 'ethers';
 * import { AdvancedEscrowClient } from 'uvd-x402-sdk/backend';
 *
 * const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
 * const signer = new ethers.Wallet(process.env.KEY!, provider);
 * const client = new AdvancedEscrowClient(signer, { chainId: 8453 });
 * ```
 *
 * @example OWS Wallet mode (SigningWalletAdapter)
 * ```typescript
 * import { OWSWalletAdapter } from 'uvd-x402-sdk';
 * import { AdvancedEscrowClient } from 'uvd-x402-sdk/backend';
 *
 * const wallet = new OWSWalletAdapter(owsWallet);
 * const client = new AdvancedEscrowClient(null, {
 *   wallet,
 *   rpcUrl: 'https://mainnet.base.org',
 *   chainId: 8453,
 * });
 * await client.init();
 *
 * const pi = client.buildPaymentInfo('0xWorker...', '5000000', 'standard');
 * const auth = await client.authorize(pi);
 * const release = await client.release(pi);
 * ```
 */
export class AdvancedEscrowClient {
  private facilitatorUrl: string;
  private chainId: number;
  private gasLimit: number;
  private readonly timeout: number;
  private contracts: AdvancedEscrowContracts;
  private signer: any; // ethers.Signer (legacy mode)
  private walletAdapter: import('../wallet').SigningWalletAdapter | null; // OWS mode (v2.36.0+)
  private rpcUrl: string | undefined;
  private payerAddress: string = '';

  /**
   * Create an AdvancedEscrowClient.
   *
   * Two modes of operation:
   *
   * 1. **Legacy (ethers.Signer)**: Pass an ethers Signer as the first argument.
   *    ```ts
   *    const client = new AdvancedEscrowClient(signer, { rpcUrl, chainId });
   *    ```
   *
   * 2. **OWS Wallet (SigningWalletAdapter)**: Pass `wallet` in options. The
   *    first argument is ignored (pass `null`). Requires `rpcUrl` for on-chain
   *    transaction building and broadcast.
   *    ```ts
   *    const wallet = new OWSWalletAdapter(owsWallet);
   *    const client = new AdvancedEscrowClient(null, { wallet, rpcUrl, chainId });
   *    ```
   *
   * @param signer - ethers.Signer instance (ignored when options.wallet is set)
   * @param options - Configuration options
   */
  constructor(signer: any, options: AdvancedEscrowClientOptions = {}) {
    this.walletAdapter = options.wallet || null;
    this.signer = this.walletAdapter ? null : signer;
    this.rpcUrl = options.rpcUrl;
    this.facilitatorUrl = (options.facilitatorUrl || 'https://facilitator.ultravioletadao.xyz').replace(/\/$/, '');
    this.chainId = options.chainId || 8453;
    this.gasLimit = options.gasLimit || 300000;
    this.timeout = options.timeout || ESCROW_TIMEOUT_MS[this.chainId] || DEFAULT_ESCROW_TIMEOUT_MS;

    if (this.walletAdapter && !this.rpcUrl) {
      throw new Error(
        'AdvancedEscrowClient: rpcUrl is required when using a SigningWalletAdapter. ' +
        'The adapter signs transactions offline; an RPC provider is needed to build ' +
        'and broadcast them.'
      );
    }

    if (options.contracts) {
      this.contracts = options.contracts;
    } else {
      const resolved = ESCROW_CONTRACTS[this.chainId];
      if (!resolved) {
        throw new Error(
          `No escrow contracts found for chain ID ${this.chainId}. ` +
          `Supported chains: ${getEscrowSupportedChainIds().join(', ')}. ` +
          `Pass custom contracts via options.contracts to use an unsupported chain.`
        );
      }
      this.contracts = resolved;
    }
  }

  /**
   * Initialize the client (resolves payer address).
   * Call this before using any methods.
   */
  async init(): Promise<void> {
    if (this.walletAdapter) {
      this.payerAddress = this.walletAdapter.getAddress();
    } else {
      this.payerAddress = await this.signer.getAddress();
    }
  }

  /**
   * Build a PaymentInfo struct with appropriate timing for the task tier.
   *
   * @param receiver - Worker's wallet address
   * @param amount - Amount in token atomic units (e.g., '5000000' for $5 USDC)
   * @param tier - Task tier determines timing parameters
   * @param salt - Random salt (auto-generated if not provided)
   */
  buildPaymentInfo(
    receiver: string,
    amount: string,
    tier: AdvancedEscrowTaskTier = 'standard',
    salt?: string,
  ): AdvancedPaymentInfo {
    const now = Math.floor(Date.now() / 1000);
    const t = TIER_TIMINGS[tier];
    // Use crypto-safe randomness (Node.js crypto or Web Crypto API)
    let generatedSalt = salt;
    if (!generatedSalt) {
      const bytes = new Uint8Array(32);
      if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
      } else {
        // Node.js fallback
        const nodeCrypto = require('crypto');
        const buf = nodeCrypto.randomBytes(32);
        bytes.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      }
      generatedSalt = '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    return {
      operator: this.contracts.operator,
      receiver,
      token: this.contracts.usdc,
      maxAmount: amount,
      preApprovalExpiry: now + t.pre,
      authorizationExpiry: now + t.auth,
      refundExpiry: now + t.refund,
      minFeeBps: 0,
      maxFeeBps: 800,
      feeReceiver: this.contracts.operator,
      salt: generatedSalt,
    };
  }

  /**
   * Compute the correct nonce (with PAYMENT_INFO_TYPEHASH).
   * Matches the on-chain AuthCaptureEscrow nonce derivation.
   */
  private async computeNonce(paymentInfo: AdvancedPaymentInfo): Promise<string> {
    // Dynamic import of ethers to avoid hard dependency at module level
    const { ethers } = await import('ethers');

    const piTuple = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'tuple(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)'],
      [
        PAYMENT_INFO_TYPEHASH,
        [
          paymentInfo.operator,
          ZERO_ADDRESS, // payer = 0 for payer-agnostic hash
          paymentInfo.receiver,
          paymentInfo.token,
          paymentInfo.maxAmount,
          paymentInfo.preApprovalExpiry,
          paymentInfo.authorizationExpiry,
          paymentInfo.refundExpiry,
          paymentInfo.minFeeBps,
          paymentInfo.maxFeeBps,
          paymentInfo.feeReceiver,
          paymentInfo.salt,
        ],
      ],
    );
    const piHash = ethers.keccak256(piTuple);

    const finalEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32'],
      [this.chainId, this.contracts.escrow, piHash],
    );
    return ethers.keccak256(finalEncoded);
  }

  /**
   * Sign ReceiveWithAuthorization for ERC-3009.
   *
   * Uses SigningWalletAdapter.signTypedData() when in OWS mode,
   * or ethers Signer.signTypedData() in legacy mode.
   */
  private async signErc3009(auth: Record<string, string>): Promise<string> {
    const domain = {
      name: USDC_DOMAIN_NAME[this.chainId] || 'USD Coin',
      version: '2',
      chainId: this.chainId,
      verifyingContract: this.contracts.usdc,
    };

    const types = {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    const message = {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    };

    // OWS wallet adapter mode: serialize to JSON and use adapter.signTypedData()
    if (this.walletAdapter) {
      const typedData = JSON.stringify({
        domain,
        types,
        primaryType: 'ReceiveWithAuthorization',
        message,
      });
      const result = await this.walletAdapter.signTypedData(typedData);
      return result.signature;
    }

    // Legacy ethers.Signer mode
    return this.signer.signTypedData(domain, types, message);
  }

  /**
   * Build the on-chain PaymentInfo tuple for contract calls.
   */
  private buildTuple(pi: AdvancedPaymentInfo): any[] {
    return [
      pi.operator,
      this.payerAddress,
      pi.receiver,
      pi.token,
      pi.maxAmount,
      pi.preApprovalExpiry,
      pi.authorizationExpiry,
      pi.refundExpiry,
      pi.minFeeBps,
      pi.maxFeeBps,
      pi.feeReceiver,
      pi.salt,
    ];
  }

  /**
   * AUTHORIZE: Lock funds in escrow via the facilitator.
   *
   * Sends an ERC-3009 ReceiveWithAuthorization to the facilitator,
   * which calls PaymentOperator.authorize() on-chain.
   */
  async authorize(paymentInfo: AdvancedPaymentInfo): Promise<AdvancedAuthorizationResult> {
    if (!this.payerAddress) await this.init();

    try {
      const nonce = await this.computeNonce(paymentInfo);

      const auth = {
        from: this.payerAddress,
        to: this.contracts.tokenCollector,
        value: paymentInfo.maxAmount,
        validAfter: '0',
        validBefore: String(paymentInfo.preApprovalExpiry),
        nonce,
      };
      const signature = await this.signErc3009(auth);

      const payload = {
        x402Version: 2,
        scheme: 'escrow',
        payload: {
          authorization: auth,
          signature,
          paymentInfo: paymentInfo,
        },
        paymentRequirements: {
          scheme: 'escrow',
          network: `eip155:${this.chainId}`,
          maxAmountRequired: paymentInfo.maxAmount,
          asset: this.contracts.usdc,
          payTo: paymentInfo.receiver,
          extra: {
            escrowAddress: this.contracts.escrow,
            operatorAddress: this.contracts.operator,
            tokenCollector: this.contracts.tokenCollector,
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.facilitatorUrl}/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const result = await response.json();

        if (result.success) {
          return {
            success: true,
            transactionHash: result.transaction,
            paymentInfo,
            salt: paymentInfo.salt,
          };
        }
        return { success: false, error: result.errorReason };
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);

        // On timeout, check on-chain state as fallback
        if (fetchErr.name === 'AbortError') {
          try {
            const state = await this.queryEscrowState(paymentInfo);
            if (state.capturableAmount && BigInt(state.capturableAmount) > 0n) {
              return {
                success: true,
                paymentInfo,
                salt: paymentInfo.salt,
              };
            }
          } catch { /* fallback query failed, report original timeout */ }
          return { success: false, error: `Authorize timed out after ${this.timeout}ms. On-chain state could not confirm escrow lock.` };
        }
        throw fetchErr;
      }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * RELEASE: Capture escrowed funds to receiver (worker gets paid).
   *
   * Calls PaymentOperator.release() -> escrow.capture()
   *
   * @param paymentInfo - PaymentInfo from the authorize step
   * @param amount - Amount to release (defaults to maxAmount)
   */
  async release(paymentInfo: AdvancedPaymentInfo, amount?: string): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const { ethers } = await import('ethers');
      const isCreate3 = CREATE3_CHAIN_IDS.has(this.chainId);
      const abi = isCreate3 ? OPERATOR_ABI_CREATE3 : OPERATOR_ABI;
      const amt = amount || paymentInfo.maxAmount;
      const tuple = this.buildTuple(paymentInfo);

      // OWS wallet adapter mode: build unsigned TX, sign via adapter, broadcast
      if (this.walletAdapter) {
        return this.sendViaAdapter(ethers, abi, (iface) => {
          return isCreate3
            ? iface.encodeFunctionData('release', [tuple, amt, '0x'])
            : iface.encodeFunctionData('release', [tuple, amt]);
        });
      }

      // Legacy ethers.Signer mode: contract sends directly
      const contract = new ethers.Contract(this.contracts.operator, abi, this.signer);
      const tx = isCreate3
        ? await contract.release(tuple, amt, '0x', { gasLimit: this.gasLimit })
        : await contract.release(tuple, amt, { gasLimit: this.gasLimit });
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        transactionHash: receipt.hash,
        gasUsed: Number(receipt.gasUsed),
        error: receipt.status !== 1 ? 'Transaction reverted' : undefined,
      };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * REFUND IN ESCROW: Return escrowed funds to payer (cancel task).
   *
   * Calls PaymentOperator.refundInEscrow() -> escrow.partialVoid()
   *
   * @param paymentInfo - PaymentInfo from the authorize step
   * @param amount - Amount to refund (defaults to maxAmount)
   */
  async refundInEscrow(paymentInfo: AdvancedPaymentInfo, amount?: string): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const { ethers } = await import('ethers');
      const isCreate3 = CREATE3_CHAIN_IDS.has(this.chainId);
      const abi = isCreate3 ? OPERATOR_ABI_CREATE3 : OPERATOR_ABI;
      const amt = amount || paymentInfo.maxAmount;
      const tuple = this.buildTuple(paymentInfo);

      // OWS wallet adapter mode: build unsigned TX, sign via adapter, broadcast
      if (this.walletAdapter) {
        return this.sendViaAdapter(ethers, abi, (iface) => {
          return isCreate3
            ? iface.encodeFunctionData('refundInEscrow', [tuple, amt, '0x'])
            : iface.encodeFunctionData('refundInEscrow', [tuple, amt]);
        });
      }

      // Legacy ethers.Signer mode
      const contract = new ethers.Contract(this.contracts.operator, abi, this.signer);
      const tx = isCreate3
        ? await contract.refundInEscrow(tuple, amt, '0x', { gasLimit: this.gasLimit })
        : await contract.refundInEscrow(tuple, amt, { gasLimit: this.gasLimit });
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        transactionHash: receipt.hash,
        gasUsed: Number(receipt.gasUsed),
        error: receipt.status !== 1 ? 'Transaction reverted' : undefined,
      };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  // ==========================================================================
  // GASLESS FACILITATOR METHODS
  // ==========================================================================

  /**
   * GASLESS RELEASE: Release escrowed funds via the facilitator.
   *
   * Instead of calling the PaymentOperator contract directly (which requires
   * gas), this sends a release request to the facilitator, which submits
   * the transaction on your behalf.
   *
   * @param paymentInfo - PaymentInfo from the authorize step
   * @param amount - Amount to release in atomic units (defaults to maxAmount)
   * @returns Transaction result from the facilitator
   *
   * @example
   * ```typescript
   * const pi = client.buildPaymentInfo('0xWorker...', '5000000', 'standard');
   * await client.authorize(pi);
   * // Worker completes task...
   * const result = await client.releaseViaFacilitator(pi);
   * console.log(result.transactionHash);
   * ```
   */
  async releaseViaFacilitator(
    paymentInfo: AdvancedPaymentInfo,
    amount?: string,
  ): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const payload = {
        x402Version: 2,
        scheme: 'escrow',
        action: 'release',
        payload: {
          paymentInfo: {
            operator: paymentInfo.operator,
            receiver: paymentInfo.receiver,
            token: paymentInfo.token,
            maxAmount: paymentInfo.maxAmount,
            preApprovalExpiry: paymentInfo.preApprovalExpiry,
            authorizationExpiry: paymentInfo.authorizationExpiry,
            refundExpiry: paymentInfo.refundExpiry,
            minFeeBps: paymentInfo.minFeeBps,
            maxFeeBps: paymentInfo.maxFeeBps,
            feeReceiver: paymentInfo.feeReceiver,
            salt: paymentInfo.salt,
          },
          payer: this.payerAddress,
          amount: amount || paymentInfo.maxAmount,
        },
        paymentRequirements: {
          scheme: 'escrow',
          network: `eip155:${this.chainId}`,
          extra: {
            escrowAddress: this.contracts.escrow,
            operatorAddress: this.contracts.operator,
            tokenCollector: this.contracts.tokenCollector,
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.facilitatorUrl}/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const result = await response.json();

        if (result.success) {
          return {
            success: true,
            transactionHash: result.transaction || result.transactionHash || result.transaction_hash,
          };
        }
        return { success: false, error: result.errorReason || result.error || 'Release failed' };
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);

        // On timeout, check on-chain state as fallback
        if (fetchErr.name === 'AbortError') {
          try {
            const state = await this.queryEscrowState(paymentInfo);
            if (state.capturableAmount === '0' && state.hasCollectedPayment) {
              return { success: true };
            }
          } catch { /* fallback query failed */ }
          return { success: false, error: `Gasless release timed out after ${this.timeout}ms. Check escrow state on-chain.` };
        }
        throw fetchErr;
      }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * GASLESS REFUND: Refund escrowed funds via the facilitator.
   *
   * Instead of calling the PaymentOperator contract directly (which requires
   * gas), this sends a refundInEscrow request to the facilitator, which
   * submits the transaction on your behalf.
   *
   * @param paymentInfo - PaymentInfo from the authorize step
   * @param amount - Amount to refund in atomic units (defaults to maxAmount)
   * @returns Transaction result from the facilitator
   *
   * @example
   * ```typescript
   * const pi = client.buildPaymentInfo('0xWorker...', '5000000', 'standard');
   * await client.authorize(pi);
   * // Task cancelled...
   * const result = await client.refundViaFacilitator(pi);
   * console.log(result.transactionHash);
   * ```
   */
  async refundViaFacilitator(
    paymentInfo: AdvancedPaymentInfo,
    amount?: string,
  ): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const payload = {
        x402Version: 2,
        scheme: 'escrow',
        action: 'refundInEscrow',
        payload: {
          paymentInfo: {
            operator: paymentInfo.operator,
            receiver: paymentInfo.receiver,
            token: paymentInfo.token,
            maxAmount: paymentInfo.maxAmount,
            preApprovalExpiry: paymentInfo.preApprovalExpiry,
            authorizationExpiry: paymentInfo.authorizationExpiry,
            refundExpiry: paymentInfo.refundExpiry,
            minFeeBps: paymentInfo.minFeeBps,
            maxFeeBps: paymentInfo.maxFeeBps,
            feeReceiver: paymentInfo.feeReceiver,
            salt: paymentInfo.salt,
          },
          payer: this.payerAddress,
          amount: amount || paymentInfo.maxAmount,
        },
        paymentRequirements: {
          scheme: 'escrow',
          network: `eip155:${this.chainId}`,
          extra: {
            escrowAddress: this.contracts.escrow,
            operatorAddress: this.contracts.operator,
            tokenCollector: this.contracts.tokenCollector,
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.facilitatorUrl}/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const result = await response.json();

        if (result.success) {
          return {
            success: true,
            transactionHash: result.transaction || result.transactionHash || result.transaction_hash,
          };
        }
        return { success: false, error: result.errorReason || result.error || 'Refund failed' };
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);

        // On timeout, check on-chain state as fallback
        if (fetchErr.name === 'AbortError') {
          try {
            const state = await this.queryEscrowState(paymentInfo);
            if (state.refundableAmount === '0') {
              return { success: true };
            }
          } catch { /* fallback query failed */ }
          return { success: false, error: `Gasless refund timed out after ${this.timeout}ms. Check escrow state on-chain.` };
        }
        throw fetchErr;
      }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * QUERY ESCROW STATE: Read on-chain escrow state via the facilitator.
   *
   * This is a read-only operation that queries the facilitator for the
   * current escrow state without requiring gas or a signer.
   *
   * @param paymentInfo - PaymentInfo to query state for
   * @returns Escrow state including capturable/refundable amounts
   *
   * @example
   * ```typescript
   * const pi = client.buildPaymentInfo('0xWorker...', '5000000', 'standard');
   * await client.authorize(pi);
   *
   * const state = await client.queryEscrowState(pi);
   * console.log(`Capturable: ${state.capturableAmount}`);
   * console.log(`Refundable: ${state.refundableAmount}`);
   * console.log(`Already collected: ${state.hasCollectedPayment}`);
   * ```
   */
  async queryEscrowState(paymentInfo: AdvancedPaymentInfo): Promise<EscrowStateResponse> {
    if (!this.payerAddress) await this.init();

    const payload = {
      paymentInfo: {
        operator: paymentInfo.operator,
        receiver: paymentInfo.receiver,
        token: paymentInfo.token,
        maxAmount: paymentInfo.maxAmount,
        preApprovalExpiry: paymentInfo.preApprovalExpiry,
        authorizationExpiry: paymentInfo.authorizationExpiry,
        refundExpiry: paymentInfo.refundExpiry,
        minFeeBps: paymentInfo.minFeeBps,
        maxFeeBps: paymentInfo.maxFeeBps,
        feeReceiver: paymentInfo.feeReceiver,
        salt: paymentInfo.salt,
      },
      payer: this.payerAddress,
      network: `eip155:${this.chainId}`,
      extra: {
        escrowAddress: this.contracts.escrow,
        operatorAddress: this.contracts.operator,
        tokenCollector: this.contracts.tokenCollector,
      },
    };

    const response = await fetch(`${this.facilitatorUrl}/escrow/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Escrow state query failed: ${response.status} - ${errorText}`);
    }

    return await response.json() as EscrowStateResponse;
  }

  /**
   * CHARGE: Direct instant payment (no escrow hold).
   *
   * Calls PaymentOperator.charge() -> escrow.charge()
   * Funds go directly from payer to receiver.
   *
   * @param paymentInfo - PaymentInfo with receiver and amount
   * @param amount - Amount to charge (defaults to maxAmount)
   */
  async charge(paymentInfo: AdvancedPaymentInfo, amount?: string): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const { ethers } = await import('ethers');
      const nonce = await this.computeNonce(paymentInfo);
      const amt = amount || paymentInfo.maxAmount;

      const auth = {
        from: this.payerAddress,
        to: this.contracts.tokenCollector,
        value: String(amt),
        validAfter: '0',
        validBefore: String(paymentInfo.preApprovalExpiry),
        nonce,
      };
      const signature = await this.signErc3009(auth);
      // Pass raw signature bytes as collectorData (ethers handles hex -> bytes)
      const collectorData = ethers.getBytes(signature);

      const tuple = this.buildTuple(paymentInfo);

      // OWS wallet adapter mode
      if (this.walletAdapter) {
        return this.sendViaAdapter(ethers, OPERATOR_ABI, (iface) => {
          return iface.encodeFunctionData('charge', [
            tuple, amt, this.contracts.tokenCollector, collectorData,
          ]);
        });
      }

      // Legacy ethers.Signer mode
      const contract = new ethers.Contract(this.contracts.operator, OPERATOR_ABI, this.signer);
      const tx = await contract.charge(
        tuple,
        amt,
        this.contracts.tokenCollector,
        collectorData,
        { gasLimit: this.gasLimit },
      );
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        transactionHash: receipt.hash,
        gasUsed: Number(receipt.gasUsed),
        error: receipt.status !== 1 ? 'Transaction reverted' : undefined,
      };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * REFUND POST ESCROW: Dispute refund after funds were released.
   *
   * Calls PaymentOperator.refundPostEscrow() -> escrow.refund()
   *
   * WARNING: NOT FUNCTIONAL IN PRODUCTION (as of 2026-02-03).
   * The protocol team has not implemented the required tokenCollector
   * contract. This call will fail on-chain.
   *
   * For dispute resolution, use refundInEscrow() instead: keep funds
   * in escrow and refund before releasing. This guarantees funds are
   * available and under arbiter control.
   *
   * Kept for future use when tokenCollector is implemented.
   *
   * @param paymentInfo - PaymentInfo from the original authorization
   * @param amount - Amount to refund (defaults to maxAmount)
   * @param tokenCollector - Address of token collector for refund sourcing
   * @param collectorData - Data for the token collector
   */
  async refundPostEscrow(
    paymentInfo: AdvancedPaymentInfo,
    amount?: string,
    tokenCollector?: string,
    collectorData?: string,
  ): Promise<AdvancedTransactionResult> {
    if (!this.payerAddress) await this.init();

    try {
      const { ethers } = await import('ethers');
      const amt = amount || paymentInfo.maxAmount;
      const tuple = this.buildTuple(paymentInfo);

      // OWS wallet adapter mode
      if (this.walletAdapter) {
        return this.sendViaAdapter(ethers, OPERATOR_ABI, (iface) => {
          return iface.encodeFunctionData('refundPostEscrow', [
            tuple, amt, tokenCollector || ZERO_ADDRESS, collectorData || '0x',
          ]);
        });
      }

      // Legacy ethers.Signer mode
      const contract = new ethers.Contract(this.contracts.operator, OPERATOR_ABI, this.signer);
      const tx = await contract.refundPostEscrow(
        tuple,
        amt,
        tokenCollector || ZERO_ADDRESS,
        collectorData || '0x',
        { gasLimit: this.gasLimit },
      );
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        transactionHash: receipt.hash,
        gasUsed: Number(receipt.gasUsed),
        error: receipt.status !== 1 ? 'Transaction reverted' : undefined,
      };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  // ==========================================================================
  // INTERNAL: Adapter-based transaction signing and broadcast
  // ==========================================================================

  /**
   * Build an unsigned transaction, sign via SigningWalletAdapter, and broadcast.
   *
   * Used by release(), refundInEscrow(), charge(), refundPostEscrow() when
   * operating in OWS wallet adapter mode. The adapter signs the serialized
   * transaction offline; the RPC provider broadcasts the signed raw TX.
   *
   * @param ethersModule - ethers namespace (from `const { ethers } = await import('ethers')`)
   * @param abi - Contract ABI (OPERATOR_ABI or OPERATOR_ABI_CREATE3)
   * @param encodeCalldata - Function that encodes the calldata using the interface
   * @returns Transaction result
   */
  private async sendViaAdapter(
    ethersModule: any,
    abi: string[],
    encodeCalldata: (iface: any) => string,
  ): Promise<AdvancedTransactionResult> {
    const provider = new ethersModule.JsonRpcProvider(this.rpcUrl);
    const iface = new ethersModule.Interface(abi);
    const data = encodeCalldata(iface);

    // Build unsigned transaction
    const nonce = await provider.getTransactionCount(this.payerAddress);
    const feeData = await provider.getFeeData();

    const unsignedTx = ethersModule.Transaction.from({
      to: this.contracts.operator,
      data,
      gasLimit: this.gasLimit,
      nonce,
      chainId: this.chainId,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      type: 2, // EIP-1559
    });

    // Sign via adapter
    const signedTxHex = await this.walletAdapter!.signTransaction(unsignedTx.unsignedSerialized);

    // Broadcast
    const txResponse = await provider.broadcastTransaction(signedTxHex);
    const receipt = await txResponse.wait();

    return {
      success: receipt !== null && receipt.status === 1,
      transactionHash: txResponse.hash,
      gasUsed: receipt ? Number(receipt.gasUsed) : undefined,
      error: receipt && receipt.status !== 1 ? 'Transaction reverted' : undefined,
    };
  }
}
