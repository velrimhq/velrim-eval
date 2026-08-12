/**
 * Fabrication-on-absent-fields judge (ANALYSIS-PLAN.md §7) — tool-independent, pre-registered
 * verbatim, symmetric across ALL arms including Velrim. No Velrim technology in the judge: no
 * anchoring, no SAP, no confidence enters the fabrication DECISION (the kicker reads confidence,
 * but only to report what the score was worth — never to decide what counts as a fabrication).
 * Every number here is re-derivable from published `predictions.jsonl` + goldens.
 *
 * The pre-registered rules, in one place:
 *  - HEADLINE rule: a golden-absent field answered with a SUBSTANTIVE value = one fabrication.
 *    Frozen abstention-equivalence set: explicit `null`, omitted key, `""`, whitespace-only
 *    strings, and the frozen case-insensitive token list below — with a per-field exclusion:
 *    a listed token that appears in that field's golden value vocabulary counts as substantive
 *    for that field, never as abstention.
 *  - STRICT sensitivity rule: any produced value that is not explicit `null` (or an omitted
 *    key) = fabrication — the same data under the harsher rule, printed adjacent.
 *  - Estimator: per-cell mean over N repeats, pooled; CIs doc-clustered (pooledMeanCI).
 *  - Denominator: the primary denominator counts absent cells only on
 *    contract-usable responses; a dual-accounting row (all attempted repeats, failures scored
 *    as abstentions) is computed alongside, next to availability.
 *  - Adjacency: gold-present ANSWER rate (equivalently, 1 − false-omission rate) is a
 *    column IN the fabrication table — an arm that abstains more fabricates less by
 *    construction, so the abstention cost prints in the same visual unit. "Answered" uses the
 *    SAME abstention-equivalence set (an "n/a" on a present field is an omission, not an
 *    answer); correctness is the accuracy section's job, not this column's.
 *  - Per-class floor: a per-class fabrication RATE exists only where natural absent-n
 *    ≥ FABRICATION_CLASS_FLOOR; below it the row carries n and no rate (render prints
 *    "n≤…; see probe table").
 *
 * Pure TS; the only imports are the runner's record type, the golden loader type, the stats
 * bootstrap, and @velrim/scoring's riskCoverage for the kicker's restricted curve.
 */

import { riskCoverage, type RiskCoveragePoint } from '@velrim/scoring';
import type { PredictionRecord } from '../run/checkpoint.js';
import type { LoadedGolden } from '../golden/loader.js';
import type { AdapterField } from '../adapters/types.js';
import { docKey } from '../run/checkpoint.js';
import { pooledMeanCI, type BootstrapCI } from '../stats/bootstrap.js';

/** The FROZEN case-insensitive abstention token list (ANALYSIS-PLAN.md §7.2). Changing it re-opens a locked rule. */
export const ABSTENTION_TOKENS = [
  'n/a',
  'not present',
  'not applicable',
  'none',
  'unknown',
] as const;

/** Pre-registered per-class floor: no per-class RATE below this natural absent-cell count. */
export const FABRICATION_CLASS_FLOOR = 20;

export type FabricationRule = 'headline' | 'strict';

/** Trim, lowercase, collapse internal whitespace — the token-matching normal form. */
export function normalizeAbstentionToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * THE per-field identity for the golden-vocabulary exclusion: the JSON Pointer with numeric
 * (array-index) segments wildcarded, so `/line_items/0/product` and `/line_items/7/product`
 * are the same FIELD. Mechanical — no per-field judgment calls.
 */
export function canonicalFieldId(pointer: string): string {
  return pointer
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? '*' : segment))
    .join('/');
}

/**
 * Per-field golden value vocabulary: for each canonical field id, the set of normalized STRING
 * values the goldens mark `present` anywhere in the corpus. A frozen abstention token found
 * here is a real value for that field (e.g. a literal "none" discount) and stays substantive.
 */
export function goldenValueVocabulary(goldens: readonly LoadedGolden[]): Map<string, Set<string>> {
  const vocabulary = new Map<string, Set<string>>();
  for (const row of goldens) {
    for (const [pointer, cell] of Object.entries(row.golden.fields)) {
      if (cell.state !== 'present' || typeof cell.value !== 'string') continue;
      const id = canonicalFieldId(pointer);
      let set = vocabulary.get(id);
      if (set === undefined) {
        set = new Set<string>();
        vocabulary.set(id, set);
      }
      set.add(normalizeAbstentionToken(cell.value));
    }
  }
  return vocabulary;
}

/**
 * The scoring rule, verbatim: is this produced leaf a SUBSTANTIVE value?
 * `undefined` means the key was omitted (abstention under both rules).
 */
export function isSubstantiveValue(
  field: AdapterField | undefined,
  fieldVocabulary: ReadonlySet<string> | undefined,
  rule: FabricationRule,
): boolean {
  if (field === undefined) return false; // omitted key
  const value = field.value;
  if (value === null) return false; // explicit null
  if (rule === 'strict') return true; // any other produced value
  if (typeof value === 'string') {
    const normalized = normalizeAbstentionToken(value);
    if (normalized.length === 0) return false; // "" and whitespace-only
    if (
      (ABSTENTION_TOKENS as readonly string[]).includes(normalized) &&
      !(fieldVocabulary?.has(normalized) ?? false)
    ) {
      return false; // frozen token, not in this field's golden vocabulary
    }
  }
  return true;
}

export interface RateWithCI {
  /** Pooled per-cell repeat-mean estimate. */
  estimate: number;
  /** 95% doc-clustered BCa interval (degenerate → estimate on both ends). */
  lo: number;
  hi: number;
  /** Cells in the denominator. */
  cells: number;
}

export interface ClassFabricationRow {
  docClass: string;
  /** Natural absent cells with at least one usable repeat. */
  absentCells: number;
  /** Present only where absentCells ≥ FABRICATION_CLASS_FLOOR — the floor is structural. */
  rate?: RateWithCI;
}

export interface AvailabilitySummary {
  attemptedDocRepeats: number;
  completedDocRepeats: number;
  availability: number | null;
}

export interface FabricationBreakout {
  rule: {
    abstentionTokens: readonly string[];
    classFloor: number;
    seed: number;
  };
  /** HEADLINE pooled rate — usable responses only (the primary denominator). */
  pooled: RateWithCI;
  /** STRICT sensitivity row — same cells, harsher rule. */
  strictPooled: RateWithCI;
  /** Dual accounting — ALL attempted repeats, failures scored as abstentions. */
  dualAccounting: RateWithCI;
  /** Gold-present ANSWER rate (1 − false-omission rate), same estimator, same table. */
  goldPresentAnswerRate: RateWithCI;
  availability: AvailabilitySummary;
  perClass: ClassFabricationRow[];
  /** Natural absent cells whose doc had NO usable repeat (excluded from the primary denominator). */
  excludedAbsentCells: number;
}

export interface FabricationInputs {
  /** Every prediction record of ONE arm-mode (all repeats, all classes). */
  records: readonly PredictionRecord[];
  /** The golden rows that drove the run (absent-cell set + vocabulary + doc set). */
  goldens: readonly LoadedGolden[];
  /** Published bootstrap seed (pre-registered). */
  seed: number;
  /** Bootstrap resamples — pre-registered run count is 10,000; tests use fewer. */
  resamples?: number;
}

interface CellSeries {
  doc: string;
  docClass: string;
  pointer: string;
  /** Per-usable-repeat substantive indicators (headline rule). */
  headline: number[];
  /** Per-usable-repeat substantive indicators (strict rule). */
  strict: number[];
  /** Per-ATTEMPTED-repeat indicators with failed repeats scored 0 (dual accounting). */
  dual: number[];
}

function groupRecords(records: readonly PredictionRecord[]): Map<string, PredictionRecord[]> {
  const byDoc = new Map<string, PredictionRecord[]>();
  for (const record of records) {
    const key = docKey(record.docClass, record.doc);
    const list = byDoc.get(key);
    if (list === undefined) byDoc.set(key, [record]);
    else list.push(record);
  }
  return byDoc;
}

function toRate(ci: BootstrapCI, cells: number): RateWithCI {
  return { estimate: ci.estimate, lo: ci.lo, hi: ci.hi, cells };
}

/** Doc-clustered pooled mean over per-cell repeat-means; degenerate empty input → null. */
function pooledRate(
  cells: ReadonlyArray<{ doc: string; docClass: string; mean: number }>,
  seed: number,
  resamples: number | undefined,
): RateWithCI | null {
  if (cells.length === 0) return null;
  const byDoc = new Map<string, number[]>();
  for (const cell of cells) {
    const key = docKey(cell.docClass, cell.doc);
    const list = byDoc.get(key);
    if (list === undefined) byDoc.set(key, [cell.mean]);
    else list.push(cell.mean);
  }
  const ci = pooledMeanCI([...byDoc.values()], {
    seed,
    ...(resamples === undefined ? {} : { resamples }),
  });
  return toRate(ci, cells.length);
}

const EMPTY_RATE: RateWithCI = { estimate: 0, lo: 0, hi: 0, cells: 0 };

/**
 * The fabrication breakout for one arm-mode. Pure and deterministic (seeded bootstrap); throws only on
 * structurally impossible input (a record for a doc the golden set does not know).
 */
export function fabricationBreakout(inputs: FabricationInputs): FabricationBreakout {
  const vocabulary = goldenValueVocabulary(inputs.goldens);
  const byDoc = groupRecords(inputs.records);
  for (const key of byDoc.keys()) {
    if (!inputs.goldens.some((row) => docKey(row.golden.docClass, row.doc) === key)) {
      throw new Error(`fabrication: prediction records reference unknown golden doc "${key}"`);
    }
  }

  const absentCells: CellSeries[] = [];
  const presentCells: CellSeries[] = [];
  let attempted = 0;
  let completed = 0;
  let excludedAbsentCells = 0;

  for (const row of inputs.goldens) {
    const records = byDoc.get(docKey(row.golden.docClass, row.doc)) ?? [];
    attempted += records.length;
    const usable = records.filter((record) => record.availability === 'completed');
    completed += usable.length;

    for (const [pointer, goldenCell] of Object.entries(row.golden.fields)) {
      const fieldVocabulary = vocabulary.get(canonicalFieldId(pointer));
      const series: CellSeries = {
        doc: row.doc,
        docClass: row.golden.docClass,
        pointer,
        headline: [],
        strict: [],
        dual: [],
      };
      for (const record of records) {
        const field =
          record.availability === 'completed' &&
          Object.prototype.hasOwnProperty.call(record.fields, pointer)
            ? record.fields[pointer]
            : undefined;
        const substantive = isSubstantiveValue(field, fieldVocabulary, 'headline');
        if (record.availability === 'completed') {
          series.headline.push(substantive ? 1 : 0);
          series.strict.push(isSubstantiveValue(field, fieldVocabulary, 'strict') ? 1 : 0);
        }
        // Dual accounting: a failed repeat contributes an abstention (0), never a value.
        series.dual.push(record.availability === 'completed' && substantive ? 1 : 0);
      }
      if (goldenCell.state === 'present') {
        if (series.headline.length > 0) presentCells.push(series);
      } else if (series.headline.length > 0) {
        absentCells.push(series);
      } else if (series.dual.length > 0) {
        excludedAbsentCells++;
        absentCells.push(series); // still in the dual-accounting denominator
      }
    }
  }

  const mean = (values: readonly number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length;

  const usableAbsent = absentCells.filter((cell) => cell.headline.length > 0);
  const pooled =
    pooledRate(
      usableAbsent.map((cell) => ({
        doc: cell.doc,
        docClass: cell.docClass,
        mean: mean(cell.headline),
      })),
      inputs.seed,
      inputs.resamples,
    ) ?? EMPTY_RATE;
  const strictPooled =
    pooledRate(
      usableAbsent.map((cell) => ({
        doc: cell.doc,
        docClass: cell.docClass,
        mean: mean(cell.strict),
      })),
      inputs.seed,
      inputs.resamples,
    ) ?? EMPTY_RATE;
  const dualCells = absentCells.filter((cell) => cell.dual.length > 0);
  const dualAccounting =
    pooledRate(
      dualCells.map((cell) => ({
        doc: cell.doc,
        docClass: cell.docClass,
        mean: mean(cell.dual),
      })),
      inputs.seed,
      inputs.resamples,
    ) ?? EMPTY_RATE;
  const goldPresentAnswerRate =
    pooledRate(
      presentCells.map((cell) => ({
        doc: cell.doc,
        docClass: cell.docClass,
        mean: mean(cell.headline),
      })),
      inputs.seed,
      inputs.resamples,
    ) ?? EMPTY_RATE;

  const classes = [...new Set(inputs.goldens.map((row) => row.golden.docClass))].sort();
  const perClass: ClassFabricationRow[] = classes.map((docClass) => {
    const cells = usableAbsent.filter((cell) => cell.docClass === docClass);
    const row: ClassFabricationRow = { docClass, absentCells: cells.length };
    if (cells.length >= FABRICATION_CLASS_FLOOR) {
      const rate = pooledRate(
        cells.map((cell) => ({
          doc: cell.doc,
          docClass: cell.docClass,
          mean: mean(cell.headline),
        })),
        inputs.seed,
        inputs.resamples,
      );
      if (rate !== null) row.rate = rate;
    }
    return row;
  });

  return {
    rule: {
      abstentionTokens: ABSTENTION_TOKENS,
      classFloor: FABRICATION_CLASS_FLOOR,
      seed: inputs.seed,
    },
    pooled,
    strictPooled,
    dualAccounting,
    goldPresentAnswerRate,
    availability: {
      attemptedDocRepeats: attempted,
      completedDocRepeats: completed,
      availability: attempted === 0 ? null : completed / attempted,
    },
    perClass,
    excludedAbsentCells,
  };
}

export interface FabricationKicker {
  /**
   * Mean confidence on the arm's OWN fabrications (per-cell repeat-mean over fabricated
   * repeats, pooled, doc-clustered CI) — null when the arm fabricated nothing or surfaced no
   * confidence on any fabrication.
   */
  meanConfidenceOnFabrications: RateWithCI | null;
  /**
   * Risk-coverage restricted to golden-absent cell-repeats that SURFACED a confidence:
   * correct = abstained (headline rule). No 0.5 imputation ever — repeats without a
   * surfaced confidence are excluded and counted below.
   */
  riskCoverage: RiskCoveragePoint[];
  points: number;
  pointsWithoutConfidence: number;
}

/** The kicker (ANALYSIS-PLAN.md §7.8) — "does the score know when it's inventing". Confidence-surfacing arms only. */
export function fabricationKicker(inputs: FabricationInputs): FabricationKicker {
  const vocabulary = goldenValueVocabulary(inputs.goldens);
  const byDoc = groupRecords(inputs.records);

  const confidenceCells: Array<{ doc: string; docClass: string; mean: number }> = [];
  const points: Array<{ confidence: number; correct: boolean }> = [];
  let pointsWithoutConfidence = 0;

  for (const row of inputs.goldens) {
    const usable = (byDoc.get(docKey(row.golden.docClass, row.doc)) ?? []).filter(
      (record) => record.availability === 'completed',
    );
    if (usable.length === 0) continue;
    for (const [pointer, goldenCell] of Object.entries(row.golden.fields)) {
      if (goldenCell.state === 'present') continue;
      const fieldVocabulary = vocabulary.get(canonicalFieldId(pointer));
      const fabricatedConfidences: number[] = [];
      for (const record of usable) {
        const field = Object.prototype.hasOwnProperty.call(record.fields, pointer)
          ? record.fields[pointer]
          : undefined;
        const substantive = isSubstantiveValue(field, fieldVocabulary, 'headline');
        const confidence = field?.confidence;
        if (confidence !== undefined) {
          points.push({ confidence, correct: !substantive });
          if (substantive) fabricatedConfidences.push(confidence);
        } else {
          pointsWithoutConfidence++;
          // A fabrication without a surfaced confidence still exists, but contributes no
          // kicker point — the count above discloses exactly how much the curve cannot see.
        }
      }
      if (fabricatedConfidences.length > 0) {
        confidenceCells.push({
          doc: row.doc,
          docClass: row.golden.docClass,
          mean: fabricatedConfidences.reduce((a, b) => a + b, 0) / fabricatedConfidences.length,
        });
      }
    }
  }

  const meanConfidenceOnFabrications =
    confidenceCells.length === 0
      ? null
      : pooledRate(confidenceCells, inputs.seed, inputs.resamples);

  return {
    meanConfidenceOnFabrications,
    riskCoverage: points.length === 0 ? [] : riskCoverage(points),
    points: points.length,
    pointsWithoutConfidence,
  };
}
