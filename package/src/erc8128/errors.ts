/**
 * uvd-x402-sdk/erc8128 — error taxonomy.
 *
 * The union is the SUPERSET of MeshRelay's 19 public HTTP error codes (a
 * published contract: `{ error, code }` with a per-code status) and the one
 * stable string EM's auth layer switches on (`nonce_store_unavailable` →
 * 503 + Retry-After). Adopting the SDK must not change either product's
 * response bodies, so nothing here is renamed or merged.
 *
 * These are VALUES, not exceptions: `verifyRequest` returns them. Exceptions
 * are reserved for programmer error (a policy without an authority, a signer
 * without a key).
 */

export type Erc8128Code =
  // wire / signature
  | 'signature_input_invalid'
  | 'signature_invalid'
  | 'alg_unsupported'
  | 'alg_missing'
  | 'keyid_not_lowercase'
  // nonce
  | 'nonce_invalid'
  | 'nonce_unknown'
  | 'nonce_replayed'
  | 'nonce_expired'
  | 'nonce_required'
  | 'nonce_rate_limited'
  | 'nonce_capacity'
  | 'nonce_limits_invalid'
  | 'nonce_ttl_invalid'
  | 'nonce_store_unavailable'
  // body
  | 'content_digest_required'
  | 'content_digest_invalid'
  | 'content_digest_mismatch'
  // components / binding
  | 'components_invalid'
  | 'class_bound_rejected'
  // freshness / identity
  | 'signature_stale'
  | 'chain_not_allowed'
  | 'wallet_invalid'
  | 'wallet_mismatch'
  | 'authority_invalid';

/**
 * HTTP status per code. 401 unless the failure is not the caller's signature:
 * a replayed nonce is a conflict (409), issuance pressure is 429, and a store
 * or config failure is 503.
 */
export const ERC8128_ERROR_STATUS: Readonly<Record<Erc8128Code, number>> = Object.freeze({
  signature_input_invalid: 401,
  signature_invalid: 401,
  alg_unsupported: 401,
  alg_missing: 401,
  keyid_not_lowercase: 401,
  nonce_invalid: 401,
  nonce_unknown: 401,
  nonce_replayed: 409,
  nonce_expired: 401,
  nonce_required: 401,
  nonce_rate_limited: 429,
  nonce_capacity: 429,
  nonce_limits_invalid: 503,
  nonce_ttl_invalid: 503,
  nonce_store_unavailable: 503,
  content_digest_required: 401,
  content_digest_invalid: 401,
  content_digest_mismatch: 401,
  components_invalid: 401,
  class_bound_rejected: 401,
  signature_stale: 401,
  chain_not_allowed: 401,
  wallet_invalid: 401,
  wallet_mismatch: 401,
  authority_invalid: 503,
});

/**
 * Whether the SAME request may be retried unchanged.
 *
 * Only infrastructure pressure qualifies. A stale signature or a burnt nonce
 * is recoverable by re-signing, not by retrying — and a misconfigured
 * authority or nonce limit will not fix itself. This turns EM's
 * `reason == "nonce_store_unavailable"` string compare into a lookup.
 */
export const ERC8128_ERROR_RETRYABLE: Readonly<Record<Erc8128Code, boolean>> = Object.freeze({
  signature_input_invalid: false,
  signature_invalid: false,
  alg_unsupported: false,
  alg_missing: false,
  keyid_not_lowercase: false,
  nonce_invalid: false,
  nonce_unknown: false,
  nonce_replayed: false,
  nonce_expired: false,
  nonce_required: false,
  nonce_rate_limited: true,
  nonce_capacity: true,
  nonce_limits_invalid: false,
  nonce_ttl_invalid: false,
  nonce_store_unavailable: true,
  content_digest_required: false,
  content_digest_invalid: false,
  content_digest_mismatch: false,
  components_invalid: false,
  class_bound_rejected: false,
  signature_stale: false,
  chain_not_allowed: false,
  wallet_invalid: false,
  wallet_mismatch: false,
  authority_invalid: false,
});

/** Default human-readable message per code. Callers may override. */
export const ERC8128_ERROR_MESSAGE: Readonly<Record<Erc8128Code, string>> = Object.freeze({
  signature_input_invalid: 'Invalid Signature-Input format',
  signature_invalid: 'Invalid Signature header',
  alg_unsupported: 'Unsupported ERC-8128 alg: only eip191 is verified',
  alg_missing: 'ERC-8128 alg="eip191" is required by this policy',
  keyid_not_lowercase: 'ERC-8128 keyid address must be lowercase',
  nonce_invalid: 'Invalid ERC-8128 nonce format',
  nonce_unknown: 'Nonce was not issued by this server',
  nonce_replayed: 'Nonce has already been used',
  nonce_expired: 'Nonce has expired',
  nonce_required: 'ERC-8128 signature must carry a nonce',
  nonce_rate_limited: 'ERC-8128 nonce issuance is temporarily rate limited',
  nonce_capacity: 'ERC-8128 nonce capacity is temporarily exhausted',
  nonce_limits_invalid: 'ERC-8128 nonce limits are invalid',
  nonce_ttl_invalid: 'ERC-8128 nonce TTL is invalid',
  nonce_store_unavailable: 'ERC-8128 nonce store is unavailable',
  content_digest_required: 'Signed request with a body requires Content-Digest',
  content_digest_invalid: 'Invalid or missing Content-Digest header',
  content_digest_mismatch: 'Content-Digest does not match request body',
  components_invalid:
    'ERC-8128 must cover method, authority, path, and query when present',
  class_bound_rejected: 'Class-bound signatures not accepted (missing required components)',
  signature_stale: 'ERC-8128 signature is expired or outside the freshness window',
  chain_not_allowed: 'ERC-8128 chain id is not allowed',
  wallet_invalid: 'Invalid wallet in ERC-8128 keyid',
  wallet_mismatch: 'Recovered wallet does not match ERC-8128 keyid',
  authority_invalid: 'ERC-8128 authority is not configured safely',
});
