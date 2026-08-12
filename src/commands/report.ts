/**
 * `velrim-eval report` — render per-field/corpus P/R/F1 + ECE/AUROC/Brier + a
 * reliability/risk-coverage SVG from scores.json. Optional --baseline adds a delta column.
 * Pure presentation: every number comes from scores.json (computed by @velrim/scoring). No math here.
 * smoothECE is not computed here.
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderTable, renderReliabilitySvg, type ReportMetrics } from '../report/render.js';
import type { ScoresFile } from './score.js';
import { REPORT_HELP } from '../help.js';

function toMetrics(s: ScoresFile): ReportMetrics {
  return {
    corpusPrecision: s.corpus.precision,
    corpusRecall: s.corpus.recall,
    corpusF1: s.corpus.f1,
    corpusECE: s.corpus.ece,
    corpusBrier: s.corpus.brier,
    corpusAUROC: s.corpus.auroc,
    docs: s.corpus.docs,
    leaves: s.corpus.leaves,
  };
}

async function loadScores(path: string): Promise<ScoresFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as ScoresFile;
  if (raw.version !== 1 || typeof raw.corpus !== 'object') {
    throw new Error(`${path}: not a recognized scores.json (version 1)`);
  }
  return raw;
}

export async function report(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        scores: { type: 'string' },
        baseline: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`report: ${(e as Error).message}\n${REPORT_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(REPORT_HELP);
    return 0;
  }
  if (!values.scores) {
    process.stderr.write('report: --scores is required\n');
    return 2;
  }

  let scores: ScoresFile;
  let baseline: ScoresFile | undefined;
  try {
    scores = await loadScores(values.scores);
  } catch (e) {
    process.stderr.write(`report: ${(e as Error).message}\n`);
    return 2;
  }
  if (values.baseline) {
    try {
      baseline = await loadScores(values.baseline);
    } catch (e) {
      process.stderr.write(`report: ${(e as Error).message}\n`);
      return 2;
    }
  }

  const table = renderTable(
    'corpus',
    toMetrics(scores),
    baseline ? toMetrics(baseline) : undefined,
  );
  process.stdout.write(table + '\n');

  const svg = renderReliabilitySvg(scores.points, scores.corpus.riskCoverage);
  const outDir = values.out ?? dirname(values.scores);
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'reliability.svg'), svg);
    await writeFile(join(outDir, 'report.txt'), table + '\n');
  } catch (e) {
    process.stderr.write(`report: failed to write report artifacts: ${(e as Error).message}\n`);
    return 2;
  }
  process.stdout.write(`report: wrote ${join(outDir, 'reliability.svg')} + report.txt\n`);
  return 0;
}
