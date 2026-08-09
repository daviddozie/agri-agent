/**
 * uvd-x402-sdk
 *
 * x402 Payment SDK - Gasless crypto payments using the Ultravioleta facilitator.
 *
 * Supports 25 blockchain networks:
 * - EVM (15): Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche, Celo, HyperEVM, Unichain, Monad, Scroll, SKALE Base, Robinhood Chain (mainnet + testnet)
 * - SVM (2): Solana, Fogo
 * - Stellar (1): Stellar
 * - NEAR (1): NEAR Protocol
 * - Algorand (2): Algorand mainnet and testnet
 * - Sui (2): Sui mainnet and testnet
 * - XRPL (2): XRP Ledger mainnet and testnet
 *
 * Supports both x402 v1 and v2 protocols.
 *
 * @example Basic usage (EVM)
 * ```ts
 * import { X402Client } from 'uvd-x402-sdk';
 *
 * const client = new X402Client({ defaultChain: 'base' });
 *
 * // Connect wallet
 * await client.connect('base');
 *
 * // Create payment
 * const result = await client.createPayment({
 *   recipient: '0x...',
 *   amount: '10.00',
 * });
 *
 * // Use result.paymentHeader in X-PAYMENT HTTP header
 * ```
 *
 * @example With SVM (Solana/Fogo)
 * ```ts
 * import { SVMProvider } from 'uvd-x402-sdk/solana';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const svm = new SVMProvider();
 * const address = await svm.connect();
 *
 * // Solana payment
 * const solanaConfig = getChainByName('solana')!;
 * const payload = await svm.signPayment(paymentInfo, solanaConfig);
 * const header = svm.encodePaymentHeader(payload, solanaConfig);
 *
 * // Fogo payment (same provider, different config)
 * const fogoConfig = getChainByName('fogo')!;
 * const fogoPayload = await svm.signPayment(paymentInfo, fogoConfig);
 * const fogoHeader = svm.encodePaymentHeader(fogoPayload, fogoConfig);
 * ```
 *
 * @example With NEAR
 * ```ts
 * import { NEARProvider } from 'uvd-x402-sdk/near';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const near = new NEARProvider();
 * const accountId = await near.connect();
 * const nearConfig = getChainByName('near')!;
 * const payload = await near.signPayment(paymentInfo, nearConfig);
 * const header = near.encodePaymentHeader(payload);
 * ```
 *
 * @example With Algorand
 * ```ts
 * import { AlgorandProvider } from 'uvd-x402-sdk/algorand';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const algorand = new AlgorandProvider();
 * const address = await algorand.connect();
 * const algorandConfig = getChainByName('algorand')!;
 * const payload = await algorand.signPayment(paymentInfo, algorandConfig);
 * const header = algorand.encodePaymentHeader(payload, algorandConfig);
 * ```
 *
 * @example With Sui (Sponsored Transactions)
 * ```ts
 * import { SuiProvider } from 'uvd-x402-sdk/sui';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const sui = new SuiProvider();
 * const address = await sui.connect();
 * const suiConfig = getChainByName('sui')!;
 * const payload = await sui.signPayment(paymentInfo, suiConfig);
 * const header = sui.encodePaymentHeader(payload, suiConfig);
 * // User pays ZERO gas - facilitator sponsors the transaction
 * ```
 *
 * @example With XRPL (t54 pre-signed Payment blob)
 * ```ts
 * import { XRPLProvider } from 'uvd-x402-sdk/xrpl';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const xrpl = new XRPLProvider({ seed: process.env.XRPL_SEED });
 * const address = await xrpl.connect();
 * const xrplConfig = getChainByName('xrpl-mainnet')!;
 * const payload = await xrpl.signPayment(paymentInfo, xrplConfig); // { signedTxBlob }
 * const header = xrpl.encodePaymentHeader(payload);
 * ```
 *
 * @example With React
 * ```tsx
 * import { X402Provider, useX402, usePayment } from 'uvd-x402-sdk/react';
 *
 * function App() {
 *   return (
 *     <X402Provider>
 *       <PaymentButton />
 *     </X402Provider>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main client
export { X402Client } from './client';

// Chain configuration
export {
  SUPPORTED_CHAINS,
  DEFAULT_CHAIN,
  DEFAULT_FACILITATOR_URL,
  getChainById,
  getChainByName,
  isChainSupported,
  getEnabledChains,
  getChainsByNetworkType,
  getEVMChainIds,
  getSVMChains,
  isSVMChain,
  getNetworkType,
  getExplorerTxUrl,
  getExplorerAddressUrl,
  // Multi-token support functions
  getTokenConfig,
  getTokenByAddress,
  getSupportedTokens,
  isTokenSupported,
  getChainsByToken,
  // Algorand helper functions
  getAlgorandChains,
  isAlgorandChain,
  // Sui helper functions
  getSuiChains,
  isSuiChain,
  // XRPL helper functions
  getXRPLChains,
  isXRPLChain,
} from './chains';

// x402 utilities
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
  // Validation utilities
  validateRecipient,
  validateAmount,
  // Payment header utilities
  createPaymentHeaders,
  getPaymentHeader,
  DEFAULT_PAYMENT_HEADER,
  PAYMENT_HEADER_NAMES,
  // UTF-8 safe base64 (token domain names like `USD₮0` are not ASCII)
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Json,
  // Multi-token payloads
  buildTokenMetadata,
} from './utils';

// Types
export type {
  // Chain types
  ChainConfig,
  USDCConfig,
  NativeCurrency,
  NetworkType,

  // Token types (multi-token support)
  TokenType,
  TokenConfig,
  PaymentTokenMetadata,

  // Wallet types
  WalletState,
  WalletAdapter,
  EIP712Domain,
  EIP712Types,

  // Payment types
  PaymentInfo,
  PaymentRequest,
  PaymentResult,
  PaymentHeaders,
  PaymentPayload,
  EVMPaymentPayload,
  SolanaPaymentPayload,
  StellarPaymentPayload,
  NEARPaymentPayload,
  AlgorandPaymentPayload,
  SuiPaymentPayload,
  XRPLPaymentPayload,
  X402HeaderName,

  // x402 header types (v1 and v2)
  X402Scheme,
  X402Version,
  X402Header,
  X402HeaderV1,
  X402HeaderV2,
  X402PaymentOption,
  X402PayloadData,
  X402EVMPayload,
  X402SolanaPayload,
  X402SettlementAccountPayload,
  X402StellarPayload,
  X402NEARPayload,
  X402AlgorandPayload,
  X402SuiPayload,
  X402XRPLPayload,

  // Config types
  X402ClientConfig,
  MultiPaymentConfig,
  NetworkBalance,

  // Event types
  X402Event,
  X402EventData,
  X402EventHandler,

  // Error types
  X402ErrorCode,
} from './types';

export { X402Error, DEFAULT_CONFIG, CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from './types';

// Signing wallet adapters
export type { SigningWalletAdapter, EIP3009Params, EIP3009Authorization } from './wallet';
export { EnvKeyAdapter } from './adapters/env-key';
export { OWSWalletAdapter } from './adapters/ows';
export type { OWSWallet } from './adapters/ows';

// Facilitator configuration
export { FACILITATOR_ADDRESSES, getFacilitatorAddress } from './facilitator';
export type { FacilitatorAddresses } from './facilitator';

// Live traffic stream (GET /events, Server-Sent Events)
export {
  streamTrafficEvents,
  parseTrafficEvent,
  matchesFilters,
  SSEParser,
  TrafficStreamError,
  EVENT_KINDS,
  KEEPALIVE_INTERVAL_MS,
} from './events';
export type {
  TrafficEvent,
  TrafficEventKind,
  StreamTrafficEventsOptions,
  SSEFrame,
} from './events';

// ERC-8128 signed HTTP requests (RFC 9421 signature base + EIP-191)
export {
  signRequest,
  signRequestWithWallet,
  signRequestWithSigner,
  fetchNonce,
  createSignedFetch,
  buildSignatureBase,
  buildSignatureParams,
} from './erc8128';
export type {
  ERC8128RequestOptions,
  SignRequestOptions,
  SignRequestWithSignerOptions,
  SignatureHeaders,
  CreateSignedFetchConfig,
  SignatureBaseParams,
  SignatureParamsInput,
} from './erc8128';

// Escrow pre-auth (sign-on-assignment X-Payment-Auth for the x402r escrow)
export {
  buildEscrowPreAuth,
  computeEscrowNonce,
  ESCROW_TIER_WINDOWS,
  ESCROW_DEPOSIT_LIMIT_USD,
  OPERATOR_FEE_BPS,
} from './escrow-preauth';
export type {
  EscrowNetworkConfig,
  EscrowPaymentInfo,
  EscrowPreAuthParams,
  EscrowPreAuthSigner,
  EscrowTierWindows,
} from './escrow-preauth';

// Server-side middleware and facilitator client
export {
  FacilitatorClient,
  createPaymentMiddleware,
  createHonoMiddleware,
  create402Response,
  extractPaymentFromHeaders,
  buildPaymentRequirements,
  buildVerifyRequest,
  buildSettleRequest,
  buildVerifyRequestV2,
  buildSettleRequestV2,
  getCorsHeaders,
  X402_CORS_HEADERS,
  X402_HEADER_NAMES,
} from './backend';
export type {
  ResourceInfoV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
  VerifyRequestV2,
  SettleRequestV2,
  FacilitatorClientOptions,
  HonoMiddlewareOptions,
  PaymentAcceptance,
  PaymentMiddlewareOptions,
  VerifiedPaymentState,
} from './backend';
