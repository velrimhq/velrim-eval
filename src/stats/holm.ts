/**
 * Holm–Bonferroni step-down correction (Holm 1979) — pre-registered over the arm-vs-Velrim
 * contrasts WITHIN each primary metric family (accuracy / fabrication / confidence-utility),
 * never between families (ANALYSIS-PLAN.md §10). Everything outside the three primary
 * families is descriptive: CIs, no stars, no winner language.
 *
 * The kill-criteria CI convention reads "Holm-adjusted intervals": alongside adjusted
 * p-values this returns the per-contrast step-down alpha and its CI level (1 − alpha), so the
 * caller can re-run bcaCI at exactly that level for the contrasts a kill criterion reads.
 */

export interface HolmEntry {
  /** Position in the caller's input array (results are returned in input order). */
  index: number;
  p: number;
  /** Step-down adjusted p-value (monotone, capped at 1). */
  pAdjusted: number;
  /** The alpha this contrast was tested against in the step-down sequence. */
  alpha: number;
  /** CI level matching the step-down alpha — the "Holm-adjusted interval" level. */
  ciLevel: number;
  rejected: boolean;
}

/** Holm step-down over one pre-registered family. `alpha` defaults to 0.05. */
export function holm(pValues: readonly number[], alpha = 0.05): HolmEntry[] {
  const m = pValues.length;
  if (m === 0) return [];
  for (const p of pValues) {
    if (!(p >= 0 && p <= 1)) throw new Error(`holm: p-value out of [0,1]: ${p}`);
  }
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p || a.index - b.index);

  const out: HolmEntry[] = new Array(m);
  let running = 0; // enforce monotonicity of adjusted p-values
  let stopped = false; // once one hypothesis fails, everything later fails too
  for (let k = 0; k < m; k++) {
    const { p, index } = order[k]!;
    const stepAlpha = alpha / (m - k);
    running = Math.max(running, Math.min(1, (m - k) * p));
    const rejected = !stopped && p <= stepAlpha;
    if (!rejected) stopped = true;
    out[index] = {
      index,
      p,
      pAdjusted: running,
      alpha: stepAlpha,
      ciLevel: 1 - stepAlpha,
      rejected,
    };
  }
  return out;
}
