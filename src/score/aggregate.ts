/**
 * Corpus aggregation = micro-average.
 *
 * @velrim/scoring scores ONE doc. The corpus number is the micro-average over the SET, using the
 * additive-identity convention the scoring header documents:
 *   corpus precision = sum(TP) / (sum(TP) + sum(FP))
 *   corpus recall    = sum(TP) / (sum(TP) + sum(FN))
 *   corpus F1        = harmonic mean of corpus P and R
 *   corpus ECE       = expectedCalibrationError over the POOLED (confidence,correct) points (15 bins)
 *
 * We re-derive the TP/FP/FN cells CLI-side from each (pred, gold) leaf, but using ONLY the scoring
 * primitives (isFieldCorrect) so @velrim/scoring stays the single source of the cell definition.
 * We do NOT fork the math.
 */

import {
  isFieldCorrect,
  fieldConfidence,
  expectedCalibrationError,
  brier,
  auroc,
  riskCoverage,
  DEFAULT_CONFIDENCE,
  type ScoringField,
  type GoldenDoc,
  type CalibrationPoint,
  type RiskCoveragePoint,
} from '@velrim/scoring';

/** A single doc's prediction map paired with its golden truth. */
export interface ScoredDocInput {
  doc: string;
  pred: Record<string, ScoringField>;
  gold: GoldenDoc;
}

export interface ConfusionCells {
  tp: number;
  fp: number;
  fn: number;
}

export interface CorpusAggregate {
  /** number of docs and golden leaves pooled. */
  docs: number;
  leaves: number;
  cells: ConfusionCells;
  corpusF1: number;
  corpusPrecision: number;
  corpusRecall: number;
  corpusECE: number;
  corpusBrier: number;
  corpusAUROC: number;
  /** pooled risk-coverage curve over every leaf of every doc. */
  riskCoverage: RiskCoveragePoint[];
  /** the pooled calibration points (kept so report/ci do not recompute leaf-by-leaf). */
  points: CalibrationPoint[];
}

/**
 * Derive the TP/FP/FN confusion cell for one (pred, gold) leaf — same definition as fieldScore in
 * @velrim/scoring, expressed via the exported isFieldCorrect primitive so the cell semantics stay
 * single-sourced. A field is "positive" iff a value was produced (state==='present').
 */
export function confusionCell(
  pred: ScoringField | undefined,
  gold: { state: GoldenDoc['fields'][string]['state']; value?: unknown },
): ConfusionCells {
  const predPresent = (pred?.state ?? 'missing') === 'present';
  const goldPresent = gold.state === 'present';
  const correct = isFieldCorrect(pred, gold);
  const tp = predPresent && goldPresent && correct ? 1 : 0;
  const fp = predPresent && !(goldPresent && correct) ? 1 : 0;
  const fn = goldPresent && !(predPresent && correct) ? 1 : 0;
  return { tp, fp, fn };
}

const harmonic = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

/** Micro-average across the corpus. Pure; deterministic. */
export function aggregateCorpus(docs: ScoredDocInput[]): CorpusAggregate {
  const cells: ConfusionCells = { tp: 0, fp: 0, fn: 0 };
  const points: CalibrationPoint[] = [];
  let leaves = 0;

  for (const d of docs) {
    for (const key of Object.keys(d.gold.fields)) {
      const goldCell = d.gold.fields[key]!;
      const predField = Object.prototype.hasOwnProperty.call(d.pred, key) ? d.pred[key] : undefined;
      const c = confusionCell(predField, goldCell);
      cells.tp += c.tp;
      cells.fp += c.fp;
      cells.fn += c.fn;
      points.push({
        confidence: predField ? fieldConfidence(predField) : DEFAULT_CONFIDENCE,
        correct: isFieldCorrect(predField, goldCell),
      });
      leaves += 1;
    }
  }

  // Empty-denominator convention matches fieldScore's additive identity: no positive prediction
  // ⇒ P=1; no positive gold ⇒ R=1.
  const corpusPrecision = cells.tp + cells.fp === 0 ? 1 : cells.tp / (cells.tp + cells.fp);
  const corpusRecall = cells.tp + cells.fn === 0 ? 1 : cells.tp / (cells.tp + cells.fn);

  return {
    docs: docs.length,
    leaves,
    cells,
    corpusPrecision,
    corpusRecall,
    corpusF1: harmonic(corpusPrecision, corpusRecall),
    corpusECE: expectedCalibrationError(points), // 15 equal-mass bins (default)
    corpusBrier: brier(points),
    corpusAUROC: auroc(points),
    riskCoverage: riskCoverage(points),
    points,
  };
}
