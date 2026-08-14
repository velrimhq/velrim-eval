/**
 * Gemini adapter proofs (A2 free-decode / A3 constrained) + the `x-goog-api-key`
 * transport auth-style extension. ZERO network anywhere: adapter requests are asserted through a
 * fake recording Transport, and the liveTransport auth-style seam is proven with an injected
 * fetchImpl. Mirrors test/adapters.test.ts (per-adapter request/mapping proofs) and
 * test/run-live.test.ts (run-command wiring round-trips).
 *
 * The load-bearing assertions:
 *   - prompt parity: the text part is byte-identical to the shared prompt builder's
 *     output in BOTH modes — constrained differs ONLY in generationConfig.responseJsonSchema;
 *   - vendor defaults: generationConfig carries temperature 0 (the one pre-registered rule) and
 *     NOTHING else in free-decode; a temperature trim omits the param entirely;
 *   - auth: the live key rides in x-goog-api-key with NO Authorization header, defaults stay
 *     bearer for every existing caller, and the key never leaks into an error message;
 *   - no confidence is ever emitted (bare-model "not requested" — never fabricated).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  geminiAdapter,
  buildGeminiRequestBody,
  mapGeminiResponse,
  GEMINI_GENERATE_URL,
  GEMINI_MODEL,
  GEMINI_FIXTURE_KEY,
  geminiVertexUrl,
  GEMINI_VERTEX_URL_TEMPLATE,
} from '../src/adapters/gemini.js';
import type { GeminiGenerateResponse } from '../src/adapters/gemini.js';
import { buildOpenAIPrompt } from '../src/adapters/openai.js';
import {
  liveTransport,
  LIVE_ENV_KEY,
  LIVE_AUTH_STYLE,
  MissingLiveKeyError,
} from '../src/adapters/transport.js';
import { getAdapter } from '../src/adapters/index.js';
import { ContractFailureError, FatalRunError } from '../src/adapters/errors.js';
import type { Transport, TransportRequest } from '../src/adapters/types.js';
import { run } from '../src/commands/run.js';

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

interface GeminiBody {
  contents: Array<{
    role?: string;
    parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }>;
  }>;
  generationConfig?: Record<string, unknown>;
}

const textPart = (body: GeminiBody): string =>
  (body.contents[0]!.parts.find((p) => 'text' in p) as { text: string }).text;
const filePart = (body: GeminiBody): { mime_type: string; data: string } =>
  (
    body.contents[0]!.parts.find((p) => 'inline_data' in p) as {
      inline_data: { mime_type: string; data: string };
    }
  ).inline_data;

// ── A2/A3 request construction ──────────────────────────────────────────────────────────────

describe('gemini adapter — A2 free-decode request construction', () => {
  it('POSTs once to the pinned generateContent URL with the shared prompt + inline base64 PDF', async () => {
    const { transport, sent } = fakeTransport([recorded('gemini/generate-free.json')]);
    await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.key).toBe(GEMINI_FIXTURE_KEY.free);
    expect(req.url).toBe(GEMINI_GENERATE_URL);
    expect(req.url).toContain(`models/${GEMINI_MODEL}:generateContent`); // pinned model, never -latest
    expect(GEMINI_MODEL).toBe('gemini-2.5-flash');
    expect(GEMINI_MODEL).not.toContain('latest');

    const body = req.body as GeminiBody;
    expect(body.contents[0]!.role).toBe('user'); // Vertex requires it; AI Studio accepts it
    // Prompt parity: BYTE-identical to the one shared prompt builder (the openai adapter uses it too).
    expect(textPart(body)).toBe(buildOpenAIPrompt(SCHEMA));
    expect(textPart(body)).toContain('Use null for fields not present in the document.');
    expect(textPart(body)).toContain(JSON.stringify(SCHEMA)); // schema rides in the prompt
    expect(filePart(body)).toEqual({ mime_type: 'application/pdf', data: DOC_B64 }); // doc IN the body

    // Vendor defaults + the ONE pre-registered rule: temperature 0 and NOTHING else.
    expect(body.generationConfig).toEqual({ temperature: 0 });
    expect(Object.keys(req.body as object).sort()).toEqual(['contents', 'generationConfig']);
  });

  it('never asks for confidence, logprobs, or constrained decoding in free-decode', () => {
    const body = buildGeminiRequestBody(DOC_BYTES, SCHEMA, false);
    expect(JSON.stringify(body)).not.toContain('logprobs');
    expect(JSON.stringify(body)).not.toContain('confidence');
    expect(body['generationConfig']).not.toHaveProperty('responseJsonSchema');
    expect(body['generationConfig']).not.toHaveProperty('responseMimeType');
  });
});

describe('gemini adapter — Vertex transport substitution (URL-only; body and auth unchanged)', () => {
  it('geminiVertexUrl pins the same model on the Vertex global generateContent path', () => {
    const url = geminiVertexUrl('my-proj-123');
    expect(url).toBe(
      `https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`,
    );
    expect(url).toContain('gemini-2.5-flash'); // the pin survives the route change
    expect(url).not.toContain('latest');
  });

  it('opts.geminiVertexProject swaps ONLY the URL: fixture key and body bytes identical', async () => {
    const aistudio = fakeTransport([recorded('gemini/generate-free.json')]);
    await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport: aistudio.transport });

    const vertex = fakeTransport([recorded('gemini/generate-free.json')]);
    await geminiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      geminiVertexProject: 'my-proj-123',
      transport: vertex.transport,
    });

    expect(vertex.sent[0]!.url).toBe(geminiVertexUrl('my-proj-123'));
    expect(aistudio.sent[0]!.url).toBe(GEMINI_GENERATE_URL);
    // The substitution is endpoint-ONLY: same fixture key, byte-identical request body.
    expect(vertex.sent[0]!.key).toBe(aistudio.sent[0]!.key);
    expect(JSON.stringify(vertex.sent[0]!.body)).toBe(JSON.stringify(aistudio.sent[0]!.body));
  });
});

describe('gemini adapter — A3 constrained mode (identical prompt bytes, decoding config only)', () => {
  it('--structured-mode adds ONLY the decoding-config pair (responseMimeType + responseJsonSchema); prompt bytes unchanged', async () => {
    const { transport, sent } = fakeTransport([recorded('gemini/generate-structured.json')]);
    await geminiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      structuredMode: true,
      transport,
    });

    const req = sent[0]!;
    expect(req.key).toBe(GEMINI_FIXTURE_KEY.structured);
    expect(req.url).toBe(GEMINI_GENERATE_URL); // same route as A2
    const body = req.body as GeminiBody;
    expect(body.generationConfig).toEqual({
      temperature: 0,
      responseMimeType: 'application/json', // required WITH responseJsonSchema (smoke-verified)
      responseJsonSchema: SCHEMA,
    });

    // The A2/A3 split is decoding config ONLY: everything outside generationConfig is identical.
    const free = buildGeminiRequestBody(DOC_BYTES, SCHEMA, false);
    expect(textPart(body)).toBe(textPart(free as unknown as GeminiBody)); // byte-identical prompt
    expect(body.contents).toEqual((free as unknown as GeminiBody).contents);
  });

  it('records structuredMode in raw so the report can label the A3 column', async () => {
    const { transport } = fakeTransport([recorded('gemini/generate-structured.json')]);
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      structuredMode: true,
      transport,
    });
    expect(result.raw).toMatchObject({ structuredMode: true });
  });
});

describe('gemini adapter — smoke-driven param trim (temperature only)', () => {
  it('a trimmed temperature is OMITTED — free-decode drops generationConfig entirely', () => {
    const trimmedFree = buildGeminiRequestBody(DOC_BYTES, SCHEMA, false, ['temperature']);
    expect('generationConfig' in trimmedFree).toBe(false); // pure vendor defaults

    const trimmedStructured = buildGeminiRequestBody(DOC_BYTES, SCHEMA, true, ['temperature']);
    expect(trimmedStructured['generationConfig']).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
    });
  });

  it('extract() threads the trim onto the wire and records it in raw', async () => {
    const { transport, sent } = fakeTransport([recorded('gemini/generate-free.json')]);
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      trimParams: ['temperature'],
      transport,
    });
    expect('generationConfig' in (sent[0]!.body as object)).toBe(false);
    expect(result.raw).toMatchObject({ structuredMode: false, trimmedParams: ['temperature'] });
  });

  it('with no trims the raw record carries NO trimmedParams key (an empty trim is not a trim)', async () => {
    const { transport } = fakeTransport([recorded('gemini/generate-free.json')]);
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });
    expect(result.raw).not.toHaveProperty('trimmedParams');
  });

  it('rejects a logprobs trim as run-fatal BEFORE any transport spend (not a gemini param)', async () => {
    const { transport, sent } = fakeTransport([recorded('gemini/generate-free.json')]);
    await expect(
      geminiAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        trimParams: ['logprobs'],
        transport,
      }),
    ).rejects.toBeInstanceOf(FatalRunError);
    expect(sent).toHaveLength(0);
  });
});

// ── response mapping (recorded fixtures; recursive flatten; no confidence ever) ─────────────

describe('gemini adapter — response mapping (recorded generateContent bodies)', () => {
  it('joins multi-part text, repairs the fenced JSON, and flattens to RFC-6901 leaves', async () => {
    const { transport } = fakeTransport([recorded('gemini/generate-free.json')]);
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'fixture', transport });

    expect(result.fields).toEqual({
      '/vendor/name': { value: 'ACME' },
      '/line_items/0/description': { value: 'Widget' },
      '/line_items/0/quantity': { value: 2 },
      '/tax': { value: null }, // explicit null preserved (derives 'null' — the abstention)
      '/total': { value: 1240.5 },
    });
    // Bare-model arm — NO confidence, ever (cells render "not requested").
    for (const field of Object.values(result.fields)) {
      expect('confidence' in field).toBe(false);
    }
    expect(result.provenance).toEqual({
      modelVersion: 'gemini-2.5-flash', // as returned by the response, for the run manifest
      requestId: 'resp-fixture-gemini-free',
    });
  });

  it('maps the structured recording: bare JSON, explicit nulls for absent fields preserved', async () => {
    const { transport } = fakeTransport([recorded('gemini/generate-structured.json')]);
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'fixture',
      structuredMode: true,
      transport,
    });
    expect(result.fields['/tax']).toEqual({ value: null });
    expect(result.fields['/discount']).toEqual({ value: null }); // nullable leaf = abstention affordance
    expect(result.fields['/vendor/name']).toEqual({ value: 'ACME' });
    expect(result.provenance).toMatchObject({ requestId: 'resp-fixture-gemini-structured' });
  });

  it('merges transport-level provenance under the response-level values', async () => {
    const { transport } = fakeTransport([recorded('gemini/generate-free.json')]);
    transport.lastResponseProvenance = () => ({ apiVersion: 'v1beta', requestId: 'header-id' });
    const result = await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });
    expect(result.provenance).toEqual({
      apiVersion: 'v1beta',
      modelVersion: 'gemini-2.5-flash',
      requestId: 'resp-fixture-gemini-free', // the body's responseId wins over the header id
    });
  });

  it('the mapper accepts the extract()-parsed object and never re-runs SAP-lite repair on it', () => {
    const decoy: GeminiGenerateResponse = {
      candidates: [{ content: { parts: [{ text: '{"decoy": true}' }] } }],
    };
    expect(mapGeminiResponse(decoy, { vendor: 'FROM-PREPARSED' })).toEqual({
      '/vendor': { value: 'FROM-PREPARSED' },
    });
  });

  it('keeps a root array invalid instead of inventing root-level fields', () => {
    expect(
      mapGeminiResponse({ candidates: [{ content: { parts: [{ text: '[{"a":1}]' }] } }] }),
    ).toEqual({});
  });
});

describe('gemini adapter — contract-failure taxonomy (FD-3, mirrors the shared contract)', () => {
  it('classifies malformed/empty/blocked/unusable 2xx bodies as typed contract failures', async () => {
    for (const response of [
      null, // non-object 2xx
      'not an object',
      {}, // no candidates key
      { candidates: 'not-an-array' },
      { candidates: [] }, // empty — the blocked-response shape
      { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }, // safety-blocked
      { candidates: [{ content: { parts: [] } }] }, // no text parts
      { candidates: [{ content: null }] },
      { candidates: [{ content: { parts: [{ text: 'no json here at all' }] } }] },
      { candidates: [{ content: { parts: [{ text: '[]' }] } }] }, // not an object
    ]) {
      const { transport } = fakeTransport([response]);
      await expect(
        geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }),
      ).rejects.toBeInstanceOf(ContractFailureError);
    }
  });

  it('a blocked response throws WITHOUT echoing the provider-supplied block reason', async () => {
    const { transport } = fakeTransport([
      { candidates: [], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } },
    ]);
    const error = await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(ContractFailureError);
    expect(error?.message).not.toContain('PROHIBITED_CONTENT');
  });

  it('attaches response-level provenance to the contract failure when the body carried it', async () => {
    const { transport } = fakeTransport([
      { candidates: [], modelVersion: 'gemini-2.5-flash', responseId: 'resp-blocked' },
    ]);
    const error = await geminiAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport }).then(
      () => undefined,
      (caught: unknown) => caught as ContractFailureError,
    );
    expect(error?.provenance).toEqual({
      modelVersion: 'gemini-2.5-flash',
      requestId: 'resp-blocked',
    });
  });
});

// ── registry / env / auth-style wiring ──────────────────────────────────────────────────────

describe('gemini adapter — registry wiring and isolation', () => {
  it('is registered, keys from GEMINI_API_KEY, auths x-goog-api-key, and never imports @velrim/core', () => {
    expect(getAdapter('gemini')).toBe(geminiAdapter);
    expect(LIVE_ENV_KEY.gemini).toBe('GEMINI_API_KEY');
    expect(LIVE_AUTH_STYLE.gemini).toBe('x-goog-api-key');
    const source = readFileSync(join(TEST_DIR, '..', 'src', 'adapters', 'gemini.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).not.toContain('@velrim/core');
  });

  it('every non-Gemini adapter stays bearer — the seam default is unchanged', () => {
    for (const id of ['velrim', 'openai', 'llamaextract', 'mistral'] as const) {
      expect(LIVE_AUTH_STYLE[id]).toBe('bearer');
    }
  });
});

// ── liveTransport auth-style seam (injected fetchImpl; ZERO sockets) ────────────────────────

describe('liveTransport — x-goog-api-key auth style (the seam extension)', () => {
  const ENV = 'VEVAL_TEST_GOOG_KEY';
  const KEY = 'goog-test-key-do-not-print';

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

  it("authStyle 'x-goog-api-key': key in that header, NO Authorization header at all", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { candidates: [] });
    const t = liveTransport(ENV, { fetchImpl, authStyle: 'x-goog-api-key' });
    await t.send({ key: 'gemini/x', url: GEMINI_GENERATE_URL, method: 'POST', body: { a: 1 } });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it("the default (omitted) and explicit 'bearer' styles both send Authorization: Bearer", async () => {
    for (const opts of [{}, { authStyle: 'bearer' as const }]) {
      const { calls, fetchImpl } = fakeFetch(200, { ok: 1 });
      const t = liveTransport(ENV, { fetchImpl, ...opts });
      await t.send({ key: 'x/y', url: 'https://api.example.test/v1', body: {} });
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
      expect(headers['x-goog-api-key']).toBeUndefined();
    }
  });

  it('still fails fast at construction on a missing key, naming the env var, never a value', () => {
    delete process.env[ENV];
    expect(() => liveTransport(ENV, { authStyle: 'x-goog-api-key' })).toThrow(MissingLiveKeyError);
    expect(() => liveTransport(ENV, { authStyle: 'x-goog-api-key' })).toThrow(new RegExp(ENV));
  });

  it('a non-2xx under x-goog-api-key throws with the status — the key NEVER leaks', async () => {
    const { fetchImpl } = fakeFetch(400, { error: 'provider detail' });
    const t = liveTransport(ENV, { fetchImpl, authStyle: 'x-goog-api-key' });
    const error = await t.send({ key: 'gemini/x', url: GEMINI_GENERATE_URL, body: {} }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(ContractFailureError);
    expect(error!.message).toContain('400');
    expect(error!.message).not.toContain(KEY);
    expect(error!.message).not.toContain('provider detail');
  });
});

// ── run-command wiring round-trips (mirrors run-live.test.ts; stubbed global fetch only) ────

describe('run — gemini CLI wiring (fixture round-trips + live header proof, zero real network)', () => {
  const DOC_CONTENT = '%PDF-1.7 live-run doc';
  const GOLDEN_ROW =
    '{"doc":"a.pdf","docClass":"invoice","schema":"a.schema.json",' +
    '"fields":{"/vendor":{"state":"present","value":"ACME"}}}';
  const SCHEMA_JSON = '{"type":"object","properties":{"vendor":{"type":"string"}}}';

  let work: string;
  let docsDir: string;
  const realFetch = globalThis.fetch;
  const realGeminiKey = process.env['GEMINI_API_KEY'];

  function stubFetch(status: number, body: string): { url: string; init: RequestInit }[] {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;
    return calls;
  }

  async function capture<T>(
    fn: () => Promise<T> | T,
  ): Promise<{ out: string; err: string; value: T }> {
    let out = '';
    let err = '';
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (s: string): boolean => ((out += s), true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (s: string): boolean => ((err += s), true);
    try {
      const value = await fn();
      return { out, err, value };
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'veval-gemini-'));
    docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'a.pdf'), DOC_CONTENT);
    await writeFile(join(work, 'golden.jsonl'), GOLDEN_ROW + '\n');
    await writeFile(join(work, 'a.schema.json'), SCHEMA_JSON);
    await writeFile(
      join(work, 'invoice.manifest.json'),
      JSON.stringify({ class: 'invoice', calTestGoldenHash: 'a'.repeat(64) }) + '\n',
    );
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (realGeminiKey === undefined) delete process.env['GEMINI_API_KEY'];
    else process.env['GEMINI_API_KEY'] = realGeminiKey;
    await rm(work, { recursive: true, force: true });
  });

  const baseArgs = (): string[] => [
    '--golden',
    join(work, 'golden.jsonl'),
    '--adapter',
    'gemini',
    '--docs',
    docsDir,
  ];

  it('fixture --structured-mode round-trip records the A3 identity in run-meta + manifest', async () => {
    const outDir = join(work, 'out-structured');
    const r = await capture(() => run([...baseArgs(), '--out', outDir, '--structured-mode']));
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['adapter']).toBe('gemini');
    expect(meta['structuredMode']).toBe(true);
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { model: string; generationSettings: Record<string, unknown> };
      code: { adapterFiles: Array<{ path: string }>; executedFiles: Array<{ path: string }> };
    };
    expect(manifest.requestedConfiguration.model).toBe('gemini-2.5-flash');
    const settings = manifest.requestedConfiguration.generationSettings;
    expect(settings['temperature']).toBe(0);
    expect(settings['confidence']).toBe('not_requested');
    expect(settings['structuredMode']).toBe(true);
    expect(settings['responseJsonSchema']).toBe(true);
    // A2/A3 reuse the eval-local prompt/SAP-lite from openai.ts — the fingerprint must carry it.
    expect(manifest.code.executedFiles.map((f) => f.path)).toContain('adapters/openai.ts');
  });

  it('fixture free-decode with --trim-param temperature records the trim', async () => {
    const outDir = join(work, 'out-trimmed');
    const r = await capture(() =>
      run([...baseArgs(), '--out', outDir, '--trim-param', 'temperature']),
    );
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['trimmedParams']).toEqual(['temperature']);
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { generationSettings: Record<string, unknown> };
    };
    expect(manifest.requestedConfiguration.generationSettings['temperature']).toBe(
      'trimmed_at_smoke',
    );
  });

  it('fixture run with --gemini-vertex-project records the vertex route but NEVER the id', async () => {
    const outDir = join(work, 'out-vertex');
    const r = await capture(() =>
      run([...baseArgs(), '--out', outDir, '--gemini-vertex-project', 'my-proj-123']),
    );
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['geminiEndpointRoute']).toBe('vertex');
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { endpoint: string; generationSettings: Record<string, unknown> };
    };
    expect(manifest.requestedConfiguration.endpoint).toBe(GEMINI_VERTEX_URL_TEMPLATE);
    expect(manifest.requestedConfiguration.generationSettings['endpointRoute']).toBe('vertex');
    for (const file of ['run-meta.json', 'run-manifest.json']) {
      expect(await readFile(join(outDir, file), 'utf8')).not.toContain('my-proj-123');
    }
  });

  it('default (no flag) records the aistudio route in run-meta + manifest', async () => {
    const outDir = join(work, 'out-aistudio-route');
    const r = await capture(() => run([...baseArgs(), '--out', outDir]));
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['geminiEndpointRoute']).toBe('aistudio');
    expect(meta).not.toHaveProperty('geminiVertexProject');
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { endpoint: string; generationSettings: Record<string, unknown> };
    };
    expect(manifest.requestedConfiguration.endpoint).toBe(GEMINI_GENERATE_URL);
    expect(manifest.requestedConfiguration.generationSettings['endpointRoute']).toBe('aistudio');
  });

  it('rejects --gemini-vertex-project for a non-gemini adapter at PARSE time', async () => {
    const calls = stubFetch(200, '{}');
    const args = baseArgs();
    args[args.indexOf('gemini')] = 'openai';
    const r = await capture(() =>
      run([
        ...args,
        '--out',
        join(work, 'out-vertex-openai'),
        '--gemini-vertex-project',
        'my-proj-123',
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('only supported by --adapter gemini');
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed --gemini-vertex-project id at PARSE time (lands verbatim in the URL)', async () => {
    const calls = stubFetch(200, '{}');
    const r = await capture(() =>
      run([
        ...baseArgs(),
        '--out',
        join(work, 'out-vertex-bad'),
        '--gemini-vertex-project',
        'Bad_Project',
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('not a valid Google Cloud project id');
    expect(calls).toHaveLength(0);
  });

  it('rejects --trim-param logprobs for gemini at PARSE time (not a gemini request param)', async () => {
    const calls = stubFetch(200, '{}');
    const r = await capture(() =>
      run([...baseArgs(), '--out', join(work, 'out-trim-logprobs'), '--trim-param', 'logprobs']),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('temperature only');
    expect(calls).toHaveLength(0);
  });

  it('--live without GEMINI_API_KEY fails fast naming the env var; fetch never reached', async () => {
    delete process.env['GEMINI_API_KEY'];
    const calls = stubFetch(200, '{}');
    const r = await capture(() =>
      run([
        ...baseArgs(),
        '--live',
        '--out',
        join(work, 'out-nokey'),
        '--expected-spend-usd',
        '0.01',
        '--pricing-basis',
        'test fixture; no real network',
        '--pricing-as-of',
        '2026-07-14',
        '--cal-test-manifest',
        `invoice=${join(work, 'invoice.manifest.json')}`,
        '--cal-test-golden-hash',
        `invoice=${'a'.repeat(64)}`,
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('GEMINI_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('--live sends x-goog-api-key (NO Authorization) to the pinned URL with the real body', async () => {
    process.env['GEMINI_API_KEY'] = 'goog-live-test-key';
    const calls = stubFetch(
      200,
      readFileSync(join(TEST_DIR, 'recorded', 'gemini', 'generate-free.json'), 'utf8'),
    );
    const outDir = join(work, 'out-live');
    const r = await capture(() =>
      run([
        ...baseArgs(),
        '--live',
        '--out',
        outDir,
        '--expected-spend-usd',
        '0.01',
        '--pricing-basis',
        'test fixture; no real network',
        '--pricing-as-of',
        '2026-07-14',
        '--cal-test-manifest',
        `invoice=${join(work, 'invoice.manifest.json')}`,
        '--cal-test-golden-hash',
        `invoice=${'a'.repeat(64)}`,
        '--confirm-spend',
      ]),
    );
    expect(r.value, r.err).toBe(0);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(GEMINI_GENERATE_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('goog-live-test-key'); // the Google auth style, end to end
    expect(headers['Authorization']).toBeUndefined(); // NO bearer header on the Google route
    const sent = JSON.parse(String(init.body)) as GeminiBody;
    expect(filePart(sent).data).toBe(Buffer.from(DOC_CONTENT).toString('base64'));
    expect(textPart(sent)).toBe(buildOpenAIPrompt(JSON.parse(SCHEMA_JSON) as object));
    expect(sent.generationConfig).toEqual({ temperature: 0 });

    const preds = (await readFile(join(outDir, 'predictions.jsonl'), 'utf8')).trim().split('\n');
    expect(preds).toHaveLength(1);
    const pred = JSON.parse(preds[0]!) as { fields: Record<string, { value: unknown }> };
    expect(pred.fields['/vendor/name']?.value).toBe('ACME');
    expect(pred.fields['/tax']?.value).toBeNull();
  });
});
