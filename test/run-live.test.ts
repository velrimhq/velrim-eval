/**
 * `run --live` wiring proofs (the live path must actually send the doc bytes and auth on the
 * wire) — ZERO network: the global fetch is stubbed with a
 * recorder for the one end-to-end case, and the fail-fast cases assert fetch is NEVER reached.
 *
 *   1. missing env key → exit 2, message names the env var, no fetch call (fail fast BEFORE network);
 *   2. a golden row without a "schema" → exit 2 BEFORE any paid call;
 *   3. end-to-end: stubbed fetch returns the recorded Velrim body → predictions.jsonl written,
 *      run-meta says mode:"live", and the outgoing request carried the doc's base64 + Bearer auth;
 *   4. the fixture default is untouched: no key needed, run-meta stays mode:"fixture".
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { recursiveFiles, run } from '../src/commands/run.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VELRIM_FIXTURE = readFileSync(join(TEST_DIR, 'recorded', 'velrim', 'extract.json'), 'utf8');
// Live velrim responses must carry a minted fitted calibrator stamp (run --live asserts it),
// so the stubbed live wire serves the live-stamped recording.
const VELRIM_LIVE_BODY = readFileSync(
  join(TEST_DIR, 'recorded', 'velrim', 'extract.fitted.json'),
  'utf8',
);

const DOC_CONTENT = '%PDF-1.7 live-run doc';
const GOLDEN_ROW =
  '{"doc":"a.pdf","docClass":"invoice","schema":"a.schema.json",' +
  '"fields":{"/vendor":{"state":"present","value":"ACME"}}}';
const GOLDEN_ROW_NO_SCHEMA =
  '{"doc":"a.pdf","docClass":"invoice","fields":{"/vendor":{"state":"present","value":"ACME"}}}';
const SCHEMA_JSON = '{"type":"object","properties":{"vendor":{"type":"string"}}}';
const LIVE_SPEND_ARGS_BASE = [
  '--expected-spend-usd',
  '0.01',
  '--pricing-basis',
  'test fixture; no real network',
  '--pricing-as-of',
  '2026-07-14',
  '--cal-test-golden-hash',
  `invoice=${'a'.repeat(64)}`,
] as const;

let work: string;
let docsDir: string;

function liveSpendArgs(): string[] {
  return [
    ...LIVE_SPEND_ARGS_BASE,
    '--cal-test-manifest',
    `invoice=${join(work, 'invoice.manifest.json')}`,
  ];
}

const realFetch = globalThis.fetch;
const realVelrimKey = process.env['VELRIM_API_KEY'];

/** Stub globalThis.fetch with a recorder; returns the captured (url, init) pairs. */
function stubFetch(status: number, body: string): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return calls;
}

/** Capture process.stdout/stderr writes around a thunk so we never pollute the test log. */
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

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-live-'));
  docsDir = join(work, 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'a.pdf'), DOC_CONTENT);
  await writeFile(join(work, 'golden.jsonl'), GOLDEN_ROW + '\n');
  await writeFile(join(work, 'golden-no-schema.jsonl'), GOLDEN_ROW_NO_SCHEMA + '\n');
  await writeFile(join(work, 'a.schema.json'), SCHEMA_JSON);
  await writeFile(
    join(work, 'invoice.manifest.json'),
    JSON.stringify({ class: 'invoice', calTestGoldenHash: 'a'.repeat(64) }) + '\n',
  );
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realVelrimKey === undefined) delete process.env['VELRIM_API_KEY'];
  else process.env['VELRIM_API_KEY'] = realVelrimKey;
});

describe('run --live — env-key fail-fast (BEFORE any network call)', () => {
  it('exits 2 naming the env var when the adapter key is absent; fetch is never reached', async () => {
    delete process.env['VELRIM_API_KEY'];
    const calls = stubFetch(200, VELRIM_LIVE_BODY);
    const r = await capture(() =>
      run([
        '--live',
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-nokey'),
        ...liveSpendArgs(),
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('VELRIM_API_KEY');
    expect(calls).toHaveLength(0); // fail-fast: no network, ever
  });

  it('exits 2 BEFORE any paid call when a golden row lacks a "schema"', async () => {
    process.env['VELRIM_API_KEY'] = 'test-key';
    const calls = stubFetch(200, VELRIM_LIVE_BODY);
    const r = await capture(() =>
      run([
        '--live',
        '--golden',
        join(work, 'golden-no-schema.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-noschema'),
        ...liveSpendArgs(),
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('schema');
    expect(calls).toHaveLength(0);
  });
});

describe('run --live — end-to-end wiring (stubbed fetch, zero real network)', () => {
  it('prints the spend preflight and makes zero calls without --confirm-spend', async () => {
    process.env['VELRIM_API_KEY'] = 'test-key';
    const calls = stubFetch(200, VELRIM_LIVE_BODY);
    const r = await capture(() =>
      run([
        '--live',
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-unconfirmed'),
        ...liveSpendArgs(),
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.out).toContain('LIVE SPEND PREFLIGHT');
    expect(r.out).toContain('expected full-run spend: $0.01');
    expect(r.err).toContain('no paid call was made');
    expect(calls).toHaveLength(0);
  });

  it('sends the real Velrim envelope (base64 doc + Bearer key) and writes live predictions', async () => {
    process.env['VELRIM_API_KEY'] = 'test-key';
    const calls = stubFetch(200, VELRIM_LIVE_BODY);
    const outDir = join(work, 'out-live');
    const r = await capture(() =>
      run([
        '--live',
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        outDir,
        ...liveSpendArgs(),
        '--confirm-spend',
      ]),
    );
    expect(r.value, r.err).toBe(0);

    // The wire request actually carried the document + the schema + the env key.
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.velrim.com/v1/extract');
    const sent = JSON.parse(String(init.body)) as {
      schema: object;
      document: { bytes_base64: string };
    };
    expect(sent.document.bytes_base64).toBe(Buffer.from(DOC_CONTENT).toString('base64'));
    expect(sent.schema).toEqual(JSON.parse(SCHEMA_JSON));
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');

    // Outputs: predictions mapped from the response body; run-meta records mode:"live".
    const preds = (await readFile(join(outDir, 'predictions.jsonl'), 'utf8')).trim().split('\n');
    expect(preds).toHaveLength(1);
    const pred = JSON.parse(preds[0]!) as {
      doc: string;
      fields: Record<string, { value: unknown }>;
    };
    expect(pred.doc).toBe('a.pdf');
    expect(pred.fields['/vendor']?.value).toBe('ACME');
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as {
      mode: string;
    };
    expect(meta.mode).toBe('live');
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      formatVersion: number;
      publicationReady: boolean;
      missingFields: string[];
      protocol: { scoring: { version: string } };
      code: { executedFiles: Array<{ path: string }> };
      classes: Array<{
        schema: { sha256: string };
        publicGolden: { sha256: string };
        calTestGoldenHash: string;
      }>;
    };
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.publicationReady).toBe(false); // matrix-orchestrator owns publication.
    // The served stamp was minted, so the Velrim pin gap is cleared on this manifest.
    expect(manifest.missingFields).not.toContain('observedVersions.calibrator.mintedFittedStamp');
    expect(manifest.protocol.scoring.version).toBe('0.1.0'); // records the INSTALLED scoring bytes
    expect(manifest.code.executedFiles.map((file) => file.path)).toContain('run/lock.ts');
    expect(manifest.classes[0]).toMatchObject({
      schema: { sha256: digest(SCHEMA_JSON) },
      publicGolden: { sha256: digest(GOLDEN_ROW + '\n') },
      calTestGoldenHash: 'a'.repeat(64),
    });
  });
});

describe('run (default) — the fixture path is untouched by the live wiring', () => {
  it('needs no key, touches no network, and records mode:"fixture"', async () => {
    delete process.env['VELRIM_API_KEY'];
    const calls = stubFetch(200, VELRIM_FIXTURE);
    const outDir = join(work, 'out-fixture');
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        outDir,
      ]),
    );
    expect(r.value, r.err).toBe(0);
    expect(calls).toHaveLength(0); // fixture transport: ZERO network
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as {
      mode: string;
    };
    expect(meta.mode).toBe('fixture');
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      fixtureInput: { status: string; aggregateSha256: string; files: unknown[] };
    };
    expect(manifest.fixtureInput.status).toBe('hashed');
    expect(manifest.fixtureInput.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.fixtureInput.files.length).toBeGreaterThan(0);
  });

  it('rejects a non-positive --repeat before any adapter call', async () => {
    const calls = stubFetch(200, VELRIM_FIXTURE);
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-repeat-zero'),
        '--repeat',
        '0',
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('positive integer');
    expect(calls).toHaveLength(0);
  });

  it('rejects --structured-mode for non-openai adapters at PARSE time (no lock, no checkpoint)', async () => {
    const calls = stubFetch(200, '{}');
    const outDir = join(work, 'out-structured-mistral');
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'mistral',
        '--docs',
        docsDir,
        '--out',
        outDir,
        '--structured-mode',
      ]),
    );
    expect(r.value).toBe(2); // usage error, not a mid-run fatal after checkpoint creation
    expect(r.err).toContain('--structured-mode');
    expect(r.err).toContain('openai');
    expect(calls).toHaveLength(0);
    // Nothing was created: no orphan checkpoint fingerprinted with the invalid combination.
    await expect(readFile(join(outDir, 'run.checkpoint.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects --trim-param for non-openai adapters and unknown trim names at PARSE time', async () => {
    const calls = stubFetch(200, '{}');
    const wrongAdapter = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-trim-velrim'),
        '--trim-param',
        'logprobs',
      ]),
    );
    expect(wrongAdapter.value).toBe(2);
    expect(wrongAdapter.err).toContain('--trim-param');
    expect(wrongAdapter.err).toContain('openai');

    const unknownTrim = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'openai',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-trim-unknown'),
        '--trim-param',
        'seed',
      ]),
    );
    expect(unknownTrim.value).toBe(2);
    expect(unknownTrim.err).toContain('logprobs|temperature');
    expect(calls).toHaveLength(0);
  });

  it('rejects --mistral-cap-branch for non-mistral adapters and unknown branch names', async () => {
    const calls = stubFetch(200, '{}');
    const wrongAdapter = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'openai',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-cap-openai'),
        '--mistral-cap-branch',
        'cap-confirmed',
      ]),
    );
    expect(wrongAdapter.value).toBe(2);
    expect(wrongAdapter.err).toContain('--mistral-cap-branch');

    const unknownBranch = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'mistral',
        '--docs',
        docsDir,
        '--out',
        join(work, 'out-cap-unknown'),
        '--mistral-cap-branch',
        'maybe',
      ]),
    );
    expect(unknownBranch.value).toBe(2);
    expect(unknownBranch.err).toContain('cap-confirmed|cap-removed');
    expect(calls).toHaveLength(0);
  });
});

describe('run — cap-branch/param-trim fixture round-trips record the run identity in run-meta', () => {
  it('mistral fixture run completes and run-meta carries the pageCapBranch + annotation config', async () => {
    const outDir = join(work, 'out-mistral-fixture');
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'mistral',
        '--docs',
        docsDir,
        '--out',
        outDir,
        '--mistral-cap-branch',
        'cap-removed',
      ]),
    );
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['adapter']).toBe('mistral');
    expect(meta['pageCapBranch']).toBe('cap-removed');
    expect(meta['trimmedParams']).toEqual([]);
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { model: string; generationSettings: Record<string, unknown> };
    };
    expect(manifest.requestedConfiguration.model).toBe('mistral-ocr-4-0');
    expect(manifest.requestedConfiguration.generationSettings['pageCapBranch']).toBe('cap-removed');
    expect(manifest.requestedConfiguration.generationSettings['confidence']).toBe('none_surfaced');
    const predictions = await readFile(join(outDir, 'predictions.jsonl'), 'utf8');
    expect(predictions).toContain('"availability":"completed"');
  });

  it('openai fixture run with --trim-param records the trim in run-meta AND the manifest', async () => {
    const outDir = join(work, 'out-openai-trimmed');
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'openai',
        '--docs',
        docsDir,
        '--out',
        outDir,
        '--trim-param',
        'logprobs',
        '--trim-param',
        'temperature',
      ]),
    );
    expect(r.err).toBe('');
    expect(r.value).toBe(0);
    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta['trimmedParams']).toEqual(['logprobs', 'temperature']);
    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { generationSettings: Record<string, unknown> };
    };
    const settings = manifest.requestedConfiguration.generationSettings;
    expect(settings['trimmedParams']).toEqual(['logprobs', 'temperature']);
    expect(settings['logprobs']).toBe('trimmed_at_smoke');
    expect(settings['temperature']).toBe('trimmed_at_smoke');
  });
});

describe('fixture-tree ordering — the aggregate hash must be locale-independent', () => {
  it('recursiveFiles sorts byte-order with forward slashes, not host-locale collation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veval-recursive-'));
    try {
      await mkdir(join(root, 'a'), { recursive: true });
      await writeFile(join(root, 'A.json'), '{}');
      await writeFile(join(root, 'b.json'), '{}');
      await writeFile(join(root, 'a', 'x.json'), '{}');
      const files = await recursiveFiles(root);
      // Plain byte order ('A' 0x41 < 'a' 0x61 < 'b' 0x62) — localeCompare would put 'a…' first.
      expect(files).toEqual(['A.json', 'a/x.json', 'b.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
