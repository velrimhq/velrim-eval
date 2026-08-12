/**
 * `velrim-eval curves` — reliability-diagram data + ECE + Brier + AUROC +
 * risk-coverage + the full-vs-logprobFree ABLATION row, computed ENTIRELY via `@velrim/scoring`
 * from a scored manifest. This is the SCORING half of the published-curves pipeline; the
 * publish/page half is out of scope here (we emit the curve DATA as JSON, not a rendered page).
 *
 * The `--manifest` is a small JSON that points at one or more pre-scored variant point-sets:
 *   {
 *     "label": "cord-v2",                 // optional, for the artifact
 *     "link": "corpora/manifests/...",    // optional provenance link, echoed verbatim
 *     "variants": {
 *       "logprobFree": "<path to a scores.json>",   // the PUBLISHED FLOOR — required
 *       "full":        "<path to a scores.json>"     // the ablation arm — optional
 *     }
 *   }
 * Each referenced file is a `scores.json` (from `velrim-eval score`) carrying the pooled
 * `(confidence, correct)` points. We re-derive every metric from those points via `@velrim/scoring`
 * — NEVER re-implemented here.
 *
 * Ablation honesty: the full-vs-logprobFree row is meaningful ONLY when the two arms
 * differ. On logprob-less corpora (the common fixture case) `full == logprobFree` byte-identical —
 * we then mark the ablation `"degenerate / not-published"` rather than a duplicated number implying
 * a logprob lift that does not exist.
 *
 * Guardrail preserved: absent/empty input → NO number, exit non-zero (3). `--allow-stub` exits 0
 * for pipeline wiring only. A real curve is emitted ONLY when given real points.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  riskCoverage,
  expectedCalibrationError,
  brier,
  auroc,
  type CalibrationPoint,
  type RiskCoveragePoint,
} from '@velrim/scoring';
import { reliabilityBins, type ReliabilityBin } from '../calibrate/platt.js';
import { CURVES_HELP } from '../help.js';

interface ManifestFile {
  label?: string;
  link?: string;
  variants?: { logprobFree?: string; full?: string };
}

interface VariantCurve {
  n: number;
  ece: number;
  brier: number;
  auroc: number;
  reliability: ReliabilityBin[];
  riskCoverage: RiskCoveragePoint[];
}

/** Read a scores.json's pooled (confidence, correct) column. Throws on malformed shape. */
async function readVariantPoints(path: string): Promise<CalibrationPoint[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null)
    throw new Error(`${path}: expected a scores.json object`);
  const pts = (raw as { points?: unknown }).points;
  if (pts === undefined) return [];
  if (!Array.isArray(pts)) throw new Error(`${path}: "points" must be an array`);
  const out: CalibrationPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as { confidence?: unknown; correct?: unknown };
    if (
      typeof p?.confidence !== 'number' ||
      !Number.isFinite(p.confidence) ||
      typeof p?.correct !== 'boolean'
    ) {
      throw new Error(
        `${path}: points[${i}] must be { confidence: finite number, correct: boolean }`,
      );
    }
    out.push({ confidence: p.confidence, correct: p.correct });
  }
  return out;
}

/** Compose ALL metrics off one variant's points — every number from @velrim/scoring. */
function curveFor(points: CalibrationPoint[]): VariantCurve {
  return {
    n: points.length,
    ece: expectedCalibrationError(points),
    brier: brier(points),
    auroc: auroc(points),
    reliability: reliabilityBins(points),
    riskCoverage: riskCoverage(points),
  };
}

/** Byte-identical points → the two ablation arms coincide (logprob-less corpora). */
function pointsIdentical(a: CalibrationPoint[], b: CalibrationPoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.confidence !== b[i]!.confidence || a[i]!.correct !== b[i]!.correct) return false;
  }
  return true;
}

export async function curves(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        manifest: { type: 'string' },
        'allow-stub': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`curves: ${(e as Error).message}\n${CURVES_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(CURVES_HELP);
    return 0;
  }
  if (!values.manifest) {
    process.stderr.write('curves: --manifest is required\n');
    return 2;
  }

  let manifest: ManifestFile;
  try {
    const raw = JSON.parse(await readFile(values.manifest, 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('expected a manifest object');
    manifest = raw as ManifestFile;
  } catch (e) {
    process.stderr.write(`curves: ${values.manifest}: ${(e as Error).message}\n`);
    return 2;
  }

  // The logprobFree variant is the PUBLISHED FLOOR — it drives the curve. Required.
  const lpFreePath = manifest.variants?.logprobFree;
  if (!lpFreePath) {
    process.stderr.write(
      'curves: manifest.variants.logprobFree (a scores.json path) is required\n',
    );
    return 2;
  }
  // Resolve variant paths relative to the manifest file's directory.
  const base = dirname(resolve(values.manifest));

  let lpFreePoints: CalibrationPoint[];
  let fullPoints: CalibrationPoint[] | undefined;
  try {
    lpFreePoints = await readVariantPoints(resolve(base, lpFreePath));
    if (manifest.variants?.full)
      fullPoints = await readVariantPoints(resolve(base, manifest.variants.full));
  } catch (e) {
    process.stderr.write(`curves: ${(e as Error).message}\n`);
    return 2;
  }

  // GUARDRAIL: no points → NO curve, exit non-zero.
  if (lpFreePoints.length === 0) {
    process.stdout.write(
      'curves: no (confidence, correct) points in the logprobFree variant. No curve emitted (nothing to score).\n',
    );
    if (values['allow-stub']) return 0;
    return 3;
  }

  const logprobFree = curveFor(lpFreePoints);
  const full = fullPoints && fullPoints.length > 0 ? curveFor(fullPoints) : undefined;

  // ABLATION HONESTY: the row is meaningful only when full differs from logprobFree. On logprob-less
  // corpora the two arms coincide → flag degenerate, never imply a non-existent logprob lift.
  let ablation:
    | { status: 'degenerate / not-published'; reason: string }
    | { status: 'measured'; aurocDelta: number; eceDelta: number; brierDelta: number };
  if (full === undefined) {
    ablation = {
      status: 'degenerate / not-published',
      reason:
        'no full variant supplied (manifest.variants.full absent); logprobFree is the only arm',
    };
  } else if (fullPoints && pointsIdentical(lpFreePoints, fullPoints)) {
    ablation = {
      status: 'degenerate / not-published',
      reason:
        'full and logprobFree points are byte-identical (corpus carries no logprobs); ablation not measurable',
    };
  } else {
    ablation = {
      status: 'measured',
      aurocDelta: full.auroc - logprobFree.auroc,
      eceDelta: full.ece - logprobFree.ece,
      brierDelta: full.brier - logprobFree.brier,
    };
  }

  const result = {
    version: 1 as const,
    label: manifest.label ?? null,
    manifestLink: manifest.link ?? null,
    // The published floor is the headline curve.
    logprobFree,
    full: full ?? null,
    ablation,
    // The page/publish half is a separate deliverable — this is the scoring half only.
    publish: 'scoring half only; no page rendered here',
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(
    `curves: logprobFree n=${logprobFree.n} AUROC=${logprobFree.auroc.toFixed(4)} ECE=${logprobFree.ece.toFixed(4)} ` +
      `Brier=${logprobFree.brier.toFixed(4)}; ablation=${ablation.status}\n`,
  );
  return 0;
}
