/**
 * `velrim-eval fabrication` — judge predictions against a golden set for fabrication on absent
 * fields (ANALYSIS-PLAN.md §7) -> fabrication.json. NO model calls. Every number comes from
 * `src/fabrication/judge.ts`; this verb only reads files and writes the breakout.
 */

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FABRICATION_HELP } from '../help.js';
import {
  fabricationBreakout,
  fabricationKicker,
  type FabricationBreakout,
  type FabricationKicker,
} from '../fabrication/judge.js';
import {
  applyStrikes,
  armPredictionPaths,
  corporaGoldenPaths,
  readGoldens,
  readPredictions,
  readStrikes,
  type Pass,
} from '../fabrication/inputs.js';

/** Published bootstrap seed and resample count (ANALYSIS-PLAN.md §10). */
export const DEFAULT_SEED = 20260712;
export const DEFAULT_RESAMPLES = 10_000;

export interface FabricationFile {
  version: 1;
  pass: Pass;
  inputs: { predictions: string[]; goldens: string[]; strikes: string | null; struck: number };
  seed: number;
  resamples: number;
  breakout: FabricationBreakout;
  /** Present only when at least one judged repeat surfaced a confidence. */
  kicker?: FabricationKicker;
}

export async function fabrication(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        predictions: { type: 'string', multiple: true },
        golden: { type: 'string', multiple: true },
        'arm-dir': { type: 'string' },
        corpora: { type: 'string' },
        pass: { type: 'string' },
        strikes: { type: 'string' },
        seed: { type: 'string' },
        resamples: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`fabrication: ${(e as Error).message}\n${FABRICATION_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(FABRICATION_HELP);
    return 0;
  }
  const pass = (values.pass ?? 'main') as Pass;
  if (pass !== 'main' && pass !== 'probe') {
    process.stderr.write('fabrication: --pass must be main or probe\n');
    return 2;
  }
  const hasFiles = (values.predictions?.length ?? 0) > 0 && (values.golden?.length ?? 0) > 0;
  const hasDirs = values['arm-dir'] !== undefined && values.corpora !== undefined;
  if (!values.out || (!hasFiles && !hasDirs)) {
    process.stderr.write(
      'fabrication: --out plus either (--predictions + --golden) or (--arm-dir + --corpora) are required\n',
    );
    return 2;
  }
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  const resamples = values.resamples === undefined ? DEFAULT_RESAMPLES : Number(values.resamples);
  if (!Number.isInteger(seed) || !Number.isInteger(resamples) || resamples < 1) {
    process.stderr.write('fabrication: --seed and --resamples must be integers\n');
    return 2;
  }

  let file: FabricationFile;
  try {
    const predictionPaths = hasFiles
      ? values.predictions!
      : await armPredictionPaths(values['arm-dir']!, pass);
    const goldenPaths = hasFiles ? values.golden! : await corporaGoldenPaths(values.corpora!, pass);
    let goldens = await readGoldens(goldenPaths);
    let struck = 0;
    if (values.strikes !== undefined) {
      const strikes = await readStrikes(values.strikes);
      const before = goldens.reduce((n, g) => n + Object.keys(g.golden.fields).length, 0);
      goldens = applyStrikes(goldens, strikes);
      struck = before - goldens.reduce((n, g) => n + Object.keys(g.golden.fields).length, 0);
    }
    const records = await readPredictions(predictionPaths);
    const inputs = { records, goldens, seed, resamples };
    const breakout = fabricationBreakout(inputs);
    const anyConfidence = records.some((r) =>
      Object.values(r.fields).some((f) => typeof f.confidence === 'number'),
    );
    file = {
      version: 1,
      pass,
      inputs: {
        predictions: predictionPaths,
        goldens: goldenPaths,
        strikes: values.strikes ?? null,
        struck,
      },
      seed,
      resamples,
      breakout,
      ...(anyConfidence ? { kicker: fabricationKicker(inputs) } : {}),
    };
  } catch (e) {
    process.stderr.write(`fabrication: ${(e as Error).message}\n`);
    return 2;
  }

  try {
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, 'fabrication.json'), JSON.stringify(file, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(
      `fabrication: failed to write fabrication.json: ${(e as Error).message}\n`,
    );
    return 2;
  }

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const b = file.breakout;
  process.stdout.write(
    `fabrication (${pass}): ${pct(b.pooled.estimate)} [${pct(b.pooled.lo)}, ${pct(b.pooled.hi)}] ` +
      `n=${b.pooled.cells} | all-attempted ${pct(b.dualAccounting.estimate)} | strict ${pct(b.strictPooled.estimate)} | ` +
      `answered when present ${pct(b.goldPresentAnswerRate.estimate)} | ` +
      `${b.availability.completedDocRepeats}/${b.availability.attemptedDocRepeats} completed -> ` +
      `${join(values.out, 'fabrication.json')}\n`,
  );
  return 0;
}
