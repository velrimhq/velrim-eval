/**
 * `velrim-eval calibrate` — GENERIC 1-D Platt/logistic calibration for an OSS
 * user's OWN extractor scores. This is the PUBLIC, generic path: it fits `p = σ(a·confidence + b)`
 * on the single `(confidence, correct)` column of a scores.json, emits a reliability curve and a
 * selective-prediction τ from `riskCoverage()`. It is NOT the proprietary per-class feature-fit
 * (that lives in Velrim's private core package and is never imported here).
 *
 * The fit is pure TS, zero-dep, deterministic (ridge-IRLS, 2 params; no RNG/Date). The only
 * cross-package import is `@velrim/scoring` (riskCoverage / expectedCalibrationError / brier /
 * auroc) — the metrics are COMPOSED, never re-implemented.
 *
 * Guardrail: on absent OR empty `(confidence, correct)` input
 * it emits NO number and exits NON-ZERO (3). `--allow-stub` exits 0 for pipeline wiring. A REAL
 * curve + τ is emitted ONLY when given real points — never fabricated.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import {
  riskCoverage,
  expectedCalibrationError,
  brier,
  auroc,
  type CalibrationPoint,
} from '@velrim/scoring';
import { CALIBRATE_HELP } from '../help.js';
import { fitPlatt1D, applyPlatt, reliabilityBins } from '../calibrate/platt.js';

/** A scores.json (from `velrim-eval score`) carries the pooled (confidence, correct) column we fit. */
interface ScoresPointsFile {
  points?: { confidence: number; correct: boolean }[];
}

/** Read the (confidence, correct) column from a scores.json. Throws on malformed shape. */
function readPoints(text: string, path: string): CalibrationPoint[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${path}: expected a scores.json object`);
  }
  const pts = (raw as ScoresPointsFile).points;
  if (pts === undefined) {
    // Honest: a scores.json with no points column is not a fabricated-zero case — it is absent input.
    return [];
  }
  if (!Array.isArray(pts)) {
    throw new Error(`${path}: "points" must be an array of { confidence, correct }`);
  }
  const out: CalibrationPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as { confidence?: unknown; correct?: unknown };
    if (
      typeof p?.confidence !== 'number' ||
      !Number.isFinite(p.confidence) ||
      typeof p?.correct !== 'boolean'
    ) {
      throw new Error(
        `${path}: points[${i}] must be { confidence: finite number, correct: boolean }`,
      );
    }
    out.push({ confidence: p.confidence, correct: p.correct });
  }
  return out;
}

/**
 * The largest selective-prediction coverage whose risk (error among accepted) is ≤ `maxError`,
 * derived from `@velrim/scoring`'s `riskCoverage()`. The accepted SET is keyed by the CALIBRATED
 * confidence (so τ is a threshold on the calibrated probability). `≤` boundary; the accept-nothing
 * `{coverage:0,error:0}` sentinel never wins on coverage. Returns the chosen point + its confidence
 * threshold τ, or null if no non-empty coverage clears the risk budget.
 */
function selectiveTau(
  calibrated: CalibrationPoint[],
  maxError: number,
): { tau: number; coverage: number; error: number } | null {
  const curve = riskCoverage(calibrated);
  // riskCoverage walks DESCENDING confidence; map each emitted coverage back to the confidence
  // threshold that admits exactly that many points (the k-th highest calibrated confidence).
  const sorted = [...calibrated].sort((a, b) => b.confidence - a.confidence);
  let best: { tau: number; coverage: number; error: number } | null = null;
  for (const pt of curve) {
    if (pt.coverage <= 0) continue; // skip the accept-nothing sentinel
    if (pt.error > maxError) continue;
    if (best === null || pt.coverage > best.coverage) {
      const k = Math.round(pt.coverage * calibrated.length); // # accepted at this coverage
      const tau = k > 0 && k <= sorted.length ? sorted[k - 1]!.confidence : 0;
      best = { tau, coverage: pt.coverage, error: pt.error };
    }
  }
  return best;
}

export async function calibrate(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        scores: { type: 'string' },
        'max-error': { type: 'string' },
        'allow-stub': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`calibrate: ${(e as Error).message}\n${CALIBRATE_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(CALIBRATE_HELP);
    return 0;
  }
  if (!values.scores) {
    process.stderr.write('calibrate: --scores is required\n');
    return 2;
  }

  // --max-error: the selective-prediction risk budget for τ (default 0.05). Usage error if non-finite.
  let maxError = 0.05;
  if (values['max-error'] !== undefined) {
    maxError = Number(values['max-error']);
    if (!Number.isFinite(maxError) || maxError < 0 || maxError > 1) {
      process.stderr.write('calibrate: --max-error must be a number in [0,1]\n');
      return 2;
    }
  }

  let points: CalibrationPoint[];
  try {
    points = readPoints(await readFile(values.scores, 'utf8'), values.scores);
  } catch (e) {
    process.stderr.write(`calibrate: ${(e as Error).message}\n`);
    return 2;
  }

  // GUARDRAIL: empty/absent (confidence, correct) column → NO number, exit non-zero.
  if (points.length === 0) {
    process.stdout.write(
      'calibrate: no (confidence, correct) points in --scores. No tau/curve emitted (nothing to fit).\n',
    );
    if (values['allow-stub']) return 0;
    return 3;
  }
  // A 1-D logistic needs BOTH classes present to be identifiable; one-class input is degenerate.
  const nPos = points.filter((p) => p.correct).length;
  if (nPos === 0 || nPos === points.length) {
    process.stdout.write(
      `calibrate: degenerate input — all ${points.length} points are ${nPos === 0 ? 'incorrect' : 'correct'}; ` +
        'a logistic fit is not identifiable. No tau/curve emitted.\n',
    );
    if (values['allow-stub']) return 0;
    return 3;
  }
  // A column where every confidence is the same value carries no signal to fit — it is what an
  // arm that surfaces NO confidence looks like after the scorer's neutral placeholder. Fitting it
  // would print a curve for a score that does not exist.
  const first = points[0]!.confidence;
  if (points.every((p) => p.confidence === first)) {
    process.stdout.write(
      `calibrate: every one of the ${points.length} points carries the same confidence (${first}); ` +
        'this arm surfaces no confidence signal. No tau/curve emitted.\n',
    );
    if (values['allow-stub']) return 0;
    return 3;
  }

  // REAL PATH: fit the generic 1-D Platt logistic on (confidence, correct), pure + deterministic.
  const model = fitPlatt1D(points);
  const calibrated: CalibrationPoint[] = points.map((p) => ({
    confidence: applyPlatt(model, p.confidence),
    correct: p.correct,
  }));

  const eceRaw = expectedCalibrationError(points);
  const eceCal = expectedCalibrationError(calibrated);
  const brierRaw = brier(points);
  const brierCal = brier(calibrated);
  const aurocVal = auroc(points); // rank-invariant under a monotone Platt → reported once.
  const bins = reliabilityBins(calibrated);
  const tau = selectiveTau(calibrated, maxError);

  const result = {
    version: 1 as const,
    method: 'platt-1d' as const,
    n: points.length,
    nPositive: nPos,
    coef: { a: model.a, b: model.b },
    ece: { raw: eceRaw, calibrated: eceCal },
    brier: { raw: brierRaw, calibrated: brierCal },
    auroc: aurocVal,
    reliability: bins, // per-bin { meanConfidence, accuracy, n } (15 equal-mass bins)
    selective: tau, // { tau, coverage, error } at risk ≤ --max-error, or null
    maxError,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(
    `calibrate: fit platt-1d on ${points.length} points (a=${model.a.toFixed(4)}, b=${model.b.toFixed(4)}); ` +
      `ECE ${eceRaw.toFixed(4)}→${eceCal.toFixed(4)}; ` +
      (tau
        ? `tau=${tau.tau.toFixed(4)} covers ${(tau.coverage * 100).toFixed(1)}% at risk ${(tau.error * 100).toFixed(2)}%\n`
        : `no coverage clears risk ≤ ${(maxError * 100).toFixed(2)}%\n`),
  );
  return 0;
}
