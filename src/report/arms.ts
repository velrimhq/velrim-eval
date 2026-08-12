/**
 * Multi-arm bake-off report layer. PRESENTATION ONLY — every number arrives computed
 * (@velrim/scoring via score/aggregate; CIs/MDEs/floors via src/stats); nothing here derives a
 * metric. The pre-registered render rules are enforced STRUCTURALLY, not by convention:
 *
 *  - Cell vocabulary (ANALYSIS-PLAN.md §6.5): an arm's confidence surface is a typed union — numeric cells render
 *    numbers under a version-stamped column label; product arms with no surface render
 *    "none surfaced" (a fact about the product); bare-model arms render "not requested"
 *    (adding a confidence ask would break byte-identical prompt parity). ECE/AUROC are never
 *    computed from a 0.5 imputation — arms without a numeric surface have no metric fields to
 *    render at all.
 *  - A1–A3 ablation block: any render containing an ablation-block arm prints the framing
 *    sentence above the table ("same base model — deliberate ablation (A1–A3)…"), in EVERY
 *    render. Block arms are hoisted above the rest in input order — enforced by blockOrder,
 *    not by caller convention.
 *  - D17: cost never pairs with accuracy alone. The combined headline table (F1 + fabrication
 *    + error@coverage-0.9 + $/1k) is the ONLY exported render that accepts cost, and it always
 *    carries the differentiating columns; the accuracy and confidence renders have no cost
 *    parameter to misuse.
 *  - Dual columns: normalized is PRIMARY, strict adjacent (FD-10) — the accuracy render takes
 *    both and prints normalized first.
 *  - Refit columns are OUT (pre-registered phase-2 item): no render in this module accepts a refit variant.
 */

import { isMintedFittedStamp } from '../adapters/velrim.js';

export interface ValueWithCI {
  value: number;
  /** 95% doc-clustered BCa interval (src/stats/bootstrap) when available. */
  ci?: [number, number];
}

/**
 * The Velrim version-stamp column label, built ONLY from a run manifest's recorded facts
 * (the label reads from the RESPONSE stamp, never hardcoded — ANALYSIS-PLAN.md §6.2). The served
 * stamp comes from `observedVersions.calibrator`, which must be uniformly SURFACED (exactly
 * one value, no missing records) and must be a minted fitted stamp — anything else throws,
 * because a label that cannot be proven must never render.
 */
export function velrimVersionStampLabel(manifest: {
  observedVersions: { calibrator: { status: string; values: string[]; missingRecords: number } };
}): string {
  const calibrator = manifest.observedVersions.calibrator;
  if (
    calibrator.status !== 'surfaced' ||
    calibrator.values.length !== 1 ||
    calibrator.missingRecords !== 0
  ) {
    throw new Error(
      `velrim version-stamp label: served calibrator stamp is not uniformly surfaced ` +
        `(status=${calibrator.status}, values=[${calibrator.values.join(', ')}]) — ` +
        'the label reads from the response stamp and cannot be guessed',
    );
  }
  const stamp = calibrator.values[0]!;
  if (!isMintedFittedStamp(stamp)) {
    throw new Error(
      `velrim version-stamp label: served stamp "${stamp}" is not a minted fitted stamp — ` +
        'a mislabeled column is a protocol error (the Velrim pin)',
    );
  }
  return `calibrator: ${stamp} (fitted stack, default served path)`;
}

/** The confidence surface is a type, so a fake numeric column cannot be rendered. */
export type ConfidenceSurface =
  | {
      kind: 'numeric';
      /**
       * Column-label stamp. For the Velrim arm this MUST come from
       * `velrimVersionStampLabel` (the served response stamp) — never a literal.
       */
      versionStamp: string;
      ece: ValueWithCI;
      brier: ValueWithCI;
      errorAtCoverage90: ValueWithCI;
    }
  | { kind: 'none-surfaced' } // the Mistral arm (A4); consented arms by name if they ever join
  | { kind: 'not-requested' }; // bare-model arms (A2/A3)

export const NONE_SURFACED = 'none surfaced';
export const NOT_REQUESTED = 'not requested';

/** The pre-registered cell-vocabulary one-liners, printed as table footnotes wherever a cell uses them. */
export const NONE_SURFACED_NOTE =
  'none surfaced: this vendor exposes no per-field confidence in this mode; a score you cannot get is not a score of 0.';
export const NOT_REQUESTED_NOTE =
  'not requested: a bare model emits a self-score only if prompted; adding a confidence ask would break byte-identical prompt parity.';

/**
 * Pre-registered A1–A3 framing sentence — printed above the table in EVERY render.
 * MUST stay byte-identical with the sentence in ANALYSIS-PLAN.md §2 (change both together).
 */
export const ABLATION_FRAMING =
  'same base model — deliberate ablation (A1–A3): the full pipeline vs its underlying model and decoding';

export interface ClassCell {
  /** normalized is the PRIMARY column (FD-10); strict prints adjacent. */
  normalized: ValueWithCI;
  strict: ValueWithCI;
}

export interface ArmRow {
  id: string;
  label: string;
  /** true for A1–A3 (the same-base-model block). */
  ablationBlock: boolean;
  /** macro-F1 (equal class weights, FD-11) per scoring variant. */
  macroF1: ClassCell;
  /** per-class micro-F1 keyed by class name. */
  perClassF1: Record<string, ClassCell>;
  /** pooled fabrication rate (per-cell repeat-mean estimator). */
  fabricationRate: ValueWithCI;
  confidence: ConfidenceSurface;
  /** list $ per 1,000 pages for the configuration as run. ONLY the headline table renders it. */
  costPer1kPagesUsd: number;
  availability?: number;
}

export const fmt = (n: number, d = 3): string => (Number.isFinite(n) ? n.toFixed(d) : 'NaN');
export const withCI = (v: ValueWithCI, d = 3): string =>
  v.ci ? `${fmt(v.value, d)} [${fmt(v.ci[0], d)}–${fmt(v.ci[1], d)}]` : fmt(v.value, d);

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Fixed-width table with a title, optional framing line, column headers and footnotes. */
export function table(
  title: string,
  framing: string | null,
  headers: string[],
  rows: string[][],
  footnotes: string[],
): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const lines: string[] = [title];
  if (framing) lines.push(`  ${framing}`);
  lines.push('  ' + headers.map((h, i) => pad(h, widths[i]!)).join('  '));
  for (const r of rows) lines.push('  ' + r.map((c, i) => pad(c, widths[i]!)).join('  '));
  for (const f of footnotes) lines.push(`  ${f}`);
  return lines.join('\n');
}

/** Ablation-block arms first, then the rest — input order preserved within each group. */
function blockOrder(arms: readonly ArmRow[]): ArmRow[] {
  return [...arms.filter((a) => a.ablationBlock), ...arms.filter((a) => !a.ablationBlock)];
}

function framingFor(arms: readonly ArmRow[]): string | null {
  return arms.some((a) => a.ablationBlock) ? ABLATION_FRAMING : null;
}

/** Marks ablation rows so the block reads as method, not padding. */
function armLabel(a: ArmRow): string {
  return a.ablationBlock ? `▸ ${a.label}` : a.label;
}

/**
 * THE combined headline table (D17) — the only summary render, and the only render in this
 * module that prints cost: F1 + fabrication + error@coverage-0.9 + $/1k pages, per arm. The
 * confidence cell falls back to the no-confidence vocabulary for arms without a numeric surface.
 */
export function renderHeadlineTable(arms: readonly ArmRow[]): string {
  const ordered = blockOrder(arms);
  const rows = ordered.map((a) => [
    armLabel(a),
    withCI(a.macroF1.normalized),
    withCI(a.fabricationRate),
    a.confidence.kind === 'numeric'
      ? withCI(a.confidence.errorAtCoverage90)
      : a.confidence.kind === 'none-surfaced'
        ? NONE_SURFACED
        : NOT_REQUESTED,
    `$${fmt(a.costPer1kPagesUsd, 2)}`,
  ]);
  const notes = [
    'macro-F1 = equal-weight mean over the four classes, normalized scoring (strict column in the accuracy table).',
  ];
  if (ordered.some((a) => a.confidence.kind === 'none-surfaced')) notes.push(NONE_SURFACED_NOTE);
  if (ordered.some((a) => a.confidence.kind === 'not-requested')) notes.push(NOT_REQUESTED_NOTE);
  return table(
    'combined headline (the only summary render: cost never pairs with accuracy alone)',
    framingFor(ordered),
    ['arm', 'macro-F1 (norm.)', 'fabrication (pooled)', 'err@cov-0.9', '$/1k pages'],
    rows,
    notes,
  );
}

/**
 * Per-class accuracy table — normalized PRIMARY, strict adjacent, per arm. No cost parameter
 * exists on this render (D17). MDE context prints as a footnote so ties read as ties.
 */
export function renderAccuracyTable(
  arms: readonly ArmRow[],
  classes: readonly string[],
  mdeFootnote?: string,
): string {
  const ordered = blockOrder(arms);
  const headers = ['arm', ...classes.flatMap((c) => [`${c} (norm.)`, `${c} (strict)`])];
  const rows = ordered.map((a) => [
    armLabel(a),
    ...classes.flatMap((c) => {
      const cell = a.perClassF1[c];
      return cell ? [withCI(cell.normalized), withCI(cell.strict)] : ['—', '—'];
    }),
  ]);
  const notes = [
    'normalized is the primary column; strict prints adjacent — both publish for every arm.',
  ];
  if (mdeFootnote) notes.push(mdeFootnote);
  return table(
    'per-class micro-F1 (normalized primary + strict)',
    framingFor(ordered),
    headers,
    rows,
    notes,
  );
}

/**
 * Confidence table — numeric arms render ECE/Brier/err@cov-0.9 under a version-stamped label;
 * non-numeric arms render the no-confidence vocabulary cell across the metric columns. No metric is
 * ever derived from an imputed 0.5.
 */
export function renderConfidenceTable(arms: readonly ArmRow[]): string {
  const ordered = blockOrder(arms);
  const rows = ordered.map((a) => {
    if (a.confidence.kind === 'numeric') {
      return [
        `${armLabel(a)} (${a.confidence.versionStamp})`,
        withCI(a.confidence.ece),
        withCI(a.confidence.brier),
        withCI(a.confidence.errorAtCoverage90),
      ];
    }
    const cell = a.confidence.kind === 'none-surfaced' ? NONE_SURFACED : NOT_REQUESTED;
    return [armLabel(a), cell, cell, cell];
  });
  const notes: string[] = [
    'risk-coverage: curves render for arms with a signal; arms without render a single dot at coverage=1 — "no selective operation possible".',
  ];
  if (ordered.some((a) => a.confidence.kind === 'none-surfaced')) notes.push(NONE_SURFACED_NOTE);
  if (ordered.some((a) => a.confidence.kind === 'not-requested')) notes.push(NOT_REQUESTED_NOTE);
  return table(
    "confidence, as shipped (column labels carry each arm's served version stamp)",
    framingFor(ordered),
    ['arm (version stamp)', 'ECE', 'Brier', 'err@cov-0.9'],
    rows,
    notes,
  );
}

export interface MdeTableRow {
  className: string;
  docs: number;
  fields: number;
  mdeAtBase75: number | null;
  mdeAtBase90: number | null;
}

/** MDE table (re-simulated at final counts) — prints NEXT TO results, never hidden. */
export function renderMdeTable(rows: readonly MdeTableRow[], assumptions: string): string {
  const body = rows.map((r) => [
    r.className,
    `${r.docs} × ${(r.fields / r.docs).toFixed(1)}`,
    r.mdeAtBase75 === null ? '> grid' : `~${(r.mdeAtBase75 * 100).toFixed(1)} pp`,
    r.mdeAtBase90 === null ? '> grid' : `~${(r.mdeAtBase90 * 100).toFixed(1)} pp`,
  ]);
  return table(
    'minimum detectable per-class F1 difference (80% power, α=.05 two-sided)',
    null,
    ['class', 'docs × fields/doc', 'MDE @ base ≈ .75', 'MDE @ base ≈ .90'],
    body,
    [
      assumptions,
      'per-class deltas smaller than the MDE are reported as "not distinguishable on this corpus" — including gaps in Velrim\'s favor.',
    ],
  );
}

export interface NoiseFloorRow {
  label: string;
  n: number;
  mean: number;
  p05: number;
  p95: number;
}

/**
 * ECE noise-floor table (methods section). The reader-facing wording rule is pre-registered
 * and adjective-free: the caption speaks of an arm "whose confidence scores were perfectly
 * reliable", never of a *calibrated* arm.
 */
export function renderNoiseFloorTable(rows: readonly NoiseFloorRow[]): string {
  const body = rows.map((r) => [
    r.label,
    String(r.n),
    `${fmt(r.mean)} [${fmt(r.p05)}–${fmt(r.p95)}]`,
  ]);
  return table(
    'plug-in ECE of an arm whose confidence scores were perfectly reliable (15 equal-mass bins)',
    null,
    ['points', 'n', 'mean [5th–95th pct]'],
    body,
    [
      "per-class ECE differences of this order sit at or below the estimator's noise floor — they are not findings.",
    ],
  );
}
