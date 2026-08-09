/**
 * uvd-x402-sdk/erc8128 — nonce store contract.
 *
 * The SDK never issues, formats or stores a nonce. All nonce policy lives in
 * the caller's store, because the two live stores are different by design:
 *
 *   - MeshRelay: issuer-bound SQLite. A nonce this server never issued is
 *     `'unknown'`; issuance rate limiting and the capacity cap live there.
 *   - Execution Market: client-chosen nonces, first-use-wins. It can never
 *     answer `'unknown'` — only `'ok'` or `'replayed'`.
 *
 * `consume()` receives the RAW nonce plus context and derives its OWN key.
 * This is load-bearing, not ergonomics: MeshRelay indexes by the bare nonce
 * and EM by `erc8128:{chain}:{addr}:{nonce}`. If the SDK derived the key,
 * MeshRelay would 401 every nonce in flight across a deploy, and EM's
 * first-use store would fail OPEN — every nonce would look new and replay
 * protection would vanish silently.
 *
 * No default store is exported on purpose. An in-process first-use-wins map
 * looks convenient and gives ZERO replay protection across ECS tasks or a
 * container restart — a wrong default is worse than no default.
 */

export type NonceOutcome = 'ok' | 'unknown' | 'replayed' | 'expired' | 'unavailable';

/** Context handed to a store so it can derive its own key and TTL. */
export interface NonceContext {
  /**
   * With `consume: 'before-verify'` this is the wallet CLAIMED by the keyid
   * (recovery has not run yet); with `'after-verify'` it is the RECOVERED
   * wallet. A store that binds a nonce to an identity must know which one it
   * is being given.
   */
  wallet: string;
  chainId: number;
  /** `expires - created` plus the future clock skew, as EM computes it. */
  ttlSeconds: number;
  created: number;
  expires: number;
}

export interface NonceStore {
  /**
   * Issue a nonce. Only issuer-bound stores implement it; rate limiting and
   * capacity caps belong here, never in the SDK.
   */
  issue?(ttlSeconds: number): Promise<{ nonce: string; ttlSeconds: number }>;

  /**
   * Consume a nonce exactly once.
   *
   * Return `'unavailable'` (or throw) for infrastructure failure — that is a
   * 503, not a bad signature. Returning `'ok'` when the nonce was already
   * used is a fail-open bug; the store's single-use check must be the
   * serialisation point.
   */
  consume(nonce: string, ctx: NonceContext): NonceOutcome | Promise<NonceOutcome>;
}

/**
 * When the nonce is consumed relative to signature recovery.
 *
 * - `'before-verify'` (EM, CRY-012): closes the concurrent double-use window;
 *   a bad signature burns the nonce, which is safe because the legitimate
 *   signer just fetches another.
 * - `'after-verify'` (MeshRelay): an unauthenticated caller cannot burn a
 *   nonce; safe as long as the store's single-use UPDATE is atomic.
 *
 * Both are deliberate. Neither is a default the other can be migrated to
 * without changing a live product's behaviour.
 */
export type NonceConsumeOrder = 'before-verify' | 'after-verify';

export interface NoncePolicy {
  store: NonceStore;
  /** `'required'` rejects a nonce-less (replayable) signature. */
  mode?: 'required' | 'optional';
  consume?: NonceConsumeOrder;
}
