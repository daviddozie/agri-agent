/**
 * uvd-x402-sdk - ERC-8128 HTTP Message Signature Signer
 *
 * Signs HTTP requests per ERC-8128 (Signed HTTP Requests with Ethereum,
 * RFC 9421 profile) so agents can authenticate against APIs that reject
 * API keys and only accept wallet signing (e.g. Execution Market, where
 * `EM_API_KEYS_ENABLED=false` in production).
 *
 * Flow:
 *   1. Fetch a fresh single-use nonce from the server (`fetchNonce`)
 *   2. Build the RFC 9421 signature base from request components
 *   3. Sign with EIP-191 personal_sign
 *   4. Produce `Signature` + `Signature-Input` (+ `Content-Digest`) headers
 *
 * Wire format: pinned by the F3-1 golden vectors (`src/erc8128.vectors.json`)
 * — `alg="eip191"` always emitted, keyid ALWAYS lowercase, params in the
 * order `created;expires;nonce;keyid;alg`. Byte-equality against the vectors
 * is enforced in `src/erc8128.test.ts`.
 *
 * Three signing entry points:
 *   - {@link signRequest} — raw private key (ethers Wallet), for scripts /
 *     bots that hold the key in env.
 *   - {@link signRequestWithWallet} — any {@link SigningWalletAdapter}
 *     (EnvKeyAdapter, OWSWalletAdapter, custom); only `getAddress()` and
 *     `signMessage()` are used, the key never leaves the adapter.
 *   - {@link signRequestWithSigner} — callback-based, for browser wallets or
 *     out-of-process signers that expose a bare EIP-191 personal_sign.
 *
 * @example Sign a single request
 * ```typescript
 * import { signRequest, fetchNonce } from 'uvd-x402-sdk';
 *
 * const nonce = await fetchNonce('https://api.execution.market');
 * const headers = await signRequest({
 *   privateKey: process.env.WALLET_PRIVATE_KEY!,
 *   method: 'POST',
 *   url: 'https://api.execution.market/api/v1/tasks',
 *   body: '{"title": "test"}',
 *   nonce,
 *   chainId: 8453,
 * });
 * // headers = { Signature: '...', 'Signature-Input': '...', 'Content-Digest': '...' }
 * ```
 *
 * @example Auto-signing fetch wrapper
 * ```typescript
 * import { createSignedFetch, EnvKeyAdapter } from 'uvd-x402-sdk';
 *
 * const signedFetch = createSignedFetch({
 *   wallet: new EnvKeyAdapter(), // or privateKey: '...'
 *   apiBase: 'https://api.execution.market',
 * });
 *
 * const resp = await signedFetch('/api/v1/tasks', {
 *   method: 'POST',
 *   body: JSON.stringify({ title: 'test' }),
 * });
 * ```
 *
 * Reference:
 *   - ERC-8128: https://eip.tools/eip/8128
 *   - RFC 9421: https://www.rfc-editor.org/rfc/rfc9421
 *   - ERC-191: https://eips.ethereum.org/EIPS/eip-191
 */

import { ethers } from 'ethers';
import { X402Error } from './types';
import type { SigningWalletAdapter } from './wallet';

/** Default label for ERC-8128 signatures */
const DEFAULT_LABEL = 'eth';

/** Signature algorithm parameter — pinned by F3-1 (always emitted) */
const ALG = 'eip191';

/** Default validity window (seconds) — server policy typically caps at 300 */
const DEFAULT_VALIDITY_SEC = 300;

/** Default EVM chain ID for the keyid (Base mainnet, the production auth chain) */
const DEFAULT_CHAIN_ID = 8453;

/**
 * Request components shared by every ERC-8128 signing entry point.
 */
export interface ERC8128RequestOptions {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full URL of the request (authority + path + query are covered) */
  url: string;
  /**
   * Request body (for POST/PUT/PATCH). Omit for bodyless requests.
   * Must be byte-identical to what is sent on the wire — the
   * `Content-Digest` covers it.
   */
  body?: string;
  /** Single-use nonce from the server. Required by most servers. */
  nonce?: string;
  /** EVM chain ID for the keyid (default: 8453 = Base) */
  chainId?: number;
  /** Signature label (default: "eth") */
  label?: string;
  /** Signature validity window in seconds (default: 300) */
  validitySec?: number;
}

export interface SignRequestOptions extends ERC8128RequestOptions {
  /** Hex-encoded private key (with or without 0x prefix) */
  privateKey: string;
}

export interface SignRequestWithSignerOptions extends ERC8128RequestOptions {
  /** Signer address (any case — lowercased for the keyid per F3-1) */
  address: string;
  /**
   * EIP-191 personal_sign callback over the RFC 9421 signature base.
   * Must return the 65-byte signature (r||s||v) as 0x-prefixed hex.
   * The private key never leaves the signer (OWS vault, browser wallet).
   */
  signMessage: (signatureBase: string) => Promise<string> | string;
}

export interface SignatureHeaders {
  Signature: string;
  'Signature-Input': string;
  'Content-Digest'?: string;
}

/**
 * Configuration for {@link createSignedFetch}. Provide exactly one signer:
 * a raw `privateKey` or a `wallet` adapter.
 */
export interface CreateSignedFetchConfig {
  /** Origin of the API (e.g. "https://api.execution.market") */
  apiBase: string;
  /** EVM chain ID for the keyid (default: 8453 = Base) */
  chainId?: number;
  /** Hex-encoded private key (with or without 0x prefix) */
  privateKey?: string;
  /** SigningWalletAdapter — the key never leaves the adapter */
  wallet?: SigningWalletAdapter;
}

/**
 * Sign an HTTP request per ERC-8128 with a raw private key.
 *
 * Thin wrapper over {@link signRequestWithSigner} using an ethers Wallet.
 *
 * @returns Headers to merge into the request (Signature, Signature-Input, Content-Digest).
 */
export async function signRequest(options: SignRequestOptions): Promise<SignatureHeaders> {
  const key = options.privateKey.startsWith('0x')
    ? options.privateKey
    : `0x${options.privateKey}`;
  const wallet = new ethers.Wallet(key);
  return signRequestWithSigner({
    address: wallet.address,
    signMessage: (signatureBase) => wallet.signMessage(signatureBase),
    method: options.method,
    url: options.url,
    body: options.body,
    nonce: options.nonce,
    chainId: options.chainId,
    label: options.label,
    validitySec: options.validitySec,
  });
}

/**
 * Sign an HTTP request per ERC-8128 with a {@link SigningWalletAdapter}.
 *
 * Only `getAddress()` and `signMessage()` (EIP-191 personal_sign) are used —
 * the private key never leaves the adapter. Works with EnvKeyAdapter,
 * OWSWalletAdapter, or any custom adapter.
 *
 * @returns Headers to merge into the request (Signature, Signature-Input, Content-Digest).
 */
export async function signRequestWithWallet(
  wallet: SigningWalletAdapter,
  options: ERC8128RequestOptions
): Promise<SignatureHeaders> {
  return signRequestWithSigner({
    ...options,
    address: wallet.getAddress(),
    signMessage: (signatureBase) => wallet.signMessage(signatureBase),
  });
}

/**
 * Sign an HTTP request per ERC-8128 with a signing callback.
 *
 * For signers that never expose the raw key (OWS vault, browser wallets):
 * the callback receives the RFC 9421 signature base and returns the EIP-191
 * personal_sign signature as 0x-hex.
 *
 * @returns Headers to merge into the request (Signature, Signature-Input, Content-Digest).
 */
export async function signRequestWithSigner(
  options: SignRequestWithSignerOptions
): Promise<SignatureHeaders> {
  const {
    address: rawAddress,
    signMessage,
    method,
    url,
    body,
    nonce,
    chainId = DEFAULT_CHAIN_ID,
    label = DEFAULT_LABEL,
    validitySec = DEFAULT_VALIDITY_SEC,
  } = options;

  // CRITICAL: lowercase — checksummed keyid caused the v9.x silent-auth INC.
  const address = rawAddress.toLowerCase();

  const parsed = new URL(url);
  const authority = parsed.host;
  const path = parsed.pathname || '/';
  const query = parsed.search || undefined; // includes '?' prefix

  const now = Math.floor(Date.now() / 1000);
  const created = now;
  const expires = now + validitySec;

  const keyid = `erc8128:${chainId}:${address}`;

  // Determine covered components
  const covered: string[] = ['@method', '@authority', '@path'];
  if (query) {
    covered.push('@query');
  }

  const headers: SignatureHeaders = {
    Signature: '',
    'Signature-Input': '',
  };

  if (body !== undefined) {
    const digest = computeContentDigest(body);
    headers['Content-Digest'] = digest;
    covered.push('content-digest');
  }

  // Build signature base
  const sigBase = buildSignatureBase({
    method,
    authority,
    path,
    query,
    contentDigest: headers['Content-Digest'],
    covered,
    created,
    expires,
    nonce,
    keyid,
  });

  // EIP-191 personal_sign via the callback — the key stays in the signer
  const sigHex = await signMessage(sigBase);

  // Encode signature as base64 (RFC 8941 byte sequence)
  const sigBytes = ethers.getBytes(sigHex.startsWith('0x') ? sigHex : `0x${sigHex}`);
  const sigB64 = ethers.encodeBase64(sigBytes);

  // Build headers
  const sigParams = buildSignatureParams({ covered, created, expires, nonce, keyid });

  headers.Signature = `${label}=:${sigB64}:`;
  headers['Signature-Input'] = `${label}=${sigParams}`;

  return headers;
}

/**
 * Fetch a fresh single-use nonce from the server.
 *
 * @param apiBase - Origin of the API (e.g. "https://api.execution.market")
 *   — the `/api/v1/auth/erc8128/nonce` path is appended here.
 * @param timeoutMs - Request timeout in milliseconds (default: 10000).
 * @returns The nonce value (single-use, short TTL — fetch one per request).
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
    return data.nonce;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a fetch wrapper that auto-signs requests with ERC-8128
 * (nonce fetch + signature headers on every call).
 *
 * @example
 * ```typescript
 * const signedFetch = createSignedFetch({
 *   wallet: new EnvKeyAdapter(),        // or privateKey: '...'
 *   apiBase: 'https://api.execution.market',
 *   chainId: 8453,
 * });
 *
 * const resp = await signedFetch('/api/v1/tasks', {
 *   method: 'POST',
 *   body: JSON.stringify({ title: 'test' }),
 * });
 * ```
 */
export function createSignedFetch(config: CreateSignedFetchConfig) {
  const { apiBase, chainId, privateKey, wallet } = config;

  if (!privateKey && !wallet) {
    throw new X402Error(
      'createSignedFetch requires a signer: pass privateKey or wallet.',
      'WALLET_NOT_CONNECTED'
    );
  }

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = `${apiBase.replace(/\/$/, '')}${path}`;
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? String(init.body) : undefined;

    // Fresh single-use nonce per request
    const nonce = await fetchNonce(apiBase);

    // Sign request
    const requestOptions: ERC8128RequestOptions = { method, url, body, nonce, chainId };
    const sigHeaders = wallet
      ? await signRequestWithWallet(wallet, requestOptions)
      : await signRequest({ ...requestOptions, privateKey: privateKey! });

    // Merge headers
    const headers = new Headers(init?.headers);
    headers.set('Signature', sigHeaders.Signature);
    headers.set('Signature-Input', sigHeaders['Signature-Input']);
    if (sigHeaders['Content-Digest']) {
      headers.set('Content-Digest', sigHeaders['Content-Digest']);
    }
    if (body) {
      headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
    }

    return fetch(url, { ...init, headers, method });
  };
}

// ---------------------------------------------------------------------------
// Signature-base construction (exported: browser / out-of-process signers
// build the exact same base and sign it elsewhere)
// ---------------------------------------------------------------------------

function computeContentDigest(body: string): string {
  const hash = ethers.sha256(ethers.toUtf8Bytes(body));
  // hash is 0x-prefixed hex, convert to raw bytes then base64
  const b64 = ethers.encodeBase64(ethers.getBytes(hash));
  return `sha-256=:${b64}:`;
}

export interface SignatureBaseParams {
  method: string;
  authority: string;
  path: string;
  query?: string;
  contentDigest?: string;
  covered: string[];
  created: number;
  expires: number;
  nonce?: string;
  keyid: string;
}

/**
 * Build the RFC 9421 signature base — the exact string that gets EIP-191
 * personal_signed. Exported so external signers (OWS, browser) can reproduce
 * it byte-for-byte; pinned by the F3-1 golden vectors.
 */
export function buildSignatureBase(params: SignatureBaseParams): string {
  const lines: string[] = [];

  for (const component of params.covered) {
    switch (component) {
      case '@method':
        lines.push(`"@method": ${params.method.toUpperCase()}`);
        break;
      case '@authority':
        lines.push(`"@authority": ${params.authority}`);
        break;
      case '@path':
        lines.push(`"@path": ${params.path}`);
        break;
      case '@query':
        lines.push(`"@query": ${params.query || '?'}`);
        break;
      case 'content-digest':
        lines.push(`"content-digest": ${params.contentDigest || ''}`);
        break;
    }
  }

  const sigParams = buildSignatureParams({
    covered: params.covered,
    created: params.created,
    expires: params.expires,
    nonce: params.nonce,
    keyid: params.keyid,
  });
  lines.push(`"@signature-params": ${sigParams}`);

  return lines.join('\n');
}

export interface SignatureParamsInput {
  covered: string[];
  created: number;
  expires: number;
  nonce?: string;
  keyid: string;
}

/**
 * Build the `@signature-params` value per RFC 9421, in the pinned order
 * `created;expires;nonce;keyid;alg` (F3-1).
 */
export function buildSignatureParams(params: SignatureParamsInput): string {
  const compStr = params.covered.map((c) => `"${c}"`).join(' ');
  const parts: string[] = [`(${compStr})`];
  parts.push(`created=${params.created}`);
  parts.push(`expires=${params.expires}`);
  if (params.nonce) {
    parts.push(`nonce="${params.nonce}"`);
  }
  parts.push(`keyid="${params.keyid}"`);
  parts.push(`alg="${ALG}"`);
  return parts.join(';');
}
