/**
 * The THIN eval-adapter contract — NOT Velrim's production `ModelAdapter`.
 *
 * `velrim-eval` scores extraction adapters (Velrim, OpenAI, Gemini, LlamaExtract, Mistral) against a
 * 3-state golden set. Because scoring's public input is `@velrim/scoring`'s `ScoringField` (which has
 * NO geometry), the eval adapter NEVER names `Anchor`/`BBox` and imports NOTHING type-wise from
 * `@velrim/core`. An adapter returns a flat `{ value; confidence? }` per JSON Pointer; the score
 * command maps those to `ScoringField` via the single-sourced `toScoringField` helper.
 *
 * This file is the FROZEN command↔adapter seam, single-owner: the commands in `src/commands/`
 * import `EvalAdapter`/`EvalAdapterOpts`/`Transport` from here. Keep the shape byte-stable.
 *
 * Pure TS, ESM, zero runtime deps. The only import is the published name `@velrim/scoring`
 * (NEVER `@velrim/core`) — and only for the `ScoringField`/`FieldState` types the mapping uses.
 */

import type { FieldState, ScoringField } from '@velrim/scoring';

/** The adapters the eval CLI ships. */
export type EvalAdapterId = 'velrim' | 'openai' | 'llamaextract' | 'mistral' | 'gemini';

/**
 * Request parameters the pre-freeze smoke may prove a provider refuses. The trim is always
 * smoke-driven and explicit — the transport deliberately never reads 4xx error bodies, so an
 * adapter cannot infer "refused because of logprobs" itself; the maintainer observes the refusal at
 * smoke, reruns with the trim flag, and the trim is recorded in run-meta + the run manifest.
 */
export type TrimmableParam = 'logprobs' | 'temperature';

/** Mistral page-cap branch — resolved by the pre-freeze bidirectional smoke, never guessed. */
export type PageCapBranch = 'cap-confirmed' | 'cap-removed';

/**
 * The injectable HTTP transport. Mirrors Velrim's production recording transport.
 *
 * - `fixtureTransport` (the BUILD DEFAULT) reads `test/recorded/<adapter>/*.json` with ZERO
 *   network — every test and the dogfood run go through it.
 * - `liveTransport` does a real `fetch`, keys from env ONLY; throws at construction if a key is
 *   missing. `run --live` is the only production caller; no test ever lets it touch a socket.
 *
 * The transport is a thin request→response indirection so adapters stay pure and testable: it
 * takes a logical request (URL, method, headers, optional body, and a fixture `key` the fixture
 * transport resolves to a recorded file) and returns the parsed JSON body.
 */
export interface TransportRequest {
  /** Fixture key — `<adapter>/<name>` resolved by `fixtureTransport` to a recorded JSON file. */
  key: string;
  /** Live endpoint (only read by `liveTransport`; `fixtureTransport` ignores it). */
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /**
   * Request body for the live path; ignored by the fixture path. JSON-serialisable, EXCEPT a
   * `FormData` instance, which the live transport sends as multipart (file upload) untouched.
   */
  body?: unknown;
}

/** The transport contract: a logical request → the parsed JSON response body. */
export interface Transport {
  readonly mode: 'fixture' | 'live';
  send(req: TransportRequest): Promise<unknown>;
  /** Allowlisted, content-free metadata from the most recently completed HTTP response. */
  lastResponseProvenance?(): AdapterResponseProvenance;
}

/**
 * Per-call options threaded from the CLI to an adapter (FROZEN seam).
 *
 * - `mode` mirrors the transport's mode (fixture is the build default; live is maintainer-run).
 * - `structuredMode` (openai + gemini) re-runs constrained so the user reproduces the
 *   ExtractBench gap themselves (openai: `response_format` json_schema; gemini:
 *   `generationConfig.responseJsonSchema` — A3).
 * - `signal` lets the command cancel an in-flight live call.
 * - `transport` is injected so adapters never reach for `fetch` directly (testability).
 */
export interface EvalAdapterOpts {
  mode: 'fixture' | 'live';
  /**
   * The golden row's docClass, passed by the runner on every call. Velrim sends it as
   * `options.doc_class` (selects the served per-class fitted calibrator); other adapters
   * ignore it — their class information already rides in the per-class schema.
   */
  docClass?: string;
  structuredMode?: boolean;
  signal?: AbortSignal;
  /** Absolute outer doc-repeat deadline, used by async adapters to leave taxonomy headroom. */
  deadlineAt?: number;
  /** Smoke-proven refused params to drop from the request (openai only); recorded in run-meta. */
  trimParams?: readonly TrimmableParam[];
  /**
   * Page-cap branch (mistral only; ANALYSIS-PLAN.md §4.3). 'cap-confirmed' ARMS the loud-fail over-cap guard:
   * an over-cap doc reaching the adapter is a protocol error (the exclusion machinery failed),
   * never a red cell. Unset/'cap-removed' → guard unarmed.
   */
  capBranch?: PageCapBranch;
  /**
   * Velrim only — the DELIBERATE seam addition mirroring the `capBranch`/`trimParams`
   * precedent: `run --live` sets it for the velrim adapter (ANALYSIS-PLAN.md §6.2). Never
   * changes the request body; on response the adapter hard-asserts the served calibrator
   * stamp is a minted `cal-YYYY.MM-n` fitted stamp (pattern, never a pinned value) — proof
   * the run was served by the shipped fitted stack, Velrim's default served path. A mismatch
   * (including `identity-0`, meaning the fitted stack was off) or a missing stamp ⇒
   * FatalRunError (a mislabeled column is a protocol error, never a red cell). Unset — the
   * fixture/dogfood default — ⇒ no assertion (a fixture's stamp may be anything).
   */
  requireFittedStamp?: boolean;
  /**
   * Gemini only — route A2/A3 to this Google Cloud project's Vertex generateContent endpoint
   * instead of AI Studio. URL-only substitution (body and auth header identical); recorded in
   * run-meta and the manifest endpoint (⇒ fingerprinted). Why it exists: gemini.ts header.
   */
  geminiVertexProject?: string;
  transport: Transport;
}

/**
 * One extracted leaf as an adapter surfaces it. Flat — NO anchor, NO geometry.
 * `value` may be `null` (explicit JSON null → scored `null`); a key being absent from the map
 * means the adapter omitted that leaf (scored `missing` by the golden's key set).
 */
export interface AdapterField {
  value: unknown;
  /** Raw self-confidence in [0,1] when the engine surfaces it; absent → scoring DEFAULT_CONFIDENCE. */
  confidence?: number;
}

/** Allowlisted, content-free response identifiers retained for the published run manifest. */
export interface AdapterResponseProvenance {
  modelVersion?: string;
  vendorVersion?: string;
  calibratorVersion?: string;
  apiVersion?: string;
  requestId?: string;
}

/**
 * THE provenance key allowlist + value rule, single-sourced: the write-side sanitizer and the
 * checkpoint's read-side validator both derive from these, so a new key can never be persisted
 * by the runner and then rejected (and truncated away) on the next resume.
 */
export const PROVENANCE_KEYS = [
  'modelVersion',
  'vendorVersion',
  'calibratorVersion',
  'apiVersion',
  'requestId',
] as const;

const PROVENANCE_KEY_SET: ReadonlySet<string> = new Set(PROVENANCE_KEYS);

function isProvenanceValue(item: unknown): item is string {
  return typeof item === 'string' && item.length > 0 && item.length <= 200;
}

/** Optional metadata can never invalidate an otherwise classifiable provider outcome. */
export function sanitizeResponseProvenance(value: unknown): AdapterResponseProvenance | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const out: AdapterResponseProvenance = {};
  for (const key of PROVENANCE_KEYS) {
    const item = candidate[key];
    if (isProvenanceValue(item)) out[key] = item;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Read-side twin of `sanitizeResponseProvenance`: accepts exactly what the sanitizer emits. */
export function isResponseProvenance(value: unknown): value is AdapterResponseProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (!PROVENANCE_KEY_SET.has(key) || !isProvenanceValue(item)) return false;
  }
  return true;
}

/** Raw self-confidence contract shared by every adapter and both checkpoint sides. */
export function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The shared per-leaf shape rule for `AdapterField`, single-sourced for the runner's write-side
 * assertion and the checkpoint's read-side validator. Returns the first violation, or null when
 * the field is acceptable. (The write side layers two STRICTER checks on top — `value` must not
 * be `undefined` and must be JSON-serializable — which the JSON round-trip makes unobservable on
 * the read side, so read stays a superset of write.)
 */
export function adapterFieldViolation(
  field: unknown,
): 'not_an_object' | 'no_value_key' | 'invalid_confidence' | null {
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return 'not_an_object';
  const candidate = field as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(candidate, 'value')) return 'no_value_key';
  if (candidate['confidence'] !== undefined && !isValidConfidence(candidate['confidence'])) {
    return 'invalid_confidence';
  }
  return null;
}

/** The result of one extract call: per-JSON-Pointer fields + the authoritative raw response. */
export interface AdapterExtractResult {
  fields: Record<string /* jsonPointer */, AdapterField>;
  /** The raw provider response (authoritative; never parsed for scoring). */
  raw: unknown;
  /** Content-free version/request identifiers only; arbitrary response data is forbidden here. */
  provenance?: AdapterResponseProvenance;
}

/** The FROZEN eval-adapter contract (keep byte-stable). */
export interface EvalAdapter {
  readonly id: EvalAdapterId;
  extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult>;
}

// --- 3-state derivation — single-sourced so the score command reuses it ----------------------

/**
 * Map one adapter leaf → `ScoringField`. The 3-state derivation lives
 * HERE once so the score command and every adapter agree:
 *
 *   - explicit JSON `null`            → `{ state: 'null' }`            (no value; the model said "absent")
 *   - any non-null value (incl. `""`  → `{ state: 'present', value }`  (the model emitted something;
 *     and whitespace strings)            coercing "" to null would mask a fabrication)
 *   - a key absent from the adapter's  → handled by the CALLER omitting the key (scored `missing`
 *     output                              by the golden's key set); this helper is never called for it.
 *
 * `confidence` flows straight to `ScoringField.confidence` (omitted when absent so scoring falls
 * back to `DEFAULT_CONFIDENCE`). Any native anchor is dropped — scoring never reads it.
 */
export function toScoringField(field: AdapterField): ScoringField {
  const state: FieldState = field.value === null ? 'null' : 'present';
  const sf: ScoringField = { state };
  if (state === 'present') sf.value = field.value;
  if (field.confidence !== undefined) sf.confidence = field.confidence;
  return sf;
}

/**
 * Map a whole adapter output → the `Record<string, ScoringField>` scoring reads (single-sourced).
 * Absent keys stay absent (scored `missing` against the golden's key set). Used by both the
 * score command and the adapter unit tests so the derivation is proven in one place.
 */
export function toScoringFields(
  fields: Record<string, AdapterField>,
): Record<string, ScoringField> {
  const out: Record<string, ScoringField> = {};
  for (const [pointer, field] of Object.entries(fields)) {
    out[pointer] = toScoringField(field);
  }
  return out;
}
