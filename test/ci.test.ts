/**
 * Dogfood baseline + end-to-end `ci` exit codes.
 *
 * Drives the REAL command functions (run → score → ci) over the authored 2-docClass golden set
 * and the per-adapter recorded responses, with the FIXTURE transport — ZERO network. Asserts:
 *   - the GREEN BASELINE: the Velrim column passes `--min-f1 0.92 --max-ece 0.05` (ci exit 0);
 *   - competitor columns are REPORTED, not gated (they may fail) — exercised here through
 *     OpenAI and LlamaExtract;
 *   - the `ci` exit-code contract end-to-end: 0 pass / 1 gate-fail / 1 regression / 2 usage|IO.
 *
 * `run` uses `fixtureTransport`, which resolves `test/recorded/<adapter>/*.json` relative to the
 * module location — so this test exercises the same fixture path the dogfood + CI use.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run } from '../src/commands/run.js';
import { score } from '../src/commands/score.js';
import { ci } from '../src/commands/ci.js';
import type { ScoresFile } from '../src/commands/score.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(TEST_DIR, 'golden', 'golden.jsonl');

let work: string;
let docsDir: string;

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

/** Full dogfood pipeline for one adapter: run (fixture) → score → return the parsed scores.json. */
async function dogfood(adapter: string): Promise<ScoresFile> {
  const outDir = join(work, adapter);
  const r1 = await capture(() =>
    run(['--golden', GOLDEN, '--adapter', adapter, '--docs', docsDir, '--out', outDir]),
  );
  expect(r1.value, `run(${adapter}) stderr: ${r1.err}`).toBe(0);
  const r2 = await capture(() =>
    score([
      '--predictions',
      join(outDir, 'predictions.jsonl'),
      '--golden',
      GOLDEN,
      '--out',
      outDir,
    ]),
  );
  expect(r2.value, `score(${adapter}) stderr: ${r2.err}`).toBe(0);
  return JSON.parse(await readFile(join(outDir, 'scores.json'), 'utf8')) as ScoresFile;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-ci-'));
  docsDir = join(work, 'docs');
  await mkdir(docsDir, { recursive: true });
  // The two doc files the golden references (bytes are opaque to the fixture transport).
  await writeFile(join(docsDir, 'invoice-0042.pdf'), 'PDF');
  await writeFile(join(docsDir, 'receipt-0007.pdf'), 'PDF');
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('dogfood baseline — Velrim is the GREEN column, competitors are reported', () => {
  it('Velrim scores F1=1.0, ECE<=0.05 and PASSES the gate (ci exit 0)', async () => {
    const s = await dogfood('velrim');
    expect(s.corpus.docs).toBe(2);
    expect(s.corpus.leaves).toBe(17);
    expect(s.corpus.f1).toBe(1); // perfect extraction on the golden set
    expect(s.corpus.ece).toBeLessThanOrEqual(0.05);
    expect(s.corpus.cells).toEqual({ tp: 13, fp: 0, fn: 0 });

    const gate = await capture(() =>
      ci([
        '--scores',
        join(work, 'velrim', 'scores.json'),
        '--min-f1',
        '0.92',
        '--max-ece',
        '0.05',
      ]),
    );
    expect(gate.value, gate.err).toBe(0); // GREEN baseline
    expect(gate.out).toMatch(/PASS/);
  });

  it('OpenAI is REPORTED, not gated: it scores a lower F1 (competitor column)', async () => {
    const s = await dogfood('openai');
    // A fair DIY baseline misses nested leaves + fabricates → strictly worse than Velrim.
    expect(s.corpus.f1).toBeGreaterThan(0);
    expect(s.corpus.f1).toBeLessThan(1);
    // It carries a REAL confidence column (logprobs) → a non-degenerate ECE.
    expect(s.corpus.ece).toBeGreaterThan(0);
    expect(s.points.every((p) => p.confidence === 0.5)).toBe(false);
  });

  it('LlamaExtract is REPORTED, not gated: no logprobs → degenerate 0.5 confidence column', async () => {
    const s = await dogfood('llamaextract');
    expect(s.corpus.f1).toBeGreaterThan(0);
    expect(s.corpus.f1).toBeLessThan(1);
    // No logprobs anywhere → every leaf falls back to DEFAULT_CONFIDENCE 0.5 (documented honest).
    expect(s.points.every((p) => p.confidence === 0.5)).toBe(true);
    expect(s.corpus.ece).toBeCloseTo(0.5, 10); // all-0.5 confidence, all-correct/wrong → 0.5
  });
});

describe('ci exit-code contract end-to-end', () => {
  it('exit 0 — Velrim passes both thresholds (no baseline)', async () => {
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'velrim', 'scores.json'),
        '--min-f1',
        '0.92',
        '--max-ece',
        '0.05',
      ]),
    );
    expect(r.value).toBe(0);
  });

  it('exit 1 — gate fail: a too-high --min-f1 reddens the build', async () => {
    // OpenAI's F1 < 1 < 0.99 → threshold fail.
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'openai', 'scores.json'),
        '--min-f1',
        '0.99',
        '--max-ece',
        '0.99',
      ]),
    );
    expect(r.value).toBe(1);
    expect(r.out).toMatch(/FAIL/);
  });

  it('exit 1 — gate fail: a too-low --max-ece reddens the build (LlamaExtract 0.5 ECE)', async () => {
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'llamaextract', 'scores.json'),
        '--min-f1',
        '0.5',
        '--max-ece',
        '0.05',
      ]),
    );
    expect(r.value).toBe(1);
  });

  it('exit 1 — regression: F1 drop beyond epsilon vs --baseline fails even when thresholds pass', async () => {
    // baseline = the perfect Velrim column; candidate = the weaker OpenAI column.
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'openai', 'scores.json'),
        '--min-f1',
        '0.5',
        '--max-ece',
        '0.99',
        '--baseline',
        join(work, 'velrim', 'scores.json'),
      ]),
    );
    expect(r.value).toBe(1);
    expect(r.err).toMatch(/regression/);
  });

  it('exit 0 — no regression: identical baseline & candidate pass with a baseline set', async () => {
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'velrim', 'scores.json'),
        '--min-f1',
        '0.92',
        '--max-ece',
        '0.05',
        '--baseline',
        join(work, 'velrim', 'scores.json'),
      ]),
    );
    expect(r.value).toBe(0);
  });

  it('exit 2 — usage: a non-finite --min-f1 (NaN) is a usage error, not a gate result', async () => {
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'velrim', 'scores.json'),
        '--min-f1',
        'notanumber',
        '--max-ece',
        '0.05',
      ]),
    );
    expect(r.value).toBe(2);
  });

  it('exit 2 — IO: a missing scores.json is an IO error, not a gate result', async () => {
    const r = await capture(() =>
      ci([
        '--scores',
        join(work, 'does-not-exist', 'scores.json'),
        '--min-f1',
        '0.92',
        '--max-ece',
        '0.05',
      ]),
    );
    expect(r.value).toBe(2);
  });
});
