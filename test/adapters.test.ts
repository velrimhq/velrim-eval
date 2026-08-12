/**
 * Adapter REQUEST-CONSTRUCTION + RESPONSE-MAPPING proofs: adapters must actually send the doc
 * bytes — proven per request (an adapter that ignored docBytes would 400 live).
 *
 * ZERO network anywhere: a fake recording Transport is injected and every request the adapter
 * WOULD send is asserted — method, url, body shape, and crucially that the base64 of the doc
 * bytes is actually IN the body. Response mapping is proven from the recorded fixtures under
 * test/recorded/ (the same files the fixture transport serves).
 *
 * The liveTransport itself is proven with an injected fetchImpl (no socket): Authorization
 * header from env, JSON vs FormData body handling, fail-fast MissingLiveKeyError, and that no
 * error message ever leaks the key.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';

import { velrimAdapter, mapVelrimResponse, VELRIM_EXTRACT_URL } from '../src/adapters/velrim.js';
import type { VelrimExtractResponse } from '../src/adapters/velrim.js';
import {
  openaiAdapter,
  buildOpenAIRequestBody,
  mapOpenAIResponse,
  OPENAI_CHAT_URL,
  OPENAI_MODEL,
} from '../src/adapters/openai.js';
import type { OpenAIChatResponse } from '../src/adapters/openai.js';
import {
  llamaextractAdapter,
  mapLlamaExtractResponse,
  LLAMAEXTRACT_UPLOAD_URL,
  LLAMAEXTRACT_EXTRACT_URL,
  LLAMAEXTRACT_FIXTURE_KEY,
  LLAMAEXTRACT_MAX_POLLS,
  LLAMAEXTRACT_POLL_HEADROOM_MS,
  LLAMAEXTRACT_POLL_INTERVAL_MS,
} from '../src/adapters/llamaextract.js';
import type { LlamaExtractResponse } from '../src/adapters/llamaextract.js';
import {
  mistralAdapter,
  mapMistralResponse,
  MISTRAL_OCR_URL,
  MISTRAL_MODEL,
  MISTRAL_PAGE_CAP,
} from '../src/adapters/mistral.js';
import type { MistralOcrResponse } from '../src/adapters/mistral.js';
import { liveTransport, MissingLiveKeyError } from '../src/adapters/transport.js';
import { sleep } from '../src/adapters/sleep.js';
import { getAdapter } from '../src/adapters/index.js';
import {
  ContractFailureError,
  FatalRunError,
  TransportFailureError,
} from '../src/adapters/errors.js';
import { bytesToBase64 } from '../src/adapters/bytes.js';
import type { Transport, TransportRequest } from '../src/adapters/types.js';
import {
  DEFAULT_DOC_TIMEOUT_MS,
  MAX_TRANSPORT_RETRIES,
  RETRY_BACKOFF_MS,
  executeDocRepeat,
} from '../src/run/runner.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const recorded = (rel: string): unknown =>
  JSON.parse(readFileSync(join(TEST_DIR, 'recorded', rel), 'utf8'));

const DOC_BYTES = new TextEncoder().encode('%PDF-1.7 fake eval doc bytes');
const DOC_B64 = Buffer.from(DOC_BYTES).toString('base64');
const SCHEMA = { type: 'object', properties: { vendor: { type: 'string' } } } as const;

/** A recording fake Transport: captures every request, replays the queued responses in order. */
function fakeTransport(responses: unknown[]): { transport: Transport; sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  let i = 0;
  return {
    sent,
    transport: {
      mode: 'live',
      send(req: TransportRequest): Promise<unknown> {
        sent.push(req);
        const res = responses[Math.min(i, responses.length - 1)];
        i++;
        return Promise.resolve(res);
      },
    },
  };
}

// ── Velrim: POST /v1/extract with { schema, document: { bytes_base64 } } ────────────────────

describe('velrim adapter — request construction (the /v1/extract envelope)', () => {
  it('sends ONE POST to the extract URL with the schema and the base64 doc bytes IN the body', async () => {
    const { transport, sent } = fakeTransport([{ fields: {} }]);
    await velrimAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(VELRIM_EXTRACT_URL);
    const body = req.body as { schema: object; document: { bytes_base64: string } };
    expect(body.schema).toBe(SCHEMA); // the caller's JSON Schema object, verbatim
    expect(body.document.bytes_base64).toBe(DOC_B64); // the doc actually rides in the request
  });

  it('rejects malformed 2xx leaf contracts with a typed contract failure', async () => {
    for (const response of [
      { fields: { '/vendor': null } },
      { fields: { '/vendor': { state: 'present' } } },
      { fields: { '/vendor': { state: 'present', value: 'ACME', confidence: 2 } } },
    ]) {
      const { transport } = fakeTransport([response]);
      await expect(
        velrimAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }),
      ).rejects.toBeInstanceOf(ContractFailureError);
    }
  });
});

describe('velrim adapter — response mapping (recorded /v1/extract body)', () => {
  const res = recorded('velrim/extract.json') as VelrimExtractResponse;

  it('maps state/value/confidence per pointer from the wire shape', () => {
    const fields = mapVelrimResponse(res);
    expect(fields['/vendor']).toEqual({ value: 'ACME', confidence: 0.99 });
    expect(fields['/tax']).toEqual({ value: null, confidence: 0.97 }); // state:'null' → value null
  });

  it('omits an explicit state:"missing" leaf (scored missing by the golden key set)', () => {
    const fields = mapVelrimResponse({
      fields: {
        '/a': { state: 'present', value: 1, confidence: 0.9 },
        '/gone': { state: 'missing' },
      },
    });
    expect(fields['/a']).toEqual({ value: 1, confidence: 0.9 });
    expect('/gone' in fields).toBe(false);
  });
});

// ── OpenAI: Chat Completions with the PDF as a base64 `file` content part ───────────────────

describe('openai adapter — request construction (file content part + schema-in-prompt)', () => {
  interface OpenAIBody {
    model: string;
    temperature: number;
    logprobs: boolean;
    messages: {
      role: string;
      content: (
        | { type: 'file'; file: { filename: string; file_data: string } }
        | { type: 'text'; text: string }
      )[];
    }[];
    response_format?: {
      type: string;
      json_schema: { name: string; strict: boolean; schema: object };
    };
  }

  it('free-decode: POSTs the PDF as a data-URL file part, schema in the prompt, logprobs on', async () => {
    const { transport, sent } = fakeTransport([{ choices: [{ message: { content: '{}' } }] }]);
    await openaiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(OPENAI_CHAT_URL);
    const body = req.body as OpenAIBody;
    expect(body.model).toBe(OPENAI_MODEL);
    expect(body.logprobs).toBe(true);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toBeUndefined(); // free-decode: NO constrained decoding

    const content = body.messages[0]!.content;
    const filePart = content.find((p) => p.type === 'file') as {
      file: { filename: string; file_data: string };
    };
    expect(filePart.file.filename).toBe('document.pdf');
    expect(filePart.file.file_data).toBe(`data:application/pdf;base64,${DOC_B64}`); // doc IN the body
    const textPart = content.find((p) => p.type === 'text') as { text: string };
    expect(textPart.text).toContain(JSON.stringify(SCHEMA)); // schema rides in the prompt
  });

  it('--structured-mode adds response_format json_schema (strict) and STILL attaches the doc', async () => {
    const { transport, sent } = fakeTransport([{ choices: [{ message: { content: '{}' } }] }]);
    await openaiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      structuredMode: true,
      transport,
    });

    const body = sent[0]!.body as OpenAIBody;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: SCHEMA },
    });
    const filePart = body.messages[0]!.content.find((p) => p.type === 'file') as {
      file: { file_data: string };
    };
    expect(filePart.file.file_data.endsWith(DOC_B64)).toBe(true);
  });

  it('rejects a non-object 2xx body with a typed contract failure', async () => {
    const { transport } = fakeTransport([null]);
    await expect(
      openaiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }),
    ).rejects.toBeInstanceOf(ContractFailureError);
  });
});

describe('openai adapter — smoke-driven param trim (drop refused params, record in run-meta)', () => {
  it('a trimmed param is OMITTED from the body entirely — never sent with a substitute value', () => {
    const full = buildOpenAIRequestBody(DOC_BYTES, SCHEMA, false);
    expect(full).toHaveProperty('logprobs', true);
    expect(full).toHaveProperty('temperature', 0);

    const trimmed = buildOpenAIRequestBody(DOC_BYTES, SCHEMA, false, ['logprobs', 'temperature']);
    expect('logprobs' in trimmed).toBe(false);
    expect('temperature' in trimmed).toBe(false);
    expect(trimmed['model']).toBe(OPENAI_MODEL); // the pin survives every trim

    const logprobsOnly = buildOpenAIRequestBody(DOC_BYTES, SCHEMA, false, ['logprobs']);
    expect('logprobs' in logprobsOnly).toBe(false);
    expect(logprobsOnly).toHaveProperty('temperature', 0);
  });

  it('extract() threads opts.trimParams into the wire body and records the trim in raw', async () => {
    const { transport, sent } = fakeTransport([{ choices: [{ message: { content: '{}' } }] }]);
    const result = await openaiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      trimParams: ['logprobs'],
      transport,
    });

    const body = sent[0]!.body as Record<string, unknown>;
    expect('logprobs' in body).toBe(false);
    expect(body['temperature']).toBe(0);
    expect(result.raw).toMatchObject({ structuredMode: false, trimmedParams: ['logprobs'] });
  });

  it('with no trims the raw record carries NO trimmedParams key (an empty trim is not a trim)', async () => {
    const { transport } = fakeTransport([{ choices: [{ message: { content: '{}' } }] }]);
    const result = await openaiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });
    expect(result.raw).not.toHaveProperty('trimmedParams');
  });

  it('executeDocRepeat threads AdapterExtras.trimParams through to the adapter request', async () => {
    const { transport, sent } = fakeTransport([{ choices: [{ message: { content: '{}' } }] }]);
    const record = await executeDocRepeat(
      openaiAdapter,
      {
        doc: 'a.pdf',
        docClass: 'test',
        bytes: DOC_BYTES,
        schema: SCHEMA,
        golden: { docClass: 'test', fields: {} },
      },
      1,
      'live',
      false,
      () => transport,
      {
        docTimeoutMs: DEFAULT_DOC_TIMEOUT_MS,
        maxTransportRetries: MAX_TRANSPORT_RETRIES,
        contractFailureLimit: 3,
        retryBackoffMs: RETRY_BACKOFF_MS,
      },
      { trimParams: ['temperature'] },
    );
    expect(record.availability).toBe('completed');
    const body = sent[0]!.body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
    expect(body['logprobs']).toBe(true);
  });
});

describe('openai adapter — response mapping (recorded chat completion)', () => {
  it('repairs the fenced free-decode JSON and derives per-leaf logprob confidence', () => {
    const res = recorded('openai/gpt-logprobs.json') as OpenAIChatResponse;
    const fields = mapOpenAIResponse(res);
    expect(fields['/vendor']?.value).toBe('ACME');
    // 'ACME' token logprob -0.02 → confidence exp(-0.02)
    expect(fields['/vendor']?.confidence).toBeCloseTo(Math.exp(-0.02), 10);
    expect(fields['/tax']?.value).toBe(0); // the free-decode fabrication the golden catches
  });

  it('maps the structured-mode recording (bare JSON, nulls preserved)', () => {
    const res = recorded('openai/gpt-structured.json') as OpenAIChatResponse;
    const fields = mapOpenAIResponse(res);
    expect(fields['/tax']?.value).toBeNull();
    expect(fields['/vendor']?.value).toBe('ACME');
  });

  it('flattens nested objects and arrays and aligns confidence to each leaf value', () => {
    const fields = mapOpenAIResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              vendor: { primary: 'ALPHA', secondary: 'BETA', unmatched: 'GAMMA' },
              line_items: [{ description: 'Widget', quantity: 2 }],
              tax: null,
            }),
          },
          logprobs: {
            content: [
              { token: 'ALPHA', logprob: -0.1 },
              { token: 'BETA', logprob: -2 },
            ],
          },
        },
      ],
    });

    expect(fields['/vendor/primary']).toEqual({ value: 'ALPHA', confidence: Math.exp(-0.1) });
    expect(fields['/vendor/secondary']).toEqual({ value: 'BETA', confidence: Math.exp(-2) });
    expect(fields['/vendor/unmatched']).toEqual({
      value: 'GAMMA',
      confidence: Math.exp((-0.1 - 2) / 2),
    });
    expect(fields['/line_items/0/description']?.value).toBe('Widget');
    expect(fields['/line_items/0/quantity']?.value).toBe(2);
    expect(fields['/tax']?.value).toBeNull();
    expect(fields['/vendor']).toBeUndefined();
    expect(fields['/line_items']).toBeUndefined();
  });

  it('omits confidence on every nested leaf when the provider returns no logprobs', () => {
    const fields = mapOpenAIResponse({
      choices: [
        {
          message: { content: JSON.stringify({ vendor: { name: 'ACME' }, amounts: [0, null] }) },
        },
      ],
    });

    expect(fields).toEqual({
      '/vendor/name': { value: 'ACME' },
      '/amounts/0': { value: 0 },
      '/amounts/1': { value: null },
    });
  });

  it('keeps a root array invalid instead of inventing root-level fields', () => {
    expect(
      mapOpenAIResponse({ choices: [{ message: { content: '[{"vendor":"ACME"}]' } }] }),
    ).toEqual({});
  });

  it('accepts the extract()-parsed object and never re-runs SAP-lite repair on it', () => {
    // The content below parses to something ELSE than preParsed: if the mapper re-repaired the
    // content instead of using the passed object, the assertion would see /decoy.
    const decoyContent = '{"decoy": true}';
    const preParsed = { vendor: 'FROM-PREPARSED' };
    const fields = mapOpenAIResponse(
      { choices: [{ message: { content: decoyContent } }] },
      preParsed,
    );
    expect(Object.keys(fields)).toEqual(['/vendor']);
    expect(fields['/vendor']?.value).toBe('FROM-PREPARSED');
  });
});

// ── LlamaExtract: upload → stateless create → poll (v2) ─────────────────────────────────────

describe('llamaextract adapter — live request construction (upload → create → poll)', () => {
  it('uploads the doc bytes as multipart, creates the job with the inline schema, polls to COMPLETED', async () => {
    const { transport, sent } = fakeTransport([
      { id: 'dfl-test-file' },
      { id: 'ext-test-job', status: 'PENDING' },
      { id: 'ext-test-job', status: 'COMPLETED', extract_result: { vendor: 'ACME', tax: null } },
    ]);
    const result = await llamaextractAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      transport,
    });

    expect(sent).toHaveLength(3);

    // 1. upload — multipart FormData carrying the ACTUAL doc bytes + purpose=extract.
    const upload = sent[0]!;
    expect(upload.method).toBe('POST');
    expect(upload.url).toBe(LLAMAEXTRACT_UPLOAD_URL);
    expect(upload.body).toBeInstanceOf(FormData);
    const form = upload.body as FormData;
    expect(form.get('purpose')).toBe('extract');
    const file = form.get('file') as File;
    expect(file.name).toBe('document.pdf');
    const sentBytes = new Uint8Array(await file.arrayBuffer());
    expect(Buffer.from(sentBytes).toString('base64')).toBe(DOC_B64);

    // 2. create — stateless job: the uploaded file id + the caller's schema INLINE.
    const create = sent[1]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe(LLAMAEXTRACT_EXTRACT_URL);
    expect(create.body).toEqual({
      file_input: 'dfl-test-file',
      configuration: { extraction_target: 'per_doc', data_schema: SCHEMA },
    });

    // 3. poll — GET the job by id until terminal.
    const poll = sent[2]!;
    expect(poll.method).toBe('GET');
    expect(poll.url).toBe(`${LLAMAEXTRACT_EXTRACT_URL}/ext-test-job`);

    expect(result.fields).toEqual({ '/vendor': { value: 'ACME' }, '/tax': { value: null } });
  });

  it('a FAILED job throws without persisting its provider-supplied error body', async () => {
    const { transport } = fakeTransport([
      { id: 'dfl-x' },
      { id: 'ext-x', status: 'FAILED', error_message: 'unsupported file' },
    ]);
    const error = await llamaextractAdapter
      .extract(DOC_BYTES, SCHEMA, { mode: 'live', transport })
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect(error).toBeInstanceOf(ContractFailureError);
    expect(error?.message).toContain('FAILED');
    expect(error?.message).not.toContain('unsupported file');
  });

  it('fixture mode stays a SINGLE send resolved by the recorded key (byte-identical behavior)', async () => {
    const { transport, sent } = fakeTransport([recorded('llamaextract/extract.json')]);
    const result = await llamaextractAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'fixture',
      transport,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe(LLAMAEXTRACT_FIXTURE_KEY);
    expect(result.fields['/vendor']).toEqual({ value: 'ACME' });
  });

  it('treats a completed response without extract_result as a contract failure', async () => {
    const { transport } = fakeTransport([{ id: 'ext-empty', status: 'COMPLETED' }]);
    await expect(
      llamaextractAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'fixture', transport }),
    ).rejects.toBeInstanceOf(ContractFailureError);
  });

  it('rejects a non-object phase response with a typed contract failure', async () => {
    const { transport } = fakeTransport([null]);
    await expect(
      llamaextractAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }),
    ).rejects.toBeInstanceOf(ContractFailureError);
  });

  it('reaches the provider poll cap as a contract failure before the shared five-minute cap', async () => {
    vi.useFakeTimers();
    try {
      const { transport, sent } = fakeTransport([
        { id: 'dfl-stuck' },
        { id: 'ext-stuck', status: 'PENDING' },
      ]);
      const extraction = llamaextractAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        transport,
      });
      const rejection = expect(extraction).rejects.toBeInstanceOf(ContractFailureError);
      await vi.runAllTimersAsync();
      await rejection;
      expect(sent).toHaveLength(2 + LLAMAEXTRACT_MAX_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses elapsed-time headroom so realistic poll latency remains a contract failure', async () => {
    expect(
      (LLAMAEXTRACT_MAX_POLLS - 1) * LLAMAEXTRACT_POLL_INTERVAL_MS +
        RETRY_BACKOFF_MS.reduce((sum, delay) => sum + delay, 0),
    ).toBeLessThanOrEqual(DEFAULT_DOC_TIMEOUT_MS - LLAMAEXTRACT_POLL_HEADROOM_MS);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    try {
      let sends = 0;
      const transport: Transport = {
        mode: 'live',
        async send(): Promise<unknown> {
          sends++;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (sends === 1) return { id: 'dfl-latent' };
          return { id: 'ext-latent', status: 'PENDING' };
        },
      };
      const startedAt = Date.now();
      const extraction = executeDocRepeat(
        llamaextractAdapter,
        {
          doc: 'latent.pdf',
          docClass: 'test',
          bytes: DOC_BYTES,
          schema: SCHEMA,
          golden: { docClass: 'test', fields: {} },
        },
        1,
        'live',
        false,
        () => transport,
        {
          docTimeoutMs: DEFAULT_DOC_TIMEOUT_MS,
          maxTransportRetries: MAX_TRANSPORT_RETRIES,
          contractFailureLimit: 3,
          retryBackoffMs: RETRY_BACKOFF_MS,
        },
      );
      await vi.runAllTimersAsync();
      const record = await extraction;
      expect(record.availability).toBe('contract_failure');
      expect(Date.now() - startedAt).toBeLessThanOrEqual(
        DEFAULT_DOC_TIMEOUT_MS - LLAMAEXTRACT_POLL_HEADROOM_MS,
      );
      expect(sends).toBeLessThan(2 + LLAMAEXTRACT_MAX_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('llamaextract adapter — response mapping (recorded completed job)', () => {
  it('maps extract_result values per pointer with NO confidence (0.5 fallback downstream)', () => {
    const res = recorded('llamaextract/extract.json') as LlamaExtractResponse;
    const fields = mapLlamaExtractResponse(res);
    expect(fields['/vendor']).toEqual({ value: 'ACME' });
    expect(fields['/tax']).toEqual({ value: null });
    expect(fields['/vendor']?.confidence).toBeUndefined();
    expect(Object.keys(fields)).toHaveLength(13);
  });

  it('a job without extract_result maps to zero fields (all leaves score missing)', () => {
    expect(mapLlamaExtractResponse({ id: 'ext-x', status: 'PENDING' })).toEqual({});
  });

  it('flattens nested objects and arrays while preserving null and omitting containers', () => {
    expect(
      mapLlamaExtractResponse({
        status: 'COMPLETED',
        extract_result: {
          vendor: { name: 'ACME' },
          line_items: [{ description: 'Widget', quantity: 2 }],
          tax: null,
          empty: {},
        },
      }),
    ).toEqual({
      '/vendor/name': { value: 'ACME' },
      '/line_items/0/description': { value: 'Widget' },
      '/line_items/0/quantity': { value: 2 },
      '/tax': { value: null },
    });
  });
});

// ── liveTransport: env-key fail-fast + exact fetch construction (injected fetchImpl) ────────

// ── Mistral: ONE POST to /v1/ocr with the schema as document_annotation_format (A4) ─────────

describe('mistral adapter — A4 request construction and registry wiring', () => {
  it('sends ONE POST to /v1/ocr: pinned model, doc as a data URL, schema as the annotation format', async () => {
    const { transport, sent } = fakeTransport([
      { model: MISTRAL_MODEL, pages: [{ index: 0 }], document_annotation: '{}' },
    ]);
    await mistralAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(MISTRAL_OCR_URL);
    const body = req.body as {
      model: string;
      document: { type: string; document_url: string };
      document_annotation_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: object };
      };
    };
    expect(body.model).toBe(MISTRAL_MODEL); // the pinned model
    expect(body.document.type).toBe('document_url');
    expect(body.document.document_url).toBe(`data:application/pdf;base64,${DOC_B64}`); // doc IN the body
    expect(body.document_annotation_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: SCHEMA },
    });
  });

  it('is wired into the registry and rejects --structured-mode as run-fatal (single documented mode)', async () => {
    expect(getAdapter('mistral')).toBe(mistralAdapter);
    const { transport } = fakeTransport([{}]);
    await expect(
      mistralAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', structuredMode: true, transport }),
    ).rejects.toBeInstanceOf(FatalRunError);
  });
});

describe('mistral adapter — annotation-JSON mapping (recorded /v1/ocr body, NO confidence ever)', () => {
  const fixture = recorded('mistral/extract.json') as MistralOcrResponse;

  it('parses the document_annotation JSON STRING into recursive RFC-6901 leaves', () => {
    const fields = mapMistralResponse(fixture)!;
    expect(fields['/vendor/name']).toEqual({ value: 'ACME' });
    expect(fields['/line_items/0/description']).toEqual({ value: 'Widget' });
    expect(fields['/line_items/0/quantity']).toEqual({ value: 2 });
    expect(fields['/tax']).toEqual({ value: null }); // explicit null preserved (derives 'null')
  });

  it('emits NO confidence on any leaf — Mistral surfaces none and we never construct one', async () => {
    const { transport } = fakeTransport([fixture]);
    const result = await mistralAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });
    for (const field of Object.values(result.fields)) {
      expect('confidence' in field).toBe(false);
    }
    expect(result.provenance).toMatchObject({ modelVersion: MISTRAL_MODEL });
  });

  it('types a missing or unparseable document_annotation as a CONTRACT failure (no SAP-lite repair)', async () => {
    for (const response of [
      { model: MISTRAL_MODEL, pages: [] }, // annotation absent
      { model: MISTRAL_MODEL, document_annotation: 'not json {' }, // unparseable string
      { model: MISTRAL_MODEL, document_annotation: '[1,2]' }, // not an object
      null, // non-object 2xx
    ]) {
      const { transport } = fakeTransport([response]);
      await expect(
        mistralAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }),
      ).rejects.toBeInstanceOf(ContractFailureError);
    }
  });
});

describe('mistral adapter — loud-fail over-cap guard (armed ONLY in the cap-confirmed branch)', () => {
  const overCap = (): MistralOcrResponse => ({
    model: MISTRAL_MODEL,
    pages: Array.from({ length: MISTRAL_PAGE_CAP + 1 }, (_unused, index) => ({ index })),
    document_annotation: '{"vendor":{"name":"ACME"}}',
    usage_info: { pages_processed: MISTRAL_PAGE_CAP + 1 },
  });

  it('cap-confirmed: an over-cap doc is a PROTOCOL error (FatalRunError), never a red cell', async () => {
    const { transport } = fakeTransport([overCap()]);
    await expect(
      mistralAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        capBranch: 'cap-confirmed',
        transport,
      }),
    ).rejects.toBeInstanceOf(FatalRunError);
  });

  it('the guard stays run-fatal through executeDocRepeat — it must never soften to contract_failure', async () => {
    const { transport } = fakeTransport([overCap()]);
    await expect(
      executeDocRepeat(
        mistralAdapter,
        {
          doc: 'over-cap.pdf',
          docClass: 'test',
          bytes: DOC_BYTES,
          schema: SCHEMA,
          golden: { docClass: 'test', fields: {} },
        },
        1,
        'live',
        false,
        () => transport,
        {
          docTimeoutMs: DEFAULT_DOC_TIMEOUT_MS,
          maxTransportRetries: MAX_TRANSPORT_RETRIES,
          contractFailureLimit: 3,
          retryBackoffMs: RETRY_BACKOFF_MS,
        },
        { capBranch: 'cap-confirmed' },
      ),
    ).rejects.toBeInstanceOf(FatalRunError);
  });

  it('unarmed (no branch) and cap-removed: the same over-cap response maps normally', async () => {
    for (const capBranch of [undefined, 'cap-removed' as const]) {
      const { transport } = fakeTransport([overCap()]);
      const result = await mistralAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        ...(capBranch === undefined ? {} : { capBranch }),
        transport,
      });
      expect(result.fields['/vendor/name']).toEqual({ value: 'ACME' });
    }
  });

  it('cap-confirmed at EXACTLY the cap passes — the guard fires strictly above it', async () => {
    const atCap: MistralOcrResponse = {
      model: MISTRAL_MODEL,
      document_annotation: '{"vendor":{"name":"ACME"}}',
      usage_info: { pages_processed: MISTRAL_PAGE_CAP },
    };
    const { transport } = fakeTransport([atCap]);
    const result = await mistralAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      capBranch: 'cap-confirmed',
      transport,
    });
    expect(result.fields['/vendor/name']).toEqual({ value: 'ACME' });
  });
});

describe('liveTransport — env keys only, fail fast, exact request', () => {
  const ENV = 'VEVAL_TEST_API_KEY';
  const KEY = 'sk-test-do-not-print';

  beforeEach(() => {
    process.env[ENV] = KEY;
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  type Recorded = { url: string; init: RequestInit };
  function fakeFetch(
    status: number,
    jsonBody: unknown,
  ): { calls: Recorded[]; fetchImpl: typeof fetch } {
    const calls: Recorded[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(jsonBody), { status }));
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('throws MissingLiveKeyError AT CONSTRUCTION when the env key is absent (no fetch possible)', () => {
    delete process.env[ENV];
    expect(() => liveTransport(ENV)).toThrow(MissingLiveKeyError);
    expect(() => liveTransport(ENV)).toThrow(new RegExp(ENV)); // names the env var, never a value
  });

  it('JSON body: Bearer auth from env, application/json, body stringified', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { ok: 1 });
    const t = liveTransport(ENV, { fetchImpl });
    const body = { schema: SCHEMA, document: { bytes_base64: DOC_B64 } };
    await t.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', method: 'POST', body });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.example.test/v1/extract');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(body)); // base64 doc bytes reach the wire verbatim
  });

  it('FormData body passes through untouched with NO json Content-Type (multipart boundary)', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: 'dfl-1' });
    const t = liveTransport(ENV, { fetchImpl });
    const form = new FormData();
    form.append('purpose', 'extract');
    await t.send({
      key: 'x/y',
      url: 'https://api.example.test/upload',
      method: 'POST',
      body: form,
    });

    const { init } = calls[0]!;
    expect(init.body).toBe(form);
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('GET with no body sends no body and no Content-Type (the polling shape)', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { status: 'COMPLETED' });
    const t = liveTransport(ENV, { fetchImpl });
    await t.send({ key: 'x/y', url: 'https://api.example.test/jobs/1', method: 'GET' });

    const { init } = calls[0]!;
    expect(init.method).toBe('GET');
    expect('body' in init).toBe(false);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('a non-2xx response throws with the status — and the error NEVER contains the key', async () => {
    const responseBody = { error: 'invalid_schema_with_customer_detail' };
    const { fetchImpl } = fakeFetch(400, responseBody);
    const t = liveTransport(ENV, { fetchImpl });
    const err = await t
      .send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    // A doc-specific 400 is a CONTRACT failure (recorded per doc), never run-fatal.
    expect(err).toBeInstanceOf(ContractFailureError);
    expect(err!.message).toContain('400');
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).not.toContain(responseBody.error);
  });

  it('types doc-specific 4xx as contract failures and auth/billing 4xx as run-fatal (errors.ts taxonomy)', async () => {
    // One oversized/unparseable/conflicting DOC must never brick the whole paid run: it is that
    // doc-repeat's contract_failure. Only statuses that poison EVERY subsequent request
    // identically (auth/billing/configuration) are fatal to the run.
    for (const status of [400, 404, 409, 413, 422]) {
      const { fetchImpl } = fakeFetch(status, { error: 'doc-specific rejection' });
      const transport = liveTransport(ENV, { fetchImpl });
      await expect(
        transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
        `status ${status} must be a per-doc contract failure`,
      ).rejects.toBeInstanceOf(ContractFailureError);
    }
    for (const status of [401, 402, 403, 407]) {
      const { fetchImpl } = fakeFetch(status, { error: 'auth or billing' });
      const transport = liveTransport(ENV, { fetchImpl });
      await expect(
        transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
        `status ${status} must stay run-fatal`,
      ).rejects.toBeInstanceOf(FatalRunError);
    }
  });

  it('types 429/5xx as retryable transport failures and a non-JSON 2xx as contract failure', async () => {
    for (const status of [429, 503]) {
      const { fetchImpl } = fakeFetch(status, { error: 'temporary' });
      const transport = liveTransport(ENV, { fetchImpl });
      await expect(
        transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
      ).rejects.toBeInstanceOf(TransportFailureError);
    }

    const fetchImpl = (() =>
      Promise.resolve(
        new Response('provider echoed customer text', { status: 200 }),
      )) as typeof fetch;
    const transport = liveTransport(ENV, { fetchImpl });
    const error = await transport
      .send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} })
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect(error).toBeInstanceOf(ContractFailureError);
    expect(error?.message).not.toContain('customer text');
  });

  it('captures only allowlisted response headers for manifest provenance', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            // `velrim-version` is prod's live contract header and must win over the legacy
            // fallback name when both are present.
            'velrim-version': '2026-08-08',
            'x-velrim-api-version': '2026-07-14',
            'x-request-id': 'req-safe',
            'x-provider-secret': 'must-not-surface',
          },
        }),
      )) as typeof fetch;
    const transport = liveTransport(ENV, { fetchImpl });
    await transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} });
    expect(transport.lastResponseProvenance?.()).toEqual({
      apiVersion: '2026-08-08',
      requestId: 'req-safe',
    });
    expect(JSON.stringify(transport.lastResponseProvenance?.())).not.toContain('secret');
  });

  it('types a response-body stream reset as a retryable transport failure', async () => {
    const response = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('socket reset')),
    } as Response;
    const fetchImpl = (() => Promise.resolve(response)) as typeof fetch;
    const transport = liveTransport(ENV, { fetchImpl });
    await expect(
      transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
    ).rejects.toBeInstanceOf(TransportFailureError);
  });

  it('classifies a fatal 4xx before reading a broken response body', async () => {
    let bodyReads = 0;
    const response = {
      ok: false,
      status: 401,
      headers: new Headers(),
      text: () => {
        bodyReads++;
        return Promise.reject(new Error('socket reset'));
      },
    } as Response;
    const fetchImpl = (() => Promise.resolve(response)) as typeof fetch;
    const transport = liveTransport(ENV, { fetchImpl });
    await expect(
      transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
    ).rejects.toBeInstanceOf(FatalRunError);
    expect(bodyReads).toBe(0);
  });

  it('cancels an unread retryable error body before classifying its status', async () => {
    let bodyReads = 0;
    let bodyCancels = 0;
    const response = {
      ok: false,
      status: 429,
      headers: new Headers(),
      body: {
        cancel: () => {
          bodyCancels++;
          return Promise.resolve();
        },
      },
      text: () => {
        bodyReads++;
        return Promise.resolve('sensitive provider error');
      },
    } as unknown as Response;
    const fetchImpl = (() => Promise.resolve(response)) as typeof fetch;
    const transport = liveTransport(ENV, { fetchImpl });
    await expect(
      transport.send({ key: 'x/y', url: 'https://api.example.test/v1/extract', body: {} }),
    ).rejects.toBeInstanceOf(TransportFailureError);
    expect(bodyReads).toBe(0);
    expect(bodyCancels).toBe(1);
  });
});

// ── bytesToBase64 (the one shared encoding every adapter body rides on) ─────────────────────

describe('bytesToBase64', () => {
  it('round-trips arbitrary bytes and respects a subarray view', () => {
    const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bytesToBase64(buf)).toBe(Buffer.from(buf).toString('base64'));
    const view = buf.subarray(2, 6);
    expect(bytesToBase64(view)).toBe(Buffer.from([2, 3, 4, 5]).toString('base64'));
  });
});

// ── shared abortable sleep (one implementation for runner backoff AND adapter polling) ───────

describe('sleep — the one shared abortable delay', () => {
  it('resolves after the delay when no signal is given', async () => {
    vi.useFakeTimers();
    try {
      const pending = sleep(50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the abort reason immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);
    await expect(sleep(10_000, controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the abort reason when aborted mid-sleep (timer cleared, no hang)', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error('mid-sleep abort');
      const pending = sleep(10_000, controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
