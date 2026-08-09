/**
 * uvd-x402-sdk/erc8128 — the signer.
 *
 * Emits the F3-1 pinned wire format: covered components in the order
 * `@method @authority @path [@query] [content-digest]`, parameters in the
 * order `created;expires;nonce;keyid;alg`, `alg="eip191"` ALWAYS LAST, keyid
 * address ALWAYS lowercase (a checksummed keyid caused the v9.x silent-auth
 * incident), base joined with single LF and no trailing newline.
 *
 * Everything the fleet's 13 copies disagreed about is a value here, not a
 * branch: `profile` (emit `alg` or not), `contentDigest` (body-present vs
 * body-truthy), `headerCase` (Title-Case vs lowercase), `now` (injectable
 * clock, so tests never monkeypatch a module's globals).
 *
 * The nonce is REQUIRED and never invented. A silent local fallback makes a
 * server outage look like an auth bug; `createSignedFetch` exposes it as an
 * explicit `onNonceUnavailable` escape hatch instead.
 *
 * Private keys: `signRequest` takes one only as a convenience for scripts.
 * It must come from `process.env` / AWS Secrets Manager — never a literal.
 * The SDK does not read it from the environment, log it or persist it.
 */

import { ethers } from 'ethers';

import { X402Error } from '../types';
import type { SigningWalletAdapter } from '../wallet';
import {
  buildSignatureBase,
  buildSignatureParams,
  canonicalKeyid,
  canonicalParams,
  computeContentDigest,
  DEFAULT_CHAIN_ID,
  DEFAULT_LABEL,
  DEFAULT_VALIDITY_SEC,
  splitRequestTarget,
} from './core';

/** Wire generation to emit. `legacy-no-alg` exists only for byte-identical
 *  migration commits; a checksummed keyid is verify-only and never emitted. */
export type WireProfile = 'canonical' | 'legacy-no-alg';

/** When to attach a `Content-Digest`. */
export type ContentDigestEmit = 'body-present' | 'body-truthy';

export type HeaderCase = 'title' | 'lower';

export interface SignOptions {
  method: string;
  /** Full URL. `@authority`, `@path` and `@query` come from it. */
  url: string;
  /** Single-use nonce from the server. Required — the SDK never mints one. */
  nonce: string;
  /** Exact body bytes that will go on the wire, or null/undefined for none. */
  body?: string | Uint8Array | null;
  /** Default 8453 (Base). */
  chainId?: number;
  /** Default `'eth'`. */
  label?: string;
  /** Default 300; clamped to 300, the window every verifier caps at. */
  validitySec?: number;
  /** Default `'canonical'`. */
  profile?: WireProfile;
  /** Default `'body-present'`: an empty-string body still gets a digest. */
  contentDigest?: ContentDigestEmit;
  /** Default `'title'`. `'lower'` is for callers that merge into a lowercase
   *  header dict, where mixed casing silently loses keys. */
  headerCase?: HeaderCase;
  /** Injectable clock, seconds. */
  now?: () => number;
}

export interface Erc8128Headers {
  Signature: string;
  'Signature-Input': string;
  'Content-Digest'?: string;
}

export interface Erc8128LowerHeaders {
  signature: string;
  'signature-input': string;
  'content-digest'?: string;
}

export type Erc8128SignedHeaders = Erc8128Headers | Erc8128LowerHeaders;

export interface SignWithSignerOptions extends SignOptions {
  /** Signer address, any case — lowercased for the keyid. */
  address: string;
  /** EIP-191 personal_sign over the signature base; returns 0x + 130 hex. */
  signMessage(signatureBase: string): string | Promise<string>;
}

export interface SignWithWalletOptions extends SignOptions {
  wallet: SigningWalletAdapter;
}

export interface SignWithPrivateKeyOptions extends SignOptions {
  /** From process.env / Secrets Manager. Never a literal, never logged. */
  privateKey: string;
}

function hasBodyFor(body: SignOptions['body'], rule: ContentDigestEmit): boolean {
  if (body === undefined || body === null) return false;
  if (rule === 'body-present') return true;
  return typeof body === 'string' ? body.length > 0 : body.length > 0;
}

function toHeaders(
  headerCase: HeaderCase,
  signature: string,
  signatureInput: string,
  contentDigest?: string
): Erc8128SignedHeaders {
  if (headerCase === 'lower') {
    const lower: Erc8128LowerHeaders = {
      signature,
      'signature-input': signatureInput,
    };
    if (contentDigest) lower['content-digest'] = contentDigest;
    return lower;
  }
  const title: Erc8128Headers = {
    Signature: signature,
    'Signature-Input': signatureInput,
  };
  if (contentDigest) title['Content-Digest'] = contentDigest;
  return title;
}

export function signRequestWithSigner(
  options: SignWithSignerOptions & { headerCase: 'lower' }
): Promise<Erc8128LowerHeaders>;
export function signRequestWithSigner(
  options: SignWithSignerOptions & { headerCase?: 'title' }
): Promise<Erc8128Headers>;
export function signRequestWithSigner(
  options: SignWithSignerOptions
): Promise<Erc8128SignedHeaders>;
/**
 * Sign with a bare EIP-191 callback — for browser wallets, OWS vaults and any
 * out-of-process signer. The key never reaches this module.
 */
export async function signRequestWithSigner(
  options: SignWithSignerOptions
): Promise<Erc8128SignedHeaders> {
  const {
    address,
    signMessage,
    method,
    url,
    nonce,
    body,
    chainId = DEFAULT_CHAIN_ID,
    label = DEFAULT_LABEL,
    validitySec = DEFAULT_VALIDITY_SEC,
    profile = 'canonical',
    contentDigest: digestRule = 'body-present',
    headerCase = 'title',
    now,
  } = options;

  if (typeof nonce !== 'string' || !nonce) {
    throw new X402Error(
      'ERC-8128 signing requires a server-issued nonce; the SDK never mints one.',
      'INVALID_CONFIG'
    );
  }

  const { authority, path, query } = splitRequestTarget(url);
  if (!authority) {
    throw new X402Error('ERC-8128 signing requires an absolute URL.', 'INVALID_CONFIG');
  }

  const created = now ? now() : Math.floor(Date.now() / 1000);
  const expires = created + Math.min(Math.max(validitySec, 1), DEFAULT_VALIDITY_SEC);

  const covered = ['@method', '@authority', '@path'];
  if (query) covered.push('@query');

  let digest: string | undefined;
  if (hasBodyFor(body, digestRule)) {
    digest = computeContentDigest(body as string | Uint8Array);
    covered.push('content-digest');
  }

  const params = canonicalParams({
    created,
    expires,
    nonce,
    keyid: canonicalKeyid(chainId, address),
    alg: profile === 'legacy-no-alg' ? null : undefined,
  });

  const message = {
    method,
    authority,
    path,
    query,
    contentDigest: digest,
    covered,
    params,
  };
  const signatureBase = buildSignatureBase(message);

  const sigHex = await signMessage(signatureBase);
  const sigBytes = ethers.getBytes(sigHex.startsWith('0x') ? sigHex : `0x${sigHex}`);
  const sigB64 = ethers.encodeBase64(sigBytes);

  // Same builder the base's last line used, so the header and the signed bytes
  // cannot drift apart.
  const sigParams = buildSignatureParams(message);

  return toHeaders(headerCase, `${label}=:${sigB64}:`, `${label}=${sigParams}`, digest);
}

export function signRequestWithWallet(
  options: SignWithWalletOptions & { headerCase: 'lower' }
): Promise<Erc8128LowerHeaders>;
export function signRequestWithWallet(
  options: SignWithWalletOptions & { headerCase?: 'title' }
): Promise<Erc8128Headers>;
export function signRequestWithWallet(
  options: SignWithWalletOptions
): Promise<Erc8128SignedHeaders>;
/**
 * Sign with a {@link SigningWalletAdapter}. Only `getAddress()` and
 * `signMessage()` are used, so the key stays inside the adapter.
 */
export function signRequestWithWallet(
  options: SignWithWalletOptions
): Promise<Erc8128SignedHeaders> {
  const { wallet, ...rest } = options;
  return signRequestWithSigner({
    ...rest,
    address: wallet.getAddress(),
    signMessage: (signatureBase) => wallet.signMessage(signatureBase),
  });
}

export function signRequest(
  options: SignWithPrivateKeyOptions & { headerCase: 'lower' }
): Promise<Erc8128LowerHeaders>;
export function signRequest(
  options: SignWithPrivateKeyOptions & { headerCase?: 'title' }
): Promise<Erc8128Headers>;
export function signRequest(
  options: SignWithPrivateKeyOptions
): Promise<Erc8128SignedHeaders>;
/**
 * Sign with a raw private key. Convenience for scripts and bots that already
 * hold the key in the environment — prefer {@link signRequestWithWallet}.
 */
export function signRequest(options: SignWithPrivateKeyOptions): Promise<Erc8128SignedHeaders> {
  const { privateKey, ...rest } = options;
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(key);
  return signRequestWithSigner({
    ...rest,
    address: wallet.address,
    signMessage: (signatureBase) => wallet.signMessage(signatureBase),
  });
}

/**
 * Fetch a fresh single-use nonce.
 *
 * Throws on failure and never falls back to a locally minted value: a local
 * nonce authenticates against a first-use-wins store and is rejected by an
 * issuer-bound one, which turns a server blip into an auth mystery.
 */
export async function fetchNonce(apiBase: string, timeoutMs = 10000): Promise<string> {
  const url = `${apiBase.replace(/\/$/, '')}/api/v1/auth/erc8128/nonce`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Failed to fetch nonce: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as { nonce: string };
    if (!data || typeof data.nonce !== 'string' || !data.nonce) {
      throw new Error('Nonce endpoint returned no nonce');
    }
    return data.nonce;
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateSignedFetchConfig {
  /** API origin, e.g. `https://api.execution.market`. */
  apiBase: string;
  chainId?: number;
  /** From process.env / Secrets Manager. Never a literal. */
  privateKey?: string;
  wallet?: SigningWalletAdapter;
  profile?: WireProfile;
  contentDigest?: ContentDigestEmit;
  headerCase?: HeaderCase;
  /**
   * EXPLICIT escape hatch for a nonce-endpoint outage. The SDK never mints a
   * local nonce on its own; a caller that opts in owns the consequence (an
   * issuer-bound store will reject it).
   */
  onNonceUnavailable?: (error: unknown) => string | Promise<string>;
}

/**
 * A `fetch` wrapper that fetches a nonce and signs every call.
 *
 * Takes an origin-relative path; `apiBase` supplies the origin.
 */
export function createSignedFetch(
  config: CreateSignedFetchConfig
): (path: string, init?: RequestInit) => Promise<Response> {
  const { apiBase, chainId, privateKey, wallet, profile, contentDigest, headerCase } = config;

  if (!privateKey && !wallet) {
    throw new X402Error(
      'createSignedFetch requires a signer: pass privateKey or wallet.',
      'WALLET_NOT_CONNECTED'
    );
  }

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = `${apiBase.replace(/\/$/, '')}${path}`;
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body === undefined || init?.body === null ? undefined : String(init.body);

    let nonce: string;
    try {
      nonce = await fetchNonce(apiBase);
    } catch (error) {
      if (!config.onNonceUnavailable) throw error;
      nonce = await config.onNonceUnavailable(error);
    }

    const options: SignOptions = {
      method,
      url,
      nonce,
      body,
      chainId,
      profile,
      contentDigest,
      headerCase,
    };
    const signed = wallet
      ? await signRequestWithWallet({ ...options, wallet })
      : await signRequest({ ...options, privateKey: privateKey as string });

    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(signed)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    if (body !== undefined) {
      headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
    }

    return fetch(url, { ...init, headers, method });
  };
}
