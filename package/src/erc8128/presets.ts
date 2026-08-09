/**
 * uvd-x402-sdk/erc8128 — the live postures, as data.
 *
 * `meshrelay-strict` and `em-lenient` reproduce what each product does today,
 * knob for knob, so adopting the SDK changes neither one's behaviour.
 * `canonical-strict` is the S3 posture: pre-written, unused until the
 * deprecation census is clean.
 *
 * These objects are pinned in the shipped vectors (`erc8128.f3-3.json`, block
 * `policies`) and `conformance.test.ts` asserts `presetAsData()` is deep-equal
 * to it — a preset edited without a matching vector edit fails the suite. That
 * block is snake_case because the SAME file is read by the Python SDK; see
 * {@link presetAsData}.
 *
 * They are PARTIAL on purpose: `authority` and `nonce` are per-deployment and
 * must be supplied by the caller. Spreading a preset and then overriding a
 * knob silently changes posture with no type error — use
 * {@link policyFromPreset}, which also carries the nonce ordering.
 *
 * One deliberate non-knob: no nonce charset/length rule. MeshRelay's
 * `^[A-Za-z0-9_-]{32,128}$` lives in its store, where issuance policy belongs;
 * the SDK never issues or formats a nonce.
 *
 * The nonce CONSUME ORDER is not inside the preset object — the store is the
 * caller's — but it belongs to the preset all the same, so it lives beside it
 * in {@link PRESET_NONCE_CONSUME} and `policyFromPreset()` stitches the two
 * together. Adopting `em-lenient` therefore gets EM's before-verify ordering
 * rather than a silently different one.
 */

import { X402Error } from '../types';
import type { NonceConsumeOrder, NonceStore } from './nonce';
import type { VerifyPolicy } from './verifier';

export type PolicyPresetName = 'meshrelay-strict' | 'em-lenient' | 'canonical-strict';

export type PolicyPreset = Omit<VerifyPolicy, 'authority' | 'nonce'>;

export const POLICY_PRESETS: Readonly<Record<PolicyPresetName, PolicyPreset>> = Object.freeze({
  /** MeshRelay today: order-locked components, method-driven digest, chain
   *  allowlist, no grace after expiry, `eth` label only. */
  'meshrelay-strict': Object.freeze({
    accept: 'accept-both',
    components: 'exact-ordered',
    contentDigest: 'non-idempotent-methods',
    allowedChainIds: Object.freeze([8453]),
    maxValiditySec: 300,
    clockSkew: Object.freeze({ future: 30, pastExpiry: 0 }),
    label: 'eth',
  }) as PolicyPreset,

  /** Execution Market today: superset components in any order, body-presence
   *  digest, any chain id, ±30s skew, any label. */
  'em-lenient': Object.freeze({
    accept: 'accept-both',
    components: 'request-bound-subset',
    contentDigest: 'body-present',
    maxValiditySec: 300,
    clockSkew: Object.freeze({ future: 30, pastExpiry: 30 }),
    label: 'any',
  }) as PolicyPreset,

  /** S3 target: legacy emitters start failing with `alg_missing` /
   *  `keyid_not_lowercase`. Not used until the census is clean.
   *
   *  The chain allowlist is PINNED to 8453, the production auth chain of both
   *  products: a preset named "strict" that accepts any chain is not strict. A
   *  verifier that already ran a wider allowlist overrides it explicitly. */
  'canonical-strict': Object.freeze({
    accept: 'canonical',
    components: 'exact-ordered',
    contentDigest: 'body-present',
    allowedChainIds: Object.freeze([8453]),
    maxValiditySec: 300,
    clockSkew: Object.freeze({ future: 30, pastExpiry: 0 }),
    label: 'eth',
  }) as PolicyPreset,
});

/**
 * Preset → the nonce-consumption order that belongs to it. Kept beside the
 * presets (rather than inside them) because the store itself is the caller's:
 * MeshRelay consumes AFTER the crypto, EM BEFORE it, and neither can be
 * migrated to the other without changing a live product's behaviour.
 */
export const PRESET_NONCE_CONSUME: Readonly<Record<PolicyPresetName, NonceConsumeOrder>> =
  Object.freeze({
    'meshrelay-strict': 'after-verify',
    'em-lenient': 'before-verify',
    'canonical-strict': 'after-verify',
  });

/** Every preset rejects a nonce-less (replayable) signature. */
export const PRESET_NONCE_MODE = 'required' as const;

/** The preset's knobs are all overridable; `authority` is required. */
export interface PolicyFromPresetOptions extends Partial<PolicyPreset> {
  /** A VALUE, never derived from a client-controlled header. */
  authority: string;
  /** The caller's store. Omitted ⇒ no nonce policy at all. */
  nonceStore?: NonceStore;
  /** Default `'required'`. */
  nonceMode?: 'required' | 'optional';
}

/**
 * Specialise a preset with the two things it cannot carry: the authority VALUE
 * and the caller's nonce store. The consume order comes from
 * {@link PRESET_NONCE_CONSUME}, so adopting `meshrelay-strict` cannot
 * accidentally flip MeshRelay to EM's ordering.
 */
export function policyFromPreset(
  name: PolicyPresetName,
  options: PolicyFromPresetOptions
): VerifyPolicy {
  const preset = POLICY_PRESETS[name];
  if (!preset) {
    throw new X402Error(`Unknown ERC-8128 policy preset: ${name}`, 'INVALID_CONFIG');
  }
  const { authority, nonceStore, nonceMode = PRESET_NONCE_MODE, ...overrides } = options;
  return {
    ...preset,
    authority,
    ...(nonceStore
      ? { nonce: { store: nonceStore, mode: nonceMode, consume: PRESET_NONCE_CONSUME[name] } }
      : {}),
    ...overrides,
  };
}

/**
 * The JSON-shaped view of a preset — what the vectors' `policies` block pins
 * and what the conformance suite compares against, nonce ordering included.
 *
 * SNAKE_CASE AND FLAT, deliberately. This is the WIRE projection, not the
 * TypeScript object: the same block is read by the Python SDK, which spells
 * these fields `content_digest` / `clock_skew_future_sec`, and the rest of the
 * vector document (`chain_id`, `observed_profile`, `signature_base`) is
 * snake_case too. Emitting `contentDigest` here meant the shared vectors could
 * never be one file — each language would have had to ship its own casing.
 * Python's `preset_as_data()` returns exactly this, field for field, so
 * `presetAsData(n) === preset_as_data(n) === vectors.policies[n]` holds across
 * both runtimes and is asserted by the cross-language harness.
 */
export function presetAsData(name: PolicyPresetName): Record<string, unknown> {
  const preset = POLICY_PRESETS[name];
  return {
    accept: preset.accept,
    components: preset.components,
    content_digest: preset.contentDigest,
    allowed_chain_ids: preset.allowedChainIds ? [...preset.allowedChainIds] : null,
    max_validity_sec: preset.maxValiditySec,
    clock_skew_future_sec: preset.clockSkew?.future,
    clock_skew_past_expiry_sec: preset.clockSkew?.pastExpiry,
    label: preset.label,
    nonce_mode: PRESET_NONCE_MODE,
    nonce_consume: PRESET_NONCE_CONSUME[name],
  };
}
