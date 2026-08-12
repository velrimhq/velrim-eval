/**
 * Generic 1-D Platt/logistic calibration — `p = σ(a·x + b)` — for an OSS user's own extractor
 * scores (velrim-eval `calibrate`/`curves`). PUBLIC + GENERIC: this is NOT the
 * proprietary per-class feature-fit (that is `@velrim/core`'s `buildCalibrator`, never imported
 * here). It fits the single `(confidence, correct)` column only.
 *
 * Pure TS, ZERO deps, DETERMINISTIC: ridge-regularized IRLS (Newton/Fisher scoring) on a 2×2 SPD
 * system, solved closed-form. No RNG, no `Date`, no `Math.random` → bit-reproducible given the
 * input row order. The ridge prior (`a` only, never the bias) keeps the solve finite under perfect
 * separation, where the unregularized MLE diverges. The math is hand-checkable (test: recovers a
 * known `a`,`b` on seeded synthetic data; stays finite under separation).
 *
 * The `@velrim/scoring` metric set (ECE/Brier/AUROC/risk-coverage) is COMPOSED by the callers off
 * the calibrated points — this file only fits + reconstructs the design and bins the reliability
 * diagram (equal-mass, the same convention scoring's `expectedCalibrationError` uses).
 */

import type { CalibrationPoint } from '@velrim/scoring';

/** Fitted 1-D Platt model: `apply(x) = σ(a·x + b)`. */
export interface Platt1D {
  a: number;
  b: number;
}

/** Default ridge strength on the slope `a` (the bias `b` is NEVER penalized). Small: it only
 *  bites under (near-)separation to keep the IRLS solve finite; otherwise the fit is ~unbiased. */
export const PLATT_RIDGE = 1e-3;

const MAX_ITERS = 100;
const TOL = 1e-12;

function sigmoid(z: number): number {
  // Numerically-stable two-branch logistic (avoids overflow of exp for large |z|).
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Solve the 2×2 SPD system [[A,B],[B,C]]·[u,v]ᵀ = [p,q]ᵀ. Ridge makes it SPD → det > 0 always. */
function solve2(A: number, B: number, C: number, p: number, q: number): [number, number] {
  const det = A * C - B * B;
  return [(C * p - B * q) / det, (A * q - B * p) / det];
}

/**
 * Fit `p = σ(a·x + b)` on `(confidence, correct)` points via ridge-IRLS. Deterministic; the caller
 * is responsible for a stable row order if bit-reproducibility across shuffles is required (the
 * arithmetic is order-insensitive up to floating-point summation order). Both classes SHOULD be
 * present (caller guards the degenerate one-class case); with ridge the solve is still finite if not.
 */
export function fitPlatt1D(points: CalibrationPoint[], ridge: number = PLATT_RIDGE): Platt1D {
  let a = 0;
  let b = 0;
  for (let it = 0; it < MAX_ITERS; it++) {
    // Build XᵀWX (+ ridge on the a-diagonal) and the Newton RHS XᵀWz with working response
    // z = η + (y − μ)/w. Design row is [x, 1] → params [a, b].
    let H11 = ridge; // a,a  (ridge here ONLY)
    let H12 = 0; // a,b
    let H22 = 0; // b,b
    let g1 = 0; // a-component of XᵀWz
    let g2 = 0; // b-component of XᵀWz
    for (const pt of points) {
      const x = pt.confidence;
      const y = pt.correct ? 1 : 0;
      const eta = a * x + b;
      const mu = sigmoid(eta);
      const w = Math.max(mu * (1 - mu), 1e-6); // floor avoids singular weights under saturation
      const z = eta + (y - mu) / w;
      const wz = w * z;
      H11 += w * x * x;
      H12 += w * x;
      H22 += w;
      g1 += wz * x;
      g2 += wz;
    }
    const [na, nb] = solve2(H11, H12, H22, g1, g2);
    const delta = Math.max(Math.abs(na - a), Math.abs(nb - b));
    a = na;
    b = nb;
    if (delta < TOL) break;
  }
  return { a, b };
}

/** Apply the fitted Platt model to one raw confidence → calibrated probability in (0,1). Pure. */
export function applyPlatt(model: Platt1D, x: number): number {
  return sigmoid(model.a * x + model.b);
}

/** One reliability-diagram bin: mean predicted confidence vs observed accuracy over `n` points. */
export interface ReliabilityBin {
  meanConfidence: number;
  accuracy: number;
  n: number;
}

/**
 * Equal-mass reliability-diagram bins (the `expectedCalibrationError` convention): sort by
 * confidence, split into `bins` contiguous equal-count groups, report each group's mean confidence
 * + observed accuracy. With fewer points than `bins` you simply get fewer non-empty bins. Pure;
 * deterministic (stable tie order by original index). `bins` defaults to the published 15.
 */
export function reliabilityBins(points: CalibrationPoint[], bins = 15): ReliabilityBin[] {
  const n = points.length;
  if (n === 0) return [];
  const sorted = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.confidence - b.p.confidence || a.i - b.i)
    .map((x) => x.p);

  const k = Math.min(bins, n);
  const out: ReliabilityBin[] = [];
  for (let bIdx = 0; bIdx < k; bIdx++) {
    const start = Math.floor((bIdx * n) / k);
    const end = Math.floor(((bIdx + 1) * n) / k);
    const slice = sorted.slice(start, end);
    if (slice.length === 0) continue;
    let confSum = 0;
    let correct = 0;
    for (const pt of slice) {
      confSum += pt.confidence;
      if (pt.correct) correct += 1;
    }
    out.push({
      meanConfidence: confSum / slice.length,
      accuracy: correct / slice.length,
      n: slice.length,
    });
  }
  return out;
}
