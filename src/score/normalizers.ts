/**
 * FD-10 normalizer-table plumbing (ANALYSIS-PLAN.md §5.2).
 *
 * @velrim/scoring ships the normalization MACHINERY (`normalizeValue`, and the `normalizers`
 * option on `scoreAgainstGolden`) but deliberately not the per-class pointer→kind tables —
 * those are pre-registration artifacts frozen in this repo as `corpora/normalizers.<class>.json`.
 * This module is the seam: load + validate a frozen table, and resolve a golden leaf's concrete
 * JSON Pointer to its kind under the plan's mechanical rule:
 *
 *   replace every purely-numeric reference token with `*`, then look the result up literally;
 *   pointers without numeric tokens match their table key as-is. No other pattern syntax exists.
 *
 * Fail-closed: a malformed table THROWS (a bad file must never silently degrade a run to
 * strict-only — both columns publish for every arm), and a table key containing a purely-numeric
 * token is rejected as unreachable (golden leaves are always wildcarded before lookup, so such a
 * key could never match; that is an authoring mistake).
 */

import type { ValueNormalizer } from '@velrim/scoring';

export interface NormalizerTable {
  docClass: string;
  /** table key = leaf JSON Pointer with numeric tokens as `*` → the kind applied to BOTH sides. */
  normalizers: Record<string, ValueNormalizer>;
}

const KINDS: readonly ValueNormalizer[] = ['currency', 'date', 'text'];

function isKind(v: unknown): v is ValueNormalizer {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/** A purely-numeric reference token (RFC 6901 array index shape — ASCII decimal only). */
const NUMERIC_TOKEN = /^\d+$/;

/**
 * The mechanical lookup form of a concrete leaf pointer: every purely-numeric reference token
 * becomes `*` (the 17 in `/line_items/17/sub_amount` turns into a `*` token); everything else —
 * including `~0`/`~1` escapes, the `-` append token, and empty tokens — passes through raw.
 */
export function wildcardPointer(pointer: string): string {
  return pointer
    .split('/')
    .map((token, i) => (i > 0 && NUMERIC_TOKEN.test(token) ? '*' : token))
    .join('/');
}

/** Parse + validate the raw text of a `normalizers.<class>.json`. Throws on any defect. */
export function parseNormalizerTable(text: string): NormalizerTable {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`normalizers table: invalid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('normalizers table: expected a JSON object { docClass, normalizers }');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['docClass'] !== 'string' || r['docClass'].length === 0) {
    throw new Error('normalizers table: missing or empty "docClass"');
  }
  const rawMap = r['normalizers'];
  if (typeof rawMap !== 'object' || rawMap === null || Array.isArray(rawMap)) {
    throw new Error('normalizers table: "normalizers" must be an object keyed by JSON Pointer');
  }

  const normalizers: Record<string, ValueNormalizer> = {};
  for (const key of Object.keys(rawMap)) {
    if (!key.startsWith('/')) {
      throw new Error(
        `normalizers table: key "${key}" is not a leaf JSON Pointer (must start with "/")`,
      );
    }
    if (
      key
        .split('/')
        .slice(1)
        .some((token) => NUMERIC_TOKEN.test(token))
    ) {
      throw new Error(
        `normalizers table: key "${key}" contains a purely-numeric token and is unreachable — ` +
          'golden leaves are wildcarded before lookup; write the array position as "*"',
      );
    }
    const kind = (rawMap as Record<string, unknown>)[key];
    if (!isKind(kind)) {
      throw new Error(
        `normalizers table: key "${key}" has unknown kind "${String(kind)}" ` +
          '(expected "currency" | "date" | "text")',
      );
    }
    normalizers[key] = kind;
  }

  return { docClass: r['docClass'], normalizers };
}

/**
 * The kind for one concrete golden leaf, or undefined (= strict match). Own-property lookup
 * only — a leaf named like an Object.prototype member must never resolve through the prototype.
 */
export function normalizerKindFor(
  pointer: string,
  table: NormalizerTable,
): ValueNormalizer | undefined {
  const key = wildcardPointer(pointer);
  return Object.prototype.hasOwnProperty.call(table.normalizers, key)
    ? table.normalizers[key]
    : undefined;
}

/**
 * The concrete per-doc pointer→kind map for `scoreAgainstGolden`'s `normalizers` option: each
 * golden leaf that resolves through the table, keyed by its CONCRETE pointer (the scoring
 * package does literal per-leaf lookups; the wildcard rule lives entirely on this side).
 */
export function leafNormalizers(
  leafPointers: Iterable<string>,
  table: NormalizerTable,
): Record<string, ValueNormalizer> {
  const out: Record<string, ValueNormalizer> = {};
  for (const pointer of leafPointers) {
    const kind = normalizerKindFor(pointer, table);
    if (kind !== undefined) out[pointer] = kind;
  }
  return out;
}
