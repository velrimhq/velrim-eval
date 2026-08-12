/**
 * Fabrication judge — the pre-registered rules proven on synthetic fixtures: the frozen
 * abstention-equivalence set (with the per-field golden-vocabulary exclusion), the strict
 * sensitivity rule, the per-cell repeat-mean estimator, the usable-response denominator rule
 * with dual accounting, the per-class floor, the answer-rate adjacency, and the
 * kicker (mean confidence on own fabrications + restricted risk-coverage, no 0.5 imputation).
 */

import { describe, expect, it } from 'vitest';
import {
  ABSTENTION_TOKENS,
  FABRICATION_CLASS_FLOOR,
  canonicalFieldId,
  fabricationBreakout,
  fabricationKicker,
  goldenValueVocabulary,
  isSubstantiveValue,
  normalizeAbstentionToken,
} from '../src/fabrication/judge.js';
import {
  renderFabricationPerClassTable,
  renderFabricationTable,
  LABEL_PROVENANCE_DISCLAIMER,
} from '../src/report/fabrication.js';
import type { PredictionRecord } from '../src/run/checkpoint.js';
import type { LoadedGolden } from '../src/golden/loader.js';
import type { AdapterField } from '../src/adapters/types.js';

const SEED = 20260712;
const RESAMPLES = 200;

function golden(
  doc: string,
  docClass: string,
  fields: Record<string, { state: 'present' | 'null' | 'missing'; value?: unknown }>,
): LoadedGolden {
  return { doc, golden: { docClass, fields } } as LoadedGolden;
}

function record(
  doc: string,
  docClass: string,
  repeat: number,
  fields: Record<string, AdapterField>,
  availability: PredictionRecord['availability'] = 'completed',
): PredictionRecord {
  return {
    kind: 'prediction',
    doc,
    docClass,
    repeat,
    fields,
    availability,
    requestAttempts: 1,
    transportRetries: 0,
  };
}

describe('the frozen abstention-equivalence set (headline rule)', () => {
  const NO_VOCAB = new Set<string>();

  it('treats explicit null, omitted key, "", whitespace, and the frozen token list as abstention', () => {
    expect(isSubstantiveValue(undefined, NO_VOCAB, 'headline')).toBe(false); // omitted key
    expect(isSubstantiveValue({ value: null }, NO_VOCAB, 'headline')).toBe(false);
    expect(isSubstantiveValue({ value: '' }, NO_VOCAB, 'headline')).toBe(false);
    expect(isSubstantiveValue({ value: '   \t ' }, NO_VOCAB, 'headline')).toBe(false);
    for (const token of ABSTENTION_TOKENS) {
      expect(isSubstantiveValue({ value: token }, NO_VOCAB, 'headline')).toBe(false);
      expect(isSubstantiveValue({ value: token.toUpperCase() }, NO_VOCAB, 'headline')).toBe(false);
    }
    // Internal-whitespace variants normalize onto the frozen list.
    expect(isSubstantiveValue({ value: ' Not   Present ' }, NO_VOCAB, 'headline')).toBe(false);
  });

  it('counts real values as substantive — including numbers, objects, and non-listed strings', () => {
    expect(isSubstantiveValue({ value: 'ACME' }, NO_VOCAB, 'headline')).toBe(true);
    expect(isSubstantiveValue({ value: 0 }, NO_VOCAB, 'headline')).toBe(true);
    expect(isSubstantiveValue({ value: false }, NO_VOCAB, 'headline')).toBe(true);
    expect(isSubstantiveValue({ value: 'nil' }, NO_VOCAB, 'headline')).toBe(true); // not on the list
  });

  it('per-field exclusion: a listed token IN the golden vocabulary is substantive for that field', () => {
    const vocab = new Set(['none']);
    expect(isSubstantiveValue({ value: 'none' }, vocab, 'headline')).toBe(true);
    expect(isSubstantiveValue({ value: 'NONE' }, vocab, 'headline')).toBe(true);
    expect(isSubstantiveValue({ value: 'unknown' }, vocab, 'headline')).toBe(false); // not excluded
  });

  it('strict rule: any produced non-null value is a fabrication — "" and n/a included', () => {
    expect(isSubstantiveValue(undefined, NO_VOCAB, 'strict')).toBe(false);
    expect(isSubstantiveValue({ value: null }, NO_VOCAB, 'strict')).toBe(false);
    expect(isSubstantiveValue({ value: '' }, NO_VOCAB, 'strict')).toBe(true);
    expect(isSubstantiveValue({ value: 'n/a' }, NO_VOCAB, 'strict')).toBe(true);
  });

  it('normalize + canonical field id are mechanical', () => {
    expect(normalizeAbstentionToken('  Not\t\tPresent ')).toBe('not present');
    expect(canonicalFieldId('/line_items/0/product')).toBe('/line_items/*/product');
    expect(canonicalFieldId('/total')).toBe('/total');
  });

  it('golden vocabulary collects normalized present STRING values per canonical field', () => {
    const vocab = goldenValueVocabulary([
      golden('a.pdf', 'c', {
        '/discount': { state: 'present', value: 'None' },
        '/items/0/name': { state: 'present', value: 'Widget' },
        '/items/3/name': { state: 'present', value: 'Bolt' },
        '/tax': { state: 'missing' },
      }),
    ]);
    expect(vocab.get('/discount')).toEqual(new Set(['none']));
    expect(vocab.get('/items/*/name')).toEqual(new Set(['widget', 'bolt']));
    expect(vocab.has('/tax')).toBe(false);
  });
});

describe('fabricationBreakout — estimator, denominator rule, floor, adjacency', () => {
  it('per-cell repeat-mean, pooled: a cell fabricated on 1 of 2 usable repeats contributes 0.5', () => {
    const goldens = [
      golden('a.pdf', 'c1', {
        '/absent': { state: 'missing' },
        '/present': { state: 'present', value: 'X' },
      }),
    ];
    const records = [
      record('a.pdf', 'c1', 1, { '/absent': { value: 'made-up' }, '/present': { value: 'X' } }),
      record('a.pdf', 'c1', 2, { '/present': { value: 'X' } }), // abstained on /absent (omitted)
    ];
    const breakout = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(breakout.pooled.estimate).toBeCloseTo(0.5, 10);
    expect(breakout.pooled.cells).toBe(1);
    expect(breakout.goldPresentAnswerRate.estimate).toBeCloseTo(1, 10);
  });

  it('denominator rule: wholly-failed docs leave the primary denominator but join dual accounting', () => {
    const goldens = [
      golden('ok.pdf', 'c1', { '/absent': { state: 'missing' } }),
      golden('down.pdf', 'c1', { '/absent': { state: 'missing' } }),
    ];
    const records = [
      record('ok.pdf', 'c1', 1, { '/absent': { value: 'fabricated' } }),
      record('down.pdf', 'c1', 1, {}, 'contract_failure'),
    ];
    const breakout = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    // Primary: only ok.pdf's cell → rate 1.0; the outage never deflates it.
    expect(breakout.pooled.estimate).toBeCloseTo(1, 10);
    expect(breakout.pooled.cells).toBe(1);
    expect(breakout.excludedAbsentCells).toBe(1);
    // Dual accounting: both cells, the failed repeat scored as abstention → 0.5.
    expect(breakout.dualAccounting.cells).toBe(2);
    expect(breakout.dualAccounting.estimate).toBeCloseTo(0.5, 10);
    expect(breakout.availability.availability).toBeCloseTo(0.5, 10);
  });

  it('the strict sensitivity row diverges from the headline row on "" and frozen tokens', () => {
    const goldens = [
      golden('a.pdf', 'c1', { '/x': { state: 'missing' }, '/y': { state: 'missing' } }),
    ];
    const records = [record('a.pdf', 'c1', 1, { '/x': { value: '' }, '/y': { value: 'n/a' } })];
    const breakout = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(breakout.pooled.estimate).toBeCloseTo(0, 10); // both abstention-equivalent
    expect(breakout.strictPooled.estimate).toBeCloseTo(1, 10); // both strict fabrications
  });

  it('gold-present answer rate uses the SAME abstention set — an "n/a" answer is an omission', () => {
    const goldens = [
      golden('a.pdf', 'c1', {
        '/p1': { state: 'present', value: 'X' },
        '/p2': { state: 'present', value: 'Y' },
      }),
    ];
    const records = [
      record('a.pdf', 'c1', 1, { '/p1': { value: 'anything' }, '/p2': { value: 'n/a' } }),
    ];
    const breakout = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(breakout.goldPresentAnswerRate.estimate).toBeCloseTo(0.5, 10);
  });

  it('per-class floor: a class below the floor carries n and NO rate; at/above the floor a rate + CI', () => {
    const bigClassGoldens = Array.from({ length: FABRICATION_CLASS_FLOOR }, (_u, i) =>
      golden(`big-${i}.pdf`, 'big', { '/absent': { state: 'missing' } }),
    );
    const goldens = [
      ...bigClassGoldens,
      golden('small.pdf', 'small', { '/absent': { state: 'missing' } }),
    ];
    const records = [
      ...bigClassGoldens.map((row, i) =>
        record(row.doc, 'big', 1, i % 2 === 0 ? { '/absent': { value: 'v' } } : {}),
      ),
      record('small.pdf', 'small', 1, { '/absent': { value: 'v' } }),
    ];
    const breakout = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    const big = breakout.perClass.find((r) => r.docClass === 'big')!;
    const small = breakout.perClass.find((r) => r.docClass === 'small')!;
    expect(big.absentCells).toBe(FABRICATION_CLASS_FLOOR);
    expect(big.rate).toBeDefined();
    expect(big.rate!.estimate).toBeCloseTo(0.5, 10);
    expect(big.rate!.lo).toBeLessThanOrEqual(big.rate!.estimate);
    expect(big.rate!.hi).toBeGreaterThanOrEqual(big.rate!.estimate);
    expect(small.absentCells).toBe(1);
    expect(small.rate).toBeUndefined(); // structurally no rate below the floor
  });

  it('is deterministic per seed and throws on records for a doc the golden set does not know', () => {
    const goldens = [golden('a.pdf', 'c1', { '/absent': { state: 'missing' } })];
    const records = [record('a.pdf', 'c1', 1, { '/absent': { value: 'v' } })];
    const first = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    const second = fabricationBreakout({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(second).toEqual(first);
    expect(() =>
      fabricationBreakout({
        records: [record('ghost.pdf', 'c1', 1, {})],
        goldens,
        seed: SEED,
      }),
    ).toThrow(/unknown golden doc/);
  });
});

describe('fabricationKicker — does the score know when it is inventing', () => {
  it('mean confidence on own fabrications uses the per-cell repeat-mean; abstentions add correct points', () => {
    const goldens = [
      golden('a.pdf', 'c1', { '/x': { state: 'missing' }, '/y': { state: 'missing' } }),
    ];
    const records = [
      record('a.pdf', 'c1', 1, {
        '/x': { value: 'fab', confidence: 0.9 },
        '/y': { value: null, confidence: 0.2 }, // confident abstention → correct point
      }),
      record('a.pdf', 'c1', 2, {
        '/x': { value: 'fab', confidence: 0.7 },
        '/y': { value: null, confidence: 0.4 },
      }),
    ];
    const kicker = fabricationKicker({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(kicker.meanConfidenceOnFabrications).not.toBeNull();
    expect(kicker.meanConfidenceOnFabrications!.estimate).toBeCloseTo(0.8, 10); // (0.9+0.7)/2
    expect(kicker.points).toBe(4);
    expect(kicker.pointsWithoutConfidence).toBe(0);
    expect(kicker.riskCoverage.length).toBeGreaterThan(0);
  });

  it('never imputes 0.5: repeats without a surfaced confidence are excluded and counted', () => {
    const goldens = [golden('a.pdf', 'c1', { '/x': { state: 'missing' } })];
    const records = [record('a.pdf', 'c1', 1, { '/x': { value: 'fab' } })]; // no confidence
    const kicker = fabricationKicker({ records, goldens, seed: SEED, resamples: RESAMPLES });
    expect(kicker.meanConfidenceOnFabrications).toBeNull();
    expect(kicker.points).toBe(0);
    expect(kicker.pointsWithoutConfidence).toBe(1);
    expect(kicker.riskCoverage).toEqual([]);
  });
});

describe('fabrication renders — adjacency and floor are structural, disclaimers always print', () => {
  const armRow = {
    id: 'velrim',
    label: 'Velrim',
    ablationBlock: true,
    pooled: { value: 0.12, ci: [0.06, 0.2] as [number, number] },
    strict: { value: 0.15, ci: [0.08, 0.24] as [number, number] },
    goldPresentAnswerRate: { value: 0.91, ci: [0.88, 0.94] as [number, number] },
    dualAccounting: { value: 0.11, ci: [0.05, 0.19] as [number, number] },
    availability: 0.997,
    absentCells: 141,
    perClass: [
      {
        docClass: 'cord-v2',
        absentCells: 66,
        rate: { value: 0.1, ci: [0.04, 0.18] as [number, number] },
      },
      { docClass: 'deepform', absentCells: 1 }, // below the floor — no rate exists to print
    ],
  };

  it('the fabrication table prints rate + strict + answer rate + dual + availability + disclaimers', () => {
    const text = renderFabricationTable([armRow]);
    expect(text).toContain('gold-present answer rate');
    expect(text).toContain('dual accounting');
    expect(text).toContain('availability');
    expect(text).toContain('0.120 [0.060–0.200]');
    expect(text).toContain(LABEL_PROVENANCE_DISCLAIMER);
    expect(text).toContain('▸ Velrim'); // ablation-block marker
  });

  it('the per-class table renders the floor cell as a pointer to the probe table, never a rate', () => {
    const text = renderFabricationPerClassTable([armRow], ['cord-v2', 'deepform']);
    expect(text).toContain('n=1; see probe table');
    expect(text).toContain('0.100 [0.040–0.180] (n=66)');
    expect(text).toContain(String(FABRICATION_CLASS_FLOOR));
  });
});
