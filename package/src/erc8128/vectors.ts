/**
 * uvd-x402-sdk/erc8128 — the conformance vectors, shipped INSIDE the package.
 *
 * They travel as an inlined string (see `vectors.generated.ts`) rather than a
 * file read, because the package is dual CJS+ESM: `__dirname` does not exist
 * in the `.mjs` chunk and `import.meta.url` is a syntax error in the `.js`
 * one. Build-time inlining is the only form that works in both, and it is the
 * only way a consumer's CI can run `runConformance()` against the SDK version
 * it actually installed.
 *
 * `CONFORMANCE_SHA256` covers the embedded bytes, so hand-editing either copy
 * fails the suite before a single signature is produced.
 */

import {
  CONFORMANCE_SHA256,
  F3_1_VECTORS_JSON,
  F3_3_VECTORS_JSON,
} from './vectors.generated';

export interface Erc8128VectorCase {
  signature_base: string;
  headers: {
    Signature: string;
    'Signature-Input': string;
    'Content-Digest'?: string;
  };
}

export interface Erc8128RequestSpec {
  method: string;
  url: string;
  /** `null` = no body at all; `""` = a zero-byte body (they differ on the wire). */
  body: string | null;
}

export interface Erc8128VerifyCase {
  /** `<family>/<request>`, resolved against F3-3 first, then F3-1. */
  vector_id: string;
  policy: string;
  expect: 'accept' | 'reject';
  code?: string;
  /** Pinned on every reject row: the authority rule turns on 401-vs-503. */
  status?: number;
  wallet?: string;
  /** `null` when the request is refused before `Signature-Input` is parsed. */
  observed_profile?: string | null;
  /**
   * The value CONFIGURED into `VerifyPolicy.authority`. Omitted ⇒
   * `frozen.authority`.
   *
   * It is a per-case field because the configured authority is NOT derivable
   * from the request — that is the whole content of the rule. A runner that
   * derived it from the URL and a runner that read it from `frozen` were
   * testing two different things off one file.
   */
  authority?: string;
}

export interface Erc8128Frozen {
  /** Synthetic public test key, stored WITHOUT the `0x` prefix. F3-1 only. */
  private_key?: string;
  address: string;
  address_checksummed: string;
  chain_id: number;
  created: number;
  expires: number;
  nonce: string;
  authority?: string;
  label?: string;
}

export interface Erc8128Vectors {
  frozen: Erc8128Frozen;
  requests: Record<string, Erc8128RequestSpec>;
  vectors: Record<string, Record<string, Erc8128VectorCase>>;
  policies?: Record<string, Record<string, unknown>>;
  verify_cases?: Erc8128VerifyCase[];
  [key: string]: unknown;
}

/** F3-1: byte-identical copy of the fleet's source of truth. */
export const CONFORMANCE_VECTORS_F3_1: Erc8128Vectors = JSON.parse(
  F3_1_VECTORS_JSON
) as Erc8128Vectors;

/** F3-3: additive — bodyless POST/DELETE, empty-body POST, presets, matrix. */
export const CONFORMANCE_VECTORS_F3_3: Erc8128Vectors = JSON.parse(
  F3_3_VECTORS_JSON
) as Erc8128Vectors;

export { CONFORMANCE_SHA256, F3_1_VECTORS_JSON, F3_3_VECTORS_JSON };
