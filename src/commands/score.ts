/**
 * `velrim-eval score` (the heart) — predictions.jsonl x golden.jsonl -> scores.json.
 * NO model calls EVER. Per-doc scoreAgainstGolden (from @velrim/scoring) + corpus micro-average.
 *
 * predictions.jsonl rows are raw adapter output: { doc, fields: Record<ptr, {value; confidence?}> }.
 * We convert each to a ScoringField per the 3-state derivation:
 *   - explicit JSON null              -> { state: 'null' }
 *   - any other produced value        -> { state: 'present', value, confidence? }
 *     (empty string / whitespace counts as PRESENT — the model emitted something)
 *   - path absent in the prediction   -> key omitted -> scored as 'missing' (golden key set drives)
 */

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreAgainstGolden, type ScoringField } from '@velrim/scoring';
// The 3-state derivation is single-sourced by the adapter seam — reuse it, do NOT fork.
import { toScoringField, type AdapterField } from '../adapters/types.js';
// The composite (docClass, doc) identity is single-sourced with the runner's checkpoint keys.
import { docKey } from '../run/checkpoint.js';
import { parseGoldenJsonl } from '../golden/loader.js';
import { aggregateCorpus, type ScoredDocInput } from '../score/aggregate.js';
import {
  leafNormalizers,
  normalizerKindFor,
  parseNormalizerTable,
  type NormalizerTable,
} from '../score/normalizers.js';
import { SCORE_HELP } from '../help.js';

/** One column's corpus micro-average (identical shape for the strict and normalized columns). */
export interface CorpusMetrics {
  docs: number;
  leaves: number;
  cells: { tp: number; fp: number; fn: number };
  precision: number;
  recall: number;
  f1: number;
  ece: number;
  brier: number;
  auroc: number;
  riskCoverage: { coverage: number; error: number }[];
}

/** One column's per-doc metrics (from scoreAgainstGolden). */
interface PerDocMetrics {
  perField: Record<string, { precision: number; recall: number; f1: number }>;
  ece: number;
  auroc: number;
}

/**
 * The on-disk scores.json contract shared by score -> report -> ci.
 *
 * BACK-COMPAT PLEDGE (FD-10): `corpus`, `points`, and the per-doc top-level metrics are the
 * STRICT column and stay byte-identical whether or not --normalizers is given — existing
 * version-1 consumers (report/ci/calibrate/curves) keep reading them unchanged. The normalized
 * column (the PRIMARY publication column, ANALYSIS-PLAN.md §5.1) is the additive `normalized`
 * block + per-doc `normalized` sub-objects, present only when a table was supplied.
 */
export interface ScoresFile {
  version: 1;
  corpus: CorpusMetrics;
  /** pooled (confidence, correct) points — so report/ci need not re-read predictions. */
  points: { confidence: number; correct: boolean }[];
  /** FD-10 normalized column (primary at publication; strict adjacent). */
  normalized?: {
    docClass: string;
    /** sha256 over the exact bytes of the normalizers table file (frozen-plan provenance). */
    tableSha256: string;
    corpus: CorpusMetrics;
    points: { confidence: number; correct: boolean }[];
  };
  perDoc: Array<
    {
      doc: string;
      normalized?: PerDocMetrics;
    } & PerDocMetrics
  >;
}

/** Raw adapter prediction row as written by `run`. */
interface PredRow {
  doc: string;
  docClass?: string;
  fields: Record<string, AdapterField>;
}

function parsePredictions(text: string): Map<string, Record<string, ScoringField>> {
  const byDoc = new Map<string, Record<string, ScoringField>>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`predictions line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    const r = row as Partial<PredRow>;
    if (typeof r.doc !== 'string' || typeof r.fields !== 'object' || r.fields === null) {
      throw new Error(`predictions line ${i + 1}: expected { doc, fields }`);
    }
    const pred: Record<string, ScoringField> = {};
    for (const key of Object.keys(r.fields)) {
      pred[key] = toScoringField(r.fields[key]!);
    }
    const key = typeof r.docClass === 'string' ? docKey(r.docClass, r.doc) : r.doc;
    if (byDoc.has(key)) {
      throw new Error(`predictions line ${i + 1}: duplicate prediction identity`);
    }
    byDoc.set(key, pred);
  }
  return byDoc;
}

export async function score(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        predictions: { type: 'string' },
        golden: { type: 'string' },
        out: { type: 'string' },
        normalizers: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`score: ${(e as Error).message}\n${SCORE_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(SCORE_HELP);
    return 0;
  }
  if (!values.predictions || !values.golden || !values.out) {
    process.stderr.write('score: --predictions, --golden and --out are all required\n');
    return 2;
  }

  let goldenRows;
  let predByDoc;
  let table: NormalizerTable | undefined;
  let tableSha256: string | undefined;
  try {
    goldenRows = parseGoldenJsonl(await readFile(values.golden, 'utf8'));
    predByDoc = parsePredictions(await readFile(values.predictions, 'utf8'));
    if (values.normalizers !== undefined) {
      const tableBytes = await readFile(values.normalizers);
      table = parseNormalizerTable(tableBytes.toString('utf8'));
      tableSha256 = createHash('sha256').update(tableBytes).digest('hex');
    }
  } catch (e) {
    process.stderr.write(`score: ${(e as Error).message}\n`);
    return 2;
  }

  // FD-10 fail-closed: the frozen table is per-class; scoring a golden set with another class's
  // table would silently publish the wrong normalized column. Hard error, before any scoring.
  if (table !== undefined) {
    for (const row of goldenRows) {
      if (row.golden.docClass !== table.docClass) {
        process.stderr.write(
          `score: golden doc "${row.doc}" has docClass "${row.golden.docClass}" but the ` +
            `normalizers table is for docClass "${table.docClass}"\n`,
        );
        return 2;
      }
    }
  }

  const docInputs: ScoredDocInput[] = [];
  const perDoc: ScoresFile['perDoc'] = [];
  for (const row of goldenRows) {
    const pred = predByDoc.get(docKey(row.golden.docClass, row.doc)) ?? predByDoc.get(row.doc);
    if (pred === undefined) {
      process.stderr.write(`score: no predictions for golden doc "${row.doc}" (key mismatch)\n`);
      return 2;
    }
    const r = scoreAgainstGolden(pred, row.golden);
    const entry: ScoresFile['perDoc'][number] = {
      doc: row.doc,
      perField: r.perField,
      ece: r.ece,
      auroc: r.auroc,
    };
    if (table !== undefined) {
      const rn = scoreAgainstGolden(pred, row.golden, {
        normalizers: leafNormalizers(Object.keys(row.golden.fields), table),
      });
      entry.normalized = { perField: rn.perField, ece: rn.ece, auroc: rn.auroc };
    }
    perDoc.push(entry);
    docInputs.push({ doc: row.doc, pred, gold: row.golden });
  }

  const toCorpusMetrics = (agg: ReturnType<typeof aggregateCorpus>): CorpusMetrics => ({
    docs: agg.docs,
    leaves: agg.leaves,
    cells: agg.cells,
    precision: agg.corpusPrecision,
    recall: agg.corpusRecall,
    f1: agg.corpusF1,
    ece: agg.corpusECE,
    brier: agg.corpusBrier,
    auroc: agg.corpusAUROC,
    riskCoverage: agg.riskCoverage,
  });

  const agg = aggregateCorpus(docInputs);
  const scores: ScoresFile = {
    version: 1,
    corpus: toCorpusMetrics(agg),
    points: agg.points,
    perDoc,
  };
  let normalizedAgg: ReturnType<typeof aggregateCorpus> | undefined;
  if (table !== undefined) {
    const frozenTable = table;
    normalizedAgg = aggregateCorpus(docInputs, (pointer) =>
      normalizerKindFor(pointer, frozenTable),
    );
    scores.normalized = {
      docClass: frozenTable.docClass,
      tableSha256: tableSha256!,
      corpus: toCorpusMetrics(normalizedAgg),
      points: normalizedAgg.points,
    };
  }

  try {
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, 'scores.json'), JSON.stringify(scores, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`score: failed to write scores.json: ${(e as Error).message}\n`);
    return 2;
  }

  const normalizedNote =
    normalizedAgg === undefined
      ? ''
      : ` | normalized F1=${normalizedAgg.corpusF1.toFixed(4)} ECE=${normalizedAgg.corpusECE.toFixed(4)}`;
  process.stdout.write(
    `score: ${agg.docs} docs, ${agg.leaves} leaves -> corpus F1=${agg.corpusF1.toFixed(4)} ECE=${agg.corpusECE.toFixed(4)}${normalizedNote} -> ${join(values.out, 'scores.json')}\n`,
  );
  return 0;
}
