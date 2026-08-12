/**
 * Run-matrix planning (pure) — arm-modes × classes × repeats × {main, probe}.
 *
 * The matrix NEVER re-implements running or scoring: each planned cell is an argv for the
 * existing `run` command (checkpointed, resumable, spend-gated per cell) and a set of scoring
 * jobs for the existing `score` command — the maintainer could replay any cell by hand with the
 * exact printed arguments. Deliberate exclusions, pre-registered:
 *
 *  - Every CAL-FIT refit pass is OUT (pre-registered: refit columns are a phase-2 item, ANALYSIS-PLAN.md §15) — 'main' and 'probe' are the only pass kinds
 *    this planner accepts; a config naming a refit pass fails validation loudly.
 *  - Velrim is ONE arm-mode (main + probe, like every other arm — ANALYSIS-PLAN.md §6.2): the
 *    served product, live-asserted by `run --live` to carry a minted fitted calibrator stamp
 *    on every response. No pass concept exists here.
 *
 * Cap-branch mechanics (ANALYSIS-PLAN.md §4.3 — the smoke resolves the branch; the planner just obeys it):
 *  - cap-removed: every arm runs the full class golden; the guard is disarmed but recorded.
 *  - cap-confirmed: over-cap docs (the FROZEN conditional exclusions in corpus-counts.json)
 *    leave the PRIMARY contrasts for ALL arms — mistral cells RUN on a derived capped golden
 *    (an over-cap doc must never reach the armed adapter), non-mistral cells still run all
 *    docs but score PRIMARY against the derived capped golden, with the all-docs numbers as a
 *    labeled appendix scoring (the "you dropped documents" answer).
 *  - unresolved: fixture planning only — a LIVE mistral cell before the smoke is a protocol
 *    error and fails planning.
 */

import type { EvalAdapterId } from '../adapters/types.js';

export const MATRIX_PASSES = ['main', 'probe'] as const;
export type MatrixPass = (typeof MATRIX_PASSES)[number];

export type MatrixCapBranch = 'unresolved' | 'cap-confirmed' | 'cap-removed';

const ADAPTERS: readonly EvalAdapterId[] = [
  'velrim',
  'openai',
  'llamaextract',
  'mistral',
  'gemini',
];

/** Flags the matrix owns per cell; an armMode smuggling one in would silently fork the plan. */
const RESERVED_EXTRA_ARGS = [
  '--golden',
  '--docs',
  '--out',
  '--adapter',
  '--repeat',
  '--live',
  '--confirm-spend',
  '--resume-paused',
  '--recover-stale-lock',
  '--allow-commit-drift',
  '--mistral-cap-branch',
  '--expected-spend-usd',
  '--pricing-basis',
  '--pricing-as-of',
  '--cal-test-manifest',
  '--cal-test-golden-hash',
  '--commit-sha',
];

export interface MatrixArmMode {
  /** Stable id — the cell's directory name and the report column key. */
  id: string;
  adapter: EvalAdapterId;
  /** Extra `run` flags for this arm-mode (e.g. --structured-mode). */
  extraArgs?: string[];
  /** Live-run pricing (required with --live): expected USD per doc-repeat + provenance. */
  spend?: { usdPerDocRepeat: number; basis: string; asOf: string };
}

export interface MatrixConfig {
  formatVersion: 1;
  capBranch: MatrixCapBranch;
  /** Doc classes — each needs golden.<class>.jsonl (and probes/golden.<class>.probe.jsonl). */
  classes: string[];
  /** Main-pass repeats (the analysis plan pre-registers 3); the probe pass is always 1 repeat. */
  repeats: number;
  passes: MatrixPass[];
  armModes: MatrixArmMode[];
  /** Frozen source manifests per class (required for live runs — `run` enforces it). */
  calTestManifests?: Record<string, string>;
}

export interface ConditionalExclusion {
  docClass: string;
  doc: string;
}

export interface ScoringJob {
  /** Which predictions file of the cell to score (relative to the cell dir). */
  predictionsFile: string;
  /** Golden path for this scoring (absolute). */
  goldenPath: string;
  /** Output directory (relative to the cell dir). */
  outDir: string;
  /** 'primary' or the labeled full-set appendix scoring. */
  kind: 'primary' | 'appendix-full-set';
  repeat: number;
}

export interface MatrixCell {
  armMode: string;
  adapter: EvalAdapterId;
  docClass: string;
  pass: MatrixPass;
  repeats: number;
  /** Cell directory relative to the matrix out root: <armMode>/<class>/<pass>. */
  relativeDir: string;
  /** The exact `run` argv (without the leading verb); --out is already the cell dir. */
  runArgs: string[];
  scoring: ScoringJob[];
  /** Docs excluded from this cell's RUN golden (cap-confirmed mistral cells only). */
  excludedDocs: string[];
}

export interface MatrixPlanInputs {
  config: MatrixConfig;
  /** Absolute path of the corpora dir (golden.<class>.jsonl, probes/, corpus-counts.json). */
  corporaDir: string;
  /** Absolute path of the docs root containing <class>/ PDF dirs. */
  pdfsDir: string;
  /** Absolute matrix out root. */
  outDir: string;
  live: boolean;
  /** Doc counts per (class, pass-golden) — the planner needs them for spend math. */
  docCounts: Record<string, { main: number; probe: number }>;
  /** The frozen conditional exclusions (from corpus-counts.json). */
  conditionalExclusions: readonly ConditionalExclusion[];
  /** Where derived (capped) goldens are written, relative to outDir. */
  derivedDirName?: string;
  /** Pass-through run flags (resume/recover/drift/confirm) appended to every cell. */
  passThroughArgs?: string[];
}

const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

/** Validate a parsed matrix config; throws with a precise message on the first violation. */
export function validateMatrixConfig(raw: unknown): MatrixConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('matrix config must be a JSON object');
  }
  const config = raw as Record<string, unknown>;
  if (config['formatVersion'] !== 1) throw new Error('matrix config formatVersion must be 1');
  const capBranch = config['capBranch'];
  if (capBranch !== 'unresolved' && capBranch !== 'cap-confirmed' && capBranch !== 'cap-removed') {
    throw new Error(
      'capBranch must be unresolved|cap-confirmed|cap-removed (the pre-freeze smoke resolves it)',
    );
  }
  const classes = config['classes'];
  if (
    !Array.isArray(classes) ||
    classes.length === 0 ||
    classes.some((c) => typeof c !== 'string')
  ) {
    throw new Error('classes must be a non-empty string array');
  }
  if (new Set(classes).size !== classes.length) throw new Error('classes must be unique');
  const repeats = config['repeats'];
  if (!Number.isInteger(repeats) || (repeats as number) <= 0) {
    throw new Error('repeats must be a positive integer (the bake-off pre-registers 3)');
  }
  const passes = config['passes'];
  if (!Array.isArray(passes) || passes.length === 0) {
    throw new Error('passes must be a non-empty array');
  }
  for (const pass of passes) {
    if (typeof pass === 'string' && /refit|cal-?fit/i.test(pass)) {
      throw new Error(
        `pass "${pass}": every CAL-FIT refit pass is excluded from this run matrix (pre-registered: refit columns are a phase-2 item, ANALYSIS-PLAN.md §15)`,
      );
    }
    if (pass !== 'main' && pass !== 'probe') {
      throw new Error(`unknown pass "${String(pass)}" (expected ${MATRIX_PASSES.join('|')})`);
    }
  }
  if (new Set(passes).size !== passes.length) throw new Error('passes must be unique');
  const armModes = config['armModes'];
  if (!Array.isArray(armModes) || armModes.length === 0) {
    throw new Error('armModes must be a non-empty array');
  }
  const ids = new Set<string>();
  for (const raw of armModes) {
    if (raw === null || typeof raw !== 'object') throw new Error('every armMode must be an object');
    const arm = raw as Record<string, unknown>;
    if (typeof arm['id'] !== 'string' || !IDENTIFIER.test(arm['id'])) {
      throw new Error(`armMode id "${String(arm['id'])}" must match ${IDENTIFIER}`);
    }
    if (ids.has(arm['id'])) throw new Error(`duplicate armMode id "${arm['id']}"`);
    ids.add(arm['id']);
    if (!ADAPTERS.includes(arm['adapter'] as EvalAdapterId)) {
      throw new Error(`armMode "${arm['id']}": unknown adapter "${String(arm['adapter'])}"`);
    }
    const extraArgs = arm['extraArgs'];
    if (extraArgs !== undefined) {
      if (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== 'string')) {
        throw new Error(`armMode "${arm['id']}": extraArgs must be a string array`);
      }
      for (const item of extraArgs) {
        const flag = item.split('=')[0]!;
        if (RESERVED_EXTRA_ARGS.includes(flag)) {
          throw new Error(
            `armMode "${arm['id']}": extraArgs may not set ${flag} — the matrix owns that flag`,
          );
        }
      }
    }
    const spend = arm['spend'];
    if (spend !== undefined) {
      const s = spend as Record<string, unknown>;
      if (
        typeof s['usdPerDocRepeat'] !== 'number' ||
        !(s['usdPerDocRepeat'] > 0) ||
        typeof s['basis'] !== 'string' ||
        s['basis'].trim().length === 0 ||
        typeof s['asOf'] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(s['asOf'])
      ) {
        throw new Error(
          `armMode "${arm['id']}": spend needs { usdPerDocRepeat > 0, basis, asOf: YYYY-MM-DD }`,
        );
      }
    }
  }
  const calTestManifests = config['calTestManifests'];
  if (calTestManifests !== undefined) {
    if (
      calTestManifests === null ||
      typeof calTestManifests !== 'object' ||
      Array.isArray(calTestManifests)
    ) {
      throw new Error('calTestManifests must be an object of <class>: <path>');
    }
    for (const [docClass, path] of Object.entries(calTestManifests)) {
      if (!(classes as string[]).includes(docClass) || typeof path !== 'string') {
        throw new Error(`calTestManifests has an unknown class or non-string path ("${docClass}")`);
      }
    }
  }
  return config as unknown as MatrixConfig;
}

/** POSIX-joined relative path (cell dirs are identifiers, so plain '/' join is exact). */
function rel(...parts: string[]): string {
  return parts.join('/');
}

function repeatFiles(repeats: number): Array<{ repeat: number; file: string }> {
  if (repeats === 1) return [{ repeat: 1, file: 'predictions.jsonl' }];
  return Array.from({ length: repeats }, (_unused, index) => ({
    repeat: index + 1,
    file: `predictions.repeat-${String(index + 1).padStart(3, '0')}.jsonl`,
  }));
}

/**
 * Build the full cell plan. Throws on protocol violations (live-before-smoke mistral, missing
 * spend for live cells, missing manifests for live cells).
 */
export function buildMatrixPlan(inputs: MatrixPlanInputs): MatrixCell[] {
  const { config, live } = inputs;
  const derivedDir = inputs.derivedDirName ?? 'derived';
  const excludedByClass = new Map<string, string[]>();
  for (const exclusion of inputs.conditionalExclusions) {
    const list = excludedByClass.get(exclusion.docClass);
    if (list === undefined) excludedByClass.set(exclusion.docClass, [exclusion.doc]);
    else list.push(exclusion.doc);
  }

  const cells: MatrixCell[] = [];
  for (const arm of config.armModes) {
    if (live && arm.adapter === 'mistral' && config.capBranch === 'unresolved') {
      throw new Error(
        `armMode "${arm.id}": a LIVE mistral cell before the smoke resolved the cap branch ` +
          'is a protocol error — set capBranch after the pre-freeze bidirectional smoke',
      );
    }
    if (live && arm.spend === undefined) {
      throw new Error(`armMode "${arm.id}": --live requires spend pricing in the matrix config`);
    }
    for (const docClass of config.classes) {
      if (live && inputs.config.calTestManifests?.[docClass] === undefined) {
        throw new Error(`--live requires calTestManifests["${docClass}"] in the matrix config`);
      }
      for (const pass of config.passes) {
        const repeats = pass === 'probe' ? 1 : config.repeats;
        const excluded = excludedByClass.get(docClass) ?? [];
        // cap-confirmed: mistral RUNS on the capped golden; everyone else runs all docs.
        const runsCapped =
          config.capBranch === 'cap-confirmed' && arm.adapter === 'mistral' && excluded.length > 0;
        const committedGolden =
          pass === 'probe'
            ? rel(inputs.corporaDir, 'probes', `golden.${docClass}.probe.jsonl`)
            : rel(inputs.corporaDir, `golden.${docClass}.jsonl`);
        const cappedGolden = rel(
          inputs.outDir,
          derivedDir,
          pass === 'probe'
            ? `golden.${docClass}.probe.capped.jsonl`
            : `golden.${docClass}.capped.jsonl`,
        );
        const runGolden = runsCapped ? cappedGolden : committedGolden;

        const relativeDir = rel(arm.id, docClass, pass);
        const docs = inputs.docCounts[docClass]?.[pass] ?? 0;
        const runDocs = runsCapped ? docs - excluded.length : docs;
        const runArgs: string[] = [
          '--golden',
          runGolden,
          '--adapter',
          arm.adapter,
          '--docs',
          rel(inputs.pdfsDir, docClass),
          '--out',
          rel(inputs.outDir, relativeDir),
          '--repeat',
          String(repeats),
          ...(arm.adapter === 'mistral' && config.capBranch !== 'unresolved'
            ? ['--mistral-cap-branch', config.capBranch]
            : []),
          ...(arm.extraArgs ?? []),
        ];
        if (live) {
          const spend = arm.spend!;
          const expected = spend.usdPerDocRepeat * runDocs * repeats;
          runArgs.push(
            '--live',
            '--expected-spend-usd',
            expected.toFixed(4),
            '--pricing-basis',
            spend.basis,
            '--pricing-as-of',
            spend.asOf,
            '--cal-test-manifest',
            `${docClass}=${inputs.config.calTestManifests![docClass]!}`,
          );
        }
        runArgs.push(...(inputs.passThroughArgs ?? []));

        // Scoring: PRIMARY always exists; in cap-confirmed the primary golden is the capped
        // one for EVERY arm (pairing preserved), and non-mistral arms add the labeled
        // full-set appendix scoring (the "you dropped documents" answer).
        const capConfirmed = config.capBranch === 'cap-confirmed' && excluded.length > 0;
        const primaryGolden = capConfirmed ? cappedGolden : committedGolden;
        const scoring: ScoringJob[] = [];
        for (const { repeat, file } of repeatFiles(repeats)) {
          scoring.push({
            predictionsFile: file,
            goldenPath: primaryGolden,
            outDir: `score.repeat-${String(repeat).padStart(3, '0')}`,
            kind: 'primary',
            repeat,
          });
          if (capConfirmed && !runsCapped) {
            scoring.push({
              predictionsFile: file,
              goldenPath: committedGolden,
              outDir: `score.appendix-full-set.repeat-${String(repeat).padStart(3, '0')}`,
              kind: 'appendix-full-set',
              repeat,
            });
          }
        }

        cells.push({
          armMode: arm.id,
          adapter: arm.adapter,
          docClass,
          pass,
          repeats,
          relativeDir,
          runArgs,
          scoring,
          excludedDocs: capConfirmed ? excluded : [],
        });
      }
    }
  }
  return cells;
}
