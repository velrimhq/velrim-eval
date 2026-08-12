/**
 * Calibration-error statistics beyond the pinned plug-in estimator (ANALYSIS-PLAN.md §6.3).
 * The PUBLISHED ECE stays `expectedCalibrationError` from @velrim/scoring
 * (15 equal-mass bins pinned; 10-bin robustness row) — nothing here replaces it. This module
 * adds the pre-registered honesty rows around it:
 *
 *  - debiasedEce — Kumar, Liang & Ma, "Verified Uncertainty Calibration" (NeurIPS 2019)
 *    sensitivity row: the plug-in estimator is upward-biased at small n (a PERFECT arm
 *    measures ~0.084 at n=196); the debiased l2 estimator subtracts the per-bin sampling
 *    variance so near-floor differences stop reading as findings.
 *  - eceNoiseFloor — the methods-section noise-floor table: plug-in ECE of a perfectly
 *    calibrated synthetic arm at the run's own n (Beta-distributed confidences), mean and
 *    5th–95th percentile band.
 *  - consistencyBands — Bröcker & Smith (2007) bands for reliability diagrams: per-bin
 *    accuracy quantiles under the perfectly-calibrated null AT THIS ARM'S own confidence
 *    distribution and n, so a reader sees what "indistinguishable from calibrated" looks like.
 *
 * Binning mirrors expectedCalibrationError's equal-mass convention (same convention
 * report/render.ts already mirrors for presentation). All simulation is seeded (rng.ts).
 */

import { expectedCalibrationError, type CalibrationPoint } from '@velrim/scoring';
import { Rng } from './rng.js';

interface Bin {
  /** indices into the ORIGINAL points array (binning is by sorted confidence, ties by index). */
  indices: number[];
  meanConfidence: number;
  accuracy: number;
}

/** Equal-mass bins over pooled points — mirrors the shared scoring binning convention. */
export function equalMassBins(points: readonly CalibrationPoint[], bins = 15): Bin[] {
  const order = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.confidence - b.p.confidence || a.i - b.i);
  const n = order.length;
  const k = Math.min(bins, Math.max(1, n));
  const out: Bin[] = [];
  for (let b = 0; b < k && n > 0; b++) {
    const start = Math.floor((b * n) / k);
    const end = Math.floor(((b + 1) * n) / k);
    if (end <= start) continue;
    const slice = order.slice(start, end);
    let cs = 0;
    let cc = 0;
    for (const { p } of slice) {
      cs += p.confidence;
      if (p.correct) cc += 1;
    }
    out.push({
      indices: slice.map((x) => x.i),
      meanConfidence: cs / slice.length,
      accuracy: cc / slice.length,
    });
  }
  return out;
}

/**
 * Debiased l2 calibration error (Kumar/Liang/Ma 2019): per equal-mass bin, subtract the
 * within-bin sampling variance acc·(1−acc)/(n_b−1) from the squared plug-in gap; the summed
 * estimate is floored at 0 and returned as a square root, so it reads in the same units as
 * ECE. A singleton bin contributes its plug-in term un-debiased (variance is inestimable).
 */
export function debiasedEce(points: readonly CalibrationPoint[], bins = 15): number {
  if (points.length === 0) return 0;
  const n = points.length;
  let sum = 0;
  for (const bin of equalMassBins(points, bins)) {
    const nb = bin.indices.length;
    const gap = bin.accuracy - bin.meanConfidence;
    const bias = nb > 1 ? (bin.accuracy * (1 - bin.accuracy)) / (nb - 1) : 0;
    sum += (nb / n) * (gap * gap - bias);
  }
  return Math.sqrt(Math.max(0, sum));
}

export interface NoiseFloorOptions {
  /** Number of pooled points at which to measure the floor (the run's own n). */
  n: number;
  seed: number;
  sims?: number;
  bins?: number;
  /** Confidence-distribution shape of the synthetic perfectly calibrated arm. */
  betaA?: number;
  betaB?: number;
}

export interface NoiseFloor {
  n: number;
  mean: number;
  p05: number;
  p95: number;
  sims: number;
  bins: number;
}

/**
 * Plug-in ECE of a PERFECTLY calibrated synthetic arm at size n: confidence ~ Beta(a, b)
 * (default Beta(5, 1.5) — the pre-registered simulation shape), correct ~ Bernoulli(conf),
 * estimator = the shared 15-equal-mass-bin plug-in. The floor depends on the confidence
 * distribution shape, so it differs per arm and the bias does not cancel across arms — which
 * is exactly why the table prints in methods.
 */
export function eceNoiseFloor(opts: NoiseFloorOptions): NoiseFloor {
  const sims = opts.sims ?? 1000;
  const bins = opts.bins ?? 15;
  const a = opts.betaA ?? 5;
  const b = opts.betaB ?? 1.5;
  if (!(opts.n > 0)) throw new Error('eceNoiseFloor: n must be > 0');
  const rng = new Rng(opts.seed);
  const eces = new Array<number>(sims);
  for (let s = 0; s < sims; s++) {
    const pts: CalibrationPoint[] = new Array(opts.n);
    for (let i = 0; i < opts.n; i++) {
      const conf = rng.beta(a, b);
      pts[i] = { confidence: conf, correct: rng.next() < conf };
    }
    eces[s] = expectedCalibrationError(pts, bins);
  }
  eces.sort((x, y) => x - y);
  const q = (p: number): number => {
    const idx = p * (sims - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? eces[lo]! : eces[lo]! * (hi - idx) + eces[hi]! * (idx - lo);
  };
  return {
    n: opts.n,
    mean: eces.reduce((x, y) => x + y, 0) / sims,
    p05: q(0.05),
    p95: q(0.95),
    sims,
    bins,
  };
}

export interface ConsistencyBandOptions {
  seed: number;
  sims?: number;
  bins?: number;
  /** Band mass (default 0.95 → 2.5th–97.5th percentile per bin). */
  level?: number;
}

export interface ConsistencyBand {
  meanConfidence: number;
  observedAccuracy: number;
  lo: number;
  hi: number;
  count: number;
}

/**
 * Per-bin consistency bands under the perfectly-calibrated null: bin membership is FIXED by
 * the observed confidences (same equal-mass binning as the diagram); each simulation redraws
 * only correct ~ Bernoulli(confidence) and records the per-bin accuracy. An observed bin dot
 * outside [lo, hi] is a departure the estimator can actually resolve at this n.
 */
export function consistencyBands(
  points: readonly CalibrationPoint[],
  opts: ConsistencyBandOptions,
): ConsistencyBand[] {
  if (points.length === 0) return [];
  const sims = opts.sims ?? 1000;
  const level = opts.level ?? 0.95;
  const bins = equalMassBins(points, opts.bins ?? 15);
  const rng = new Rng(opts.seed);

  const perBin: number[][] = bins.map(() => new Array<number>(sims));
  for (let s = 0; s < sims; s++) {
    for (let b = 0; b < bins.length; b++) {
      const bin = bins[b]!;
      let correct = 0;
      for (const idx of bin.indices) {
        if (rng.next() < points[idx]!.confidence) correct++;
      }
      perBin[b]![s] = correct / bin.indices.length;
    }
  }

  const tail = (1 - level) / 2;
  return bins.map((bin, b) => {
    const accs = perBin[b]!.slice().sort((x, y) => x - y);
    const q = (p: number): number => {
      const idx = p * (sims - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return lo === hi ? accs[lo]! : accs[lo]! * (hi - idx) + accs[hi]! * (idx - lo);
    };
    return {
      meanConfidence: bin.meanConfidence,
      observedAccuracy: bin.accuracy,
      lo: q(tail),
      hi: q(1 - tail),
      count: bin.indices.length,
    };
  });
}
