/**
 * Stats module — synthetic-fixture tests. Everything is seeded, so every expectation here
 * is deterministic; no test depends on RNG luck. The fixtures are constructed so the CORRECT
 * behavior is knowable by hand (or by construction), never by re-running the implementation.
 */

import { describe, expect, it } from 'vitest';
import { Rng, mulberry32 } from '../src/stats/rng.js';
import { normalCdf, normalQuantile } from '../src/stats/gauss.js';
import { bcaCI, pooledMeanCI, pairedMeanDeltaCI } from '../src/stats/bootstrap.js';
import { holm } from '../src/stats/holm.js';
import { debiasedEce, eceNoiseFloor, consistencyBands, equalMassBins } from '../src/stats/ece.js';
import { canonicalSignature, instabilityRate } from '../src/stats/instability.js';
import { simulateMde } from '../src/stats/mde.js';
import { expectedCalibrationError, type CalibrationPoint } from '@velrim/scoring';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a1 = mulberry32(42);
    const a2 = mulberry32(42);
    const b = mulberry32(43);
    const s1 = [a1(), a1(), a1()];
    const s2 = [a2(), a2(), a2()];
    const s3 = [b(), b(), b()];
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
  });

  it('normal() has ~0 mean and ~1 sd; beta(5,1.5) has the analytic mean', () => {
    const rng = new Rng(7);
    let sum = 0;
    let ss = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const x = rng.normal();
      sum += x;
      ss += x * x;
    }
    expect(sum / n).toBeCloseTo(0, 1);
    expect(ss / n).toBeCloseTo(1, 1);

    let bsum = 0;
    for (let i = 0; i < n; i++) bsum += rng.beta(5, 1.5);
    expect(bsum / n).toBeCloseTo(5 / 6.5, 2); // E[Beta(a,b)] = a/(a+b)
  });
});

describe('gauss', () => {
  it('CDF and quantile are mutual inverses at reference points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    for (const p of [0.01, 0.1, 0.3, 0.7, 0.9, 0.99]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 5);
    }
  });
});

describe('bootstrap (doc-clustered, BCa)', () => {
  it('is deterministic per seed and brackets the estimate', () => {
    const clusters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => v / 10);
    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const r1 = bcaCI([clusters], mean, { seed: 11, resamples: 2000 });
    const r2 = bcaCI([clusters], mean, { seed: 11, resamples: 2000 });
    expect(r1).toEqual(r2);
    expect(r1.estimate).toBeCloseTo(0.55, 10);
    expect(r1.lo).toBeLessThan(r1.estimate);
    expect(r1.hi).toBeGreaterThan(r1.estimate);
    expect(r1.method).toBe('bca');
  });

  it('degenerates cleanly when every resample is identical', () => {
    const r = bcaCI([[2, 2, 2, 2]], (xs) => xs[0]!, { seed: 1, resamples: 200 });
    expect(r.method).toBe('degenerate');
    expect(r.lo).toBe(2);
    expect(r.hi).toBe(2);
  });

  it('clustered arrangement of the same cells yields a WIDER pooled-mean interval', () => {
    // 10 docs × 10 cells; doc-level all-0 or all-1 — maximal intra-doc correlation…
    const clustered: number[][] = [];
    for (let d = 0; d < 10; d++) clustered.push(new Array<number>(10).fill(d % 2));
    // …vs the same 100 cells as independent singleton clusters.
    const singletons: number[][] = [];
    for (let d = 0; d < 10; d++) for (let c = 0; c < 10; c++) singletons.push([d % 2]);
    const wide = pooledMeanCI(clustered, { seed: 3, resamples: 2000 });
    const narrow = pooledMeanCI(singletons, { seed: 3, resamples: 2000 });
    expect(wide.estimate).toBeCloseTo(0.5, 10);
    expect(narrow.estimate).toBeCloseTo(0.5, 10);
    expect(wide.hi - wide.lo).toBeGreaterThan(narrow.hi - narrow.lo);
  });

  it('stratified resampling preserves per-stratum sizes', () => {
    const strata = [
      [1, 1, 1],
      [10, 10, 10, 10, 10],
    ];
    // Statistic = count of small values; constant iff stratum sizes are preserved.
    const r = bcaCI(strata, (xs) => xs.filter((v) => v < 5).length, {
      seed: 5,
      resamples: 500,
    });
    expect(r.method).toBe('degenerate');
    expect(r.estimate).toBe(3);
  });

  it('paired delta: constant per-doc delta pins the interval; pZero is small', () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ a: 0.6 + i / 100, b: 0.5 + i / 100 }));
    const r = pairedMeanDeltaCI(docs, { seed: 9, resamples: 1000 });
    expect(r.estimate).toBeCloseTo(0.1, 10);
    expect(r.lo).toBeCloseTo(0.1, 10);
    expect(r.pZero).toBeLessThan(0.01);
  });

  it('pZero is large for a centered delta', () => {
    const rng = new Rng(21);
    const docs = Array.from({ length: 30 }, () => {
      const base = rng.next();
      return { a: base + 0.05 * rng.normal(), b: base + 0.05 * rng.normal() };
    });
    const r = pairedMeanDeltaCI(docs, { seed: 22, resamples: 2000 });
    expect(r.pZero).toBeGreaterThan(0.05);
    expect(r.lo).toBeLessThan(0);
    expect(r.hi).toBeGreaterThan(0);
  });
});

describe('holm', () => {
  it('reproduces the textbook step-down on a known family', () => {
    // sorted: 0.005, 0.01, 0.03, 0.04 vs α/4=0.0125, α/3≈0.0167, α/2=0.025, α/1=0.05
    const res = holm([0.01, 0.04, 0.03, 0.005], 0.05);
    expect(res.map((r) => r.rejected)).toEqual([true, false, false, true]);
    expect(res[3]!.pAdjusted).toBeCloseTo(0.02, 10); // 4 × 0.005
    expect(res[0]!.pAdjusted).toBeCloseTo(0.03, 10); // 3 × 0.01
    expect(res[2]!.pAdjusted).toBeCloseTo(0.06, 10); // 2 × 0.03
    expect(res[1]!.pAdjusted).toBeCloseTo(0.06, 10); // monotone: max(0.04, 0.06)
    // The step-down alpha (and its CI level) is exposed for the kill-criteria convention.
    expect(res[3]!.alpha).toBeCloseTo(0.0125, 10);
    expect(res[3]!.ciLevel).toBeCloseTo(0.9875, 10);
  });

  it('once one hypothesis fails, all larger p-values fail even below raw alpha', () => {
    const res = holm([0.03, 0.04], 0.05); // 0.03 > 0.05/2 → both fail
    expect(res.map((r) => r.rejected)).toEqual([false, false]);
  });

  it('rejects invalid p-values and handles the empty family', () => {
    expect(holm([])).toEqual([]);
    expect(() => holm([1.2])).toThrow();
  });
});

describe('ece stats', () => {
  const calibrated = (n: number, seed: number): CalibrationPoint[] => {
    const rng = new Rng(seed);
    return Array.from({ length: n }, () => {
      const conf = rng.beta(5, 1.5);
      return { confidence: conf, correct: rng.next() < conf };
    });
  };

  it('debiased ECE sits below plug-in ECE for a perfectly calibrated small sample', () => {
    const pts = calibrated(196, 31);
    const plugin = expectedCalibrationError(pts, 15);
    const debiased = debiasedEce(pts, 15);
    expect(plugin).toBeGreaterThan(0.02); // the small-n bias the sensitivity row exists for
    expect(debiased).toBeLessThan(plugin);
  });

  it('debiased ≈ plug-in for a grossly miscalibrated arm (bias is second-order there)', () => {
    const rng = new Rng(33);
    const pts: CalibrationPoint[] = Array.from({ length: 500 }, () => ({
      confidence: 0.9,
      correct: rng.next() < 0.5,
    }));
    const plugin = expectedCalibrationError(pts, 15);
    const debiased = debiasedEce(pts, 15);
    expect(plugin).toBeGreaterThan(0.3);
    expect(Math.abs(debiased - plugin)).toBeLessThan(0.05);
  });

  it('noise floor at n=196 reproduces the pre-registered order of magnitude', () => {
    const f = eceNoiseFloor({ n: 196, seed: 41, sims: 300 });
    expect(f.mean).toBeGreaterThan(0.05); // design sim: 0.084 [0.058–0.114]
    expect(f.mean).toBeLessThan(0.12);
    expect(f.p05).toBeLessThan(f.mean);
    expect(f.p95).toBeGreaterThan(f.mean);
  });

  it('noise floor shrinks with n', () => {
    const small = eceNoiseFloor({ n: 196, seed: 43, sims: 200 });
    const large = eceNoiseFloor({ n: 2102, seed: 43, sims: 200 });
    expect(large.mean).toBeLessThan(small.mean);
  });

  it('consistency bands cover a calibrated arm in nearly every bin', () => {
    const pts = calibrated(600, 51);
    const bands = consistencyBands(pts, { seed: 52, sims: 400 });
    expect(bands.length).toBe(15);
    const covered = bands.filter((b) => b.observedAccuracy >= b.lo && b.observedAccuracy <= b.hi);
    expect(covered.length).toBeGreaterThanOrEqual(13); // ~95% bands; allow ≤2 excursions
    for (const b of bands) {
      expect(b.lo).toBeLessThanOrEqual(b.hi);
      expect(b.count).toBeGreaterThan(0);
    }
  });

  it('flags a miscalibrated bin: observed accuracy far outside its band', () => {
    const rng = new Rng(61);
    // High confidence, coin-flip accuracy — bin dots must fall below their null bands
    // (allow one grazing bin: per-bin observed accuracy is itself a ~40-point estimate).
    const pts: CalibrationPoint[] = Array.from({ length: 600 }, () => ({
      confidence: 0.85 + 0.1 * rng.next(),
      correct: rng.next() < 0.5,
    }));
    const bands = consistencyBands(pts, { seed: 62, sims: 400 });
    const flagged = bands.filter((b) => b.observedAccuracy < b.lo).length;
    expect(flagged).toBeGreaterThanOrEqual(14);
  });

  it('equal-mass binning matches the shared convention (bin count, mass balance)', () => {
    const pts = calibrated(200, 71);
    const bins = equalMassBins(pts, 15);
    expect(bins.length).toBe(15);
    const sizes = bins.map((b) => b.indices.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(200);
  });
});

describe('instability', () => {
  it('canonical signature ignores key order, catches value and field-set changes', () => {
    expect(canonicalSignature({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      canonicalSignature({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(canonicalSignature({ a: 1 })).not.toBe(canonicalSignature({ a: 2 }));
    expect(canonicalSignature({ a: 1 })).not.toBe(canonicalSignature({ a: 1, b: null }));
    expect(canonicalSignature([1, 2])).not.toBe(canonicalSignature([2, 1])); // arrays keep order
  });

  it('identical repeats → rate 0; one divergent of six → 1/6', () => {
    const stable = instabilityRate([
      { doc: 'a', repeats: [{ x: 1 }, { x: 1 }, { x: 1 }] },
      { doc: 'b', repeats: [{ y: 2 }, { y: 2 }, { y: 2 }] },
    ]);
    expect(stable.rate).toBe(0);

    const oneDiv = instabilityRate([
      { doc: 'a', repeats: [{ x: 1 }, { x: 1 }, { x: 9 }] },
      { doc: 'b', repeats: [{ y: 2 }, { y: 2 }, { y: 2 }] },
    ]);
    expect(oneDiv.totalRepeats).toBe(6);
    expect(oneDiv.divergentRepeats).toBe(1);
    expect(oneDiv.rate).toBeCloseTo(1 / 6, 10);
    expect(oneDiv.perDoc.find((d) => d.doc === 'a')!.divergent).toBe(1);
  });

  it('breaks modal ties toward the lexicographically smaller signature', () => {
    const r = instabilityRate([{ doc: 'a', repeats: [{ x: 1 }, { x: 2 }] }]);
    // Two 1-count signatures: exactly one repeat is divergent regardless of which wins,
    // and the winner is deterministic.
    expect(r.divergentRepeats).toBe(1);
    const again = instabilityRate([{ doc: 'a', repeats: [{ x: 2 }, { x: 1 }] }]);
    expect(again.divergentRepeats).toBe(1);
  });

  it('single-repeat docs cannot diverge; empty input is rate 0', () => {
    expect(instabilityRate([{ doc: 'a', repeats: [{ x: 1 }] }]).rate).toBe(0);
    expect(instabilityRate([]).rate).toBe(0);
  });
});

describe('mde re-simulation', () => {
  const registrationLike = new Array<number>(48).fill(6); // 48 docs × 6 fields

  it('is deterministic per seed', () => {
    const opts = {
      fieldCounts: registrationLike,
      baseAccuracy: 0.75,
      deltaGrid: [0.04, 0.08, 0.12],
      seed: 91,
      sims: 150,
    };
    expect(simulateMde(opts)).toEqual(simulateMde(opts));
  });

  it('power grows with delta and the MDE lands in the design-sim ballpark', () => {
    const r = simulateMde({
      fieldCounts: registrationLike,
      baseAccuracy: 0.75,
      deltaGrid: [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16],
      seed: 93,
      sims: 300,
    });
    const powers = r.grid.map((g) => g.power);
    expect(powers[powers.length - 1]!).toBeGreaterThan(powers[0]!);
    // Design sim said ~8pp for registration @ base .75 — assert the honest neighborhood.
    expect(r.mde).not.toBeNull();
    expect(r.mde!).toBeGreaterThanOrEqual(0.04);
    expect(r.mde!).toBeLessThanOrEqual(0.14);
    expect(r.assumptions.docs).toBe(48);
    expect(r.assumptions.fields).toBe(288);
  });

  it('more docs → the MDE can only tighten (same per-doc field count)', () => {
    const grid = [0.03, 0.06, 0.09, 0.12, 0.15, 0.18, 0.21];
    const few = simulateMde({
      fieldCounts: new Array<number>(10).fill(10),
      baseAccuracy: 0.8,
      deltaGrid: grid,
      seed: 95,
      sims: 250,
    });
    const many = simulateMde({
      fieldCounts: new Array<number>(40).fill(10),
      baseAccuracy: 0.8,
      deltaGrid: grid,
      seed: 95,
      sims: 250,
    });
    expect(many.mde).not.toBeNull();
    if (few.mde !== null) expect(many.mde!).toBeLessThanOrEqual(few.mde);
  });

  it('marks unreachable grid deltas (accuracy ≥ 1) as NaN power', () => {
    const r = simulateMde({
      fieldCounts: new Array<number>(10).fill(5),
      baseAccuracy: 0.9,
      deltaGrid: [0.05, 0.2],
      seed: 97,
      sims: 100,
    });
    expect(r.grid.find((g) => g.delta === 0.2)!.power).toBeNaN();
  });

  it('rejects degenerate inputs', () => {
    expect(() =>
      simulateMde({ fieldCounts: [5], baseAccuracy: 0.8, deltaGrid: [0.1], seed: 1 }),
    ).toThrow();
    expect(() =>
      simulateMde({ fieldCounts: [5, 5], baseAccuracy: 1.2, deltaGrid: [0.1], seed: 1 }),
    ).toThrow();
    expect(() =>
      simulateMde({ fieldCounts: [5, 5], baseAccuracy: 0.8, deltaGrid: [], seed: 1 }),
    ).toThrow();
  });
});
