/**
 * 3-state golden loader.
 *
 * Reads golden.jsonl (one JSON object per line) into a LoadedGolden[] where each row carries:
 *   - doc:    the input doc filename/id (drives the run's doc set + the prediction key space)
 *   - schema: held loader-side for prediction JSON-Schema validation — NEVER passed to scoring
 *             (keeps @velrim/scoring runtime-agnostic + dep-free)
 *   - golden: a { docClass, fields } GoldenDoc — the ONLY thing handed to scoreAgainstGolden
 *
 * Fail-closed rules:
 *   - docClass is REQUIRED per row (deriving from a schema filename is lossy). Missing -> throw.
 *   - each field.state in {present,null,missing}; value present IFF state==='present'.
 *   - JSON parse / shape errors throw with the 1-based line number.
 */

import type { GoldenDoc, FieldState } from '@velrim/scoring';

export interface LoadedGolden {
  doc: string;
  schema?: string;
  golden: GoldenDoc;
}

const STATES: readonly FieldState[] = ['present', 'null', 'missing'];

function isState(s: unknown): s is FieldState {
  return typeof s === 'string' && (STATES as readonly string[]).includes(s);
}

/** Parse + validate the raw newline-delimited golden text. `lineNo` is 1-based for error context. */
export function parseGoldenJsonl(text: string): LoadedGolden[] {
  const out: LoadedGolden[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue; // tolerate blank lines
    const lineNo = i + 1;

    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`golden line ${lineNo}: invalid JSON (${(e as Error).message})`);
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`golden line ${lineNo}: expected a JSON object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r['doc'] !== 'string' || r['doc'].length === 0) {
      throw new Error(`golden line ${lineNo}: missing or empty "doc"`);
    }
    // Explicit docClass required; fail closed.
    if (typeof r['docClass'] !== 'string' || r['docClass'].length === 0) {
      throw new Error(
        `golden line ${lineNo}: missing required "docClass" (do not derive from schema)`,
      );
    }
    if (r['schema'] !== undefined && typeof r['schema'] !== 'string') {
      throw new Error(`golden line ${lineNo}: "schema" must be a string when present`);
    }
    if (typeof r['fields'] !== 'object' || r['fields'] === null || Array.isArray(r['fields'])) {
      throw new Error(`golden line ${lineNo}: "fields" must be an object keyed by JSON Pointer`);
    }

    const rawFields = r['fields'] as Record<string, unknown>;
    const fields: GoldenDoc['fields'] = {};
    for (const key of Object.keys(rawFields)) {
      const cell = rawFields[key];
      if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
        throw new Error(`golden line ${lineNo}: field "${key}" must be an object`);
      }
      const c = cell as Record<string, unknown>;
      if (!isState(c['state'])) {
        throw new Error(
          `golden line ${lineNo}: field "${key}" has invalid state "${String(c['state'])}"`,
        );
      }
      const state = c['state'];
      const hasValue = Object.prototype.hasOwnProperty.call(c, 'value');
      // value present IFF state==='present' (null/missing carry no value).
      if (state === 'present' && !hasValue) {
        throw new Error(`golden line ${lineNo}: field "${key}" state="present" requires a "value"`);
      }
      if (state !== 'present' && hasValue) {
        throw new Error(
          `golden line ${lineNo}: field "${key}" state="${state}" must NOT carry a "value"`,
        );
      }
      fields[key] = state === 'present' ? { state, value: c['value'] } : { state };
    }

    const loaded: LoadedGolden = {
      doc: r['doc'],
      golden: { docClass: r['docClass'], fields },
    };
    if (typeof r['schema'] === 'string') loaded.schema = r['schema'];
    out.push(loaded);
  }

  if (out.length === 0) throw new Error('golden set is empty (no rows parsed)');
  return out;
}
