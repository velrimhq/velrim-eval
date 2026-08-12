/**
 * Fabrication-table renders (ANALYSIS-PLAN.md §7). PRESENTATION ONLY — every number arrives computed by
 * `src/fabrication/judge.ts`; nothing here derives a metric. The pre-registered render rules are
 * structural, matching the multi-arm report layer:
 *
 *  - The gold-present ANSWER-rate column (abstention cost) is IN the fabrication table — the
 *    row type requires it, so a fabrication rate cannot render without its adjacency (§7.5).
 *  - The strict-rule sensitivity row and the dual-accounting row are required fields for the
 *    same reason (same data, both rules; failures-as-abstentions next to availability).
 *  - Per-class rates below the pre-registered floor render "n=…; see probe table", never a
 *    rate (§7.6) — enforced by the judge emitting no rate, not by renderer politeness.
 *  - The label-provenance disclaimer prints as a standing footnote of EVERY fabrication
 *    render, with the symmetric correction rule beside it.
 *  - No cost parameter exists on these renders (D17 stays owned by the headline table).
 */

import { ABLATION_FRAMING, table, withCI, type ValueWithCI } from './arms.js';
import { FABRICATION_CLASS_FLOOR } from '../fabrication/judge.js';

/** Printed with the fabrication table, every render, before any critic asks. */
export const LABEL_PROVENANCE_DISCLAIMER =
  'label provenance: natural absent cells rest on third-party labels on noisy corpora ' +
  '(cord is scans; prior review of raw scoring failures found some were label artifacts); ' +
  'noise rate unmeasured. ' +
  'correction rule: any golden label shown wrong post-publication is reclassified or excluded ' +
  'for ALL arms symmetrically, count disclosed, changelog entry.';

/** The denominator rule, stated where the number prints (ANALYSIS-PLAN.md §7.4). */
export const DENOMINATOR_NOTE =
  "primary denominator: golden-absent cells on contract-usable responses only — an arm's " +
  'fabrication rate is never deflated by its own outage rate; the dual-accounting column ' +
  '(all attempted, failures as abstentions) prints adjacent, next to availability.';

/** Why the recall column lives in THIS table (ANALYSIS-PLAN.md §7.5). */
export const ABSTENTION_ADJACENCY_NOTE =
  'gold-present answer rate prints in this table because any arm that abstains more ' +
  'fabricates less by construction — the abstention cost and the fabrication rate are one ' +
  'visual unit, for every arm symmetrically.';

export interface FabricationArmRow {
  id: string;
  label: string;
  /** true for A1–A3 (the same-base-model block). */
  ablationBlock: boolean;
  /** HEADLINE pooled rate (per-cell repeat-mean, usable-only denominator). */
  pooled: ValueWithCI;
  /** STRICT sensitivity (any non-null = fabrication) — same cells. */
  strict: ValueWithCI;
  /** Gold-present answer rate (1 − false-omission rate). */
  goldPresentAnswerRate: ValueWithCI;
  /** Dual accounting (all attempted, failures as abstentions). */
  dualAccounting: ValueWithCI;
  /** Docs-completed / docs-attempted for the arm. */
  availability: number;
  /** Natural absent cells in the primary denominator. */
  absentCells: number;
  /** Per-class rows — `rate` absent below the floor (the judge enforces it). */
  perClass: ReadonlyArray<{ docClass: string; absentCells: number; rate?: ValueWithCI }>;
}

/** Same ordering rule as the multi-arm report layer: block arms first, input order within. */
function blockOrder(arms: readonly FabricationArmRow[]): FabricationArmRow[] {
  return [...arms.filter((a) => a.ablationBlock), ...arms.filter((a) => !a.ablationBlock)];
}

function armLabel(a: FabricationArmRow): string {
  return a.ablationBlock ? `▸ ${a.label}` : a.label;
}

const pct = (v: ValueWithCI): string => withCI(v, 3);

/**
 * THE fabrication table: pooled headline rate + strict sensitivity + gold-present answer rate
 * + dual accounting + availability, per arm. Footnotes carry the pre-registered disclaimers.
 */
export function renderFabricationTable(arms: readonly FabricationArmRow[]): string {
  const ordered = blockOrder(arms);
  const rows = ordered.map((a) => [
    armLabel(a),
    String(a.absentCells),
    pct(a.pooled),
    pct(a.strict),
    pct(a.goldPresentAnswerRate),
    pct(a.dualAccounting),
    a.availability.toFixed(3),
  ]);
  return table(
    'fabrication on golden-absent fields (per-cell repeat-mean, doc-clustered CIs)',
    ordered.some((a) => a.ablationBlock) ? ABLATION_FRAMING : null,
    [
      'arm',
      'absent n',
      'fabrication (headline)',
      'strict rule',
      'gold-present answer rate',
      'dual accounting',
      'availability',
    ],
    rows,
    [DENOMINATOR_NOTE, ABSTENTION_ADJACENCY_NOTE, LABEL_PROVENANCE_DISCLAIMER],
  );
}

/**
 * Per-class fabrication rows with the pre-registered floor: a class below the absent-n
 * floor renders "n=…; see probe table", never a rate. The judge emits no rate below the
 * floor, so this renderer CANNOT print one.
 */
export function renderFabricationPerClassTable(
  arms: readonly FabricationArmRow[],
  classes: readonly string[],
): string {
  const ordered = blockOrder(arms);
  const rows = ordered.map((a) => [
    armLabel(a),
    ...classes.map((docClass) => {
      const cell = a.perClass.find((c) => c.docClass === docClass);
      if (cell === undefined) return '—';
      if (cell.rate === undefined) return `n=${cell.absentCells}; see probe table`;
      return `${pct(cell.rate)} (n=${cell.absentCells})`;
    }),
  ]);
  return table(
    `per-class fabrication (rate printed only where natural absent-n ≥ ${FABRICATION_CLASS_FLOOR})`,
    ordered.some((a) => a.ablationBlock) ? ABLATION_FRAMING : null,
    ['arm', ...classes],
    rows,
    [
      'per-class rows carry CIs and no winner language; the pooled number is the headline ' +
        '(uneven absent-cell counts make macro CIs on a rate unstable — pre-registered).',
      LABEL_PROVENANCE_DISCLAIMER,
    ],
  );
}
