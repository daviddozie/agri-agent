/**
 * uvd-x402-sdk/erc8128 — ERC-8128 signed HTTP requests, signer AND verifier.
 *
 * ERC-8128 is the RFC 9421 profile that lets an agent authenticate with an
 * Ethereum wallet instead of an API key. This subpath is the single
 * implementation for the fleet: one signer, one verifier, one set of
 * conformance vectors shipped inside the package.
 *
 * The design rule everything else hangs off: THE VERIFIER NEVER
 * RE-SERIALISES `@signature-params`. It replays the substring verbatim from
 * the `Signature-Input` header into the same signature-base builder the
 * signer uses, so `alg` present, `alg` absent, a checksummed keyid, an
 * unusual parameter order and any future RFC 9421 parameter all verify
 * through one byte path with no flags.
 *
 * @example Sign a request
 * ```ts
 * import { fetchNonce, signRequest } from 'uvd-x402-sdk/erc8128';
 *
 * const nonce = await fetchNonce('https://api.execution.market');
 * const headers = await signRequest({
 *   privateKey: process.env.WALLET_PRIVATE_KEY!,   // never a literal
 *   method: 'POST',
 *   url: 'https://api.execution.market/api/v1/tasks',
 *   body: JSON.stringify({ title: 'test' }),
 *   nonce,
 * });
 * ```
 *
 * @example Verify a request
 * ```ts
 * import { policyFromPreset, verifyRequest } from 'uvd-x402-sdk/erc8128';
 *
 * const result = await verifyRequest(
 *   { method: req.method, url: req.originalUrl, headers: req.headers, rawBody: req.rawBody },
 *   policyFromPreset('meshrelay-strict', {
 *     authority: 'api.meshrelay.xyz',   // a VALUE, never a header; written as it is signed
 *     nonceStore: store,                // consume order comes WITH the preset
 *   }),
 * );
 * if (!result.ok) return res.status(result.status).json({ error: result.message, code: result.code });
 * ```
 *
 * @example Pin the wire format in your own CI
 * ```ts
 * import { runConformance } from 'uvd-x402-sdk/erc8128';
 *
 * const report = await runConformance();
 * if (report.failed.length) throw new Error(JSON.stringify(report.failed, null, 2));
 * ```
 */

// ── L0 · pure core ─────────────────────────────────────────────────────────
export {
  ALG_EIP191,
  buildSignatureBase,
  buildSignatureParams,
  canonicalAuthority,
  canonicalKeyid,
  canonicalParams,
  computeContentDigest,
  DEFAULT_CHAIN_ID,
  DEFAULT_LABEL,
  DEFAULT_VALIDITY_SEC,
  eip191ByteLength,
  eip191Message,
  Erc8128ParseError,
  extractKeyidWallet,
  KEYID_RE,
  parseSignatureHeader,
  parseSignatureInput,
  REQUEST_BOUND_COMPONENTS,
  selectCovered,
  splitRequestTarget,
  WIRE_CONTRACT_VERSION,
} from './core';
export type {
  CanonicalMessage,
  ObservedProfile,
  ParsedSignatureInput,
  SigParam,
} from './core';

// ── errors ─────────────────────────────────────────────────────────────────
export {
  ERC8128_ERROR_MESSAGE,
  ERC8128_ERROR_RETRYABLE,
  ERC8128_ERROR_STATUS,
} from './errors';
export type { Erc8128Code } from './errors';

// ── signer ─────────────────────────────────────────────────────────────────
export {
  createSignedFetch,
  fetchNonce,
  signRequest,
  signRequestWithSigner,
  signRequestWithWallet,
} from './signer';
export type {
  ContentDigestEmit,
  CreateSignedFetchConfig,
  Erc8128Headers,
  Erc8128LowerHeaders,
  Erc8128SignedHeaders,
  HeaderCase,
  SignOptions,
  SignWithPrivateKeyOptions,
  SignWithSignerOptions,
  SignWithWalletOptions,
  WireProfile,
} from './signer';

// ── nonce ──────────────────────────────────────────────────────────────────
export type {
  NonceConsumeOrder,
  NonceContext,
  NonceOutcome,
  NoncePolicy,
  NonceStore,
} from './nonce';

// ── verifier ───────────────────────────────────────────────────────────────
export { verifyRequest } from './verifier';
export type {
  AcceptProfile,
  ComponentsRule,
  ContentDigestRule,
  ContractVerifierInput,
  VerifiableRequest,
  VerifyPolicy,
  VerifyResult,
} from './verifier';

// ── policy presets ─────────────────────────────────────────────────────────
export {
  POLICY_PRESETS,
  policyFromPreset,
  PRESET_NONCE_CONSUME,
  PRESET_NONCE_MODE,
  presetAsData,
} from './presets';
export type { PolicyFromPresetOptions, PolicyPreset, PolicyPresetName } from './presets';

// ── conformance ────────────────────────────────────────────────────────────
export {
  CONFORMANCE_SHA256,
  CONFORMANCE_VECTORS_F3_1,
  CONFORMANCE_VECTORS_F3_3,
  F3_1_VECTORS_JSON,
  F3_3_VECTORS_JSON,
} from './vectors';
export type {
  Erc8128Frozen,
  Erc8128RequestSpec,
  Erc8128VectorCase,
  Erc8128Vectors,
  Erc8128VerifyCase,
} from './vectors';
export { conformancePolicy, runConformance, verifiableRequestFromVector } from './conformance';
export type { ConformanceCaseResult, ConformanceReport } from './conformance';
