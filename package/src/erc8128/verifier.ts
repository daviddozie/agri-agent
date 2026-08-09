/**
 * uvd-x402-sdk/erc8128 — the verifier.
 *
 * ONE pipeline, driven by a policy object:
 *
 *   parse → alg gate → signature bytes → freshness → chain → binding
 *         → [nonce?] → content-digest → components → base → recover → [nonce?]
 *
 * `meshrelay-strict` and `em-lenient` are records of knobs over that pipeline,
 * not branches — see `presets.ts`. Strict and lenient differ in POLICY, never
 * in how bytes are rebuilt.
 *
 * The rebuild takes the `@signature-params` substring VERBATIM off the wire
 * (`ParsedSignatureInput.paramsRaw`) and feeds it to the same
 * `buildSignatureBase()` the signer uses. That is why `alg` present, `alg`
 * absent, a checksummed keyid, a different parameter order and any future
 * RFC 9421 parameter all verify through one byte path with no flags. Parsing
 * exists only to make POLICY decisions.
 *
 * Content-Digest follows Execution Market's body-presence rule, which the
 * owner made canonical (spec §10 Q1): a digest is required — and must be in
 * the signed component list — if and only if the request carries a body; a
 * bodyless request may cover it voluntarily and is still verified.
 * MeshRelay's method-driven rule stays available as
 * `contentDigest: 'non-idempotent-methods'`.
 */

import { ethers } from 'ethers';

import { X402Error } from '../types';
import {
  buildSignatureBase,
  Erc8128ParseError,
  eip191Message,
  parseSignatureHeader,
  parseSignatureInput,
  REQUEST_BOUND_COMPONENTS,
  splitRequestTarget,
} from './core';
import type { ObservedProfile, ParsedSignatureInput } from './core';
import {
  ERC8128_ERROR_MESSAGE,
  ERC8128_ERROR_RETRYABLE,
  ERC8128_ERROR_STATUS,
} from './errors';
import type { Erc8128Code } from './errors';
import type { NoncePolicy } from './nonce';

/** Which wire generations a verifier accepts. */
export type AcceptProfile = 'canonical' | 'legacy' | 'accept-both';

/** How the covered-component list is checked. */
export type ComponentsRule = 'exact-ordered' | 'request-bound-subset';

/** When a `Content-Digest` is mandatory. */
export type ContentDigestRule = 'body-present' | 'non-idempotent-methods';

/** ERC-1271 hook. The SDK never opens an RPC connection itself. */
export interface ContractVerifierInput {
  address: string;
  chainId: number;
  /** keccak256 of the EIP-191 message, using the UTF-8 BYTE length prefix. */
  messageHash: Uint8Array;
  signature: Uint8Array;
}

export interface VerifyPolicy {
  /**
   * A VALUE, never derived inside the SDK.
   *
   * MeshRelay passes its pinned `config.erc8128Auth.publicAuthority`; EM's
   * REST/MCP wrapper passes `_resolve_authority(request)`; EM's WebSocket path
   * MUST keep passing `url.netloc` — deriving it from `X-Forwarded-Host`
   * there let a caller rebuild the base over an authority they chose
   * (websocket/server.py:199-213).
   *
   * WRITE IT THE WAY IT IS SIGNED. The value goes through
   * `policyAuthority()`, which lowercases and validates it and NEVER touches
   * ports: it is the expected OUTPUT of the signer's `canonicalAuthority()`,
   * so `:443` under https and `:80` under http are already gone by the time
   * they get here, and any other port is part of the authority and is kept.
   * Configuring a default port is misconfiguration and answers 503 with a
   * message that says so — re-normalising it under a scheme this value does
   * not carry is what broke `https` on `:80`.
   */
  authority: string;
  /** Default `'accept-both'`. */
  accept?: AcceptProfile;
  /** Default `'exact-ordered'`. */
  components?: ComponentsRule;
  /** Default `'body-present'` (EM's rule, canonical per the owner's Q1 call). */
  contentDigest?: ContentDigestRule;
  nonce?: NoncePolicy;
  /** `undefined` accepts any chain id (EM's posture). */
  allowedChainIds?: readonly number[];
  /** Default 300. */
  maxValiditySec?: number;
  /**
   * Default `{ future: 30, pastExpiry: 0 }` (MeshRelay). EM uses 30/30.
   *
   * `pastExpiry` is inclusive: a signature is rejected once
   * `now >= expires + pastExpiry`. EM's Python compares strictly, so it
   * accepts the single instant `now == expires + 30` that this rejects — a
   * one-second difference in the stricter direction.
   */
  clockSkew?: { future?: number; pastExpiry?: number };
  /** `'eth'` by default; `'any'` takes `eth` when present, else the first. */
  label?: 'any' | string;
  contractVerifier?(input: ContractVerifierInput): Promise<boolean>;
  /** Injectable clock (seconds). */
  now?: () => number;
  /**
   * Deprecation census. Fires on SUCCESSFUL **and FAILED** verifications,
   * tagged with the outcome — a legacy emitter that is already failing for
   * another reason must not make the census look clean, or the S3 flip turns
   * a recoverable outage into a permanent one.
   *
   * Aggregate by `profile` (3 values), never by keyid: keyid is per-wallet
   * cardinality.
   */
  onObservedProfile?(
    profile: ObservedProfile,
    ctx: { wallet: string; chainId: number; keyid: string; outcome: 'ok' | Erc8128Code }
  ): void;
}

export interface VerifiableRequest {
  method: string;
  /** Absolute or origin-relative. Never normalised — raw bytes matter. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Exact body bytes off the wire, or `undefined` when there is no body. */
  rawBody?: Uint8Array;
}

export type VerifyResult =
  | {
      ok: true;
      wallet: string;
      chainId: number;
      keyid: string;
      label: string;
      nonce?: string;
      created: number;
      expires: number;
      signatureBase: string;
      observedProfile: ObservedProfile;
      via: 'eoa' | 'erc1271';
    }
  | {
      ok: false;
      code: Erc8128Code;
      message: string;
      status: number;
      retryable: boolean;
      observedProfile?: ObservedProfile;
    };

/** Internal control flow. Never escapes `verifyRequest`. */
class VerifyFailure extends Error {
  constructor(
    public readonly code: Erc8128Code,
    message?: string
  ) {
    super(message ?? ERC8128_ERROR_MESSAGE[code]);
    this.name = 'VerifyFailure';
  }
}

const CONTENT_DIGEST_RE = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/;
const IDEMPOTENT_METHODS = ['GET', 'HEAD'];

function headerLookup(
  headers: Readonly<Record<string, string | string[] | undefined>>
): (name: string) => string | undefined {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const flat = Array.isArray(value) ? value[0] : value;
    if (typeof flat !== 'string' || !flat) continue;
    const lower = key.toLowerCase();
    if (!map.has(lower)) map.set(lower, flat);
  }
  return (name: string) => map.get(name.toLowerCase());
}

/**
 * Characters that can never appear inside a configured authority: every
 * whitespace character the rule names, plus the four delimiters that mark a
 * value as a URL, a path, a query or a userinfo prefix rather than a bare
 * `host[:port]`.
 *
 * The class is ENUMERATED rather than written `\s`, because the Python side
 * must reject the byte-for-byte same input set and the two languages disagree
 * about which exotic code points `\s` covers. `\n`, `\r`, `\v`, `\f` and NBSP
 * are here on purpose: they used to slip through and get embedded into the
 * rebuilt signature base.
 */
const AUTHORITY_FORBIDDEN_RE = /[ \t\n\r\v\f\u00a0/@?#]/;

/**
 * The CONFIGURED authority: lowercased and validated. IT NEVER TOUCHES PORTS.
 *
 * This is the counterpart of `canonicalAuthority()`, not a second application
 * of it. The configured value is the EXPECTED RESULT of that function, so it
 * must already be written in its output form; normalising it a second time,
 * under a scheme it does not carry, is exactly what made the two SDKs diverge.
 * A port present here is preserved verbatim, whatever it is — which is what
 * makes `https` on `:80` (signed `host:80`) and a non-default port like
 * `host:8443` both work.
 *
 * Everything below is misconfiguration — the operator's typo, never the
 * caller's signature — so it answers 503 `authority_invalid`, never 401:
 *   - empty, or empty once trimmed
 *   - longer than 253 characters
 *   - any whitespace, or any of `/ @ ? #` (which is also how a pasted URL, a
 *     scheme prefix and a path component are caught)
 *   - a port that is the default for EITHER scheme (`:443` / `:80`), which
 *     gets its own message: the signer omits that port, so a config carrying
 *     it can never match. Silently stripping it is what broke https-on-:80.
 */
export function policyAuthority(value: string): string {
  const authority = String(value ?? '')
    .trim()
    .toLowerCase();

  if (!authority || authority.length > 253 || AUTHORITY_FORBIDDEN_RE.test(authority)) {
    throw new VerifyFailure('authority_invalid');
  }

  const portAt = authority.lastIndexOf(':');
  // No port at all, or a bracketed IPv6 host whose colons are inside it.
  if (portAt > authority.lastIndexOf(']')) {
    const port = authority.slice(portAt + 1);
    if (port === '443' || port === '80') {
      throw new VerifyFailure(
        'authority_invalid',
        `ERC-8128 authority must be configured the way it is signed, with the default port omitted: ` +
          `write "${authority.slice(0, portAt)}", not "${authority}"`
      );
    }
  }

  return authority;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify the `Content-Digest` header against the body bytes.
 *
 * The header value is replayed into the signature base VERBATIM (EM's
 * behaviour), not re-encoded: a signer that emitted non-canonical base64
 * padding signed its own bytes, and re-encoding would rebuild a base it never
 * signed.
 */
function verifyContentDigest(headerValue: string | undefined, rawBody: Uint8Array): void {
  if (!headerValue) throw new VerifyFailure('content_digest_required');
  const match = CONTENT_DIGEST_RE.exec(headerValue);
  if (!match) throw new VerifyFailure('content_digest_invalid');

  let provided: Uint8Array;
  try {
    provided = ethers.decodeBase64(match[1]);
  } catch {
    throw new VerifyFailure('content_digest_invalid');
  }
  const expected = ethers.getBytes(ethers.sha256(rawBody));
  if (!constantTimeEqual(provided, expected)) {
    throw new VerifyFailure('content_digest_mismatch');
  }
}

async function consumeNonce(
  noncePolicy: NoncePolicy,
  parsed: ParsedSignatureInput,
  wallet: string,
  skewFuture: number
): Promise<void> {
  if (!parsed.nonce) return;
  let outcome;
  try {
    outcome = await noncePolicy.store.consume(parsed.nonce, {
      wallet,
      chainId: parsed.chainId,
      ttlSeconds: parsed.expires - parsed.created + skewFuture,
      created: parsed.created,
      expires: parsed.expires,
    });
  } catch {
    // Store infrastructure failure is NOT a bad signature: it must answer
    // 503 + retry, never a terminal 401.
    throw new VerifyFailure('nonce_store_unavailable');
  }
  switch (outcome) {
    case 'ok':
      return;
    case 'unknown':
      throw new VerifyFailure('nonce_unknown');
    case 'replayed':
      throw new VerifyFailure('nonce_replayed');
    case 'expired':
      throw new VerifyFailure('nonce_expired');
    case 'unavailable':
      throw new VerifyFailure('nonce_store_unavailable');
    default:
      throw new VerifyFailure('nonce_store_unavailable', 'Nonce store returned an unknown outcome');
  }
}

/**
 * Verify an ERC-8128 signed HTTP request.
 *
 * Expected authentication failures come back as `{ ok: false, code, status,
 * retryable }` — they are values, not exceptions. Exceptions are reserved for
 * programmer error (e.g. a policy with no authority).
 */
export async function verifyRequest(
  req: VerifiableRequest,
  policy: VerifyPolicy
): Promise<VerifyResult> {
  if (!policy || typeof policy.authority !== 'string') {
    throw new X402Error(
      'verifyRequest requires policy.authority — a value, never derived from a client-controlled header.',
      'INVALID_CONFIG'
    );
  }

  const accept = policy.accept ?? 'accept-both';
  const componentsRule = policy.components ?? 'exact-ordered';
  const digestRule = policy.contentDigest ?? 'body-present';
  const maxValiditySec = policy.maxValiditySec ?? 300;
  const skewFuture = policy.clockSkew?.future ?? 30;
  const skewPastExpiry = policy.clockSkew?.pastExpiry ?? 0;
  const label = policy.label ?? 'eth';
  const now = policy.now ? policy.now() : Math.floor(Date.now() / 1000);

  let parsed: ParsedSignatureInput | undefined;

  const census = (outcome: 'ok' | Erc8128Code) => {
    if (!policy.onObservedProfile || !parsed) return;
    policy.onObservedProfile(parsed.observedProfile, {
      wallet: parsed.wallet,
      chainId: parsed.chainId,
      keyid: parsed.keyid,
      outcome,
    });
  };

  try {
    const header = headerLookup(req.headers);
    const authority = policyAuthority(policy.authority);

    // 1. Wire parsing. paramsRaw is kept verbatim from here on.
    parsed = parseSignatureInput(header('signature-input') ?? '', label);

    // 2. alg gate. Accepting a scheme we do not verify with would let a
    //    signature declare one algorithm and be checked under another.
    if (parsed.alg !== undefined && parsed.alg !== 'eip191') {
      throw new VerifyFailure('alg_unsupported');
    }
    if (accept === 'canonical') {
      if (parsed.alg === undefined) throw new VerifyFailure('alg_missing');
      if (parsed.keyid !== parsed.keyid.toLowerCase()) {
        throw new VerifyFailure('keyid_not_lowercase');
      }
    }
    if (accept === 'legacy' && parsed.alg !== undefined) {
      throw new VerifyFailure('alg_unsupported', 'This policy accepts only the legacy (no alg) profile');
    }

    // 3. Signature bytes for this label.
    const signature = parseSignatureHeader(header('signature') ?? '', parsed.label);

    // 4. Freshness.
    if (
      !Number.isSafeInteger(parsed.created) ||
      !Number.isSafeInteger(parsed.expires) ||
      parsed.expires <= parsed.created ||
      parsed.expires - parsed.created > maxValiditySec ||
      parsed.created > now + skewFuture ||
      now >= parsed.expires + skewPastExpiry
    ) {
      throw new VerifyFailure('signature_stale');
    }

    // 5. Chain allowlist (undefined ⇒ any chain, EM's posture).
    if (policy.allowedChainIds && !policy.allowedChainIds.includes(parsed.chainId)) {
      throw new VerifyFailure('chain_not_allowed');
    }

    const { path, query } = splitRequestTarget(req.url);
    const covered = parsed.covered;

    // 6. Nonce presence.
    const nonceMode = policy.nonce?.mode ?? 'required';
    if (policy.nonce && nonceMode === 'required' && !parsed.nonce) {
      throw new VerifyFailure('nonce_required');
    }

    // 7. Binding, for the lenient posture. The strict posture checks the
    //    exact list further down (it needs the digest decision first).
    if (componentsRule === 'request-bound-subset') {
      const missing = REQUEST_BOUND_COMPONENTS.some((c) => !covered.includes(c));
      if (missing || (query && !covered.includes('@query'))) {
        throw new VerifyFailure('class_bound_rejected');
      }
    }

    // 8. Nonce consumption, EM's order: before the expensive crypto, so two
    //    concurrent requests cannot both pass.
    const consumeOrder = policy.nonce?.consume ?? 'before-verify';
    if (policy.nonce && consumeOrder === 'before-verify') {
      await consumeNonce(policy.nonce, parsed, parsed.wallet, skewFuture);
    }

    // 9. Content-Digest.
    const digestHeader = header('content-digest');
    const rawBody = req.rawBody;
    let digestVerified = false;

    if (digestRule === 'non-idempotent-methods') {
      // MeshRelay's rule: every write must carry a raw body AND a digest.
      const requiresDigest = !IDEMPOTENT_METHODS.includes(req.method.toUpperCase());
      if (requiresDigest) {
        if (rawBody === undefined || digestHeader === undefined) {
          throw new VerifyFailure('content_digest_required');
        }
        verifyContentDigest(digestHeader, rawBody);
        digestVerified = true;
      }
    } else {
      // EM's rule, body-presence driven.
      //
      // `hasBody` is derived from the wire headers exactly as EM derives it,
      // PLUS a byte-level term. EM's header-only heuristic is sound only under
      // HTTP/1.1 framing, where a body cannot exist without content-length or
      // transfer-encoding; that is an environmental invariant of its uvicorn
      // deployment, not something the rule enforces. A shared SDK cannot
      // inherit an unstated precondition, so a non-empty body always counts as
      // a body here. The extra term never fires for HTTP/1.1 traffic.
      const contentLength = header('content-length');
      const headerSaysBody =
        (contentLength !== undefined && contentLength !== '0') ||
        header('transfer-encoding') !== undefined;
      const bytesSayBody = rawBody !== undefined && rawBody.length > 0;
      const hasBody = headerSaysBody || bytesSayBody;

      if (hasBody) {
        // CRY-001: the test is on the SIGNED list, not on header presence, so
        // an unsigned Content-Digest header can never satisfy it — and a body
        // attached to a bodyless-signed request is rejected here, before any
        // signature work.
        if (!covered.includes('content-digest')) {
          throw new VerifyFailure(
            'content_digest_required',
            'Bodied request MUST include content-digest in signed components'
          );
        }
        verifyContentDigest(digestHeader, rawBody ?? new Uint8Array(0));
        digestVerified = true;
      } else if (covered.includes('content-digest')) {
        // Bodyless request that covers the digest voluntarily — still verified.
        verifyContentDigest(digestHeader, rawBody ?? new Uint8Array(0));
        digestVerified = true;
      }
    }

    // 10. Exact covered list, for the strict posture.
    if (componentsRule === 'exact-ordered') {
      const expected = [...REQUEST_BOUND_COMPONENTS];
      if (query) expected.push('@query');
      if (digestVerified) expected.push('content-digest');
      if (
        covered.length !== expected.length ||
        covered.some((component, index) => component !== expected[index])
      ) {
        throw new VerifyFailure('components_invalid');
      }
    }

    // 11. Rebuild the base. The parameter substring is replayed VERBATIM.
    const signatureBase = buildSignatureBase({
      method: req.method,
      authority,
      path,
      query,
      contentDigest: digestHeader,
      covered,
      params: parsed.paramsRaw,
      headers: Object.fromEntries(
        covered
          .filter((c) => !c.startsWith('@') && c !== 'content-digest')
          .map((c) => [c.toLowerCase(), header(c) ?? ''])
      ),
    });

    // 12. EIP-191 recovery.
    let recovered: string | undefined;
    try {
      recovered = ethers.verifyMessage(signatureBase, ethers.hexlify(signature)).toLowerCase();
    } catch {
      recovered = undefined;
    }

    let via: 'eoa' | 'erc1271' = 'eoa';
    if (recovered !== parsed.wallet) {
      if (!policy.contractVerifier) {
        throw new VerifyFailure(
          recovered === undefined ? 'signature_invalid' : 'wallet_mismatch'
        );
      }
      let valid = false;
      try {
        valid = await policy.contractVerifier({
          address: parsed.wallet,
          chainId: parsed.chainId,
          messageHash: ethers.getBytes(ethers.keccak256(eip191Message(signatureBase))),
          signature,
        });
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new VerifyFailure(
          recovered === undefined ? 'signature_invalid' : 'wallet_mismatch'
        );
      }
      via = 'erc1271';
    }

    // 13. Nonce consumption, MeshRelay's order: only after every
    //     cryptographic and freshness check has passed.
    if (policy.nonce && consumeOrder === 'after-verify') {
      await consumeNonce(policy.nonce, parsed, parsed.wallet, skewFuture);
    }

    census('ok');
    return {
      ok: true,
      wallet: parsed.wallet,
      chainId: parsed.chainId,
      keyid: parsed.keyid,
      label: parsed.label,
      nonce: parsed.nonce,
      created: parsed.created,
      expires: parsed.expires,
      signatureBase,
      observedProfile: parsed.observedProfile,
      via,
    };
  } catch (error) {
    if (error instanceof VerifyFailure || error instanceof Erc8128ParseError) {
      census(error.code);
      return {
        ok: false,
        code: error.code,
        message: error.message,
        status: ERC8128_ERROR_STATUS[error.code],
        retryable: ERC8128_ERROR_RETRYABLE[error.code],
        observedProfile: parsed?.observedProfile,
      };
    }
    // Anything else is an SDK bug, not an authentication outcome. External
    // callbacks (nonce store, contract verifier) are already contained above.
    throw error;
  }
}
