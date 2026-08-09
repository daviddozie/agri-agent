/**
 * uvd-x402-sdk/erc8128 — `runConformance()`.
 *
 * Public on purpose: it is the only mechanism by which a consumer's CI can
 * check the SDK build it ACTUALLY INSTALLED, rather than the source tree of
 * this repo. Wire it into MeshRelay's api tests, EM's mcp_server tests, the
 * KarmaKadabra bundle build and Sentinel's image build; fail the job when
 * `report.failed.length > 0`.
 *
 * Three sections — the SAME three the Python package runs, in the same order
 * and with the same count, so one green condition (`report.ok`) and one
 * `passed === total` mean the same thing in both languages:
 *   - integrity — the shipped vector bytes hash to `CONFORMANCE_SHA256`, and
 *              every policy preset still equals the `policies` block pinned in
 *              those bytes. ALWAYS RUNS, even under `only`: a sign-only run
 *              against a hand-edited artefact is not a pass. This section is
 *              the one TypeScript was missing, which is why the two runners
 *              reported 62 and 67 checks off one byte-identical file.
 *   - sign   — every emittable vector is re-signed and compared BYTE for byte
 *              (signatures are deterministic, RFC 6979).
 *   - verify — the `verify_cases` matrix: each (vector, policy) pair must
 *              produce the pinned accept/reject verdict, error code, HTTP
 *              status and observed profile, under the authority that case
 *              CONFIGURES. Turning acceptance into DATA is what keeps the
 *              TypeScript and Python verifiers from drifting apart.
 *
 * The key used is the synthetic public test key already published in the F3-1
 * fixture (documented there as a key that never held funds). It is read from
 * the vector document, never inlined.
 */

import { ethers } from 'ethers';

import { signRequest } from './signer';
import type { WireProfile } from './signer';
import { policyFromPreset, presetAsData } from './presets';
import type { PolicyPresetName } from './presets';
import { verifyRequest } from './verifier';
import type { VerifyPolicy } from './verifier';
import type { NonceContext, NonceOutcome, NonceStore } from './nonce';
import { WIRE_CONTRACT_VERSION } from './core';
import {
  CONFORMANCE_SHA256,
  CONFORMANCE_VECTORS_F3_1,
  CONFORMANCE_VECTORS_F3_3,
  F3_1_VECTORS_JSON,
  F3_3_VECTORS_JSON,
} from './vectors';
import type { Erc8128RequestSpec, Erc8128VectorCase, Erc8128Vectors } from './vectors';

export interface ConformanceCaseResult {
  /** Mirrors Python's `failed[].section`. */
  id: string;
  kind: 'integrity' | 'policy' | 'sign' | 'verify';
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  /**
   * THE green condition, spelled the same in both languages: `report.ok` in
   * TypeScript and `report.ok` in Python. `passed`, `total` and `failed` carry
   * the same names on both sides too, so `report.passed === report.total`
   * transliterates as well. Each side keeps its own extra fields (`cases`,
   * `sha256`, `wireContractVersion` here; `generations`,
   * `wire_contract_version` there).
   */
  ok: boolean;
  wireContractVersion: string;
  sha256: typeof CONFORMANCE_SHA256;
  total: number;
  passed: number;
  failed: ConformanceCaseResult[];
  cases: ConformanceCaseResult[];
}

/**
 * First-use-wins, in process. NOT exported: as a production default it would
 * give zero replay protection across tasks or restarts. It exists here only
 * so the matrix can exercise the nonce path deterministically.
 */
class ConformanceNonceStore implements NonceStore {
  private readonly seen = new Set<string>();

  consume(nonce: string, ctx: NonceContext): NonceOutcome {
    const key = `erc8128:${ctx.chainId}:${ctx.wallet}:${nonce}`;
    if (this.seen.has(key)) return 'replayed';
    this.seen.add(key);
    return 'ok';
  }
}

const GENERATIONS: Array<{ name: string; doc: Erc8128Vectors }> = [
  { name: 'f3-1', doc: CONFORMANCE_VECTORS_F3_1 },
  { name: 'f3-3', doc: CONFORMANCE_VECTORS_F3_3 },
];

/** Families a signer can emit. A checksummed keyid is verify-only. */
const EMITTABLE: Record<string, WireProfile> = {
  canonical: 'canonical',
  legacy_no_alg: 'legacy-no-alg',
};

/**
 * The signing key for the `sign` section.
 *
 * This is 0x42 repeated 32 times — a synthetic constant, not a secret. It is
 * the same value the Python package and execution-market's shared vectors use,
 * and it has to stay identical in all three or the pinned signatures stop
 * being comparable, which is the entire point of a conformance vector.
 *
 * It is stored in the JSON without the `0x` prefix. That is worth knowing and
 * worth changing: the stated reason is that the pre-commit secret scanner
 * blocks `0x` + 64 hex, so the prefix was dropped to get past it. Hiding a
 * known-public constant FROM the scanner teaches the scanner nothing and makes
 * every future reader do the derivation to find out whether it is real. An
 * explicit allow-list entry for this one value would say the same thing out
 * loud.
 */
function privateKey(): string {
  const raw = CONFORMANCE_VECTORS_F3_1.frozen.private_key;
  if (!raw) throw new Error('F3-1 vectors are missing frozen.private_key');
  return `0x${raw}`;
}

/** Resolve `<family>/<request>` across generations, newest first. */
function resolveVector(
  vectorId: string
): { vector: Erc8128VectorCase; request: Erc8128RequestSpec; doc: Erc8128Vectors } | undefined {
  const [family, name] = vectorId.split('/');
  for (const generation of [...GENERATIONS].reverse()) {
    const vector = generation.doc.vectors?.[family]?.[name];
    const request = generation.doc.requests?.[name];
    if (vector && request) return { vector, request, doc: generation.doc };
  }
  return undefined;
}

/** Key-order-insensitive structural equality, for comparing a preset object to
 *  the JSON block that pins it. */
function sameShape(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])])
      );
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/**
 * The section that has to run FIRST and has to run ALWAYS.
 *
 * A sign-only or verify-only pass against a hand-edited artefact is not a
 * pass, and the pinned presets are half of what the artefact pins: the
 * `policies` block is the only thing stopping a preset from being retuned in
 * one language and not the other. `sha256` is taken with ethers rather than
 * `node:crypto` because this module ships in the browser bundle too.
 */
function runIntegrityCases(results: ConformanceCaseResult[]): void {
  const shipped: Array<[keyof typeof CONFORMANCE_SHA256, string]> = [
    ['f3-1', F3_1_VECTORS_JSON],
    ['f3-3', F3_3_VECTORS_JSON],
  ];
  for (const [generation, text] of shipped) {
    const actual = ethers.sha256(ethers.toUtf8Bytes(text)).slice(2);
    const expected = CONFORMANCE_SHA256[generation];
    results.push({
      id: `integrity:${generation}`,
      kind: 'integrity',
      ok: actual === expected,
      detail: actual === expected ? undefined : `sha256 ${actual} != ${expected}`,
    });
  }

  for (const [name, pinned] of Object.entries(CONFORMANCE_VECTORS_F3_3.policies ?? {})) {
    let actual: Record<string, unknown> | undefined;
    let detail: string | undefined;
    try {
      actual = presetAsData(name as PolicyPresetName);
    } catch (error) {
      detail = String(error);
    }
    const ok = actual !== undefined && sameShape(actual, pinned);
    results.push({
      id: `policy:${name}`,
      kind: 'policy',
      ok,
      detail: ok
        ? undefined
        : (detail ?? `runtime=${JSON.stringify(actual)} pinned=${JSON.stringify(pinned)}`),
    });
  }
}

async function runSignCases(results: ConformanceCaseResult[]): Promise<void> {
  const key = privateKey();

  for (const generation of GENERATIONS) {
    const frozen = generation.doc.frozen;
    for (const [family, cases] of Object.entries(generation.doc.vectors ?? {})) {
      const profile = EMITTABLE[family];
      if (!profile) continue;

      for (const [name, vector] of Object.entries(cases)) {
        const id = `${generation.name}:sign:${family}/${name}`;
        const request = generation.doc.requests?.[name];
        if (!request) {
          results.push({ id, kind: 'sign', ok: false, detail: `no request spec for ${name}` });
          continue;
        }
        try {
          const headers = await signRequest({
            privateKey: key,
            method: request.method,
            url: request.url,
            body: request.body,
            nonce: frozen.nonce,
            chainId: frozen.chain_id,
            profile,
            now: () => frozen.created,
          });
          const mismatches: string[] = [];
          if (headers.Signature !== vector.headers.Signature) mismatches.push('Signature');
          if (headers['Signature-Input'] !== vector.headers['Signature-Input']) {
            mismatches.push('Signature-Input');
          }
          if ((headers['Content-Digest'] ?? undefined) !== vector.headers['Content-Digest']) {
            mismatches.push('Content-Digest');
          }
          results.push({
            id,
            kind: 'sign',
            ok: mismatches.length === 0,
            detail: mismatches.length ? `byte mismatch: ${mismatches.join(', ')}` : undefined,
          });
        } catch (error) {
          results.push({ id, kind: 'sign', ok: false, detail: String(error) });
        }
      }
    }
  }
}

/**
 * Build the request the way an HTTP server would present it: content-length is
 * set only when the fixture body is non-null, which is exactly how a zero-byte
 * body ends up classified as "no body" by the body-presence rule.
 */
export function verifiableRequestFromVector(
  vector: Erc8128VectorCase,
  request: Erc8128RequestSpec
): { method: string; url: string; headers: Record<string, string>; rawBody?: Uint8Array } {
  const headers: Record<string, string> = {
    signature: vector.headers.Signature,
    'signature-input': vector.headers['Signature-Input'],
  };
  if (vector.headers['Content-Digest']) {
    headers['content-digest'] = vector.headers['Content-Digest'];
  }

  let rawBody: Uint8Array | undefined;
  if (request.body !== null && request.body !== undefined) {
    rawBody = ethers.toUtf8Bytes(request.body);
    headers['content-length'] = String(rawBody.length);
  }

  return { method: request.method, url: request.url, headers, rawBody };
}

/**
 * The preset plus the two per-deployment values it deliberately omits. The
 * consume order is NOT re-decided here: it comes from the preset's own
 * `PRESET_NONCE_CONSUME` entry (EM before the crypto, MeshRelay after).
 */
export function conformancePolicy(
  name: PolicyPresetName,
  authority: string,
  now: number
): VerifyPolicy {
  return policyFromPreset(name, {
    authority,
    nonceStore: new ConformanceNonceStore(),
    now: () => now,
  });
}

async function runVerifyCases(results: ConformanceCaseResult[]): Promise<void> {
  const cases = CONFORMANCE_VECTORS_F3_3.verify_cases ?? [];
  const frozen = CONFORMANCE_VECTORS_F3_3.frozen;
  const defaultAuthority = frozen.authority ?? 'api.execution.market';

  for (const [index, testCase] of cases.entries()) {
    // The index disambiguates the rows that reuse one (vector, policy) pair
    // with a different CONFIGURED authority — the whole point of those rows.
    const id = `verify:${index}:${testCase.vector_id}:${testCase.policy}`;
    const resolved = resolveVector(testCase.vector_id);
    if (!resolved) {
      results.push({ id, kind: 'verify', ok: false, detail: 'vector not found' });
      continue;
    }

    const req = verifiableRequestFromVector(resolved.vector, resolved.request);
    const policy = conformancePolicy(
      testCase.policy as PolicyPresetName,
      // A case that names an authority is testing the CONFIGURED value; the
      // rest run against the one the fleet actually deploys.
      testCase.authority ?? defaultAuthority,
      frozen.created
    );

    try {
      const result = await verifyRequest(req, policy);
      const problems: string[] = [];
      // `observed_profile` is pinned on accept AND reject rows, `null`
      // included: what a verifier reports for a REJECTED signature is part of
      // the contract, and skipping the check on rejects is how the two suites
      // ended up pinning different things.
      const observed = result.observedProfile ?? null;
      if (observed !== (testCase.observed_profile ?? null)) {
        problems.push(`profile ${observed} != ${testCase.observed_profile ?? null}`);
      }

      if (testCase.expect === 'accept') {
        if (!result.ok) {
          results.push({ id, kind: 'verify', ok: false, detail: `rejected: ${result.code}` });
          continue;
        }
        if (testCase.wallet && result.wallet !== testCase.wallet) {
          problems.push(`wallet ${result.wallet} != ${testCase.wallet}`);
        }
      } else {
        if (result.ok) {
          results.push({ id, kind: 'verify', ok: false, detail: 'accepted, expected reject' });
          continue;
        }
        if (testCase.code && result.code !== testCase.code) {
          problems.push(`code ${result.code} != ${testCase.code}`);
        }
        // 401 blames the client, 503 blames the operator. A misconfigured
        // authority answering 401 is the failure this pin exists to catch.
        if (testCase.status !== undefined && result.status !== testCase.status) {
          problems.push(`status ${result.status} != ${testCase.status}`);
        }
      }

      results.push({
        id,
        kind: 'verify',
        ok: problems.length === 0,
        detail: problems.length ? problems.join('; ') : undefined,
      });
    } catch (error) {
      results.push({ id, kind: 'verify', ok: false, detail: String(error) });
    }
  }
}

/**
 * Run the shipped conformance suite against this build of the SDK.
 *
 * @param options.only - restrict to the `sign` or the `verify` section. The
 *   integrity section always runs — same as Python's `run_conformance(only=…)`
 *   — because "the signer is byte-correct against an artefact I did not check"
 *   is not a statement anyone wants to act on.
 */
export async function runConformance(options?: {
  only?: 'sign' | 'verify';
}): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];

  runIntegrityCases(results);
  if (options?.only !== 'verify') await runSignCases(results);
  if (options?.only !== 'sign') await runVerifyCases(results);

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    wireContractVersion: WIRE_CONTRACT_VERSION,
    sha256: CONFORMANCE_SHA256,
    total: results.length,
    passed: results.length - failed.length,
    failed,
    cases: results,
  };
}
