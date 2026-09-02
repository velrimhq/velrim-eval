/**
 * Shared input loading for the fabrication judge's callers (`velrim-eval fabrication` and the
 * dataset generator): golden rows, the audit strike overlay, and prediction records read from
 * `predictions.repeat-NNN.jsonl` files. Pure file-to-object mapping; no metric lives here.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseGoldenJsonl, type LoadedGolden } from '../golden/loader.js';
import type { PredictionRecord } from '../run/checkpoint.js';

export type Pass = 'main' | 'probe';

/** `corpora/natural-strikes.json` — absent labels struck from the denominator, every arm alike. */
export interface StrikeRecord {
  auditedCells: number;
  struck: Array<{
    docClass: string;
    doc: string;
    field: string;
    reason: 'visible' | 'unverifiable';
    page: number | null;
    seen: string | null;
  }>;
}

export function strikeKey(docClass: string, doc: string, field: string): string {
  return `${docClass}|${doc}|${field}`;
}

export async function readStrikes(path: string): Promise<StrikeRecord> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<StrikeRecord>;
  if (!Array.isArray(raw.struck)) throw new Error(`${path}: expected a "struck" array`);
  return raw as StrikeRecord;
}

/**
 * Drop struck absent cells from the golden rows. Golden bytes never change on disk; the overlay
 * narrows the denominator in memory, identically for whichever arm is judged.
 */
export function applyStrikes(goldens: LoadedGolden[], strikes: StrikeRecord): LoadedGolden[] {
  const keys = new Set(strikes.struck.map((s) => strikeKey(s.docClass, s.doc, s.field)));
  return goldens.map((row) => {
    const fields: LoadedGolden['golden']['fields'] = {};
    for (const [pointer, cell] of Object.entries(row.golden.fields)) {
      if (cell.state !== 'present' && keys.has(strikeKey(row.golden.docClass, row.doc, pointer)))
        continue;
      fields[pointer] = cell;
    }
    return { ...row, golden: { ...row.golden, fields } };
  });
}

export function parsePredictionJsonl(text: string, where: string): PredictionRecord[] {
  const out: PredictionRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`${where} line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    const r = row as Partial<PredictionRecord>;
    if (r.kind !== undefined && r.kind !== 'prediction') continue;
    if (
      typeof r.doc !== 'string' ||
      typeof r.docClass !== 'string' ||
      typeof r.fields !== 'object' ||
      r.fields === null
    ) {
      throw new Error(`${where} line ${i + 1}: expected { doc, docClass, fields }`);
    }
    out.push({
      kind: 'prediction',
      doc: r.doc,
      docClass: r.docClass,
      repeat: typeof r.repeat === 'number' ? r.repeat : 1,
      fields: r.fields,
      availability: r.availability ?? 'completed',
      requestAttempts: r.requestAttempts ?? 1,
      transportRetries: r.transportRetries ?? 0,
      ...(r.provenance === undefined ? {} : { provenance: r.provenance }),
    });
  }
  return out;
}

export async function readPredictions(paths: readonly string[]): Promise<PredictionRecord[]> {
  const records: PredictionRecord[] = [];
  for (const path of paths)
    records.push(...parsePredictionJsonl(await readFile(path, 'utf8'), path));
  return records;
}

export async function readGoldens(paths: readonly string[]): Promise<LoadedGolden[]> {
  const rows: LoadedGolden[] = [];
  for (const path of paths) rows.push(...parseGoldenJsonl(await readFile(path, 'utf8')));
  return rows;
}

/** `golden.<class>.jsonl` (main) or `probes/golden.<class>.probe.jsonl` (probe), sorted by class. */
export async function corporaGoldenPaths(corporaDir: string, pass: Pass): Promise<string[]> {
  const dir = pass === 'main' ? corporaDir : join(corporaDir, 'probes');
  const re = pass === 'main' ? /^golden\.[^.]+\.jsonl$/ : /^golden\.[^.]+\.probe\.jsonl$/;
  const names = (await readdir(dir)).filter((n) => re.test(n)).sort();
  if (names.length === 0) throw new Error(`no ${pass} golden files in ${dir}`);
  return names.map((n) => join(dir, n));
}

/** `<armDir>/<class>/<pass>/predictions.repeat-NNN.jsonl`, sorted by class then repeat. */
export async function armPredictionPaths(armDir: string, pass: Pass): Promise<string[]> {
  const classes = (await readdir(armDir)).sort();
  const out: string[] = [];
  for (const cls of classes) {
    const dir = join(armDir, cls, pass);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const names = (await readdir(dir))
      .filter((n) => /^predictions\.repeat-\d+\.jsonl$/.test(n))
      .sort();
    out.push(...names.map((n) => join(dir, n)));
  }
  if (out.length === 0)
    throw new Error(`no predictions.repeat-NNN.jsonl under ${armDir}/*/${pass}`);
  return out;
}
