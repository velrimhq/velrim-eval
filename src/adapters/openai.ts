/**
 * The OpenAI eval adapter — a FAIR DIY baseline a customer could build themselves.
 *
 * Two modes the user can A/B to reproduce the ExtractBench gap THEMSELVES:
 *   - free-decode (default): ask for JSON in the prompt, then repair the free text with this
 *     CLI's OWN bundled SAP-lite repair (a small, self-contained JSON salvager — it MUST NOT
 *     import `@velrim/core`'s proprietary SAP; the whole point is a fair, reproducible baseline).
 *   - `--structured-mode` (`opts.structuredMode`): re-run with constrained decoding
 *     (`response_format` json_schema). This is what surfaces the ExtractBench gap; the adapter
 *     records that it was used in `raw.structuredMode` so the report can label the column.
 *
 * Confidence: from `choices[0].logprobs.content` when present (the `gpt-logprobs.json` fixture
 * shape) — a per-leaf confidence derived from the token logprobs covering that leaf's value, fell
 * back to a whole-response mean. When logprobs are absent → confidence is OMITTED → scoring uses
 * `DEFAULT_CONFIDENCE` (0.5).
 *
 * Live wire contract (verified against the current OpenAI file-inputs docs, mid-2026):
 *   POST https://api.openai.com/v1/chat/completions
 *   Authorization: Bearer $OPENAI_API_KEY   (added by liveTransport, never here)
 *   The PDF rides as a `{ type:'file', file:{ filename, file_data:'data:application/pdf;base64,…' } }`
 *   content part; the JSON Schema rides IN THE PROMPT (free-decode default). `logprobs: true` asks
 *   for the per-token confidences. `--structured-mode` adds `response_format:{ type:'json_schema' }`.
 *
 * Fixture-backed by default (`run` wires `--live` → liveTransport, env key `OPENAI_API_KEY`).
 * The SAME body is constructed in both modes — the fixture transport simply never sends it.
 * Pure TS, ESM, zero runtime deps. NO import of `@velrim/core`.
 */

import { bytesToBase64 } from './bytes.js';
import { flattenJsonLeaves } from './flatten.js';
import { ContractFailureError } from './errors.js';
import type {
  AdapterExtractResult,
  AdapterField,
  AdapterResponseProvenance,
  EvalAdapter,
  EvalAdapterOpts,
  TrimmableParam,
} from './types.js';
import { SHARED_EXTRACTION_INSTRUCTION } from '../protocol.js';

/** Live endpoint (used by the `--live` transport; the fixture transport ignores it). */
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * The DIY-baseline model. `gpt-5.4-mini` is the same eval-target model Velrim's own production
 * eval lineup pins — a fair, reproducible, cheap default a customer could pick themselves.
 * Bump deliberately; the report column is labeled with the model it measured.
 */
export const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';

/** Fixture keys: free-decode vs the `--structured-mode` re-run (distinct recorded responses). */
export const OPENAI_FIXTURE_KEY = {
  free: 'openai/gpt-logprobs',
  structured: 'openai/gpt-structured',
} as const;

// --- OpenAI response shape (the subset this adapter reads; OpenAI-compatible) ---------

/** A single per-token logprob entry (OpenAI Chat Completions shape). */
export interface OpenAILogprobToken {
  token: string;
  logprob: number;
}

export interface OpenAIChoice {
  message?: { content?: string | null };
  finish_reason?: string;
  logprobs?: { content?: OpenAILogprobToken[] | null } | null;
}

export interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
}

// --- bundled SAP-lite: a small, self-contained JSON salvager (NOT @velrim/core's SAP) ---

/**
 * The CLI's OWN minimal JSON repair — deliberately simple and self-contained so the OpenAI
 * baseline is reproducible by any customer. This is NOT Velrim's proprietary SAP repair ladder
 * (that stays in `@velrim/core` and is never imported here). It handles the few benign things a
 * free-decoding model commonly emits around otherwise-valid JSON:
 *   - a leading/trailing Markdown code fence (```json … ```)
 *   - leading prose before the first `{` and trailing prose after the last `}`
 *   - a single trailing comma before `}`/`]`
 * If it still cannot parse, it returns `undefined` (no fabricated object) — `extract()` then
 * records the doc-repeat as a first-class CONTRACT FAILURE (FD-3: 2xx-but-unusable, no retry,
 * scored as an empty prediction), an HONEST representation of a free-decode failure, which is
 * exactly the gap the structured-mode comparison exists to show.
 */
export function sapLiteRepair(rawText: string): unknown {
  const direct = tryParse(rawText);
  if (direct !== undefined) return direct;

  let s = rawText.trim();
  // Strip a Markdown code fence.
  s = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const fenced = tryParse(s);
  if (fenced !== undefined) return fenced;

  // Slice to the outermost {...} or [...] (drop surrounding prose).
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  let sliced: string | undefined;
  if (objStart !== -1 && objEnd > objStart) sliced = s.slice(objStart, objEnd + 1);
  else if (arrStart !== -1 && arrEnd > arrStart) sliced = s.slice(arrStart, arrEnd + 1);
  if (sliced !== undefined) {
    const slicedParse = tryParse(sliced);
    if (slicedParse !== undefined) return slicedParse;
    // Last resort: drop a single trailing comma before a closer.
    const decommad = sliced.replace(/,\s*([}\]])/g, '$1');
    const decommadParse = tryParse(decommad);
    if (decommadParse !== undefined) return decommadParse;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- confidence from logprobs (gpt-logprobs.json shape) -------------------------------

/**
 * Per-leaf confidence from the response's token logprobs (when present). OpenAI returns a flat
 * token stream over the WHOLE completion, not aligned to JSON pointers, so we approximate: a
 * leaf's confidence is `exp(mean logprob)` over the tokens whose text overlaps that leaf's
 * serialized value; if no token matches (or alignment is impossible), we use the whole-response
 * mean. Returns `undefined` when the engine surfaced no logprobs at all → confidence omitted →
 * scoring uses `DEFAULT_CONFIDENCE`.
 */
export function confidenceFromLogprobs(
  tokens: OpenAILogprobToken[] | null | undefined,
  serializedValue: string,
): number | undefined {
  if (!tokens || tokens.length === 0) return undefined;
  const matching = tokens.filter(
    (t) =>
      serializedValue.length > 0 &&
      serializedValue.includes(t.token.trim()) &&
      t.token.trim().length > 0,
  );
  const pool = matching.length > 0 ? matching : tokens;
  let sum = 0;
  for (const t of pool) sum += t.logprob;
  const mean = sum / pool.length;
  // exp(meanLogprob) → a probability in (0,1]; clamp for safety.
  return Math.min(1, Math.max(0, Math.exp(mean)));
}

// --- chat-completions post-transport contract ------------------------------------------

/** The minimal OpenAI-compatible response surface the shared contract inspects. */
interface ChatCompletionLike {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * THE post-transport contract for OpenAI-compatible chat-completions responses. Validates the
 * 2xx body, assembles provenance, and SAP-lite-parses the content exactly ONCE; the returned
 * `parsed` object is handed to the arm's mapper so the guard and the mapping can never see two
 * different parses.
 */
export function parseChatCompletion<R extends ChatCompletionLike>(
  adapterId: string,
  raw: unknown,
  transportProvenance: AdapterResponseProvenance,
  provenanceFrom: (response: R) => AdapterResponseProvenance,
): { response: R; parsed: Record<string, unknown>; provenance: AdapterResponseProvenance } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractFailureError(
      `${adapterId}: 2xx response is not an object`,
      undefined,
      undefined,
      transportProvenance,
    );
  }
  const response = raw as R;
  const provenance = { ...transportProvenance, ...provenanceFrom(response) };
  if (!Array.isArray(response.choices)) {
    throw new ContractFailureError(
      `${adapterId}: 2xx response has no choices array`,
      undefined,
      undefined,
      provenance,
    );
  }
  const content = response.choices[0]?.message?.content;
  const parsed = typeof content === 'string' ? sapLiteRepair(content) : undefined;
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new ContractFailureError(
      `${adapterId}: 2xx response has no usable JSON object`,
      undefined,
      undefined,
      provenance,
    );
  }
  return { response, parsed: parsed as Record<string, unknown>, provenance };
}

// --- response → flat fields -----------------------------------------------------------

/**
 * Map an OpenAI chat response → the flat per-pointer `{ value; confidence? }` map.
 *
 * - `preParsed` (from `parseChatCompletion`) is used when given so the response is parsed once;
 *   calling the mapper alone repairs the content with `sapLiteRepair`, and on failure returns
 *   `{}` (every golden leaf scores `missing`). Via `extract()` an unusable response never
 *   reaches the mapper — it is recorded as a first-class contract failure (FD-3).
 * - Nested objects and arrays are recursively flattened to RFC 6901 leaves. Containers are never
 *   emitted; `value:null` is preserved (derives `null`) and a present value (incl. `""`) derives
 *   `present`.
 * - Confidence is attached per leaf from logprobs when present; omitted otherwise.
 */
export function mapOpenAIResponse(
  res: OpenAIChatResponse,
  preParsed?: unknown,
): Record<string, AdapterField> {
  const choice = res.choices?.[0];
  const content = choice?.message?.content ?? '';
  const tokens = choice?.logprobs?.content ?? null;

  const parsed = preParsed ?? sapLiteRepair(content);
  const out: Record<string, AdapterField> = {};
  if (
    parsed === undefined ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return out;
  }
  for (const [pointer, value] of Object.entries(
    flattenJsonLeaves(parsed as Record<string, unknown>),
  )) {
    const field: AdapterField = { value };
    const serialized =
      value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value);
    const conf = confidenceFromLogprobs(tokens, serialized);
    if (conf !== undefined) field.confidence = conf;
    out[pointer] = field;
  }
  return out;
}

// --- request construction (the body a live call actually sends) -----------------------

/**
 * Build the prompt that carries the caller's JSON Schema (free-decode: schema-in-prompt, JSON
 * asked for in text — the fair DIY baseline; NO constrained decoding unless `--structured-mode`).
 */
export function buildOpenAIPrompt(jsonSchema: object): string {
  return `${SHARED_EXTRACTION_INSTRUCTION}\n\nJSON Schema:\n${JSON.stringify(jsonSchema)}`;
}

/**
 * The Chat Completions body: PDF attached as a base64 `file` content part (data-URL form, per the
 * current file-inputs contract), schema in the prompt, `logprobs: true`, `temperature: 0` for a
 * reproducible baseline. `structured` adds `response_format: json_schema` (constrained decoding —
 * the ExtractBench-gap arm; `strict: true` is what "constrained" means on this API).
 *
 * `trims` drops smoke-refused params from the body entirely (never sends a substitute
 * value): a trimmed `logprobs` also means no logprob-derived confidence can exist downstream —
 * confidence is simply omitted and scoring falls back to DEFAULT_CONFIDENCE.
 */
export function buildOpenAIRequestBody(
  docBytes: Uint8Array,
  jsonSchema: object,
  structured: boolean,
  trims: readonly TrimmableParam[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: OPENAI_MODEL,
    ...(trims.includes('temperature') ? {} : { temperature: 0 }),
    ...(trims.includes('logprobs') ? {} : { logprobs: true }),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              filename: 'document.pdf',
              file_data: `data:application/pdf;base64,${bytesToBase64(docBytes)}`,
            },
          },
          { type: 'text', text: buildOpenAIPrompt(jsonSchema) },
        ],
      },
    ],
  };
  if (structured) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: jsonSchema },
    };
  }
  return body;
}

export const openaiAdapter: EvalAdapter = {
  id: 'openai',
  async extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult> {
    const structured = opts.structuredMode === true;
    const trims = opts.trimParams ?? [];
    const key = structured ? OPENAI_FIXTURE_KEY.structured : OPENAI_FIXTURE_KEY.free;
    // The REAL body in both modes (the fixture transport ignores it) — doc attached as base64,
    // schema in the prompt, structured mode adds constrained decoding.
    const raw = await opts.transport.send({
      key,
      url: OPENAI_CHAT_URL,
      method: 'POST',
      body: buildOpenAIRequestBody(docBytes, jsonSchema, structured, trims),
    });
    const { response, parsed, provenance } = parseChatCompletion<OpenAIChatResponse>(
      'openai',
      raw,
      opts.transport.lastResponseProvenance?.() ?? {},
      (res) => ({
        ...(typeof res.model === 'string' ? { modelVersion: res.model } : {}),
        ...(typeof res.id === 'string' ? { requestId: res.id } : {}),
      }),
    );
    return {
      fields: mapOpenAIResponse(response, parsed),
      raw: {
        structuredMode: structured,
        ...(trims.length === 0 ? {} : { trimmedParams: [...trims] }),
        response: raw,
      },
      provenance,
    };
  },
};
