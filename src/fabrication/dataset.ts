/**
 * The Hugging Face dataset derivation (pure: files in, rows out). Three tables:
 *   predictions        one row per (arm, pass, document, repeat, golden field): the raw value, the
 *                      confidence when surfaced, the request id, and the judge's verdict for
 *                      absent fields under both rules
 *   probes             the seeded trap-field selection with the visual-pass strikes
 *   absent-label audit every natural absent label with its audit verdict
 * Every verdict comes from `judge.ts`; nothing here decides what counts as a fabrication.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalFieldId, goldenValueVocabulary, isSubstantiveValue } from './judge.js';
import {
  armPredictionPaths,
  corporaGoldenPaths,
  readGoldens,
  readPredictions,
  readStrikes,
  strikeKey,
  type Pass,
} from './inputs.js';

export type PredictedState = 'value' | 'null' | 'omitted' | 'declined' | 'failed';

export interface PredictionRow {
  arm: string;
  pass: Pass;
  doc_class: string;
  doc: string;
  repeat: number;
  field: string;
  gold_state: 'present' | 'null' | 'missing';
  gold_value: unknown;
  availability: string;
  predicted_state: PredictedState;
  value: unknown;
  confidence: number | null;
  /** Absent label struck by the audit: out of every denominator, for every arm alike. */
  struck: boolean;
  /** Headline rule; null where the golden field is present, struck, or the call failed. */
  fabricated: boolean | null;
  /** Strict rule (any value other than null or an omitted key); same null cases. */
  fabricated_strict: boolean | null;
  request_id: string | null;
}

export interface ProbeRow {
  doc_class: string;
  field: string;
  source_class: string;
  rank: number;
  struck: boolean;
  visible_docs: number;
}

export interface AuditRow {
  doc_class: string;
  doc: string;
  field: string;
  verdict: 'confirmed' | 'visible' | 'unverifiable';
  page: number | null;
  seen: string | null;
}

export interface Dataset {
  predictions: PredictionRow[];
  probes: ProbeRow[];
  audit: AuditRow[];
}

interface MatrixManifest {
  config: { classes: string[]; passes: Pass[]; armModes: Array<{ id: string }> };
}

interface ProbesFile {
  probes: Record<string, Array<{ field: string; sourceClass: string }>>;
}

interface ProbeStrikes {
  struck: Array<{ docClass: string; field: string; visibleDocs: string[] }>;
}

export async function buildDataset(opts: {
  resultsDir: string;
  corporaDir: string;
}): Promise<Dataset> {
  const manifest = JSON.parse(
    await readFile(join(opts.resultsDir, 'matrix-manifest.json'), 'utf8'),
  ) as MatrixManifest;
  const arms = manifest.config.armModes.map((a) => a.id);
  const passes = manifest.config.passes;
  const strikes = await readStrikes(join(opts.corporaDir, 'natural-strikes.json'));
  const struckKeys = new Set(strikes.struck.map((s) => strikeKey(s.docClass, s.doc, s.field)));

  const predictions: PredictionRow[] = [];
  for (const arm of arms) {
    for (const pass of passes) {
      const goldens = await readGoldens(await corporaGoldenPaths(opts.corporaDir, pass));
      const vocabulary = goldenValueVocabulary(goldens);
      const records = await readPredictions(
        await armPredictionPaths(join(opts.resultsDir, arm), pass),
      );
      const byDoc = new Map<string, typeof records>();
      for (const r of records) {
        const key = `${r.docClass}|${r.doc}`;
        const list = byDoc.get(key);
        if (list === undefined) byDoc.set(key, [r]);
        else list.push(r);
      }
      for (const row of goldens) {
        const docRecords = (byDoc.get(`${row.golden.docClass}|${row.doc}`) ?? []).sort(
          (a, b) => a.repeat - b.repeat,
        );
        for (const record of docRecords) {
          const completed = record.availability === 'completed';
          for (const [pointer, cell] of Object.entries(row.golden.fields)) {
            const has = completed && Object.prototype.hasOwnProperty.call(record.fields, pointer);
            const field = has ? record.fields[pointer] : undefined;
            const vocab = vocabulary.get(canonicalFieldId(pointer));
            const substantive = completed && isSubstantiveValue(field, vocab, 'headline');
            const substantiveStrict = completed && isSubstantiveValue(field, vocab, 'strict');
            const struck =
              pass === 'main' &&
              cell.state !== 'present' &&
              struckKeys.has(strikeKey(row.golden.docClass, row.doc, pointer));
            const judged = cell.state !== 'present' && !struck && completed;
            const predictedState: PredictedState = !completed
              ? 'failed'
              : field === undefined
                ? 'omitted'
                : field.value === null
                  ? 'null'
                  : substantive
                    ? 'value'
                    : 'declined';
            predictions.push({
              arm,
              pass,
              doc_class: row.golden.docClass,
              doc: row.doc,
              repeat: record.repeat,
              field: pointer,
              gold_state: cell.state,
              gold_value: cell.state === 'present' ? cell.value : null,
              availability: record.availability,
              predicted_state: predictedState,
              value: field === undefined ? null : field.value,
              confidence: typeof field?.confidence === 'number' ? field.confidence : null,
              struck,
              fabricated: judged ? substantive : null,
              fabricated_strict: judged ? substantiveStrict : null,
              request_id: record.provenance?.requestId ?? null,
            });
          }
        }
      }
    }
  }

  const probesFile = JSON.parse(
    await readFile(join(opts.corporaDir, 'probes', 'probes.json'), 'utf8'),
  ) as ProbesFile;
  const probeStrikes = JSON.parse(
    await readFile(join(opts.corporaDir, 'probes', 'strikes.json'), 'utf8'),
  ) as ProbeStrikes;
  const probes: ProbeRow[] = [];
  for (const docClass of Object.keys(probesFile.probes).sort()) {
    probesFile.probes[docClass]!.forEach((p, i) => {
      const strike = probeStrikes.struck.find(
        (s) => s.docClass === docClass && s.field === p.field,
      );
      probes.push({
        doc_class: docClass,
        field: p.field,
        source_class: p.sourceClass,
        rank: i + 1,
        struck: strike !== undefined,
        visible_docs: strike?.visibleDocs.length ?? 0,
      });
    });
  }

  const audit: AuditRow[] = [];
  const mainGoldens = await readGoldens(await corporaGoldenPaths(opts.corporaDir, 'main'));
  for (const row of mainGoldens) {
    for (const [pointer, cell] of Object.entries(row.golden.fields)) {
      if (cell.state === 'present') continue;
      const strike = strikes.struck.find(
        (s) => s.docClass === row.golden.docClass && s.doc === row.doc && s.field === pointer,
      );
      audit.push({
        doc_class: row.golden.docClass,
        doc: row.doc,
        field: pointer,
        verdict: strike?.reason ?? 'confirmed',
        page: strike?.page ?? null,
        seen: strike?.seen ?? null,
      });
    }
  }
  if (audit.length !== strikes.auditedCells) {
    throw new Error(
      `absent labels in the goldens (${audit.length}) differ from the audit's count (${strikes.auditedCells})`,
    );
  }

  return { predictions, probes, audit };
}

const jsonl = (rows: readonly unknown[]): string =>
  rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

export const FILES = {
  predictions: 'predictions.jsonl',
  probes: 'probes.jsonl',
  audit: 'absent-label-audit.jsonl',
} as const;

export function serialize(data: Dataset): Record<(typeof FILES)[keyof typeof FILES], string> {
  return {
    [FILES.predictions]: jsonl(data.predictions),
    [FILES.probes]: jsonl(data.probes),
    [FILES.audit]: jsonl(data.audit),
  };
}

/** The standing sweeps; every published text file already passes these. */
export const BUILTIN_SWEEPS: Array<[string, RegExp]> = [
  ['local path', /[A-Za-z]:\\|\/Users\/|\/home\//],
  ['machine identity', /hostname|DESKTOP-|LAPTOP-/i],
  ['non-velrim email', /[A-Za-z0-9._%+-]+@(?!velrim\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['key-shaped string', /AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{15,}/],
  ['cloud project id', /projects\/(?!<gcp-project>)[A-Za-z0-9-]+\//],
  ['edge request ray', /cf-ray [a-f0-9]{8,}-[A-Za-z]{3}\b/],
];

export function parseDenylist(text: string): Array<[string, RegExp]> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((src, i) => [`denylist line ${i + 1}`, new RegExp(src, 'i')]);
}

export function sweep(
  files: Record<string, string>,
  extra: ReadonlyArray<[string, RegExp]> = [],
): string[] {
  const hits: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    for (const [label, re] of [...BUILTIN_SWEEPS, ...extra]) {
      const m = text.match(re);
      if (m) hits.push(`${name}: ${label}: ${m[0].slice(0, 60)}`);
    }
  }
  return hits;
}

export function summarize(data: Dataset): string {
  const counts = new Map<string, { rows: number; judged: number; fabricated: number }>();
  for (const r of data.predictions) {
    const key = `${r.arm} ${r.pass} ${r.doc_class}`;
    const c = counts.get(key) ?? { rows: 0, judged: 0, fabricated: 0 };
    c.rows++;
    if (r.fabricated !== null) c.judged++;
    if (r.fabricated === true) c.fabricated++;
    counts.set(key, c);
  }
  const lines = [...counts.entries()].map(
    ([k, c]) => `${k}: ${c.rows} rows, ${c.judged} judged absent cells, ${c.fabricated} fabricated`,
  );
  lines.push(
    `total: ${data.predictions.length} prediction rows, ${data.probes.length} probes, ${data.audit.length} audited absent labels`,
  );
  return lines.join('\n') + '\n';
}
