/**
 * `velrim-eval calibrate` — the GENERIC 1-D Platt path.
 *
 * Proves, WITHOUT any model call:
 *   1. the exit-3 / --allow-stub guardrail is preserved (absent points, single-class input,
 *      missing --scores) — NO number is emitted on empty/degenerate input;
 *   2. the pure ridge-IRLS `fitPlatt1D` RECOVERS a known (a,b) on SEEDED synthetic data (splitmix64,
 *      NOT Math.random — bit-reproducible on this Windows box) and is DETERMINISTIC across runs;
 *   3. it stays finite under perfect separation (ridge), where the unregularized MLE diverges;
 *   4. the real --scores path emits a coef + reliability + selective tau and exits 0, with every
 *      composed metric coming from @velrim/scoring;
 *   5. calibration does not WORSEN ECE on a miscalibrated input (sanity, not a fabricated number).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrate } from '../src/commands/calibrate.js';
import { fitPlatt1D, applyPlatt } from '../src/calibrate/platt.js';
import type { CalibrationPoint } from '@velrim/scoring';

/** Capture stdout/stderr around a thunk (same pattern as ci.test.ts). */
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

/** Seeded splitmix64 → uniform (0,1). NOT Math.random — byte-reproducible across runs/OSes. */
function splitmix64(seed: bigint): () => number {
  let s = seed & 0xffffffffffffffffn;
  const M = 0xffffffffffffffffn;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    z = z ^ (z >> 31n);
    return Number(z & 0x1fffffffffffffn) / Number(0x20000000000000n);
  };
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** N points drawn from p = σ(A·x + B), x~U(0,1), seeded. */
function syntheticPoints(n: number, A: number, B: number, seed: bigint): CalibrationPoint[] {
  const rnd = splitmix64(seed);
  const pts: CalibrationPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd();
    const p = sigmoid(A * x + B);
    pts.push({ confidence: x, correct: rnd() < p });
  }
  return pts;
}

let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-cal-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('fitPlatt1D — pure, deterministic, recovers known coefficients (no RNG in the fit)', () => {
  it('recovers a known (a,b) on seeded synthetic data within tolerance', () => {
    // True model a=3, b=-1.5 (centered around x=0.5). Seed pinned: 0x1234.
    const pts = syntheticPoints(4000, 3, -1.5, 0x1234n);
    const m = fitPlatt1D(pts);
    expect(Math.abs(m.a - 3)).toBeLessThan(0.4);
    expect(Math.abs(m.b - -1.5)).toBeLessThan(0.4);
  });

  it('is deterministic — same input → identical coef to full precision (+ stable under shuffle)', () => {
    const pts = syntheticPoints(1500, 2, -1, 0xabcdn);
    const m1 = fitPlatt1D(pts);
    const m2 = fitPlatt1D(pts);
    expect(m1).toEqual(m2);
    // Order-insensitive up to float summation: reversed input lands at the same fixed point closely.
    const m3 = fitPlatt1D([...pts].reverse());
    expect(Math.abs(m1.a - m3.a)).toBeLessThan(1e-9);
    expect(Math.abs(m1.b - m3.b)).toBeLessThan(1e-9);
  });

  it('stays finite under perfect separation (ridge) — no NaN/Infinity', () => {
    const sep: CalibrationPoint[] = [
      { confidence: 0.1, correct: false },
      { confidence: 0.2, correct: false },
      { confidence: 0.8, correct: true },
      { confidence: 0.9, correct: true },
    ];
    const m = fitPlatt1D(sep);
    expect(Number.isFinite(m.a)).toBe(true);
    expect(Number.isFinite(m.b)).toBe(true);
    // apply still produces probabilities in (0,1).
    for (const x of [0, 0.5, 1]) {
      const p = applyPlatt(m, x);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('calibrate — guardrail preserved (no fabricated number on absent/degenerate input)', () => {
  it('exit 2 — --scores is required', async () => {
    const r = await capture(() => calibrate([]));
    expect(r.value).toBe(2);
  });

  it('exit 3 — a scores.json with no points column emits NO tau/curve', async () => {
    const f = join(work, 'empty.json');
    await writeFile(f, JSON.stringify({ version: 1, corpus: {} }));
    const r = await capture(() => calibrate(['--scores', f]));
    expect(r.value).toBe(3);
    expect(r.out).not.toMatch(/tau=/);
    expect(r.out).toMatch(/No tau\/curve emitted/);
  });

  it('exit 3 — an empty points array emits NO number', async () => {
    const f = join(work, 'zero.json');
    await writeFile(f, JSON.stringify({ points: [] }));
    const r = await capture(() => calibrate(['--scores', f]));
    expect(r.value).toBe(3);
  });

  it('exit 3 — single-class (all-correct) input is not identifiable → no number', async () => {
    const f = join(work, 'allcorrect.json');
    await writeFile(
      f,
      JSON.stringify({
        points: [
          { confidence: 0.2, correct: true },
          { confidence: 0.9, correct: true },
        ],
      }),
    );
    const r = await capture(() => calibrate(['--scores', f]));
    expect(r.value).toBe(3);
    expect(r.out).toMatch(/degenerate/);
  });

  it('exit 0 — --allow-stub on empty input wires the pipeline without a number', async () => {
    const f = join(work, 'empty2.json');
    await writeFile(f, JSON.stringify({ points: [] }));
    const r = await capture(() => calibrate(['--scores', f, '--allow-stub']));
    expect(r.value).toBe(0);
    expect(r.out).not.toMatch(/"ece"/);
  });

  it('exit 2 — malformed points row is a usage/IO error', async () => {
    const f = join(work, 'bad.json');
    await writeFile(f, JSON.stringify({ points: [{ confidence: 'nope', correct: true }] }));
    const r = await capture(() => calibrate(['--scores', f]));
    expect(r.value).toBe(2);
  });
});

describe('calibrate — real path emits a fitted curve + selective tau (exit 0)', () => {
  it('fits, emits coef/reliability/tau, and does not worsen ECE on a miscalibrated input', async () => {
    // Miscalibrated input: confidence is informative but NOT well-calibrated (slope > 1 truth).
    const pts = syntheticPoints(3000, 4, -2, 0x55n);
    const f = join(work, 'real.json');
    await writeFile(f, JSON.stringify({ points: pts }));
    const r = await capture(() => calibrate(['--scores', f, '--max-error', '0.1']));
    expect(r.value, r.err).toBe(0);

    // The first stdout chunk is the JSON result; parse it and check structure + honesty.
    const json = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)) as {
      method: string;
      n: number;
      coef: { a: number; b: number };
      ece: { raw: number; calibrated: number };
      reliability: unknown[];
      selective: { tau: number; coverage: number; error: number } | null;
    };
    expect(json.method).toBe('platt-1d');
    expect(json.n).toBe(3000);
    expect(Number.isFinite(json.coef.a)).toBe(true);
    expect(json.reliability.length).toBeGreaterThan(0);
    // Platt calibration should not INCREASE ECE on this monotone-but-miscalibrated input.
    expect(json.ece.calibrated).toBeLessThanOrEqual(json.ece.raw + 1e-9);
    // A selective tau exists for a generous 10% risk budget on a discriminative column.
    expect(json.selective).not.toBeNull();
    expect(json.selective!.error).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(json.selective!.coverage).toBeGreaterThan(0);
  });
});
