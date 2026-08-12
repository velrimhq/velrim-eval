/**
 * The Velrim served-stamp assertion (the A1 arm; ANALYSIS-PLAN.md §6.2), asserted as behavior:
 *
 *  1. `requireFittedStamp` NEVER changes the request — the same default public body is sent
 *     with the assertion armed and unarmed (the flag is a response-side expectation only);
 *  2. armed (`run --live` sets it for the velrim adapter): the served calibrator stamp must
 *     be a minted cal-YYYY.MM-n fitted stamp (pattern, never a pinned value) — proof the run
 *     was served by the shipped fitted stack; a non-minted stamp (`identity-0` = the fitted
 *     stack was off) or a missing stamp is a FatalRunError (the Mistral over-cap precedent:
 *     protocol error, never a red cell);
 *  3. unarmed (the fixture/dogfood default): no assertion — whatever stamp arrives is
 *     recorded, so existing fixtures keep passing;
 *  4. run command: fixture runs record requireFittedStamp:false and keep the Velrim pin
 *     publication gap; live runs record requireFittedStamp:true, surface the served stamp,
 *     and clear the gap — a live response without a minted stamp stops the run;
 *  5. report: the version-stamp column label is built from the manifest's recorded facts only.
 *
 * ZERO network — fake transports, the recorded fixtures, and a stubbed global fetch.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  VELRIM_FIXTURE_KEY,
  VELRIM_FITTED_STAMP_PATTERN,
  VELRIM_IDENTITY_STAMP,
  isMintedFittedStamp,
  velrimAdapter,
} from '../src/adapters/velrim.js';
import { ContractFailureError, FatalRunError } from '../src/adapters/errors.js';
import type { Transport, TransportRequest } from '../src/adapters/types.js';
import {
  DEFAULT_DOC_TIMEOUT_MS,
  MAX_TRANSPORT_RETRIES,
  RETRY_BACKOFF_MS,
  executeDocRepeat,
} from '../src/run/runner.js';
import { run } from '../src/commands/run.js';
import { velrimVersionStampLabel } from '../src/report/arms.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** The live-stamped recording — a real minted fitted stamp on the wire shape. */
const LIVE_STAMPED_BODY = readFileSync(
  join(TEST_DIR, 'recorded', 'velrim', 'extract.fitted.json'),
  'utf8',
);

const DOC_BYTES = new TextEncoder().encode('%PDF-1.7 velrim stamp doc');
const SCHEMA = { type: 'object', properties: { vendor: { type: 'string' } } } as const;

const bodyOf = (stamp?: string): Record<string, unknown> => ({
  fields: { '/vendor': { state: 'present', value: 'ACME', confidence: 0.9 } },
  ...(stamp === undefined ? {} : { meta: { calibrator_version: stamp } }),
});

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

describe('isMintedFittedStamp — the single-sourced minted-stamp rule', () => {
  it('accepts any minted cal-YYYY.MM-n stamp and nothing else', () => {
    expect(isMintedFittedStamp('cal-2026.08-1')).toBe(true);
    expect(isMintedFittedStamp('cal-2027.01-12')).toBe(true); // pattern, not a pin
    expect(isMintedFittedStamp(VELRIM_IDENTITY_STAMP)).toBe(false); // fitted stack OFF
    expect(isMintedFittedStamp('cal-2026.8-1')).toBe(false); // MM must be 2 digits
    expect(isMintedFittedStamp('CAL-2026.08-1')).toBe(false);
    expect(isMintedFittedStamp(undefined)).toBe(false);
  });
});

describe('velrim adapter — the assertion NEVER changes the request', () => {
  it('sends the same default public body armed and unarmed, under the one fixture key', async () => {
    const armed = fakeTransport([bodyOf('cal-2026.08-1')]);
    const unarmed = fakeTransport([bodyOf()]);
    await velrimAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      requireFittedStamp: true,
      transport: armed.transport,
    });
    await velrimAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      transport: unarmed.transport,
    });
    expect(armed.sent[0]!.body).toEqual(unarmed.sent[0]!.body);
    expect(armed.sent[0]!.url).toBe(unarmed.sent[0]!.url);
    expect(armed.sent[0]!.headers).toEqual(unarmed.sent[0]!.headers);
    expect(armed.sent[0]!.key).toBe(VELRIM_FIXTURE_KEY);
    expect(unarmed.sent[0]!.key).toBe(VELRIM_FIXTURE_KEY);
  });
});

describe('velrim adapter — served-stamp hard assertion (requireFittedStamp)', () => {
  it('accepts a minted stamp and surfaces it as calibratorVersion provenance', async () => {
    const { transport } = fakeTransport([bodyOf('cal-2026.08-1')]);
    const result = await velrimAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      requireFittedStamp: true,
      transport,
    });
    expect(result.provenance?.calibratorVersion).toBe('cal-2026.08-1');
    expect(result.fields['/vendor']).toEqual({ value: 'ACME', confidence: 0.9 });
  });

  it('accepts the live-stamped recording end-to-end (the recording carries a minted stamp)', async () => {
    const { transport } = fakeTransport([JSON.parse(LIVE_STAMPED_BODY)]);
    const result = await velrimAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      requireFittedStamp: true,
      transport,
    });
    expect(isMintedFittedStamp(result.provenance?.calibratorVersion)).toBe(true);
  });

  it('identity-0 is a FatalRunError naming what it means — the fitted stack was off', async () => {
    const { transport } = fakeTransport([bodyOf(VELRIM_IDENTITY_STAMP)]);
    const attempt = velrimAdapter.extract(DOC_BYTES, SCHEMA, {
      mode: 'live',
      requireFittedStamp: true,
      transport,
    });
    await expect(attempt).rejects.toBeInstanceOf(FatalRunError);
    await expect(attempt).rejects.not.toBeInstanceOf(ContractFailureError);
    await expect(attempt).rejects.toThrow(VELRIM_IDENTITY_STAMP);
    await expect(attempt).rejects.toThrow(/fitted stack was OFF/);
    await expect(attempt).rejects.toThrow(/protocol error/);
  });

  it('a missing stamp is equally fatal — an unproven serving path cannot be labeled', async () => {
    const { transport } = fakeTransport([bodyOf()]);
    await expect(
      velrimAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        requireFittedStamp: true,
        transport,
      }),
    ).rejects.toBeInstanceOf(FatalRunError);
  });

  it('unarmed (fixture default) makes no assertion: whatever stamp arrives is recorded', async () => {
    for (const stamp of [VELRIM_IDENTITY_STAMP, 'cal-2026.08-1', undefined]) {
      const { transport } = fakeTransport([bodyOf(stamp)]);
      const result = await velrimAdapter.extract(DOC_BYTES, SCHEMA, { mode: 'live', transport });
      expect(result.provenance?.calibratorVersion).toBe(stamp);
    }
  });

  it('a malformed 2xx stays in the per-doc contract taxonomy even when armed', async () => {
    const { transport } = fakeTransport([{ fields: { '/vendor': null } }]);
    await expect(
      velrimAdapter.extract(DOC_BYTES, SCHEMA, {
        mode: 'live',
        requireFittedStamp: true,
        transport,
      }),
    ).rejects.toBeInstanceOf(ContractFailureError);
  });

  it('the mismatch propagates through executeDocRepeat — the run STOPS, no red cell is recorded', async () => {
    const policy = {
      docTimeoutMs: DEFAULT_DOC_TIMEOUT_MS,
      maxTransportRetries: MAX_TRANSPORT_RETRIES,
      contractFailureLimit: 1,
      retryBackoffMs: RETRY_BACKOFF_MS,
    };
    const doc = {
      doc: 'a.pdf',
      docClass: 'invoice',
      bytes: DOC_BYTES,
      schema: SCHEMA,
      golden: {},
    };
    await expect(
      executeDocRepeat(
        velrimAdapter,
        doc,
        1,
        'live',
        false,
        () => fakeTransport([bodyOf(VELRIM_IDENTITY_STAMP)]).transport,
        policy,
        { requireFittedStamp: true },
      ),
    ).rejects.toBeInstanceOf(FatalRunError);
  });
});

// ── CLI + run-meta/manifest wiring (fixture transport + a stubbed fetch for --live) ──────────

const GOLDEN_ROW =
  '{"doc":"a.pdf","docClass":"invoice","schema":"a.schema.json",' +
  '"fields":{"/vendor":{"state":"present","value":"ACME"}}}';
const SCHEMA_JSON = '{"type":"object","properties":{"vendor":{"type":"string"}}}';

let work: string;

const realFetch = globalThis.fetch;
const realVelrimKey = process.env['VELRIM_API_KEY'];

function stubFetch(status: number, body: string): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return calls;
}

function liveArgs(outDir: string): string[] {
  return [
    '--live',
    '--golden',
    join(work, 'golden.jsonl'),
    '--adapter',
    'velrim',
    '--docs',
    join(work, 'docs'),
    '--out',
    outDir,
    '--expected-spend-usd',
    '0.01',
    '--pricing-basis',
    'test fixture; no real network',
    '--pricing-as-of',
    '2026-08-11',
    '--cal-test-manifest',
    `invoice=${join(work, 'invoice.manifest.json')}`,
    '--confirm-spend',
  ];
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-velrim-stamp-'));
  await mkdir(join(work, 'docs'), { recursive: true });
  await writeFile(join(work, 'golden.jsonl'), GOLDEN_ROW + '\n');
  await writeFile(join(work, 'docs', 'a.pdf'), '%PDF-1.7 velrim stamp doc');
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

describe('run — fixture mode never asserts; the Velrim pin gap stays open', () => {
  it('records requireFittedStamp:false and keeps the minted-stamp publication gap', async () => {
    const outDir = join(work, 'out-fixture');
    const r = await capture(() =>
      run([
        '--golden',
        join(work, 'golden.jsonl'),
        '--adapter',
        'velrim',
        '--docs',
        join(work, 'docs'),
        '--out',
        outDir,
      ]),
    );
    expect(r.value, r.err).toBe(0);

    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as {
      requireFittedStamp: boolean;
    };
    expect(meta.requireFittedStamp).toBe(false);

    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      missingFields: string[];
      requestedConfiguration: { generationSettings: Record<string, unknown> };
    };
    expect(manifest.requestedConfiguration.generationSettings['requireFittedStamp']).toBe(false);
    expect(manifest.requestedConfiguration.generationSettings['expectedCalibratorStamp']).toBe(
      null,
    );
    // The default recording carries no stamp — the pin gap must stay open.
    expect(manifest.missingFields).toContain('observedVersions.calibrator.mintedFittedStamp');
  });
});

describe('run --live — the assertion is automatic for the velrim arm', () => {
  it('a minted served stamp: recorded, surfaced, and the Velrim pin gap is cleared', async () => {
    process.env['VELRIM_API_KEY'] = 'test-key';
    stubFetch(200, LIVE_STAMPED_BODY);
    const outDir = join(work, 'out-live-minted');
    const r = await capture(() => run(liveArgs(outDir)));
    expect(r.value, r.err).toBe(0);

    const meta = JSON.parse(await readFile(join(outDir, 'run-meta.json'), 'utf8')) as {
      requireFittedStamp: boolean;
    };
    expect(meta.requireFittedStamp).toBe(true);

    const manifest = JSON.parse(await readFile(join(outDir, 'run-manifest.json'), 'utf8')) as {
      missingFields: string[];
      requestedConfiguration: { generationSettings: Record<string, unknown> };
      observedVersions: { calibrator: { status: string; values: string[] } };
    };
    expect(manifest.requestedConfiguration.generationSettings['requireFittedStamp']).toBe(true);
    expect(manifest.requestedConfiguration.generationSettings['expectedCalibratorStamp']).toBe(
      VELRIM_FITTED_STAMP_PATTERN.source,
    );
    // The label reads from THIS served stamp, never a pin.
    expect(manifest.observedVersions.calibrator).toMatchObject({
      status: 'surfaced',
      values: ['cal-2026.08-1'],
    });
    expect(manifest.missingFields).not.toContain('observedVersions.calibrator.mintedFittedStamp');
  });

  it('an identity-0 served stamp stops the live run as a protocol error (no red cell)', async () => {
    process.env['VELRIM_API_KEY'] = 'test-key';
    stubFetch(200, JSON.stringify(bodyOf(VELRIM_IDENTITY_STAMP)));
    const outDir = join(work, 'out-live-identity');
    const r = await capture(() => run(liveArgs(outDir)));
    expect(r.value).toBe(1);
    expect(r.err).toContain('non-retryable');
    expect(r.err).toContain('fitted stack was OFF');
    // No prediction record was written for the poisoned response — stopped, not scored.
    const predictions = await readFile(join(outDir, 'predictions.jsonl'), 'utf8');
    expect(predictions.trim()).toBe('');
  });
});

describe('velrimVersionStampLabel — column labels read from the manifest, never hardcoded', () => {
  const manifestFor = (calibrator: {
    status: string;
    values: string[];
    missingRecords: number;
  }): Parameters<typeof velrimVersionStampLabel>[0] => ({
    observedVersions: { calibrator },
  });

  it('renders the fitted-style label from the served minted stamp', () => {
    expect(
      velrimVersionStampLabel(
        manifestFor({ status: 'surfaced', values: ['cal-2026.08-1'], missingRecords: 0 }),
      ),
    ).toBe('calibrator: cal-2026.08-1 (fitted stack, default served path)');
  });

  it('refuses a non-uniform stamp or a stamp that is not a minted fitted version', () => {
    expect(() =>
      velrimVersionStampLabel(
        manifestFor({
          status: 'mixed',
          values: ['cal-2026.08-1', VELRIM_IDENTITY_STAMP],
          missingRecords: 0,
        }),
      ),
    ).toThrow(/not uniformly surfaced/);
    expect(() =>
      velrimVersionStampLabel(
        manifestFor({ status: 'surfaced', values: [VELRIM_IDENTITY_STAMP], missingRecords: 0 }),
      ),
    ).toThrow(/not a minted fitted stamp/);
    expect(() =>
      velrimVersionStampLabel(
        manifestFor({ status: 'not_surfaced', values: [], missingRecords: 1 }),
      ),
    ).toThrow(/not uniformly surfaced/);
  });
});
