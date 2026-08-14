/**
 * FD-10 dual-column aggregation: `aggregateCorpus` with a per-leaf kind lookup.
 *
 * The strict column is the no-argument call (unchanged semantics); the normalized column passes
 * a `kindFor` lookup and may only ADD matches on listed leaves — unlisted leaves stay strict
 * inside the very same aggregation. The correctness label feeding ECE/AUROC/risk-coverage flips
 * with the cells (it is the same isFieldCorrect call).
 */

import { describe, expect, it } from 'vitest';
import type { ValueNormalizer } from '@velrim/scoring';
import { aggregateCorpus, type ScoredDocInput } from '../src/score/aggregate.js';
import { normalizerKindFor, parseNormalizerTable } from '../src/score/normalizers.js';

const TABLE = parseNormalizerTable(
  JSON.stringify({
    docClass: 'invoice',
    normalizers: {
      '/amount': 'currency',
      '/issued': 'date',
      '/line_items/*/price': 'currency',
    },
  }),
);
const kindFor = (pointer: string): ValueNormalizer | undefined => normalizerKindFor(pointer, TABLE);

/** Two docs: every present pred differs from gold ONLY by formatting on listed leaves; the
 *  unlisted `/id` leaf differs by formatting too — and must stay wrong in BOTH columns. */
const DOCS: ScoredDocInput[] = [
  {
    doc: 'a.pdf',
    pred: {
      '/amount': { state: 'present', value: '$1,880.00', confidence: 0.9 },
      '/issued': { state: 'present', value: '02/07/2020', confidence: 0.8 },
      '/id': { state: 'present', value: ' X-1 ', confidence: 0.7 },
    },
    gold: {
      docClass: 'invoice',
      fields: {
        '/amount': { state: 'present', value: '1880' },
        '/issued': { state: 'present', value: '2020-02-07' },
        '/id': { state: 'present', value: 'X-1' },
      },
    },
  },
  {
    doc: 'b.pdf',
    pred: {
      '/amount': { state: 'null' },
      '/line_items/0/price': { state: 'present', value: '(2,000.00)', confidence: 0.6 },
    },
    gold: {
      docClass: 'invoice',
      fields: {
        '/amount': { state: 'missing' },
        '/line_items/0/price': { state: 'present', value: '-2000' },
      },
    },
  },
];

describe('aggregateCorpus dual columns (FD-10)', () => {
  it('strict column: formatting differences are FP+FN; absent-equivalence still holds', () => {
    const strict = aggregateCorpus(DOCS);
    // 4 present-vs-present formatting mismatches = 4 FP + 4 FN; the null-vs-missing leaf is a
    // correct negative (FD-8), contributing nothing.
    expect(strict.cells).toEqual({ tp: 0, fp: 4, fn: 4 });
    expect(strict.leaves).toBe(5);
    expect(strict.corpusF1).toBe(0);
    // Points: 5 golden leaves; only the null↔missing leaf is labeled correct.
    expect(strict.points).toHaveLength(5);
    expect(strict.points.filter((p) => p.correct)).toHaveLength(1);
  });

  it('normalized column: listed leaves flip to TP; the unlisted leaf stays strictly wrong', () => {
    const normalized = aggregateCorpus(DOCS, kindFor);
    // /amount (currency), /issued (date), /line_items/0/price (currency via wildcard) flip;
    // /id is unlisted → still FP+FN despite being only whitespace off.
    expect(normalized.cells).toEqual({ tp: 3, fp: 1, fn: 1 });
    expect(normalized.leaves).toBe(5);
    expect(normalized.points.filter((p) => p.correct)).toHaveLength(4);
    expect(normalized.corpusPrecision).toBe(0.75);
    expect(normalized.corpusRecall).toBe(0.75);
  });

  it('normalization only ever ADDS matches: every strict-correct point stays correct', () => {
    const strict = aggregateCorpus(DOCS);
    const normalized = aggregateCorpus(DOCS, kindFor);
    for (let i = 0; i < strict.points.length; i++) {
      if (strict.points[i]!.correct) expect(normalized.points[i]!.correct).toBe(true);
    }
    expect(normalized.cells.tp).toBeGreaterThanOrEqual(strict.cells.tp);
  });

  it('confidences are untouched by the column choice (same points, different labels)', () => {
    const strict = aggregateCorpus(DOCS);
    const normalized = aggregateCorpus(DOCS, kindFor);
    expect(normalized.points.map((p) => p.confidence)).toEqual(
      strict.points.map((p) => p.confidence),
    );
  });
});
