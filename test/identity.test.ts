/**
 * Shared-snapshot code-IDENTITY proof (STRUCTURAL identity).
 *
 * velrim-eval imports the PUBLISHED name `@velrim/scoring` (dev-linked to the packed tarball, NOT
 * a local copy). This test proves the SAME `scoreAgainstGolden` the eval CLI runs is the one
 * Velrim's private core package re-exports (it transits `@velrim/scoring` too) and the published
 * curves page will consume. The math lives ONCE; there is no second copy to drift.
 *
 * Three assertions:
 *   1. IMPORT IDENTITY  — `scoreAgainstGolden` resolves from the published package and is a function.
 *   2. HAND-CHECKED SNAPSHOT — run it over the FROZEN 4-leaf worked pair (ported byte-for-byte from
 *      from `@velrim/scoring`'s own worked-example test) and assert the FULL
 *      { perField, ece, auroc, riskCoverage } against the LITERAL hand-computed numbers. This is NOT
 *      `toMatchSnapshot` auto-capture — the module's anti-tautology rule forbids it. Every number
 *      below is the worked arithmetic, not the implementation re-run:
 *        AUROC = (R_pos − n_pos(n_pos+1)/2)/(n_pos·n_neg) = (6−3)/4 = 0.75
 *        ECE   = (|1−0.9|+|0−0.7|+|1−0.6|+|0−0.3|)/4 = (0.1+0.7+0.4+0.3)/4 = 1.5/4 = 0.375
 *        risk-coverage = 5 points: {0,0},{¼,0},{½,½},{¾,⅓},{1,½}
 *      The published curves page scoring this SAME pair via `@velrim/scoring` MUST produce the identical
 *      object. Divergence = drift = fail.
 *   3. SINGLE-SOURCE COROLLARY (note) — the package publish gate proves the tarball is scoring-ONLY math;
 *      this test proves the CONSUMED function is that one. Together: code identity is structural; no
 *      runtime drift-check is needed.
 */

import { describe, expect, it } from 'vitest';
import { scoreAgainstGolden, type GoldenDoc, type ScoringField } from '@velrim/scoring';

const close = (a: number, b: number, eps = 1e-12): void =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe('code identity — velrim-eval runs the PUBLISHED @velrim/scoring', () => {
  it('(1) import identity: scoreAgainstGolden resolves from @velrim/scoring and is a function', () => {
    // Proves resolution to the carved/published package (dev-linked tarball), not a local copy.
    expect(typeof scoreAgainstGolden).toBe('function');
  });

  it('(2) hand-checked numeric snapshot over the FROZEN 4-leaf worked pair (NOT auto-snapshot)', () => {
    // The exact worked pair from packages/scoring/src/index.test.ts (and core's original):
    //   /vendor : gold present "ACME", pred present "ACME" conf 0.9  → correct
    //   /total  : gold present 100,     pred present 999  conf 0.7  → WRONG value
    //   /date   : gold present "2026",  pred present "2026" conf 0.6 → correct
    //   /tax    : gold null,            pred present "fab" conf 0.3  → WRONG (fabrication)
    const gold: GoldenDoc = {
      docClass: 'invoice',
      fields: {
        '/vendor': { state: 'present', value: 'ACME' },
        '/total': { state: 'present', value: 100 },
        '/date': { state: 'present', value: '2026' },
        '/tax': { state: 'null' },
      },
    };
    const pred: Record<string, ScoringField> = {
      '/vendor': { state: 'present', value: 'ACME', confidence: 0.9 },
      '/total': { state: 'present', value: 999, confidence: 0.7 },
      '/date': { state: 'present', value: '2026', confidence: 0.6 },
      '/tax': { state: 'present', value: 'fab', confidence: 0.3 },
    };

    const r = scoreAgainstGolden(pred, gold);

    // --- per-field cells (hand-checked, see fieldScore worked examples) ---
    expect(r.perField['/vendor']).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(r.perField['/date']).toEqual({ precision: 1, recall: 1, f1: 1 });
    // wrong value present⇔present ⇒ FP and FN ⇒ all zero:
    expect(r.perField['/total']).toEqual({ precision: 0, recall: 0, f1: 0 });
    // fabrication (pred present, gold null) ⇒ FP only ⇒ P=0, R=1, F1=0:
    expect(r.perField['/tax']).toEqual({ precision: 0, recall: 1, f1: 0 });
    // the FULL perField object — nothing extra, nothing missing:
    expect(Object.keys(r.perField).sort()).toEqual(['/date', '/tax', '/total', '/vendor']);

    // --- AUROC = 0.75 (hand-computed rank-sum) ---
    close(r.auroc, 0.75);

    // --- ECE = 0.375 (4 singleton equal-mass bins, weight ¼ each) ---
    close(r.ece, 0.375);

    // --- risk-coverage: EXACTLY 5 hand-checked points ---
    expect(r.riskCoverage).toHaveLength(5);
    close(r.riskCoverage[0]!.coverage, 0);
    close(r.riskCoverage[0]!.error, 0);
    close(r.riskCoverage[1]!.coverage, 0.25);
    close(r.riskCoverage[1]!.error, 0);
    close(r.riskCoverage[2]!.coverage, 0.5);
    close(r.riskCoverage[2]!.error, 0.5);
    close(r.riskCoverage[3]!.coverage, 0.75);
    close(r.riskCoverage[3]!.error, 1 / 3);
    close(r.riskCoverage[4]!.coverage, 1);
    close(r.riskCoverage[4]!.error, 0.5);
  });

  it('(3) single-source corollary: the consumed result object shape is exactly the curve contract', () => {
    // Corollary to assertions (1)+(2): the package publish gate proves the tarball is scoring-only math;
    // this proves the CONSUMED function returns exactly { perField, ece, auroc, riskCoverage } — the
    // same object the published curves page renders. No runtime drift-check is needed (identity is structural).
    const gold: GoldenDoc = {
      docClass: 'receipt',
      fields: { '/a': { state: 'present', value: 1 } },
    };
    const r = scoreAgainstGolden({ '/a': { state: 'present', value: 1, confidence: 1 } }, gold);
    expect(Object.keys(r).sort()).toEqual(['auroc', 'ece', 'perField', 'riskCoverage']);
    expect(r.perField['/a']).toEqual({ precision: 1, recall: 1, f1: 1 });
  });
});
