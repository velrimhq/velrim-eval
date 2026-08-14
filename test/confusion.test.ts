/**
 * Cell-seam pin.
 *
 * `aggregate.confusionCell` re-derives the TP/FP/FN cells CLI-side from the (pred, gold) inputs.
 * The cell ARITHMETIC is byte-identical to
 * @velrim/scoring's `fieldScore`, but nothing pinned the two together — so a future change to
 * fieldScore's cell convention (e.g. how a present↔present value-mismatch splits FP vs FN) would
 * let the corpus micro-average silently diverge from the per-doc scores.
 *
 * This test pins the seam the way identity.test.ts pins the type seam: across the FULL 3-state ×
 * correct/wrong matrix it asserts confusionCell(pred, gold) is CONSISTENT with @velrim/scoring's
 * fieldScore(pred, gold). fieldScore returns {precision, recall, f1} (not the raw cells), so we
 * map each cell triple to its expected P/R/F1 under the single-instance empty-denominator
 * convention both functions document, and assert equality. If fieldScore's cell logic moves,
 * this reddens.
 */

import { describe, expect, it } from 'vitest';
import { fieldScore, type ScoringField, type FieldState } from '@velrim/scoring';
import { confusionCell, type ConfusionCells } from '../src/score/aggregate.js';

/** The per-instance P/R/F1 a single cell triple implies (same empty-denominator convention as
 *  fieldScore: no positive prediction ⇒ P=1; no positive gold ⇒ R=1). */
function cellsToScore(c: ConfusionCells): { precision: number; recall: number; f1: number } {
  const precision = c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

const STATES: FieldState[] = ['present', 'null', 'missing'];

describe('confusionCell ⇔ @velrim/scoring.fieldScore — cell seam pin (no silent drift)', () => {
  it('agrees across the full 3-state × value-match matrix', () => {
    let checked = 0;
    for (const goldState of STATES) {
      // gold value only meaningful when present; use a fixed scalar.
      const gold = goldState === 'present' ? { state: goldState, value: 42 } : { state: goldState };

      for (const predState of STATES) {
        // For present predictions, exercise BOTH a value-match and a value-mismatch.
        const predValues =
          predState === 'present' ? [42 /* match */, 99 /* mismatch */] : [undefined];

        for (const v of predValues) {
          const pred: ScoringField | undefined =
            predState === 'missing' && v === undefined
              ? undefined // a missing prediction is the `undefined`/absent case
              : { state: predState, ...(v === undefined ? {} : { value: v }) };

          const fromCli = cellsToScore(confusionCell(pred, gold));
          const fromScoring = fieldScore(pred, gold);
          expect(fromCli, `pred=${predState}:${String(v)} gold=${goldState}`).toEqual(fromScoring);
          checked += 1;
        }
      }
    }
    // 3 gold states × (present×2 value cases + null×1 + missing×1) = 3 × 4 = 12 combinations.
    expect(checked).toBe(12);
  });

  it('agrees across the same matrix WITH a normalizer kind (FD-10 dual-column seam)', () => {
    // Values chosen so strict and normalized labels DIVERGE: "$1,880.00" ≠ "1880" byte-wise but
    // both normalize (currency) to "1880" — the kind must reach both sides in both functions.
    let checked = 0;
    for (const goldState of STATES) {
      const gold =
        goldState === 'present' ? { state: goldState, value: '1880' } : { state: goldState };
      for (const predState of STATES) {
        const predValues =
          predState === 'present'
            ? ['$1,880.00' /* normalized match, strict mismatch */, 'nonsense' /* mismatch */]
            : [undefined];
        for (const v of predValues) {
          const pred: ScoringField | undefined =
            predState === 'missing' && v === undefined
              ? undefined
              : { state: predState, ...(v === undefined ? {} : { value: v }) };
          const fromCli = cellsToScore(confusionCell(pred, gold, 'currency'));
          const fromScoring = fieldScore(pred, gold, 'currency');
          expect(fromCli, `pred=${predState}:${String(v)} gold=${goldState}`).toEqual(fromScoring);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(12);
  });

  it('the kind flips a formatting-only mismatch from FP+FN to TP — and only when given', () => {
    const pred: ScoringField = { state: 'present', value: '$1,880.00' };
    const gold = { state: 'present' as FieldState, value: '1880' };
    expect(confusionCell(pred, gold)).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(confusionCell(pred, gold, 'currency')).toEqual({ tp: 1, fp: 0, fn: 0 });
    // A kind can only ADD matches: identical bytes stay equal under it.
    const exact: ScoringField = { state: 'present', value: '1880' };
    expect(confusionCell(exact, gold, 'currency')).toEqual({ tp: 1, fp: 0, fn: 0 });
  });
});
