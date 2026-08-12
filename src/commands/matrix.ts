/**
 * `velrim-eval matrix` — run-matrix orchestrator + cost log. Composes the EXISTING verbs:
 * every cell is executed via the `run` command (checkpoint/resume/spend-gating per cell,
 * unchanged) and scored via the `score` command; the matrix never talks to a transport itself.
 * Sequential on purpose: paid cells are maintainer-supervised, and one arm's outage must never
 * interleave with another arm's spend. A failed/paused cell is recorded and the matrix moves
 * on — pausing an arm is pre-registered protocol, not discretion, and not a reason to block the other arms.
 *
 * Owns the runner's declared `matrix.authoritativeValidation` gap: after execution it
 * aggregates every cell manifest into matrix-manifest.json and computes publicationReady over
 * the WHOLE matrix (all cells completed + live + one clean commit + scoring 0.1.0 + every
 * per-cell gap resolved). Also writes cost-log.json — per-cell spend preflights and the
 * request and job IDs harvested from the run manifests (ANALYSIS-PLAN.md §8: "provider request
 * and job IDs retained and published").
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '../adapters/errors.js';
import { parseGoldenJsonl } from '../golden/loader.js';
import { MATRIX_HELP } from '../help.js';
import {
  buildMatrixPlan,
  validateMatrixConfig,
  type ConditionalExclusion,
  type MatrixCell,
  type MatrixConfig,
} from '../matrix/plan.js';
import { run } from './run.js';
import { score } from './score.js';

interface CellOutcome {
  cell: MatrixCell;
  status: 'completed' | 'failed_or_paused' | 'scoring_failed';
  runExit: number;
}

interface CorpusCountsFile {
  classes?: Record<string, { conditionalExclusions?: Array<{ doc: string }> }>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

/** Filter one committed golden down to the capped branch (frozen exclusions removed). */
function cappedGoldenText(committedText: string, excludedDocs: ReadonlySet<string>): string {
  const kept = committedText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const row = JSON.parse(line) as { doc?: string };
      return typeof row.doc !== 'string' || !excludedDocs.has(row.doc);
    });
  return kept.join('\n') + '\n';
}

export async function matrix(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        corpora: { type: 'string' },
        pdfs: { type: 'string' },
        out: { type: 'string' },
        live: { type: 'boolean' },
        'confirm-spend': { type: 'boolean' },
        'resume-paused': { type: 'boolean' },
        'recover-stale-lock': { type: 'boolean' },
        'allow-commit-drift': { type: 'boolean' },
        cell: { type: 'string', multiple: true },
        'plan-only': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(`matrix: ${errorMessage(error)}\n${MATRIX_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(MATRIX_HELP);
    return 0;
  }
  if (!values.config || !values.corpora || !values.out) {
    process.stderr.write('matrix: --config, --corpora and --out are all required\n');
    return 2;
  }
  const live = values.live === true;
  const corporaDir = resolve(values.corpora);
  const outDir = resolve(values.out);
  const pdfsDir = resolve(values.pdfs ?? join(corporaDir, 'pdfs'));

  let config: MatrixConfig;
  try {
    config = validateMatrixConfig(await readJson(resolve(values.config)));
  } catch (error) {
    process.stderr.write(`matrix: invalid config: ${errorMessage(error)}\n`);
    return 2;
  }

  // Load goldens (row counts feed spend math), the probe goldens when the probe pass is on,
  // and the frozen exclusions when the cap-confirmed branch needs them.
  const docCounts: Record<string, { main: number; probe: number }> = {};
  const goldenTexts = new Map<string, string>(); // committed golden path -> text (for derivation)
  try {
    for (const docClass of config.classes) {
      const mainPath = join(corporaDir, `golden.${docClass}.jsonl`);
      const mainText = await readFile(mainPath, 'utf8');
      goldenTexts.set(mainPath, mainText);
      const main = parseGoldenJsonl(mainText).length;
      let probe = 0;
      if (config.passes.includes('probe')) {
        const probePath = join(corporaDir, 'probes', `golden.${docClass}.probe.jsonl`);
        let probeText: string;
        try {
          probeText = await readFile(probePath, 'utf8');
        } catch {
          throw new Error(
            `missing probe golden for "${docClass}" — run \`probes-cli generate\` first`,
          );
        }
        goldenTexts.set(probePath, probeText);
        probe = parseGoldenJsonl(probeText).length;
      }
      docCounts[docClass] = { main, probe };
    }
  } catch (error) {
    process.stderr.write(`matrix: ${errorMessage(error)}\n`);
    return 2;
  }

  const conditionalExclusions: ConditionalExclusion[] = [];
  if (config.capBranch === 'cap-confirmed') {
    const counts = (await readJsonOrNull(
      join(corporaDir, 'corpus-counts.json'),
    )) as CorpusCountsFile | null;
    if (counts?.classes === undefined) {
      process.stderr.write(
        'matrix: capBranch=cap-confirmed needs corpus-counts.json (the frozen exclusions) in --corpora\n',
      );
      return 2;
    }
    for (const [docClass, entry] of Object.entries(counts.classes)) {
      if (!config.classes.includes(docClass)) continue;
      for (const exclusion of entry.conditionalExclusions ?? []) {
        conditionalExclusions.push({ docClass, doc: exclusion.doc });
      }
    }
  }

  let cells: MatrixCell[];
  try {
    cells = buildMatrixPlan({
      config,
      corporaDir,
      pdfsDir,
      outDir,
      live,
      docCounts,
      conditionalExclusions,
      passThroughArgs: [
        ...(values['confirm-spend'] === true ? ['--confirm-spend'] : []),
        ...(values['resume-paused'] === true ? ['--resume-paused'] : []),
        ...(values['recover-stale-lock'] === true ? ['--recover-stale-lock'] : []),
        ...(values['allow-commit-drift'] === true ? ['--allow-commit-drift'] : []),
      ],
    });
  } catch (error) {
    process.stderr.write(`matrix: ${errorMessage(error)}\n`);
    return 2;
  }

  // Optional cell filter (reruns of a single arm/class/pass without touching the rest).
  const cellFilter = values.cell;
  if (cellFilter !== undefined && cellFilter.length > 0) {
    const wanted = new Set(cellFilter);
    cells = cells.filter((cell) => wanted.has(cell.relativeDir));
    if (cells.length === 0) {
      process.stderr.write(
        `matrix: --cell matched nothing (expected <armMode>/<class>/<pass> from the plan)\n`,
      );
      return 2;
    }
  }

  // Derive the capped goldens BEFORE any cell runs (cap-confirmed only) — deterministic,
  // disclosed in the manifest, and byte-derived from the committed goldens.
  const excludedByClass = new Map<string, Set<string>>();
  for (const exclusion of conditionalExclusions) {
    const set = excludedByClass.get(exclusion.docClass);
    if (set === undefined) excludedByClass.set(exclusion.docClass, new Set([exclusion.doc]));
    else set.add(exclusion.doc);
  }
  if (config.capBranch === 'cap-confirmed' && excludedByClass.size > 0) {
    const derivedDir = join(outDir, 'derived');
    await mkdir(derivedDir, { recursive: true });
    for (const [docClass, excluded] of excludedByClass) {
      const mainPath = join(corporaDir, `golden.${docClass}.jsonl`);
      await writeFile(
        join(derivedDir, `golden.${docClass}.capped.jsonl`),
        cappedGoldenText(goldenTexts.get(mainPath)!, excluded),
      );
      if (config.passes.includes('probe')) {
        const probePath = join(corporaDir, 'probes', `golden.${docClass}.probe.jsonl`);
        await writeFile(
          join(derivedDir, `golden.${docClass}.probe.capped.jsonl`),
          cappedGoldenText(goldenTexts.get(probePath)!, excluded),
        );
      }
    }
  }

  process.stdout.write(
    `matrix: ${cells.length} cells (${config.armModes.length} arm-modes × ${config.classes.length} classes × ${config.passes.length} passes)\n`,
  );
  if (values['plan-only'] === true) {
    for (const cell of cells) {
      process.stdout.write(`  ${cell.relativeDir}: run ${cell.runArgs.join(' ')}\n`);
    }
    return 0;
  }

  // Execute + score, cell by cell.
  const outcomes: CellOutcome[] = [];
  for (const cell of cells) {
    process.stdout.write(`matrix: [${cell.relativeDir}] run\n`);
    const runExit = await run(cell.runArgs);
    if (runExit !== 0) {
      outcomes.push({ cell, status: 'failed_or_paused', runExit });
      process.stderr.write(
        `matrix: [${cell.relativeDir}] run exited ${runExit}; recorded, continuing with the other arms\n`,
      );
      continue;
    }
    const cellDir = join(outDir, cell.relativeDir);
    let scoringFailed = false;
    const repeatSummaries: Array<{ repeat: number; kind: string; corpus: unknown }> = [];
    for (const job of cell.scoring) {
      const scoreExit = await score([
        '--predictions',
        join(cellDir, job.predictionsFile),
        '--golden',
        job.goldenPath,
        '--out',
        join(cellDir, job.outDir),
      ]);
      if (scoreExit !== 0) {
        scoringFailed = true;
        process.stderr.write(`matrix: [${cell.relativeDir}] scoring ${job.outDir} failed\n`);
        continue;
      }
      const scores = (await readJson(join(cellDir, job.outDir, 'scores.json'))) as {
        corpus: unknown;
      };
      repeatSummaries.push({ repeat: job.repeat, kind: job.kind, corpus: scores.corpus });
    }
    // The per-class scores.json: per-repeat primary corpus stats + their mean (repeat noise
    // itself is the instability metric's job, reported separately — never folded in here).
    const primary = repeatSummaries.filter((s) => s.kind === 'primary');
    const metricKeys = ['precision', 'recall', 'f1', 'ece', 'brier', 'auroc'] as const;
    const mean: Record<string, number> = {};
    if (primary.length > 0) {
      for (const key of metricKeys) {
        mean[key] =
          primary.reduce((sum, s) => sum + (s.corpus as Record<string, number>)[key]!, 0) /
          primary.length;
      }
    }
    await writeFile(
      join(cellDir, 'scores.json'),
      JSON.stringify(
        {
          formatVersion: 1,
          cell: {
            armMode: cell.armMode,
            adapter: cell.adapter,
            docClass: cell.docClass,
            pass: cell.pass,
            repeats: cell.repeats,
          },
          excludedDocs: cell.excludedDocs,
          repeats: repeatSummaries,
          meanOverRepeats: mean,
        },
        null,
        2,
      ) + '\n',
    );
    outcomes.push({ cell, status: scoringFailed ? 'scoring_failed' : 'completed', runExit });
  }

  // Cost log — per-cell spend preflights + request-id receipts from the run manifests.
  const costRows: unknown[] = [];
  for (const { cell, status } of outcomes) {
    const cellDir = join(outDir, cell.relativeDir);
    const meta = (await readJsonOrNull(join(cellDir, 'run-meta.json'))) as Record<
      string,
      unknown
    > | null;
    const manifest = (await readJsonOrNull(join(cellDir, 'run-manifest.json'))) as {
      observedVersions?: { requestIds?: { values?: string[] } };
      run?: { fingerprint?: string };
    } | null;
    const health = (await readJsonOrNull(join(cellDir, 'run-health.json'))) as {
      aggregate?: unknown;
    } | null;
    costRows.push({
      cell: cell.relativeDir,
      armMode: cell.armMode,
      adapter: cell.adapter,
      docClass: cell.docClass,
      pass: cell.pass,
      status,
      spendPreflight: meta?.['spendPreflight'] ?? null,
      requestIds: manifest?.observedVersions?.requestIds?.values ?? [],
      fingerprint: manifest?.run?.fingerprint ?? null,
      availability: health?.aggregate ?? null,
    });
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, 'cost-log.json'),
    JSON.stringify(
      { formatVersion: 1, live, generatedAt: new Date().toISOString(), cells: costRows },
      null,
      2,
    ) + '\n',
  );

  // The authoritative matrix validation (the gap each single run declares it cannot close).
  const missingFields: string[] = [];
  const commits = new Set<string>();
  for (const { cell, status } of outcomes) {
    const prefix = `cells.${cell.relativeDir}`;
    if (status !== 'completed') {
      missingFields.push(`${prefix}.status=${status}`);
      continue;
    }
    const manifest = (await readJsonOrNull(
      join(outDir, cell.relativeDir, 'run-manifest.json'),
    )) as {
      missingFields?: string[];
      code?: { velrimEvalCommitSha?: string | null; worktreeDirty?: boolean | null };
    } | null;
    if (manifest === null) {
      missingFields.push(`${prefix}.run-manifest.json`);
      continue;
    }
    for (const gap of manifest.missingFields ?? []) {
      if (gap === 'matrix.authoritativeValidation') continue; // this IS that validation
      missingFields.push(`${prefix}.${gap}`);
    }
    if (typeof manifest.code?.velrimEvalCommitSha === 'string') {
      commits.add(manifest.code.velrimEvalCommitSha);
    }
  }
  if (commits.size > 1) missingFields.push('matrix.singleCommitAcrossCells');
  const manifestOut = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    live,
    config,
    conditionalExclusions,
    cells: outcomes.map(({ cell, status, runExit }) => ({
      cell: cell.relativeDir,
      status,
      runExit,
    })),
    validation: {
      owner: 'matrix-orchestrator',
      publicationReady: missingFields.length === 0,
      missingFields,
    },
  };
  await writeFile(
    join(outDir, 'matrix-manifest.json'),
    JSON.stringify(manifestOut, null, 2) + '\n',
  );

  const failed = outcomes.filter((o) => o.status !== 'completed');
  process.stdout.write(
    `matrix: ${outcomes.length - failed.length}/${outcomes.length} cells completed -> ${outDir} ` +
      `(cost-log.json, matrix-manifest.json; publicationReady=${missingFields.length === 0})\n`,
  );
  return failed.length === 0 ? 0 : 1;
}
