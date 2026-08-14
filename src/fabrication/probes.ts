/**
 * Probe schemas (ANALYSIS-PLAN.md §7.7) — mechanically selected fabrication probes with
 * ZERO selector discretion:
 *
 *  - Candidate pool per target class = the enumerated nullable scalar leaf fields of the REAL
 *    sibling-class schemas, minus any name that exists in the target schema (class-level
 *    inapplicability by construction — a FARA registration form has no `service_charge`).
 *  - Sampling: one published seed (PROBE_SELECTION_SEED), classes visited in sorted order,
 *    draws without replacement from the sorted pool — same seed, same probes, bit-for-bit.
 *  - Provenance per probe field (which sibling schema it came from) is published.
 *  - Probes live in a SEPARATE schema variant and a SEPARATE golden (every probe cell golden
 *    state `missing`): headline accuracy is computed on the untouched class schema only; the
 *    probe pass is one extra 1-repeat run per arm.
 *  - Absence is verified tool-independently (text-layer search — probes-cli `verify`) AND
 *    visually: the per-probe×doc manual-pass WORKSHEET is generated here, performed by the
 *    maintainer, and published; any probe visibly present in any doc image is struck before the
 *    pre-registration hash.
 *
 * Pure TS; the only import is the stats RNG (published-seed determinism).
 */

import { mulberry32 } from '../stats/rng.js';
import type { LoadedGolden } from '../golden/loader.js';

/**
 * The published probe-selection seed — pre-registered in `probes.json` and hashed into the
 * analysis plan. The value is a calendar date; it carries no other meaning.
 */
export const PROBE_SELECTION_SEED = 20260712;

/** Probes per class (ANALYSIS-PLAN.md §7.7 pre-registers three per class). */
export const PROBES_PER_CLASS = 3;

export interface ProbeField {
  /** The transplanted field name, verbatim from the sibling schema. */
  field: string;
  /** The sibling class whose schema contributed the field (provenance, published). */
  sourceClass: string;
}

export interface ProbeSelection {
  formatVersion: 1;
  seed: number;
  probesPerClass: number;
  /** Full enumerated candidate pool per target class — published so the sampling is auditable. */
  candidatePools: Record<string, ProbeField[]>;
  /** The selected probes per target class. */
  probes: Record<string, ProbeField[]>;
}

interface SchemaObject {
  properties?: Record<string, { type?: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Enumerate a class schema's top-level nullable scalar leaf fields — the only shapes that
 * transplant cleanly into a sibling schema as `{ "type": ["string", "null"] }` probes.
 */
export function enumerateLeafFields(schema: object): string[] {
  const properties = (schema as SchemaObject).properties ?? {};
  const out: string[] = [];
  for (const [name, spec] of Object.entries(properties)) {
    const type = spec.type;
    if (Array.isArray(type) && type.includes('string') && type.includes('null')) out.push(name);
  }
  return out.sort();
}

/**
 * The mechanical selection. `schemas` maps class name → parsed class schema. Deterministic:
 * classes sorted, pools sorted, one RNG stream from the published seed, draws without
 * replacement. Throws when a pool cannot supply `probesPerClass` fields (a protocol error —
 * the pre-registered design assumes real sibling schemas, never padding).
 */
export function selectProbes(
  schemas: Record<string, object>,
  seed: number = PROBE_SELECTION_SEED,
  probesPerClass: number = PROBES_PER_CLASS,
): ProbeSelection {
  const classes = Object.keys(schemas).sort();
  if (classes.length < 2) throw new Error('probes: need at least two class schemas');
  const rand = mulberry32(seed);

  const candidatePools: Record<string, ProbeField[]> = {};
  const probes: Record<string, ProbeField[]> = {};
  for (const target of classes) {
    const targetProperties = new Set(
      Object.keys((schemas[target] as SchemaObject).properties ?? {}),
    );
    // Sorted sibling order + first-source dedupe keeps the pool deterministic.
    const seen = new Set<string>();
    const pool: ProbeField[] = [];
    for (const sibling of classes) {
      if (sibling === target) continue;
      for (const field of enumerateLeafFields(schemas[sibling]!)) {
        if (targetProperties.has(field) || seen.has(field)) continue;
        seen.add(field);
        pool.push({ field, sourceClass: sibling });
      }
    }
    if (pool.length < probesPerClass) {
      throw new Error(
        `probes: candidate pool for "${target}" has ${pool.length} fields (< ${probesPerClass})`,
      );
    }
    candidatePools[target] = pool;
    const remaining = [...pool];
    const selected: ProbeField[] = [];
    for (let draw = 0; draw < probesPerClass; draw++) {
      const index = Math.floor(rand() * remaining.length);
      selected.push(remaining.splice(index, 1)[0]!);
    }
    probes[target] = selected;
  }
  return { formatVersion: 1, seed, probesPerClass, candidatePools, probes };
}

/**
 * The probe-pass schema variant: the UNTOUCHED class schema plus the probe fields as nullable
 * leaves (every leaf nullable — a non-nullable probe would remove the abstention
 * affordance and measure the schema, not the model), appended to `required` so constrained
 * modes must take a position on each probe.
 */
export function buildProbeSchema(classSchema: object, probes: readonly ProbeField[]): object {
  const base = classSchema as SchemaObject;
  const properties: Record<string, unknown> = { ...(base.properties ?? {}) };
  const required = [...(base.required ?? [])];
  for (const probe of probes) {
    if (probe.field in properties) {
      throw new Error(`probes: "${probe.field}" already exists in the target schema`);
    }
    properties[probe.field] = { type: ['string', 'null'] };
    required.push(probe.field);
  }
  return { ...base, properties, required };
}

/**
 * The probe-pass golden: one row per doc, fields = ONLY the probe pointers, every state
 * `missing` (class-level inapplicable by construction). Scored in its own results table —
 * never merged into headline accuracy.
 */
export function buildProbeGoldenJsonl(
  goldenRows: readonly LoadedGolden[],
  probes: readonly ProbeField[],
  schemaFile: string,
): string {
  const lines = goldenRows.map((row) =>
    JSON.stringify({
      doc: row.doc,
      docClass: row.golden.docClass,
      schema: schemaFile,
      fields: Object.fromEntries(probes.map((probe) => [`/${probe.field}`, { state: 'missing' }])),
    }),
  );
  return lines.join('\n') + '\n';
}

/**
 * The per-probe×doc visual manual-pass worksheet: text-layer search alone is unreliable
 * on scan classes, so the maintainer confirms per probe×doc that the probe's value is not visibly
 * present in the doc IMAGE. The completed worksheet is published as the auditable artifact;
 * any visible probe value strikes that probe before the pre-registration hash.
 */
export function buildWorksheetMarkdown(
  selection: ProbeSelection,
  docsByClass: Record<string, readonly string[]>,
): string {
  const lines: string[] = [
    '# Probe absence — visual manual-pass worksheet',
    '',
    'One row per probe×doc. Maintainer: open the doc IMAGE (not the text layer) and record',
    'whether any value for the probe field is visibly present. `text-layer hits` is filled by',
    '`probes-cli verify` (tool-independent first pass); the VISUAL column is authoritative.',
    'Any probe with a visible value in ANY doc is struck before the pre-registration hash.',
    '',
    `Selection seed: ${selection.seed} (published; see probes.json for pools + provenance).`,
    '',
    '| class | doc | probe field | source class | text-layer hits | visually absent? (y/n) | notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const docClass of Object.keys(selection.probes).sort()) {
    const docs = docsByClass[docClass] ?? [];
    for (const probe of selection.probes[docClass]!) {
      for (const doc of docs) {
        lines.push(`| ${docClass} | ${doc} | ${probe.field} | ${probe.sourceClass} |  |  |  |`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** Human-readable search tokens for a probe field name (`gross_amount` → "gross amount"). */
export function probeSearchTokens(field: string): string[] {
  const spaced = field.replace(/_/g, ' ').trim();
  return spaced === field ? [field] : [field, spaced];
}

export interface StruckProbe {
  docClass: string;
  field: string;
  /** Docs where the maintainer recorded the value as visible, in worksheet order. */
  visibleDocs: string[];
}

export interface StrikeRecord {
  formatVersion: 1;
  /** The strike source is the published worksheet — the visual column is authoritative. */
  source: 'WORKSHEET.md';
  struck: StruckProbe[];
}

/**
 * Derive the strike record from the COMPLETED worksheet — zero discretion: a probe is struck
 * iff its value was recorded visible (`n`) on any doc. Throws on an unanswered or malformed
 * visual cell, so strikes can only finalize from a complete pass.
 */
export function parseWorksheetStrikes(markdown: string): StrikeRecord {
  const visible = new Map<string, StruckProbe>();
  let dataRows = 0;
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 9 || cells[1] === 'class' || /^-+$/.test(cells[1]!)) continue;
    dataRows++;
    const docClass = cells[1]!,
      doc = cells[2]!,
      field = cells[3]!,
      visual = cells[6]!;
    if (visual !== 'y' && visual !== 'n') {
      throw new Error(
        `probes: worksheet row "${docClass} / ${doc} / ${field}" has visual "${visual}" (want y|n) — the visual pass must complete before strikes finalize`,
      );
    }
    if (visual === 'n') {
      const key = `${docClass}|${field}`;
      const entry = visible.get(key) ?? { docClass, field, visibleDocs: [] };
      entry.visibleDocs.push(doc);
      visible.set(key, entry);
    }
  }
  if (dataRows === 0) throw new Error('probes: worksheet has no data rows');
  const struck = [...visible.values()].sort(
    (a, b) => a.docClass.localeCompare(b.docClass) || a.field.localeCompare(b.field),
  );
  return { formatVersion: 1, source: 'WORKSHEET.md', struck };
}

/** The selection minus struck probes — the set the probe pass actually runs. */
export function survivingProbes(
  selection: ProbeSelection,
  strikes: StrikeRecord,
): Record<string, ProbeField[]> {
  const struckKeys = new Set(strikes.struck.map((s) => `${s.docClass}|${s.field}`));
  for (const s of strikes.struck) {
    const known = (selection.probes[s.docClass] ?? []).some((p) => p.field === s.field);
    if (!known)
      throw new Error(`probes: strike "${s.docClass}|${s.field}" is not a selected probe`);
  }
  return Object.fromEntries(
    Object.entries(selection.probes).map(([docClass, probes]) => [
      docClass,
      probes.filter((p) => !struckKeys.has(`${docClass}|${p.field}`)),
    ]),
  );
}
