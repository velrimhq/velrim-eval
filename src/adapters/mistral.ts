/**
 * Mistral OCR bake-off adapter (A4) — the vendor's documented structured-extraction happy
 * path: one POST to `/v1/ocr` with the frozen class JSON Schema as `document_annotation_format`.
 *
 * - Model pinned to `mistral-ocr-4-0`; the response's own `model` string is captured as
 *   provenance ("no version surfaced" is itself reported by the manifest).
 * - The annotation-JSON mapper emits NO confidence, ever: Mistral surfaces no per-field
 *   confidence in this mode, and constructing one from word confidences would inject
 *   Velrim-authored aggregation into their arm (the cell renders "none surfaced").
 *   For the same reason there is no SAP-lite repair here: `document_annotation` is the vendor's
 *   own constrained JSON contract; if it does not parse, that is a first-class contract failure.
 * - Loud-fail over-cap guard (ANALYSIS-PLAN.md §4.3), ARMED ONLY in the cap-confirmed branch
 *   (`opts.capBranch === 'cap-confirmed'`): in that branch over-cap docs are excluded from every
 *   arm before any request is built, so an over-cap doc reaching this adapter means the exclusion
 *   machinery failed — a PROTOCOL error (FatalRunError: stop the run, checkpoint preserved),
 *   never a red cell in Mistral's column. The guard reads the RESPONSE's own page accounting
 *   (`usage_info.pages_processed` / `pages`), the only page count this zero-dep adapter can see.
 *
 * Standalone: never imports `@velrim/core`; shares only the eval-local flatten/bytes helpers.
 */

import { bytesToBase64 } from './bytes.js';
import { ContractFailureError, FatalRunError } from './errors.js';
import { flattenJsonLeaves } from './flatten.js';
import type { AdapterExtractResult, AdapterField, EvalAdapter, EvalAdapterOpts } from './types.js';

/** Mistral's OCR + document-annotation endpoint (their documented structured path). */
export const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

/** Pinned model. Bump deliberately; the report column is labeled with what it measured. */
export const MISTRAL_MODEL = 'mistral-ocr-4-0';

/**
 * The CONTESTED page cap for document annotations. The pre-freeze bidirectional smoke selects
 * the branch; this constant only matters when `capBranch === 'cap-confirmed'` arms the guard.
 */
export const MISTRAL_PAGE_CAP = 8;

/** One recorded annotation response; A4 has a single mode. */
export const MISTRAL_FIXTURE_KEY = 'mistral/extract';

export interface MistralOcrResponse {
  model?: string;
  pages?: Array<{ index?: number; markdown?: string }>;
  /** The vendor's annotation payload — a JSON STRING per their contract (object tolerated). */
  document_annotation?: string | Record<string, unknown> | null;
  usage_info?: { pages_processed?: number; doc_size_bytes?: number } | null;
}

/** Build the exact A4 request body: pinned model, doc as a data URL, schema as the annotation format. */
export function buildMistralRequestBody(
  docBytes: Uint8Array,
  jsonSchema: object,
): Record<string, unknown> {
  return {
    model: MISTRAL_MODEL,
    document: {
      type: 'document_url',
      document_url: `data:application/pdf;base64,${bytesToBase64(docBytes)}`,
    },
    document_annotation_format: {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: jsonSchema },
    },
  };
}

/** The response's own page accounting — the only page count the adapter can observe. */
export function mistralPagesProcessed(res: MistralOcrResponse): number | undefined {
  const fromUsage = res.usage_info?.pages_processed;
  if (typeof fromUsage === 'number' && Number.isFinite(fromUsage)) return fromUsage;
  if (Array.isArray(res.pages)) return res.pages.length;
  return undefined;
}

/**
 * Map the vendor's annotation JSON to recursive RFC-6901 leaves. NO confidence is ever attached
 * (none surfaced — see the header). Returns `undefined` when the annotation is absent or is not
 * a JSON object; `extract()` records that as a first-class contract failure (FD-3).
 */
export function mapMistralResponse(
  res: MistralOcrResponse,
): Record<string, AdapterField> | undefined {
  const annotation = res.document_annotation;
  let parsed: unknown = annotation;
  if (typeof annotation === 'string') {
    try {
      parsed = JSON.parse(annotation);
    } catch {
      return undefined;
    }
  }
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }
  const out: Record<string, AdapterField> = {};
  for (const [pointer, value] of Object.entries(
    flattenJsonLeaves(parsed as Record<string, unknown>),
  )) {
    out[pointer] = { value };
  }
  return out;
}

export const mistralAdapter: EvalAdapter = {
  id: 'mistral',
  async extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult> {
    if (opts.structuredMode === true) {
      throw new FatalRunError(
        'mistral: --structured-mode is not valid for A4 — document annotation IS the single documented mode',
      );
    }

    const raw = await opts.transport.send({
      key: MISTRAL_FIXTURE_KEY,
      url: MISTRAL_OCR_URL,
      method: 'POST',
      body: buildMistralRequestBody(docBytes, jsonSchema),
    });
    const transportProvenance = opts.transport.lastResponseProvenance?.() ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ContractFailureError(
        'mistral: 2xx response is not an object',
        undefined,
        undefined,
        transportProvenance,
      );
    }
    const response = raw as MistralOcrResponse;
    const provenance = {
      ...transportProvenance,
      ...(typeof response.model === 'string' ? { modelVersion: response.model } : {}),
    };

    // Loud-fail over-cap guard — armed ONLY in the cap-confirmed branch. FatalRunError on
    // purpose: this is a protocol error (the exclusion machinery failed), never a red cell.
    if (opts.capBranch === 'cap-confirmed') {
      const pages = mistralPagesProcessed(response);
      if (pages !== undefined && pages > MISTRAL_PAGE_CAP) {
        throw new FatalRunError(
          `mistral: over-cap document reached the adapter in the cap-confirmed branch ` +
            `(${pages} pages > ${MISTRAL_PAGE_CAP}); the analysis plan excludes over-cap docs from ALL arms — ` +
            'this is a protocol error, not a Mistral failure cell',
        );
      }
    }

    const fields = mapMistralResponse(response);
    if (fields === undefined) {
      throw new ContractFailureError(
        'mistral: 2xx response has no usable document_annotation JSON object',
        undefined,
        undefined,
        provenance,
      );
    }
    return { fields, raw, provenance };
  },
};
