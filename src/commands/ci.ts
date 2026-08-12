/**
 * `velrim-eval ci` — gate a scores.json against thresholds (and an optional
 * --baseline). The red build is the conversion event.
 *
 * Gate: pass = corpusF1 >= min-f1 AND corpusECE <= max-ece
 *       AND (with --baseline) NO regression beyond epsilon vs the baseline scores.json:
 *            corpus-F1 drop  > eps-f1  (default 0.005)  -> fail
 *            corpus-ECE rise > eps-ece (default 0.005)  -> fail
 *
 * Exit: 0 pass / 1 gate fail / 2 usage|IO. A non-finite threshold (e.g. NaN) -> 2.
 * One-line greppable verdict to stdout; the failing-metric breakdown to stderr.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { ScoresFile } from './score.js';
import { CI_HELP } from '../help.js';

const DEFAULT_EPS_F1 = 0.005;
const DEFAULT_EPS_ECE = 0.005;

/**
 * Coerce a required numeric flag; returns NaN on absent/garbage so the caller can exit 2.
 * Only a canonical decimal literal is accepted — `''`, whitespace, hex (`0x10`), exponent
 * (`1e2`), `Infinity`, etc. all route to NaN so a blank/templated CI var can NEVER coerce to a
 * silent 0 threshold (which would green-light everything).
 */
function num(v: string | undefined): number {
  if (v === undefined) return NaN;
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return NaN;
  return Number(v);
}

async function loadScores(path: string): Promise<ScoresFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as ScoresFile;
  if (raw.version !== 1 || typeof raw.corpus !== 'object' || raw.corpus === null) {
    throw new Error(`${path}: not a recognized scores.json (version 1)`);
  }
  if (typeof raw.corpus.f1 !== 'number' || typeof raw.corpus.ece !== 'number') {
    throw new Error(`${path}: scores.json missing corpus.f1 / corpus.ece`);
  }
  return raw;
}

export async function ci(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        scores: { type: 'string' },
        'min-f1': { type: 'string' },
        'max-ece': { type: 'string' },
        baseline: { type: 'string' },
        'eps-f1': { type: 'string' },
        'eps-ece': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`ci: ${(e as Error).message}\n${CI_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(CI_HELP);
    return 0;
  }

  if (values.scores === undefined || values.scores.trim() === '') {
    process.stderr.write('ci: --scores is required\n');
    return 2;
  }
  const minF1 = num(values['min-f1']);
  const maxEce = num(values['max-ece']);
  if (!Number.isFinite(minF1) || !Number.isFinite(maxEce)) {
    process.stderr.write('ci: --min-f1 and --max-ece must both be finite numbers\n');
    return 2;
  }
  // epsilons only matter with a baseline, but validate them eagerly if supplied.
  const epsF1 = values['eps-f1'] !== undefined ? num(values['eps-f1']) : DEFAULT_EPS_F1;
  const epsEce = values['eps-ece'] !== undefined ? num(values['eps-ece']) : DEFAULT_EPS_ECE;
  if (!Number.isFinite(epsF1) || !Number.isFinite(epsEce)) {
    process.stderr.write('ci: --eps-f1 and --eps-ece must be finite numbers\n');
    return 2;
  }

  let scores: ScoresFile;
  try {
    scores = await loadScores(values.scores);
  } catch (e) {
    process.stderr.write(`ci: ${(e as Error).message}\n`);
    return 2;
  }

  const f1 = scores.corpus.f1;
  const ece = scores.corpus.ece;
  const failures: string[] = [];

  if (f1 < minF1) failures.push(`F1 ${f1.toFixed(4)} < min-f1 ${minF1}`);
  if (ece > maxEce) failures.push(`ECE ${ece.toFixed(4)} > max-ece ${maxEce}`);

  // Distinguish 'flag absent' (threshold-only gate, fine) from 'flag present but empty' (a
  // templated `--baseline "$PREV"` with an unset var) — the latter must NOT silently downgrade
  // the no-regression half of the gate to a no-op (the gate is threshold AND no-regression).
  if (values.baseline !== undefined) {
    if (values.baseline.trim() === '') {
      process.stderr.write('ci: --baseline path is empty\n');
      return 2;
    }
    let base: ScoresFile;
    try {
      base = await loadScores(values.baseline);
    } catch (e) {
      process.stderr.write(`ci: baseline ${(e as Error).message}\n`);
      return 2;
    }
    const f1Drop = base.corpus.f1 - f1;
    const eceRise = ece - base.corpus.ece;
    if (f1Drop > epsF1) {
      failures.push(
        `F1 regression: dropped ${f1Drop.toFixed(4)} (> eps-f1 ${epsF1}) vs baseline ${base.corpus.f1.toFixed(4)}`,
      );
    }
    if (eceRise > epsEce) {
      failures.push(
        `ECE regression: rose ${eceRise.toFixed(4)} (> eps-ece ${epsEce}) vs baseline ${base.corpus.ece.toFixed(4)}`,
      );
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`ci: FAIL — corpus F1=${f1.toFixed(4)} ECE=${ece.toFixed(4)}\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    return 1;
  }

  process.stdout.write(
    `ci: PASS — corpus F1=${f1.toFixed(4)} (>= ${minF1}) ECE=${ece.toFixed(4)} (<= ${maxEce})\n`,
  );
  return 0;
}
