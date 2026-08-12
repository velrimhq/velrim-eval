/**
 * Minimum-detectable-effect re-simulation at final counts (ANALYSIS-PLAN.md §10 — the MDE
 * table is re-simulated at the frozen counts before plan-freeze). The MDE table PRINTS BESIDE the
 * results (Card et al., EMNLP 2020): per class, the corpus cannot distinguish arms closer than
 * the MDE, and any smaller gap is reported as "not distinguishable on this corpus" — including
 * gaps in Velrim's favor.
 *
 * Simulation model (the pre-registered assumptions; every knob is an explicit input so the
 * frozen plan can print them):
 *  - paired doc-level comparison of per-field accuracy between two arms over the SAME docs;
 *  - doc random effect u_i ~ N(0, docEffectSd=0.7) on the probit scale, shared by both arms
 *    (docs are hard or easy for everyone);
 *  - shared-difficulty fraction (default 0.60): each field's latent difficulty is
 *    √λ·shared + √(1−λ)·arm-specific, so errors concentrate on the same hard fields;
 *  - arm A marginal accuracy = baseAccuracy; arm B = baseAccuracy + delta (probit-shifted).
 *
 * Decision rule: paired statistic t = mean(per-doc accuracy delta)/SE across docs; the
 * rejection threshold is ESTIMATED FROM THE NULL (delta = 0) within the same harness — the
 * (1−alpha) quantile of |t| over null simulations — so no distributional approximation leaks
 * into the power number. MDE = smallest grid delta reaching targetPower. Fully seeded.
 */

import { normalQuantile, normalCdf } from './gauss.js';
import { Rng } from './rng.js';

export interface MdeOptions {
  /** Per-doc golden field counts for the class at FINAL counts (one entry per doc). */
  fieldCounts: readonly number[];
  /** Arm-A marginal per-field accuracy (e.g. 0.75 and 0.90 rows in the published table). */
  baseAccuracy: number;
  /** Ascending grid of accuracy deltas to test (absolute, e.g. 0.02..0.15). */
  deltaGrid: readonly number[];
  seed: number;
  sharedDifficulty?: number; // λ, default 0.60
  docEffectSd?: number; // τ on the probit scale, default 0.7
  alpha?: number; // two-sided, default 0.05
  targetPower?: number; // default 0.80
  sims?: number; // per grid point AND for the null threshold, default 600
}

export interface MdeResult {
  /** Smallest grid delta with power ≥ targetPower; null if none reaches it. */
  mde: number | null;
  grid: Array<{ delta: number; power: number }>;
  /** Empirical |t| rejection threshold estimated at delta = 0. */
  nullThreshold: number;
  assumptions: {
    docs: number;
    fields: number;
    baseAccuracy: number;
    sharedDifficulty: number;
    docEffectSd: number;
    alpha: number;
    targetPower: number;
    sims: number;
  };
}

/** One simulated paired dataset → the paired t statistic over per-doc accuracy deltas. */
function simulateT(
  rng: Rng,
  fieldCounts: readonly number[],
  baseAccuracy: number,
  delta: number,
  lambda: number,
  tau: number,
): number {
  const zA = normalQuantile(Math.min(0.999, Math.max(0.001, baseAccuracy)));
  const zB = normalQuantile(Math.min(0.999, Math.max(0.001, baseAccuracy + delta)));
  const sqL = Math.sqrt(lambda);
  const sqE = Math.sqrt(1 - lambda);
  const deltas: number[] = new Array(fieldCounts.length);
  for (let i = 0; i < fieldCounts.length; i++) {
    const u = tau * rng.normal();
    // Per-doc accuracy on the probit scale, same doc effect for both arms.
    const thA = zA + u;
    const thB = zB + u;
    const m = fieldCounts[i]!;
    let accA = 0;
    let accB = 0;
    for (let j = 0; j < m; j++) {
      const shared = rng.normal();
      const a = sqL * shared + sqE * rng.normal();
      const b = sqL * shared + sqE * rng.normal();
      if (a < thA) accA++;
      if (b < thB) accB++;
    }
    deltas[i] = accB / m - accA / m;
  }
  const n = deltas.length;
  const mean = deltas.reduce((x, y) => x + y, 0) / n;
  let ss = 0;
  for (const d of deltas) ss += (d - mean) * (d - mean);
  const se = Math.sqrt(ss / (n - 1) / n);
  return se === 0 ? (mean === 0 ? 0 : Number.POSITIVE_INFINITY) : mean / se;
}

/** Re-simulate the MDE for one class at its final counts. */
export function simulateMde(opts: MdeOptions): MdeResult {
  const lambda = opts.sharedDifficulty ?? 0.6;
  const tau = opts.docEffectSd ?? 0.7;
  const alpha = opts.alpha ?? 0.05;
  const targetPower = opts.targetPower ?? 0.8;
  const sims = opts.sims ?? 600;
  if (opts.fieldCounts.length < 2) throw new Error('simulateMde: need ≥ 2 docs');
  if (!(opts.baseAccuracy > 0 && opts.baseAccuracy < 1)) {
    throw new Error('simulateMde: baseAccuracy must be in (0,1)');
  }
  const grid = [...opts.deltaGrid].sort((a, b) => a - b);
  if (grid.length === 0 || grid[0]! <= 0)
    throw new Error('simulateMde: deltaGrid must be positive');

  // Null threshold: (1−alpha) quantile of |t| at delta = 0, on its own seed stream.
  const nullRng = new Rng(opts.seed ^ 0x9e3779b9);
  const nullAbsT = new Array<number>(sims);
  for (let s = 0; s < sims; s++) {
    nullAbsT[s] = Math.abs(simulateT(nullRng, opts.fieldCounts, opts.baseAccuracy, 0, lambda, tau));
  }
  nullAbsT.sort((a, b) => a - b);
  const qIdx = (1 - alpha) * (sims - 1);
  const lo = Math.floor(qIdx);
  const hi = Math.ceil(qIdx);
  const nullThreshold =
    lo === hi ? nullAbsT[lo]! : nullAbsT[lo]! * (hi - qIdx) + nullAbsT[hi]! * (qIdx - lo);

  const gridResults: Array<{ delta: number; power: number }> = [];
  let mde: number | null = null;
  for (const delta of grid) {
    if (opts.baseAccuracy + delta >= 1) {
      // A delta that pushes accuracy to/past 1 is not simulable under the probit model.
      gridResults.push({ delta, power: NaN });
      continue;
    }
    const rng = new Rng(opts.seed + Math.round(delta * 1e6));
    let rejected = 0;
    for (let s = 0; s < sims; s++) {
      const t = simulateT(rng, opts.fieldCounts, opts.baseAccuracy, delta, lambda, tau);
      if (Math.abs(t) > nullThreshold) rejected++;
    }
    const power = rejected / sims;
    gridResults.push({ delta, power });
    if (mde === null && power >= targetPower) mde = delta;
  }

  return {
    mde,
    grid: gridResults,
    nullThreshold,
    assumptions: {
      docs: opts.fieldCounts.length,
      fields: opts.fieldCounts.reduce((a, b) => a + b, 0),
      baseAccuracy: opts.baseAccuracy,
      sharedDifficulty: lambda,
      docEffectSd: tau,
      alpha,
      targetPower,
      sims,
    },
  };
}

/** Marginal accuracy implied by a probit threshold — exported for tests/diagnostics. */
export function probitAccuracy(z: number): number {
  return normalCdf(z);
}
