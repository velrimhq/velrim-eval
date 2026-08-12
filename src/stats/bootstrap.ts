/**
 * Doc-clustered bootstrap (ANALYSIS-PLAN.md §10). The resampling unit is ALWAYS the
 * document — fields cluster within docs (shared scan quality, template, length), so field-level
 * resampling would understate every interval. Pre-registered procedure: resample docs with
 * replacement (stratified by class for macro numbers), 10,000 resamples, BCa 95% CIs
 * (Efron & Tibshirani 1993). Comparisons are paired at the document level: the caller's
 * statistic sees the SAME resampled doc set for both arms, so a paired delta is just a
 * statistic over clusters that carry both arms' per-doc values. Per-doc contribution = mean
 * over its N repeats — the caller collapses repeats before building clusters; repeat noise is
 * reported separately (instability.ts), never folded into these CIs silently.
 *
 * The doc-clustered fabrication CI is `pooledMeanCI` over clusters of per-cell
 * repeat-means grouped by doc. Refit-column statistics are deliberately absent from this
 * module (pre-registered: the symmetric CAL-FIT refit is a phase-2 slot, not a round-1 column).
 */

import { normalCdf, normalQuantile } from './gauss.js';
import { mulberry32 } from './rng.js';

export interface BootstrapOptions {
  /** Pre-registered, published seed — same seed, same intervals, bit-for-bit. */
  seed: number;
  /** Bootstrap resamples. The pre-registered run count is 10,000; tests use fewer. */
  resamples?: number;
  /** Confidence level for the interval (default 0.95). */
  level?: number;
}

export interface BootstrapCI {
  estimate: number;
  lo: number;
  hi: number;
  level: number;
  resamples: number;
  method: 'bca' | 'degenerate';
  /**
   * Two-sided bootstrap p-value against a zero null (for delta statistics), with the +1
   * small-sample correction: p = 2·min[(1+#{θ*≤0})/(B+1), (1+#{θ*≥0})/(B+1)], capped at 1.
   * Feed these into holm() for the arm-vs-Velrim families. Meaningless for non-delta
   * statistics (a rate is never 0-null-tested) — read it only where a zero null makes sense.
   */
  pZero: number;
}

/** Empirical quantile with linear interpolation over an ASCENDING-sorted array. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

/**
 * BCa confidence interval for `statistic` over doc-clusters, resampled within strata.
 * Unstratified input = a single stratum. `statistic` receives the concatenated resampled
 * clusters (order: stratum by stratum) and must be pure.
 */
export function bcaCI<T>(
  strata: ReadonlyArray<ReadonlyArray<T>>,
  statistic: (clusters: readonly T[]) => number,
  opts: BootstrapOptions,
): BootstrapCI {
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  const all: T[] = strata.flat() as T[];
  if (all.length === 0) throw new Error('bcaCI: no clusters');
  if (strata.some((s) => s.length === 0)) throw new Error('bcaCI: empty stratum');
  if (!(resamples > 0)) throw new Error('bcaCI: resamples must be > 0');
  if (!(level > 0 && level < 1)) throw new Error('bcaCI: level must be in (0,1)');

  const estimate = statistic(all);
  const rand = mulberry32(opts.seed);

  // Bootstrap distribution: resample clusters with replacement WITHIN each stratum.
  const boot = new Array<number>(resamples);
  const sample: T[] = new Array<T>(all.length);
  for (let b = 0; b < resamples; b++) {
    let k = 0;
    for (const stratum of strata) {
      const n = stratum.length;
      for (let i = 0; i < n; i++) sample[k++] = stratum[Math.floor(rand() * n)]!;
    }
    boot[b] = statistic(sample);
  }

  // Two-sided zero-null p-value (before sorting mutates nothing — computed on raw counts).
  let le = 0;
  let ge = 0;
  for (const v of boot) {
    if (v <= 0) le++;
    if (v >= 0) ge++;
  }
  const pZero = Math.min(1, 2 * Math.min((1 + le) / (resamples + 1), (1 + ge) / (resamples + 1)));

  const sorted = [...boot].sort((a, b) => a - b);
  if (sorted[0] === sorted[sorted.length - 1]) {
    // Degenerate distribution — every resample produced the same value.
    return { estimate, lo: estimate, hi: estimate, level, resamples, method: 'degenerate', pZero };
  }

  // Bias correction z0 (ties get half weight; proportion clamped away from {0,1}).
  let below = 0;
  let equal = 0;
  for (const v of boot) {
    if (v < estimate) below++;
    else if (v === estimate) equal++;
  }
  const propRaw = (below + equal / 2) / resamples;
  const prop = Math.min(1 - 1 / (resamples + 1), Math.max(1 / (resamples + 1), propRaw));
  const z0 = normalQuantile(prop);

  // Acceleration via leave-one-cluster-out jackknife (cluster removed from its stratum).
  const jack: number[] = [];
  for (let s = 0; s < strata.length; s++) {
    const stratum = strata[s]!;
    if (strata.length === 1 && stratum.length === 1) break; // cannot jackknife a single cluster
    for (let i = 0; i < stratum.length; i++) {
      const rest: T[] = [];
      for (let t = 0; t < strata.length; t++) {
        const st = strata[t]!;
        for (let j = 0; j < st.length; j++) {
          if (t === s && j === i) continue;
          rest.push(st[j]!);
        }
      }
      jack.push(statistic(rest));
    }
  }
  let accel = 0;
  if (jack.length > 1) {
    const mean = jack.reduce((a, b) => a + b, 0) / jack.length;
    let num = 0;
    let den = 0;
    for (const v of jack) {
      const d = mean - v;
      num += d * d * d;
      den += d * d;
    }
    accel = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
  }

  const alpha = 1 - level;
  const zLo = normalQuantile(alpha / 2);
  const zHi = normalQuantile(1 - alpha / 2);
  const adjust = (z: number): number => {
    const w = z0 + (z0 + z) / (1 - accel * (z0 + z));
    return normalCdf(w);
  };
  const lo = quantileSorted(sorted, Math.min(Math.max(adjust(zLo), 0), 1));
  const hi = quantileSorted(sorted, Math.min(Math.max(adjust(zHi), 0), 1));
  return {
    estimate,
    lo: Math.min(lo, hi),
    hi: Math.max(lo, hi),
    level,
    resamples,
    method: 'bca',
    pZero,
  };
}

/**
 * Doc-clustered CI on a pooled mean — the fabrication-CI shape: each cluster is one
 * doc's array of per-cell values (each value = that cell's mean over N repeats); the statistic
 * is the pooled mean over every cell of the resampled docs. 66 of ~141 absent cells sit in 15
 * cord docs, so this interval is honestly wider than a binomial sketch — by design.
 */
export function pooledMeanCI(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  opts: BootstrapOptions,
): BootstrapCI {
  const nonEmpty = clusters.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) throw new Error('pooledMeanCI: no cells in any cluster');
  return bcaCI(
    [nonEmpty],
    (docs) => {
      let sum = 0;
      let n = 0;
      for (const d of docs) {
        for (const v of d) {
          sum += v;
          n++;
        }
      }
      return sum / n;
    },
    opts,
  );
}

/**
 * Paired per-doc delta CI (arm A − arm B), docs resampled together so pairing is preserved.
 * Each cluster carries BOTH arms' per-doc contributions (already repeat-averaged). The
 * statistic here is the mean per-doc delta; for micro-F1 deltas build the pooled cells into
 * the cluster payload and use bcaCI with a pooled-F1 statistic instead.
 */
export function pairedMeanDeltaCI(
  docs: ReadonlyArray<{ a: number; b: number }>,
  opts: BootstrapOptions,
): BootstrapCI {
  if (docs.length === 0) throw new Error('pairedMeanDeltaCI: no docs');
  return bcaCI(
    [docs],
    (sample) => {
      let sum = 0;
      for (const d of sample) sum += d.a - d.b;
      return sum / sample.length;
    },
    opts,
  );
}
