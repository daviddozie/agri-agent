/**
 * uvd-x402-sdk - Validation and Payment Header Utilities
 *
 * Functions for validating payment parameters and creating
 * payment headers for HTTP requests.
 */

import type { X402HeaderName, PaymentHeaders } from '../types';
import { X402Error } from '../types';

/**
 * Regular expression for validating Ethereum addresses
 */
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Regular expression for validating Solana addresses (base58, 32-44 chars)
 */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Regular expression for validating Stellar addresses (G... format)
 */
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Regular expression for validating NEAR addresses
 */
const NEAR_ADDRESS_REGEX = /^[a-z0-9._-]+$/;

/**
 * Regular expression for validating XRPL classic addresses (r... base58, Ripple alphabet)
 */
const XRPL_ADDRESS_REGEX = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/**
 * Validate that a recipient address is present and valid
 *
 * This function ensures that:
 * 1. The recipient is not null, undefined, or empty
 * 2. The recipient is not just whitespace
 * 3. For EVM, it's a valid checksummed or lowercase 0x address
 *
 * @param recipient - The recipient address to validate
 * @param networkType - Optional network type for format validation
 * @throws X402Error with code 'INVALID_RECIPIENT' if validation fails
 */
export function validateRecipient(
  recipient: string | undefined | null,
  networkType?: 'evm' | 'svm' | 'solana' | 'stellar' | 'near' | 'xrpl'
): asserts recipient is string {
  // Check for null, undefined, or empty
  if (!recipient) {
    throw new X402Error(
      'Recipient address is required. The payTo/recipient field cannot be empty. ' +
      'Please provide a valid recipient address where payments should be sent.',
      'INVALID_RECIPIENT'
    );
  }

  // Check for whitespace-only
  const trimmed = recipient.trim();
  if (trimmed === '') {
    throw new X402Error(
      'Recipient address cannot be empty or whitespace. ' +
      'Please provide a valid recipient address.',
      'INVALID_RECIPIENT'
    );
  }

  // Network-specific validation
  if (networkType) {
    switch (networkType) {
      case 'evm':
        if (!ETH_ADDRESS_REGEX.test(trimmed)) {
          throw new X402Error(
            `Invalid EVM recipient address: "${trimmed}". ` +
            'Expected a 40-character hexadecimal address starting with 0x.',
            'INVALID_RECIPIENT'
          );
        }
        break;

      case 'svm':
      case 'solana':
        if (!SOLANA_ADDRESS_REGEX.test(trimmed)) {
          throw new X402Error(
            `Invalid Solana recipient address: "${trimmed}". ` +
            'Expected a base58-encoded public key (32-44 characters).',
            'INVALID_RECIPIENT'
          );
        }
        break;

      case 'stellar':
        if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
          throw new X402Error(
            `Invalid Stellar recipient address: "${trimmed}". ` +
            'Expected a G-prefixed public key (56 characters).',
            'INVALID_RECIPIENT'
          );
        }
        break;

      case 'near':
        if (!NEAR_ADDRESS_REGEX.test(trimmed) || trimmed.length > 64) {
          throw new X402Error(
            `Invalid NEAR recipient address: "${trimmed}". ` +
            'Expected a valid NEAR account ID.',
            'INVALID_RECIPIENT'
          );
        }
        break;

      case 'xrpl':
        if (!XRPL_ADDRESS_REGEX.test(trimmed)) {
          throw new X402Error(
            `Invalid XRPL recipient address: "${trimmed}". ` +
            'Expected a classic r-address (base58, Ripple alphabet).',
            'INVALID_RECIPIENT'
          );
        }
        break;
    }
  }
}

/**
 * Validate payment amount
 *
 * Ensures the amount is a valid positive number string
 *
 * @param amount - The amount string to validate
 * @throws X402Error with code 'INVALID_AMOUNT' if validation fails
 */
export function validateAmount(amount: string | undefined | null): asserts amount is string {
  if (!amount) {
    throw new X402Error(
      'Payment amount is required.',
      'INVALID_AMOUNT'
    );
  }

  const trimmed = amount.trim();
  if (trimmed === '') {
    throw new X402Error(
      'Payment amount cannot be empty.',
      'INVALID_AMOUNT'
    );
  }

  // Parse as number
  const num = parseFloat(trimmed);
  if (isNaN(num)) {
    throw new X402Error(
      `Invalid payment amount: "${trimmed}". Expected a valid number.`,
      'INVALID_AMOUNT'
    );
  }

  if (num <= 0) {
    throw new X402Error(
      `Payment amount must be positive. Got: ${trimmed}`,
      'INVALID_AMOUNT'
    );
  }
}

// ============================================================================
// PAYMENT HEADER UTILITIES
// ============================================================================

/**
 * Create payment headers object from a base64-encoded payload
 *
 * Returns an object with both X-PAYMENT and PAYMENT-SIGNATURE headers,
 * making it easy to use either header format.
 *
 * @param paymentHeader - Base64-encoded payment payload
 * @returns PaymentHeaders object with both header formats
 *
 * @example
 * ```ts
 * const headers = createPaymentHeaders(paymentHeader);
 *
 * // Use v1 header (most compatible)
 * fetch(url, { headers: { 'X-PAYMENT': headers['X-PAYMENT'] } });
 *
 * // Use v2 header
 * fetch(url, { headers: { 'PAYMENT-SIGNATURE': headers['PAYMENT-SIGNATURE'] } });
 * ```
 */
export function createPaymentHeaders(paymentHeader: string): PaymentHeaders {
  return {
    'X-PAYMENT': paymentHeader,
    'PAYMENT-SIGNATURE': paymentHeader,
  };
}

/**
 * Get a single payment header by name
 *
 * @param paymentHeader - Base64-encoded payment payload
 * @param headerName - Header name to use ('X-PAYMENT' or 'PAYMENT-SIGNATURE')
 * @returns Object with a single header entry
 *
 * @example
 * ```ts
 * // Use with fetch spread operator
 * fetch(url, {
 *   headers: {
 *     'Content-Type': 'application/json',
 *     ...getPaymentHeader(result.paymentHeader, 'X-PAYMENT'),
 *   },
 * });
 * ```
 */
export function getPaymentHeader(
  paymentHeader: string,
  headerName: X402HeaderName = 'X-PAYMENT'
): Record<X402HeaderName, string> {
  return { [headerName]: paymentHeader } as Record<X402HeaderName, string>;
}

/**
 * Default x402 payment header name
 *
 * Use 'X-PAYMENT' for maximum compatibility with all facilitators.
 * Use 'PAYMENT-SIGNATURE' for x402 v2 compliance.
 */
export const DEFAULT_PAYMENT_HEADER: X402HeaderName = 'X-PAYMENT';

/**
 * All supported x402 payment header names
 */
export const PAYMENT_HEADER_NAMES: readonly X402HeaderName[] = [
  'X-PAYMENT',
  'PAYMENT-SIGNATURE',
] as const;
