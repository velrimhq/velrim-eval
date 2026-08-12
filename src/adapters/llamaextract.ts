/**
 * The LlamaExtract eval adapter — LlamaIndex Cloud's v2 stateless extraction API.
 *
 * Live wire contract (verified against the current LlamaCloud REST docs, mid-2026):
 *   1. POST https://api.cloud.llamaindex.ai/api/v1/beta/files          (multipart: file + purpose='extract')
 *        → { id: "dfl-…" }
 *   2. POST https://api.cloud.llamaindex.ai/api/v2/extract             (JSON, schema INLINE — stateless,
 *        { file_input: "dfl-…", configuration: { extraction_target: 'per_doc', data_schema } })
 *        → { id: "ext-…", status: PENDING|RUNNING|COMPLETED|FAILED|CANCELLED, extract_result? }
 *   3. GET  https://api.cloud.llamaindex.ai/api/v2/extract/{job_id}    (poll until terminal)
 *        → extracted values live in `extract_result` when status === 'COMPLETED'.
 *   Authorization: Bearer $LLAMA_CLOUD_API_KEY on every call (added by liveTransport, never here).
 *
 * Fixture mode (the build default) stays a SINGLE send resolved to the recorded job JSON — the
 * multi-step flow only runs under `--live`. LlamaExtract exposes no token logprobs (its optional
 * `confidence_scores` feature is deliberately NOT requested — the published comparison keeps this
 * column logprob-free), so every leaf's confidence is ABSENT → scoring uses `DEFAULT_CONFIDENCE`
 * (0.5). That yields a degenerate-but-valid ECE/AUROC column — honest and documented, not a
 * fabricated confidence.
 *
 * Pure TS, ESM, zero runtime deps (FormData/Blob/setTimeout are Node ≥20 globals). NO import of
 * `@velrim/core`.
 */

import { flattenJsonLeaves } from './flatten.js';
import { ContractFailureError } from './errors.js';
import { sleep } from './sleep.js';
import type { AdapterExtractResult, AdapterField, EvalAdapter, EvalAdapterOpts } from './types.js';
import type { AdapterResponseProvenance } from './types.js';

/** Live endpoints (used by the `--live` transport; the fixture transport ignores them). */
export const LLAMAEXTRACT_UPLOAD_URL = 'https://api.cloud.llamaindex.ai/api/v1/beta/files';
export const LLAMAEXTRACT_EXTRACT_URL = 'https://api.cloud.llamaindex.ai/api/v2/extract';

/** Live polling cadence: first poll immediately after create, then every interval, capped. */
export const LLAMAEXTRACT_POLL_INTERVAL_MS = 2000;
export const LLAMAEXTRACT_MAX_POLLS = 90;
/** Reserve this much of the outer five-minute cap for request latency, retries, and cancellation. */
export const LLAMAEXTRACT_POLL_HEADROOM_MS = 120_000;

/** The fixture key resolved to `test/recorded/llamaextract/<name>.json`. */
export const LLAMAEXTRACT_FIXTURE_KEY = 'llamaextract/extract';

/** The subset of a v2 extract-job response this adapter reads. */
export interface LlamaExtractResponse {
  id?: string;
  status?: string; // PENDING | RUNNING | COMPLETED | FAILED | CANCELLED
  /** The extracted values (present when COMPLETED). */
  extract_result?: Record<string, unknown> | null;
  error_message?: string;
  configuration?: { version?: string };
}

/**
 * Map a completed LlamaExtract job → the flat per-pointer `{ value }` map. No logprobs → no
 * confidence on any leaf (omitted → scoring DEFAULT_CONFIDENCE).
 *
 * - Nested objects and arrays are recursively flattened to RFC 6901 leaves. Containers are never
 *   emitted; `value:null` is preserved (derives `null`) and a present value (incl. `""`) derives
 *   `present`.
 * - An absent `extract_result` (or absent key) → key omitted → scored `missing` by the golden's
 *   key set.
 */
export function mapLlamaExtractResponse(res: LlamaExtractResponse): Record<string, AdapterField> {
  const out: Record<string, AdapterField> = {};
  const data = res.extract_result;
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return out;
  }
  for (const [pointer, value] of Object.entries(flattenJsonLeaves(data))) {
    // No confidence ever (degenerate-but-valid 0.5 fallback downstream).
    out[pointer] = { value };
  }
  return out;
}

/** The inline (stateless) job configuration — the caller's JSON Schema rides as `data_schema`. */
export function buildLlamaExtractConfiguration(jsonSchema: object): Record<string, unknown> {
  return { extraction_target: 'per_doc', data_schema: jsonSchema };
}

/** True while the job is still queued/processing (poll again); false on any terminal status. */
function isPending(status: string | undefined): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

function responseObject(
  raw: unknown,
  phase: string,
  provenance: AdapterResponseProvenance,
): LlamaExtractResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractFailureError(
      `llamaextract: ${phase} response is not an object`,
      undefined,
      undefined,
      provenance,
    );
  }
  return raw as LlamaExtractResponse;
}

function responseProvenance(
  response: LlamaExtractResponse | undefined,
  opts: EvalAdapterOpts,
): AdapterResponseProvenance {
  return {
    ...(opts.transport.lastResponseProvenance?.() ?? {}),
    ...(typeof response?.configuration?.version === 'string'
      ? { vendorVersion: response.configuration.version }
      : {}),
    ...(typeof response?.id === 'string' ? { requestId: response.id } : {}),
  };
}

/**
 * The live 3-step flow: multipart upload → stateless job create → poll to terminal. Every send
 * goes through the injected transport (so tests record the EXACT requests with zero network).
 */
async function extractLive(
  docBytes: Uint8Array,
  jsonSchema: object,
  opts: EvalAdapterOpts,
): Promise<LlamaExtractResponse> {
  // 1. Upload the document bytes (multipart; liveTransport passes FormData through untouched).
  const form = new FormData();
  // Copy into a fresh Uint8Array<ArrayBuffer> — BlobPart rejects a possibly-shared buffer view.
  form.append(
    'file',
    new Blob([new Uint8Array(docBytes)], { type: 'application/pdf' }),
    'document.pdf',
  );
  form.append('purpose', 'extract');
  const uploadRaw = await opts.transport.send({
    key: 'llamaextract/upload',
    url: LLAMAEXTRACT_UPLOAD_URL,
    method: 'POST',
    body: form,
  });
  const uploaded = responseObject(uploadRaw, 'upload', responseProvenance(undefined, opts));
  if (typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
    throw new ContractFailureError(
      'llamaextract: upload returned no file id',
      undefined,
      undefined,
      responseProvenance(uploaded, opts),
    );
  }

  // 2. Create the stateless extract job — the schema rides inline; no agent is created.
  const createRaw = await opts.transport.send({
    key: 'llamaextract/create',
    url: LLAMAEXTRACT_EXTRACT_URL,
    method: 'POST',
    body: { file_input: uploaded.id, configuration: buildLlamaExtractConfiguration(jsonSchema) },
  });
  let job = responseObject(createRaw, 'create', responseProvenance(undefined, opts));
  if (typeof job.id !== 'string' || job.id.length === 0) {
    throw new ContractFailureError(
      'llamaextract: create returned no job id',
      undefined,
      undefined,
      responseProvenance(job, opts),
    );
  }

  // 3. Poll to terminal (first poll immediate, then every interval, capped).
  let polls = 0;
  const pollDeadline =
    opts.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : opts.deadlineAt - LLAMAEXTRACT_POLL_HEADROOM_MS;
  while (isPending(job.status)) {
    if (
      polls >= LLAMAEXTRACT_MAX_POLLS ||
      Date.now() >= pollDeadline ||
      (polls > 0 && Date.now() + LLAMAEXTRACT_POLL_INTERVAL_MS >= pollDeadline)
    ) {
      throw new ContractFailureError(
        `llamaextract: job ${job.id} still ${job.status} at the polling cap after ${polls} polls`,
        undefined,
        undefined,
        responseProvenance(job, opts),
      );
    }
    if (polls > 0) await sleep(LLAMAEXTRACT_POLL_INTERVAL_MS, opts.signal);
    const pollRaw = await opts.transport.send({
      key: 'llamaextract/poll',
      url: `${LLAMAEXTRACT_EXTRACT_URL}/${job.id}`,
      method: 'GET',
    });
    job = responseObject(pollRaw, 'poll', responseProvenance(undefined, opts));
    polls++;
  }
  if (job.status !== 'COMPLETED') {
    throw new ContractFailureError(
      `llamaextract: job ${job.id ?? '?'} ended ${job.status ?? 'unknown'}`,
      undefined,
      undefined,
      responseProvenance(job, opts),
    );
  }
  if (
    job.extract_result === null ||
    typeof job.extract_result !== 'object' ||
    Array.isArray(job.extract_result)
  ) {
    throw new ContractFailureError(
      `llamaextract: completed job ${job.id} has no usable result`,
      undefined,
      undefined,
      responseProvenance(job, opts),
    );
  }
  return job;
}

export const llamaextractAdapter: EvalAdapter = {
  id: 'llamaextract',
  async extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult> {
    if (opts.mode === 'live') {
      const job = await extractLive(docBytes, jsonSchema, opts);
      return {
        fields: mapLlamaExtractResponse(job),
        raw: job,
        provenance: responseProvenance(job, opts),
      };
    }
    // Fixture mode: one send, resolved to the recorded completed-job JSON (ZERO network, byte-
    // identical to the pre-live-wiring behavior). The body carries the real inline configuration
    // for parity; `file_input` cannot exist without a live upload, so it is honestly absent.
    const fixtureRaw = await opts.transport.send({
      key: LLAMAEXTRACT_FIXTURE_KEY,
      url: LLAMAEXTRACT_EXTRACT_URL,
      method: 'POST',
      body: { configuration: buildLlamaExtractConfiguration(jsonSchema) },
    });
    const raw = responseObject(fixtureRaw, 'fixture', responseProvenance(undefined, opts));
    if (
      raw.status !== 'COMPLETED' ||
      raw.extract_result === null ||
      typeof raw.extract_result !== 'object' ||
      Array.isArray(raw.extract_result)
    ) {
      throw new ContractFailureError(
        'llamaextract: fixture response has no usable completed result',
        undefined,
        undefined,
        responseProvenance(raw, opts),
      );
    }
    return {
      fields: mapLlamaExtractResponse(raw),
      raw,
      provenance: responseProvenance(raw, opts),
    };
  },
};
