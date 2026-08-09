/**
 * uvd-x402-sdk - Utilities
 *
 * Re-exports all utility functions.
 */

export {
  detectX402Version,
  chainToCAIP2,
  caip2ToChain,
  parseNetworkIdentifier,
  encodeX402Header,
  decodeX402Header,
  createX402V1Header,
  createX402V2Header,
  createX402Header,
  generatePaymentOptions,
  isCAIP2Format,
  convertX402Header,
} from './x402';

export { buildTokenMetadata } from './token-metadata';

export {
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Json,
} from './base64';

export {
  validateRecipient,
  validateAmount,
  createPaymentHeaders,
  getPaymentHeader,
  DEFAULT_PAYMENT_HEADER,
  PAYMENT_HEADER_NAMES,
} from './validation';
