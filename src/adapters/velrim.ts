/**
 * The Velrim eval adapter — POST `api.velrim.com/v1/extract`.
 *
 * Velrim's response is native to the 3-state world: each leaf already carries
 * `{ state, value?, confidence? }`, so the mapping to the eval-adapter's flat
 * `{ value; confidence? }` is ~1:1. The native `anchor`/`provenance` geometry is DROPPED on the
 * floor — scoring never reads it (the published `ScoringField` has no geometry).
 *
 * 3-state note: the score command derives `present/null/missing` from the flat `{ value }` via
 * `toScoringField`. Velrim's own `state` is informative but we re-derive from `value` so
 * the SAME single-sourced rule governs every adapter — a Velrim leaf with `state:'null'` carries
 * `value:null`, and an omitted leaf is simply absent from `fields`. We honor an explicit
 * `state:'missing'`/`state:'null'` by emitting the right `value` so the shared derivation agrees.
 *
 * Live wire contract (verified against the production /v1/extract route and its responder):
 *   POST https://api.velrim.com/v1/extract
 *   Authorization: Bearer $VELRIM_API_KEY   (added by liveTransport, never here)
 *   { schema: <JSON Schema object>, options: { doc_class: <golden docClass> },
 *     document: { bytes_base64: <base64 PDF bytes> } }
 *   → { data, fields: { "/ptr": { state, value?, confidence?, anchor?, reason } }, meta }
 *   doc_class selects the served per-class fitted calibrator; a request without it is served
 *   identity-0 by production design (non-corpus scoping).
 *
 * Fixture-backed by default (`run` wires `--live` → liveTransport, env key `VELRIM_API_KEY`).
 * The SAME body is constructed in both modes — the fixture transport simply never sends it.
 * Pure TS, ESM, zero runtime deps. No import of `@velrim/core`.
 *
 * The A1 arm runs ONE live pass: the served product (the fitted stack, the default of the
 * public `/v1/extract`). `opts.requireFittedStamp` (set by `run --live` for this adapter)
 * arms the served-stamp assertion: the response's `meta.calibrator_version` stamp must be a
 * minted fitted version, PROVING the run was served by the shipped fitted stack. A mismatch —
 * including `identity-0`, which means the fitted stack was off — is a FatalRunError (the
 * Mistral over-cap precedent) because a mislabeled column is a protocol error (stop the run,
 * checkpoint preserved), never a red cell in Velrim's column. Fixture/dogfood runs leave the
 * flag unset and make no assertion (a fixture's stamp may be anything).
 */

import { bytesToBase64 } from './bytes.js';
import { ContractFailureError, FatalRunError } from './errors.js';
import type {
  AdapterExtractResult,
  AdapterField,
  AdapterResponseProvenance,
  EvalAdapter,
  EvalAdapterOpts,
} from './types.js';
import { isValidConfidence } from './types.js';

/** Live endpoint (used by the `--live` transport; the fixture transport ignores it). */
export const VELRIM_EXTRACT_URL = 'https://api.velrim.com/v1/extract';

/** The fixture key the build-default transport resolves to `test/recorded/velrim/<name>.json`. */
export const VELRIM_FIXTURE_KEY = 'velrim/extract';

/**
 * The stamp `/v1/extract` returns when the fitted stack is OFF (raw self-scores served).
 * Kept ONLY so the assertion can say what seeing it means: on a live benchmark run it is a
 * protocol error — the response was not served by the product's default fitted path.
 */
export const VELRIM_IDENTITY_STAMP = 'identity-0';

/**
 * Minted fitted-stamp shape (`cal-2026.08-1` etc.). A PATTERN, deliberately not a pinned value:
 * the run manifest cites the version serving on the run date, and the column label must read
 * from the RESPONSE stamp (ANALYSIS-PLAN.md §6.2) — pinning a value here would hardcode the label.
 */
export const VELRIM_FITTED_STAMP_PATTERN = /^cal-\d{4}\.\d{2}-\d+$/;

/**
 * THE minted-stamp rule, single-sourced: the adapter's hard assertion, the runner's
 * publication gate, and the report label builder all derive from this one predicate.
 */
export function isMintedFittedStamp(stamp: string | undefined): stamp is string {
  return typeof stamp === 'string' && VELRIM_FITTED_STAMP_PATTERN.test(stamp);
}

/** The subset of Velrim's `/v1/extract` response this adapter reads. */
export interface VelrimExtractResponse {
  /** Per-JSON-Pointer leaf: native 3-state + raw self-confidence. */
  fields?: Record<
    string,
    {
      state?: 'present' | 'null' | 'missing';
      value?: unknown;
      confidence?: number;
      // anchor/provenance may be present on the wire — deliberately NOT typed here (dropped).
    }
  >;
  meta?: {
    model?: string;
    calibrator_version?: string;
    routing_policy_version?: string;
    request_id?: string;
  };
}

function contractFailure(
  message: string,
  provenance: AdapterResponseProvenance,
): ContractFailureError {
  return new ContractFailureError(message, undefined, undefined, provenance);
}

function assertUsableVelrimResponse(
  raw: unknown,
  provenance: AdapterResponseProvenance,
): asserts raw is VelrimExtractResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw contractFailure('velrim: 2xx response is not an object', provenance);
  }
  const fields = (raw as VelrimExtractResponse).fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw contractFailure('velrim: 2xx response has no usable fields object', provenance);
  }
  for (const [pointer, value] of Object.entries(fields)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw contractFailure(`velrim: field ${pointer} is not an object`, provenance);
    }
    if (value.state !== 'present' && value.state !== 'null' && value.state !== 'missing') {
      throw contractFailure(`velrim: field ${pointer} has an invalid state`, provenance);
    }
    const hasValue = Object.prototype.hasOwnProperty.call(value, 'value');
    if (value.state === 'present' && !hasValue) {
      throw contractFailure(`velrim: present field ${pointer} has no value`, provenance);
    }
    if (value.state !== 'present' && hasValue) {
      throw contractFailure(
        `velrim: non-present field ${pointer} unexpectedly has value`,
        provenance,
      );
    }
    if (value.confidence !== undefined && !isValidConfidence(value.confidence)) {
      throw contractFailure(`velrim: field ${pointer} has invalid confidence`, provenance);
    }
  }
}

/**
 * Map a Velrim response → the flat per-pointer `{ value; confidence? }` map.
 *
 * - `state:'missing'` (or an absent leaf) → key OMITTED → scored `missing` by the golden key set.
 * - `state:'null'`                         → `{ value: null }` → derives `null` downstream.
 * - otherwise (a value, incl. `""`)        → `{ value, confidence? }` → derives `present`.
 *
 * `confidence` is passed through only when finite; otherwise omitted so scoring uses
 * `DEFAULT_CONFIDENCE`. We never fabricate a confidence.
 */
export function mapVelrimResponse(res: VelrimExtractResponse): Record<string, AdapterField> {
  const out: Record<string, AdapterField> = {};
  for (const [pointer, leaf] of Object.entries(res.fields ?? {})) {
    // Omit missing leaves so the golden's key set scores them `missing`.
    if (leaf.state === 'missing') continue;
    // An explicit null state with no value → emit null so the shared 3-state rule yields `null`.
    const value = leaf.state === 'null' ? null : leaf.value;
    const field: AdapterField = { value };
    if (typeof leaf.confidence === 'number' && Number.isFinite(leaf.confidence)) {
      field.confidence = leaf.confidence;
    }
    out[pointer] = field;
  }
  return out;
}

export const velrimAdapter: EvalAdapter = {
  id: 'velrim',
  async extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult> {
    // The REAL /v1/extract envelope the production route parses: schema + inline base64 doc +
    // options.doc_class (the documented per-class calibration hint — without it the server
    // routes to identity-0 and the fitted-stamp assertion below correctly stops the run).
    // Constructed identically in fixture mode (the fixture transport ignores the body) so the
    // request the reader's live run sends is the one the tests assert on. The stamp assertion
    // never changes the request — the body/URL/headers are the default public request always.
    const raw = await opts.transport.send({
      key: VELRIM_FIXTURE_KEY,
      url: VELRIM_EXTRACT_URL,
      method: 'POST',
      body: {
        schema: jsonSchema,
        ...(opts.docClass === undefined ? {} : { options: { doc_class: opts.docClass } }),
        document: { bytes_base64: bytesToBase64(docBytes) },
      },
    });
    const record =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
    const candidateMeta = record?.['meta'];
    const meta =
      candidateMeta !== null && typeof candidateMeta === 'object' && !Array.isArray(candidateMeta)
        ? (candidateMeta as VelrimExtractResponse['meta'])
        : undefined;
    const provenance: AdapterResponseProvenance = {
      ...(opts.transport.lastResponseProvenance?.() ?? {}),
      ...(typeof meta?.model === 'string'
        ? { modelVersion: meta.model }
        : typeof record?.['model'] === 'string'
          ? { modelVersion: record['model'] }
          : {}),
      ...(typeof meta?.routing_policy_version === 'string'
        ? { vendorVersion: meta.routing_policy_version }
        : {}),
      ...(typeof meta?.calibrator_version === 'string'
        ? { calibratorVersion: meta.calibrator_version }
        : {}),
      ...(typeof meta?.request_id === 'string' ? { requestId: meta.request_id } : {}),
    };
    assertUsableVelrimResponse(raw, provenance);
    // The served-stamp hard assertion — AFTER the usable-response check on purpose: a
    // wholly-malformed 2xx stays in the per-doc contract taxonomy (scored empty,
    // denominator-excluded), while a well-formed response served WITHOUT a minted fitted stamp
    // is the mislabeled-column case and poisons every subsequent request identically →
    // FatalRunError, mirroring the Mistral over-cap guard: stop the run (checkpoint
    // preserved), never a red cell. Fixture mode never sets the flag: no assertion there.
    if (opts.requireFittedStamp === true) {
      const stamp = meta?.calibrator_version;
      if (!isMintedFittedStamp(stamp)) {
        throw new FatalRunError(
          `velrim: served calibrator stamp ${stamp === undefined ? '(none)' : `"${stamp}"`} ` +
            `is not a minted fitted stamp (expected ${VELRIM_FITTED_STAMP_PATTERN.source})` +
            (stamp === VELRIM_IDENTITY_STAMP
              ? ` — "${VELRIM_IDENTITY_STAMP}" means the fitted stack was OFF, a protocol ` +
                'error for this benchmark'
              : '') +
            '; a mislabeled column is a protocol error (labels read from the response ' +
            'stamp), never a red cell. Verify the prod serving configuration before resuming.',
        );
      }
    }
    return {
      fields: mapVelrimResponse(raw),
      raw,
      provenance,
    };
  },
};
