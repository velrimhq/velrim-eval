/**
 * `velrim-eval curves` — reliability-diagram data + full-vs-logprobFree ablation.
 *
 * Proves, WITHOUT any model call:
 *   1. the exit-3 / --allow-stub guardrail (absent points, missing --manifest, missing logprobFree
 *      variant) — NO number on empty input;
 *   2. the real --manifest path re-derives ECE/Brier/AUROC/risk-coverage + 15-equal-mass reliability
 *      bins for the logprobFree floor, ALL via @velrim/scoring;
 *   3. ABLATION HONESTY: full == logprobFree (logprob-less corpus) → "degenerate / not-published",
 *      never a duplicated number implying a logprob lift; a DIFFERING full arm → "measured";
 *   4. variant paths resolve relative to the manifest directory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { curves } from '../src/commands/curves.js';
import type { CalibrationPoint } from '@velrim/scoring';

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

/** A spread of (confidence, correct) points with both classes present. */
const LP_FREE: CalibrationPoint[] = [
  { confidence: 0.95, correct: true },
  { confidence: 0.9, correct: true },
  { confidence: 0.8, correct: true },
  { confidence: 0.7, correct: false },
  { confidence: 0.6, correct: true },
  { confidence: 0.5, correct: false },
  { confidence: 0.4, correct: false },
  { confidence: 0.3, correct: true },
  { confidence: 0.2, correct: false },
  { confidence: 0.1, correct: false },
];

/** A DIFFERENT (sharper) full arm — simulates logprobs adding discrimination. */
const FULL: CalibrationPoint[] = LP_FREE.map((p) => ({
  confidence: p.correct ? Math.min(0.99, p.confidence + 0.05) : Math.max(0.01, p.confidence - 0.05),
  correct: p.correct,
}));

let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-curves-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeScores(name: string, points: CalibrationPoint[]): Promise<string> {
  const f = join(work, name);
  await writeFile(f, JSON.stringify({ version: 1, points }));
  return name; // relative name — resolved against the manifest dir (which is `work`)
}

async function writeManifest(name: string, body: unknown): Promise<string> {
  const f = join(work, name);
  await writeFile(f, JSON.stringify(body));
  return f;
}

describe('curves — guardrail preserved (no fabricated number on absent input)', () => {
  it('exit 2 — --manifest is required', async () => {
    const r = await capture(() => curves([]));
    expect(r.value).toBe(2);
  });

  it('exit 2 — manifest without a logprobFree variant is a usage error', async () => {
    const m = await writeManifest('no-floor.json', { variants: {} });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value).toBe(2);
  });

  it('exit 3 — a logprobFree variant with no points emits NO curve', async () => {
    await writeScores('floor-empty.json', []);
    const m = await writeManifest('m-empty.json', {
      variants: { logprobFree: 'floor-empty.json' },
    });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value).toBe(3);
    expect(r.out).toMatch(/No curve emitted/);
  });

  it('exit 0 — --allow-stub on empty input wires the pipeline without a number', async () => {
    await writeScores('floor-empty2.json', []);
    const m = await writeManifest('m-empty2.json', {
      variants: { logprobFree: 'floor-empty2.json' },
    });
    const r = await capture(() => curves(['--manifest', m, '--allow-stub']));
    expect(r.value).toBe(0);
    expect(r.out).not.toMatch(/"auroc"/);
  });
});

describe('curves — real path composes @velrim/scoring metrics (exit 0)', () => {
  it('emits reliability + ECE/Brier/AUROC/risk-coverage for the logprobFree floor', async () => {
    await writeScores('floor.json', LP_FREE);
    const m = await writeManifest('m-floor.json', {
      label: 'fixture-class',
      link: 'corpora/manifests/fixture-class.manifest.json',
      variants: { logprobFree: 'floor.json' },
    });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value, r.err).toBe(0);
    const json = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)) as {
      label: string;
      manifestLink: string;
      logprobFree: {
        n: number;
        auroc: number;
        ece: number;
        brier: number;
        reliability: unknown[];
        riskCoverage: unknown[];
      };
      ablation: { status: string };
    };
    expect(json.label).toBe('fixture-class');
    expect(json.manifestLink).toBe('corpora/manifests/fixture-class.manifest.json');
    expect(json.logprobFree.n).toBe(LP_FREE.length);
    expect(json.logprobFree.reliability.length).toBeGreaterThan(0);
    expect(json.logprobFree.riskCoverage.length).toBeGreaterThan(0);
    expect(Number.isFinite(json.logprobFree.auroc)).toBe(true);
  });

  it('ABLATION HONESTY — no full arm → "degenerate / not-published"', async () => {
    await writeScores('floor2.json', LP_FREE);
    const m = await writeManifest('m-nofull.json', { variants: { logprobFree: 'floor2.json' } });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value).toBe(0);
    const json = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)) as {
      ablation: { status: string };
    };
    expect(json.ablation.status).toBe('degenerate / not-published');
  });

  it('ABLATION HONESTY — full == logprobFree byte-identical → "degenerate / not-published"', async () => {
    await writeScores('floor3.json', LP_FREE);
    await writeScores('full-same.json', LP_FREE); // identical points (logprob-less corpus)
    const m = await writeManifest('m-same.json', {
      variants: { logprobFree: 'floor3.json', full: 'full-same.json' },
    });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value).toBe(0);
    const json = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)) as {
      ablation: { status: string };
    };
    expect(json.ablation.status).toBe('degenerate / not-published');
  });

  it('ABLATION — a DIFFERING full arm → "measured" with deltas', async () => {
    await writeScores('floor4.json', LP_FREE);
    await writeScores('full-diff.json', FULL);
    const m = await writeManifest('m-diff.json', {
      variants: { logprobFree: 'floor4.json', full: 'full-diff.json' },
    });
    const r = await capture(() => curves(['--manifest', m]));
    expect(r.value).toBe(0);
    const json = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)) as {
      full: { n: number } | null;
      ablation: { status: string; aurocDelta?: number };
    };
    expect(json.full).not.toBeNull();
    expect(json.ablation.status).toBe('measured');
    expect(typeof json.ablation.aurocDelta).toBe('number');
  });
});
