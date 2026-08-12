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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreAgainstGolden, type ScoringField } from '@velrim/scoring';
// The 3-state derivation is single-sourced by the adapter seam — reuse it, do NOT fork.
import { toScoringField, type AdapterField } from '../adapters/types.js';
// The composite (docClass, doc) identity is single-sourced with the runner's checkpoint keys.
import { docKey } from '../run/checkpoint.js';
import { parseGoldenJsonl } from '../golden/loader.js';
import { aggregateCorpus, type ScoredDocInput } from '../score/aggregate.js';
import { SCORE_HELP } from '../help.js';

/** The on-disk scores.json contract shared by score -> report -> ci. */
export interface ScoresFile {
  version: 1;
  corpus: {
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
  };
  /** pooled (confidence, correct) points — so report/ci need not re-read predictions. */
  points: { confidence: number; correct: boolean }[];
  perDoc: Array<{
    doc: string;
    perField: Record<string, { precision: number; recall: number; f1: number }>;
    ece: number;
    auroc: number;
  }>;
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
  try {
    goldenRows = parseGoldenJsonl(await readFile(values.golden, 'utf8'));
    predByDoc = parsePredictions(await readFile(values.predictions, 'utf8'));
  } catch (e) {
    process.stderr.write(`score: ${(e as Error).message}\n`);
    return 2;
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
    perDoc.push({ doc: row.doc, perField: r.perField, ece: r.ece, auroc: r.auroc });
    docInputs.push({ doc: row.doc, pred, gold: row.golden });
  }

  const agg = aggregateCorpus(docInputs);
  const scores: ScoresFile = {
    version: 1,
    corpus: {
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
    },
    points: agg.points,
    perDoc,
  };

  try {
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, 'scores.json'), JSON.stringify(scores, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`score: failed to write scores.json: ${(e as Error).message}\n`);
    return 2;
  }

  process.stdout.write(
    `score: ${agg.docs} docs, ${agg.leaves} leaves -> corpus F1=${agg.corpusF1.toFixed(4)} ECE=${agg.corpusECE.toFixed(4)} -> ${join(values.out, 'scores.json')}\n`,
  );
  return 0;
}
