/**
 * Gemini bake-off adapter (A2/A3) — the HEADLINE bare-model control ("Gemini reseller"
 * answer), Google AI Studio direct, never Vertex: Vertex's terms attach replication-disclosure
 * and reciprocity conditions to publishing benchmark results; the AI Studio terms carry no
 * benchmark clause at all (the arms table pins the AI Studio route: ANALYSIS-PLAN.md §2).
 *
 * Two modes, ONE prompt (prompt parity, ANALYSIS-PLAN.md §5.4 — byte-identical across A2/A3/A5,
 * built by the shared `buildOpenAIPrompt` so the bytes can never fork):
 *   - A2 free-decode (default): schema in the prompt via the ONE shared minimal instruction, the
 *     PDF inline as base64, vendor-default generation settings except `temperature: 0` (the one
 *     pre-registered rule the shipped OpenAI adapter pins — carried to Gemini). The free text is
 *     repaired with this CLI's OWN bundled `sapLiteRepair` — NEVER `@velrim/core`'s SAP.
 *   - A3 constrained (`opts.structuredMode`): identical prompt bytes; the ONLY difference is
 *     decoding config — `generationConfig.responseJsonSchema` carries the caller's schema
 *     (2.5-flash acceptance of `responseJsonSchema` is a pre-freeze smoke item;
 *     `--trim-param temperature` covers the smoke-driven param-survival rule).
 *
 * Confidence is NOT requested and never derived (bare-model cells render "not requested" —
 * adding a confidence ask would break byte-identical prompt parity; ANALYSIS-PLAN.md §6.5).
 * Model pin: `gemini-2.5-flash`, never `-latest`. Auth: the key rides in the `x-goog-api-key`
 * header via the transport's `authStyle` extension — this adapter never touches the key itself.
 *
 * Fixture-backed by default (`run` wires `--live` → liveTransport, env key `GEMINI_API_KEY`).
 * Pure TS, ESM, zero runtime deps. NO import of `@velrim/core`.
 */

import { bytesToBase64 } from './bytes.js';
import { flattenJsonLeaves } from './flatten.js';
import { ContractFailureError, FatalRunError } from './errors.js';
import { buildOpenAIPrompt, sapLiteRepair } from './openai.js';
import type {
  AdapterExtractResult,
  AdapterField,
  AdapterResponseProvenance,
  EvalAdapter,
  EvalAdapterOpts,
  TrimmableParam,
} from './types.js';

/** Model pin — never `-latest` (deprecation horizon ≥2026-10-16; ANALYSIS-PLAN.md §9.4). */
export const GEMINI_MODEL = 'gemini-2.5-flash';

/** Google AI Studio generateContent endpoint (model in the PATH, key in the header — never here). */
export const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Fixture keys: A2 free-decode vs the A3 `--structured-mode` re-run (distinct recordings). */
export const GEMINI_FIXTURE_KEY = {
  free: 'gemini/generate-free',
  structured: 'gemini/generate-structured',
} as const;

// --- generateContent response shape (the subset this adapter reads) ---------------------

export interface GeminiPart {
  text?: string;
}

export interface GeminiCandidate {
  content?: { parts?: GeminiPart[] | null; role?: string } | null;
  finishReason?: string;
}

export interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  /** Present (with a blockReason) when the prompt was blocked and no candidates exist. */
  promptFeedback?: { blockReason?: string } | null;
  modelVersion?: string;
  responseId?: string;
}

// --- request construction (the body a live call actually sends) -------------------------

/**
 * The generateContent body: shared prompt text part (byte-identical to A5 — built by the one
 * shared builder), PDF inline as base64, and `generationConfig.temperature: 0` (the one
 * pre-registered rule; everything else stays vendor-default — nothing else is ever set).
 * `structured` (A3) adds `generationConfig.responseJsonSchema` — the ONLY free-vs-constrained
 * difference. The model is pinned in the URL, not the body.
 *
 * `trims`: a smoke-refused `temperature` is OMITTED from the body entirely (never sent
 * with a substitute value); an empty generationConfig is dropped so the request stays exactly
 * vendor-default. `logprobs` is not a Gemini request param — `extract()` rejects it loudly
 * instead of recording a trim that never changed the wire body.
 */
export function buildGeminiRequestBody(
  docBytes: Uint8Array,
  jsonSchema: object,
  structured: boolean,
  trims: readonly TrimmableParam[] = [],
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    ...(trims.includes('temperature') ? {} : { temperature: 0 }),
    ...(structured ? { responseJsonSchema: jsonSchema } : {}),
  };
  return {
    contents: [
      {
        parts: [
          { text: buildOpenAIPrompt(jsonSchema) },
          {
            inline_data: {
              mime_type: 'application/pdf',
              data: bytesToBase64(docBytes),
            },
          },
        ],
      },
    ],
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
  };
}

// --- post-transport contract (mirrors parseChatCompletion's FD-3 taxonomy) --------------

/**
 * Validate a 2xx generateContent body, assemble provenance, and SAP-lite-parse the candidate
 * text exactly ONCE (the returned `parsed` is handed to the mapper so guard and mapping can
 * never see two different parses). Contract failures — non-object body, missing/empty
 * candidates (including safety-blocked responses), no text parts, unusable JSON after repair —
 * throw `ContractFailureError` with the provenance attached; messages stay content-free (no
 * provider-supplied strings, mirroring the shared chat-completions contract).
 */
export function parseGeminiResponse(
  raw: unknown,
  transportProvenance: AdapterResponseProvenance,
): {
  response: GeminiGenerateResponse;
  parsed: Record<string, unknown>;
  provenance: AdapterResponseProvenance;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractFailureError(
      'gemini: 2xx response is not an object',
      undefined,
      undefined,
      transportProvenance,
    );
  }
  const response = raw as GeminiGenerateResponse;
  const provenance: AdapterResponseProvenance = {
    ...transportProvenance,
    ...(typeof response.modelVersion === 'string' ? { modelVersion: response.modelVersion } : {}),
    ...(typeof response.responseId === 'string' ? { requestId: response.responseId } : {}),
  };
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    // Includes the safety-blocked shape (promptFeedback.blockReason, zero candidates). The
    // reason string is provider-supplied and is deliberately NOT echoed into the message.
    throw new ContractFailureError(
      'gemini: 2xx response has no candidates (empty or blocked response)',
      undefined,
      undefined,
      provenance,
    );
  }
  const text = candidateText(response);
  if (text.length === 0) {
    throw new ContractFailureError(
      'gemini: 2xx candidate has no text parts',
      undefined,
      undefined,
      provenance,
    );
  }
  const parsed = sapLiteRepair(text);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new ContractFailureError(
      'gemini: 2xx response has no usable JSON object',
      undefined,
      undefined,
      provenance,
    );
  }
  return { response, parsed: parsed as Record<string, unknown>, provenance };
}

/** Join every string text part of the first candidate (Gemini may split output across parts). */
function candidateText(res: GeminiGenerateResponse): string {
  const parts = res.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

// --- response → flat fields -------------------------------------------------------------

/**
 * Map repaired candidate JSON to recursive RFC-6901 leaves WITHOUT constructing
 * confidence (the cell renders "not requested" — never fabricated). `preParsed` (from
 * `parseGeminiResponse`) is used when given so the response is parsed exactly once; calling the
 * mapper alone repairs the text itself and returns `{}` on failure (via `extract()` that case is
 * a recorded contract failure instead).
 */
export function mapGeminiResponse(
  res: GeminiGenerateResponse,
  preParsed?: unknown,
): Record<string, AdapterField> {
  const parsed = preParsed ?? sapLiteRepair(candidateText(res));
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return {};
  }
  const out: Record<string, AdapterField> = {};
  for (const [pointer, value] of Object.entries(
    flattenJsonLeaves(parsed as Record<string, unknown>),
  )) {
    out[pointer] = { value };
  }
  return out;
}

export const geminiAdapter: EvalAdapter = {
  id: 'gemini',
  async extract(
    docBytes: Uint8Array,
    jsonSchema: object,
    opts: EvalAdapterOpts,
  ): Promise<AdapterExtractResult> {
    const structured = opts.structuredMode === true;
    const trims = opts.trimParams ?? [];
    if (trims.includes('logprobs')) {
      // Gemini never sends a logprobs param; recording a "trim" that changed nothing on the
      // wire would misstate the run manifest. Loud protocol error before any transport spend.
      throw new FatalRunError(
        'gemini: --trim-param logprobs is not a gemini request param (temperature only)',
      );
    }
    const key = structured ? GEMINI_FIXTURE_KEY.structured : GEMINI_FIXTURE_KEY.free;
    // The REAL body in both modes (the fixture transport ignores it) — doc inline as base64,
    // shared prompt bytes, structured mode adding ONLY the responseJsonSchema decoding config.
    const raw = await opts.transport.send({
      key,
      url: GEMINI_GENERATE_URL,
      method: 'POST',
      body: buildGeminiRequestBody(docBytes, jsonSchema, structured, trims),
    });
    const { response, parsed, provenance } = parseGeminiResponse(
      raw,
      opts.transport.lastResponseProvenance?.() ?? {},
    );
    return {
      fields: mapGeminiResponse(response, parsed),
      raw: {
        structuredMode: structured,
        ...(trims.length === 0 ? {} : { trimmedParams: [...trims] }),
        response: raw,
      },
      provenance,
    };
  },
};
