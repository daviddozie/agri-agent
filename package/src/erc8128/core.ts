/**
 * uvd-x402-sdk/erc8128 — L0, the pure layer.
 *
 * Everything here is deterministic: no clock, no network, no nonce store, no
 * private key. Only `ethers` is imported, and only for hashing/base64 (the
 * package already depends on it, and it works identically in Node and the
 * browser).
 *
 * THE LOAD-BEARING RULE OF THIS FILE:
 *
 *   The verifier must NEVER re-serialise `@signature-params`.
 *
 * `parseSignatureInput()` keeps the parameter substring VERBATIM from the
 * `Signature-Input` header (`paramsRaw`) and `buildSignatureBase()` accepts
 * that substring in place of a parameter list. That single byte path is what
 * makes `alg`-present, `alg`-absent, checksummed keyids, unusual parameter
 * ordering and any future RFC 9421 parameter verify with no flags at all.
 * An anchored regex that enumerates the allowed parameters is exactly the bug
 * this module exists to delete — do not reintroduce one.
 *
 * Wire contract: F3-1 pinned format + F3-3 additive cases. See
 * `erc8128.f3-1.json` / `erc8128.f3-3.json`, shipped inside this package.
 *
 * Reference:
 *   - ERC-8128: https://eip.tools/eip/8128
 *   - RFC 9421: https://www.rfc-editor.org/rfc/rfc9421
 *   - RFC 9530 (Content-Digest): https://www.rfc-editor.org/rfc/rfc9530
 */

import { ethers } from 'ethers';

import type { Erc8128Code } from './errors';

/** Generation of the wire contract this module implements. */
export const WIRE_CONTRACT_VERSION = 'F3-3';

/** Default signature label (F3-1). */
export const DEFAULT_LABEL = 'eth';

/** The only algorithm this module signs with or verifies. */
export const ALG_EIP191 = 'eip191';

/** Default validity window in seconds; server policy caps at the same value. */
export const DEFAULT_VALIDITY_SEC = 300;

/** Default EVM chain id for the keyid (Base mainnet). */
export const DEFAULT_CHAIN_ID = 8453;

/** `erc8128:<decimal chain id>:<0x + 40 hex>` — chain id is bare decimal. */
export const KEYID_RE = /^erc8128:(\d+):(0x[0-9a-fA-F]{40})$/;

const WALLET_RE = /^0x[0-9a-f]{40}$/;

/** Components that make a signature request-bound rather than class-bound. */
export const REQUEST_BOUND_COMPONENTS: readonly string[] = ['@method', '@authority', '@path'];

/**
 * Parse failure of a wire value. Thrown by the pure parsers; `verifyRequest`
 * catches it and turns it into a `VerifyResult` — it never escapes there.
 */
export class Erc8128ParseError extends Error {
  constructor(
    public readonly code: Erc8128Code,
    message: string
  ) {
    super(message);
    this.name = 'Erc8128ParseError';
  }
}

/** One `@signature-params` parameter. Numbers go bare, strings get quoted. */
export interface SigParam {
  readonly name: string;
  readonly value: string | number;
}

/**
 * Everything needed to build one RFC 9421 signature base.
 *
 * `params` is either a parameter LIST (the signer builds one) or the VERBATIM
 * parameter substring taken off the wire (the verifier passes one). Both feed
 * the same builder — that is the whole design.
 */
export interface CanonicalMessage {
  /** HTTP method; upper-cased by the builder. */
  readonly method: string;
  /** host[:port]. Never a URL, never derived from a client-controlled header. */
  readonly authority: string;
  /** Origin-form path; `/` when empty. */
  readonly path: string;
  /** Query string INCLUDING the leading `?`. Omit when there is none. */
  readonly query?: string;
  /** Full `sha-256=:…:` value, verbatim as it appears on the wire. */
  readonly contentDigest?: string;
  /** Covered component ids, in signing order. The order is load-bearing. */
  readonly covered: readonly string[];
  /** Parameter list (signer) or verbatim parameter substring (verifier). */
  readonly params: readonly SigParam[] | string;
  /**
   * Values for covered components that are plain header fields (anything that
   * is not a `@`-component or `content-digest`). Keys must be lowercase.
   * A covered header that is absent here resolves to the empty string, which
   * is what EM's verifier does.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Wire generation an emitter produced, as observed by the verifier. */
export type ObservedProfile = 'canonical' | 'legacy_no_alg' | 'legacy_alg_checksum_keyid';

/** A parsed `Signature-Input` value. `paramsRaw` is the byte path. */
export interface ParsedSignatureInput {
  readonly label: string;
  readonly covered: readonly string[];
  /** VERBATIM parameter substring, `(…);created=…`. Never re-serialised. */
  readonly paramsRaw: string;
  readonly created: number;
  readonly expires: number;
  readonly nonce?: string;
  /** Original case — it is re-emitted into the signed base as-is. */
  readonly keyid: string;
  readonly chainId: number;
  /** Address from the keyid, lowercased for comparison. */
  readonly wallet: string;
  readonly alg?: string;
  readonly observedProfile: ObservedProfile;
}

// ---------------------------------------------------------------------------
// Signature base construction
// ---------------------------------------------------------------------------

function formatParam(param: SigParam): string {
  return typeof param.value === 'number'
    ? `${param.name}=${param.value}`
    : `${param.name}="${param.value}"`;
}

/**
 * Build the `@signature-params` value.
 *
 * When `params` is a string it is the verbatim substring off the wire and is
 * returned untouched — it already contains its own covered-component list.
 */
export function buildSignatureParams(
  message: Pick<CanonicalMessage, 'covered' | 'params'>
): string {
  if (typeof message.params === 'string') return message.params;
  const compStr = message.covered.map((c) => `"${c}"`).join(' ');
  const parts = [`(${compStr})`, ...message.params.map(formatParam)];
  return parts.join(';');
}

/**
 * Build the RFC 9421 signature base — the exact string that is EIP-191
 * personal_signed. Lines are joined with a single LF, with no trailing
 * newline; each line is `"<id>": <value>` with exactly one space.
 */
export function buildSignatureBase(message: CanonicalMessage): string {
  const lines: string[] = [];

  for (const component of message.covered) {
    switch (component) {
      case '@method':
        lines.push(`"@method": ${message.method.toUpperCase()}`);
        break;
      case '@authority':
        lines.push(`"@authority": ${message.authority}`);
        break;
      case '@path':
        lines.push(`"@path": ${message.path}`);
        break;
      case '@query':
        // `?` is the present-but-empty fallback. Only a verifier reaches it —
        // canonical signers omit @query entirely when there is no query
        // string (spec §3.3) — but EM emits it, so it stays for bug-compat.
        lines.push(`"@query": ${message.query || '?'}`);
        break;
      case 'content-digest':
        lines.push(`"content-digest": ${message.contentDigest || ''}`);
        break;
      default:
        lines.push(`"${component}": ${message.headers?.[component.toLowerCase()] ?? ''}`);
        break;
    }
  }

  lines.push(`"@signature-params": ${buildSignatureParams(message)}`);
  return lines.join('\n');
}

/**
 * The covered-component list a canonical signer emits for a request.
 * `@query` only when the URL carries one, `content-digest` only when the
 * request carries a body.
 */
export function selectCovered(input: { url: string; hasBody: boolean }): string[] {
  const covered = [...REQUEST_BOUND_COMPONENTS];
  const { query } = splitRequestTarget(input.url);
  if (query) covered.push('@query');
  if (input.hasBody) covered.push('content-digest');
  return covered;
}

/**
 * The pinned parameter list: `created;expires;nonce?;keyid;alg`.
 * `alg` is ALWAYS last (em_plugin_sdk/erc8128.py:262-278); pass `alg: null`
 * to emit the legacy generation that omits it.
 */
export function canonicalParams(input: {
  created: number;
  expires: number;
  keyid: string;
  nonce?: string;
  alg?: string | null;
}): SigParam[] {
  const params: SigParam[] = [
    { name: 'created', value: input.created },
    { name: 'expires', value: input.expires },
  ];
  if (input.nonce) params.push({ name: 'nonce', value: input.nonce });
  params.push({ name: 'keyid', value: input.keyid });
  const alg = input.alg === undefined ? ALG_EIP191 : input.alg;
  if (alg) params.push({ name: 'alg', value: alg });
  return params;
}

/** RFC 9530 `Content-Digest` value over the exact body bytes. */
export function computeContentDigest(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? ethers.toUtf8Bytes(body) : body;
  const b64 = ethers.encodeBase64(ethers.getBytes(ethers.sha256(bytes)));
  return `sha-256=:${b64}:`;
}

/**
 * `erc8128:<chainId>:<address>` with the address ALWAYS lowercased — a
 * checksummed keyid caused the v9.x silent-auth incident.
 */
export function canonicalKeyid(chainId: number, address: string): string {
  return `erc8128:${chainId}:${address.toLowerCase()}`;
}

/**
 * Length of the EIP-191 prefix counter for a signature base: the length in
 * UTF-8 BYTES, never UTF-16 code units.
 *
 * Named on purpose. EM's ERC-1271 path computes it with `len(message)` on a
 * Python `str` (code points), so its EOA and contract paths hash different
 * messages the moment a base carries one non-ASCII byte. This module uses
 * bytes on every path.
 */
export function eip191ByteLength(base: string): number {
  return ethers.toUtf8Bytes(base).length;
}

/** The exact bytes EIP-191 (version 0x45) hashes for a signature base. */
export function eip191Message(base: string): Uint8Array {
  const body = ethers.toUtf8Bytes(base);
  const prefix = ethers.toUtf8Bytes(`\x19Ethereum Signed Message:\n${body.length}`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

// ---------------------------------------------------------------------------
// Request target
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443', ws: '80', wss: '443' };

/**
 * RFC 9421 §2.2.3 `@authority`: lowercase, and OMIT the port when it is the
 * default FOR THAT SCHEME (443 for https/wss, 80 for http/ws). A non-default
 * port is part of the authority and is kept — including `:80` under https and
 * `:443` under http, which are ordinary ports there.
 *
 * The transform is IDEMPOTENT — an authority that is already in this form
 * comes back unchanged — which is why applying it to live traffic changes no
 * signature. The alternative, replaying `netloc` verbatim, makes the SAME
 * request written two ways (`https://host/x` and `https://host:443/x`) sign
 * two different bases.
 *
 * `scheme` is REQUIRED, and deliberately so. This is the URL-derived path and
 * nothing else: the signer has the request URL, the verifier derives the
 * authority from the incoming request, so a scheme is always in hand. The
 * verifier's CONFIGURED authority does NOT come through here — it carries no
 * scheme, so "the default port" has no unique answer for it, and guessing one
 * breaks two real deployment shapes (`https` on `:80`, `http` on `:443`).
 * That value goes through `policyAuthority()` in the verifier, which never
 * touches ports at all.
 */
export function canonicalAuthority(authority: string, scheme: string): string {
  const lower = String(authority ?? '')
    .trim()
    .toLowerCase();
  const portAt = lower.lastIndexOf(':');
  // No port at all, or a bracketed IPv6 host whose colons are inside it.
  if (portAt <= lower.lastIndexOf(']')) return lower;

  const port = lower.slice(portAt + 1);
  const isDefault = port === DEFAULT_PORTS[String(scheme ?? '').trim().toLowerCase()];
  return isDefault ? lower.slice(0, portAt) : lower;
}

/**
 * Split a URL (absolute or origin-relative) into the `@authority`, `@path`
 * and `@query` values.
 *
 * The path and query are taken RAW: `new URL()` is deliberately avoided
 * because it percent-encodes and normalises them, which would change the
 * bytes relative to what the client signed. A lone `?` counts as no query,
 * matching every emitter in the fleet.
 *
 * The authority IS normalised, per RFC 9421 §2.2.3: lowercased, with the
 * scheme's default port removed. That is what a server sees in `Host` and
 * what every verifier compares against — `urlparse().netloc` keeps an
 * explicit `:443`, so a URL written with the default port would otherwise
 * sign an authority no verifier ever reproduces.
 */
export function splitRequestTarget(url: string): {
  authority?: string;
  path: string;
  query?: string;
} {
  let rest = url;
  let authority: string | undefined;

  const absolute = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (absolute) {
    authority = canonicalAuthority(absolute[2], absolute[1]);
    rest = url.slice(absolute[0].length);
  }

  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);

  const mark = rest.indexOf('?');
  const path = (mark >= 0 ? rest.slice(0, mark) : rest) || '/';
  const query = mark >= 0 ? rest.slice(mark) : '';

  return { authority, path, query: query.length > 1 ? query : undefined };
}

// ---------------------------------------------------------------------------
// RFC 8941 structured-field parsing (the subset ERC-8128 needs)
// ---------------------------------------------------------------------------

interface DictMember {
  label: string;
  /** Verbatim member value, trimmed of surrounding whitespace. */
  value: string;
}

/**
 * Split a structured dictionary into ordered members, respecting quoted
 * strings and parentheses so a comma inside either does not split a member.
 */
function splitDictMembers(raw: string): DictMember[] {
  const members: DictMember[] = [];
  let i = 0;

  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === ',')) i++;
    if (i >= raw.length) break;

    const eq = raw.indexOf('=', i);
    if (eq < 0) break;
    const label = raw.slice(i, eq).trim();

    let j = eq + 1;
    let depth = 0;
    let inQuotes = false;
    for (; j < raw.length; j++) {
      const ch = raw[j];
      if (inQuotes) {
        if (ch === '\\') j++;
        else if (ch === '"') inQuotes = false;
        continue;
      }
      if (ch === '"') inQuotes = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth <= 0) break;
    }

    members.push({ label, value: raw.slice(eq + 1, j).trim() });
    i = j + 1;
  }

  return members;
}

/** Pick the member a policy label selects. `'any'` prefers `eth`, else first. */
function selectMember(members: DictMember[], label: string): DictMember | undefined {
  if (label === 'any') {
    return members.find((m) => m.label === DEFAULT_LABEL) ?? members[0];
  }
  return members.find((m) => m.label === label);
}

function unquote(value: string): string {
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

/** Split `;a=1;b="x"` respecting quotes. Returns raw `name=value` chunks. */
function splitParamChunks(rest: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inQuotes) {
      current += ch;
      if (ch === '\\' && i + 1 < rest.length) {
        current += rest[++i];
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Parse a `Signature-Input` value.
 *
 * Deliberately NOT an anchored regex over a fixed parameter list: unknown and
 * reordered parameters must survive, because the verifier replays the whole
 * substring into the signed base. Only the parameters this module needs for
 * POLICY (`created`, `expires`, `nonce`, `keyid`, `alg`) are extracted.
 *
 * @param value - raw header value
 * @param label - `'eth'` (default), a specific label, or `'any'`
 * @throws {Erc8128ParseError} on a malformed value
 */
export function parseSignatureInput(value: string, label = DEFAULT_LABEL): ParsedSignatureInput {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Erc8128ParseError('signature_input_invalid', 'Missing Signature-Input header');
  }

  const member = selectMember(splitDictMembers(value), label);
  if (!member || !member.label) {
    throw new Erc8128ParseError('signature_input_invalid', 'Invalid Signature-Input format');
  }

  const paramsRaw = member.value;
  if (!paramsRaw.startsWith('(')) {
    throw new Erc8128ParseError('signature_input_invalid', 'Invalid Signature-Input format');
  }
  const close = paramsRaw.indexOf(')');
  if (close < 0) {
    throw new Erc8128ParseError('signature_input_invalid', 'Invalid covered component list');
  }

  const inner = paramsRaw.slice(1, close).trim();
  const covered = [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  // Reject anything that is not a plain list of quoted tokens: an unquoted
  // token, or a per-component parameter, would resolve to bytes we do not
  // reproduce.
  if (covered.map((c) => `"${c}"`).join(' ') !== inner) {
    throw new Erc8128ParseError('signature_input_invalid', 'Invalid covered component list');
  }

  const params = new Map<string, string | number | boolean>();
  for (const chunk of splitParamChunks(paramsRaw.slice(close + 1))) {
    const eq = chunk.indexOf('=');
    if (eq < 0) {
      params.set(chunk, true);
      continue;
    }
    const name = chunk.slice(0, eq).trim();
    const raw = chunk.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      params.set(name, unquote(raw));
    } else if (/^-?\d+$/.test(raw)) {
      params.set(name, Number(raw));
    } else {
      params.set(name, raw);
    }
  }

  const created = params.get('created');
  const expires = params.get('expires');
  if (typeof created !== 'number' || typeof expires !== 'number') {
    throw new Erc8128ParseError(
      'signature_input_invalid',
      'Missing or non-integer created/expires parameter'
    );
  }

  const keyidValue = params.get('keyid');
  if (typeof keyidValue !== 'string') {
    throw new Erc8128ParseError('signature_input_invalid', 'Missing keyid parameter');
  }
  const keyidMatch = KEYID_RE.exec(keyidValue);
  if (!keyidMatch) {
    throw new Erc8128ParseError(
      'signature_input_invalid',
      `Invalid keyid format: ${keyidValue}`
    );
  }

  const nonceValue = params.get('nonce');
  const algValue = params.get('alg');
  if (algValue !== undefined && typeof algValue !== 'string') {
    throw new Erc8128ParseError('signature_input_invalid', 'Invalid alg parameter');
  }

  const address = keyidMatch[2];
  const wallet = address.toLowerCase();
  if (!WALLET_RE.test(wallet)) {
    throw new Erc8128ParseError('wallet_invalid', 'Invalid wallet in ERC-8128 keyid');
  }

  return {
    label: member.label,
    covered,
    paramsRaw,
    created,
    expires,
    nonce: typeof nonceValue === 'string' ? nonceValue : undefined,
    keyid: keyidValue,
    chainId: Number(keyidMatch[1]),
    wallet,
    alg: algValue,
    observedProfile: classifyProfile(algValue, address),
  };
}

/**
 * Which wire generation produced this signature. `alg` absence wins over a
 * checksummed keyid: it is the older split and the one the deprecation ladder
 * counts.
 */
function classifyProfile(alg: string | undefined, address: string): ObservedProfile {
  if (alg === undefined) return 'legacy_no_alg';
  if (address !== address.toLowerCase()) return 'legacy_alg_checksum_keyid';
  return 'canonical';
}

/**
 * Parse a `Signature` header into the raw 65 bytes (r‖s‖v, v = 27/28).
 *
 * Standard base64 alphabet with padding — base64url is NOT accepted (spec
 * §3.6).
 *
 * @throws {Erc8128ParseError} when the header, the label or the length is wrong
 */
export function parseSignatureHeader(value: string, label = DEFAULT_LABEL): Uint8Array {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Erc8128ParseError('signature_invalid', 'Missing Signature header');
  }

  const member = selectMember(splitDictMembers(value), label);
  if (!member) {
    throw new Erc8128ParseError('signature_invalid', `No signature found for label '${label}'`);
  }

  const match = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(member.value);
  if (!match) {
    throw new Erc8128ParseError('signature_invalid', 'Invalid Signature header');
  }

  let bytes: Uint8Array;
  try {
    bytes = ethers.decodeBase64(match[1]);
  } catch {
    throw new Erc8128ParseError('signature_invalid', 'Invalid Signature base64 encoding');
  }
  if (bytes.length !== 65) {
    throw new Erc8128ParseError('signature_invalid', 'Ethereum signature must be 65 bytes');
  }
  return bytes;
}

/**
 * Lowercase wallet address from a `Signature-Input` value, or `null` when it
 * cannot be parsed. Never throws — this is the primitive a rate-limit
 * middleware needs BEFORE any signature work, so it must not be able to break
 * the request path.
 */
export function extractKeyidWallet(signatureInput: string): string | null {
  try {
    return parseSignatureInput(signatureInput, 'any').wallet;
  } catch {
    return null;
  }
}
