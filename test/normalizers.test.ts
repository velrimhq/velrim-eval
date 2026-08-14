/**
 * FD-10 normalizer-table plumbing (ANALYSIS-PLAN.md §5.2).
 *
 * The scoring package ships the normalization MACHINERY; the per-class pointer→kind tables are
 * frozen files in THIS repo. This module is the seam between them: it loads/validates a
 * `normalizers.<class>.json` and resolves a golden leaf's concrete JSON Pointer to its table
 * kind under the pre-registered mechanical rule — replace every purely-numeric reference token
 * with `*`, then look the result up literally. "No other pattern syntax exists."
 *
 * Fail-closed: a malformed table throws at load time (never a silent strict-only run), and a
 * table key containing a purely-numeric token is REJECTED as unreachable (a golden leaf is
 * always wildcarded before lookup, so `/line_items/0/x` could never match anything — that is an
 * authoring mistake, not a narrower rule).
 */

import { describe, expect, it } from 'vitest';
import {
  leafNormalizers,
  normalizerKindFor,
  parseNormalizerTable,
  wildcardPointer,
  type NormalizerTable,
} from '../src/score/normalizers.js';

const VALID = JSON.stringify({
  docClass: 'vrdu-ad-buy',
  normalizers: {
    '/advertiser': 'text',
    '/flight_from': 'date',
    '/gross_amount': 'currency',
    '/line_items/*/sub_amount': 'currency',
  },
});

describe('parseNormalizerTable', () => {
  it('parses a valid frozen table', () => {
    const table = parseNormalizerTable(VALID);
    expect(table.docClass).toBe('vrdu-ad-buy');
    expect(table.normalizers['/gross_amount']).toBe('currency');
    expect(table.normalizers['/line_items/*/sub_amount']).toBe('currency');
    expect(Object.keys(table.normalizers)).toHaveLength(4);
  });

  it('throws on invalid JSON with context', () => {
    expect(() => parseNormalizerTable('{ not json')).toThrow(/invalid JSON/);
  });

  it('throws on a non-object root (array, null, scalar)', () => {
    expect(() => parseNormalizerTable('[]')).toThrow(/expected a JSON object/);
    expect(() => parseNormalizerTable('null')).toThrow(/expected a JSON object/);
    expect(() => parseNormalizerTable('"x"')).toThrow(/expected a JSON object/);
  });

  it('throws on a missing or empty docClass', () => {
    expect(() => parseNormalizerTable(JSON.stringify({ normalizers: { '/a': 'text' } }))).toThrow(
      /docClass/,
    );
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: '', normalizers: { '/a': 'text' } })),
    ).toThrow(/docClass/);
  });

  it('throws when normalizers is missing or not a plain object', () => {
    expect(() => parseNormalizerTable(JSON.stringify({ docClass: 'x' }))).toThrow(/normalizers/);
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: ['/a'] })),
    ).toThrow(/normalizers/);
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: null })),
    ).toThrow(/normalizers/);
  });

  it('throws on an unknown normalizer kind', () => {
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: { '/a': 'money' } })),
    ).toThrow(/\/a.*money/);
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: { '/a': 7 } })),
    ).toThrow(/\/a/);
  });

  it('throws on a key that is not a leaf JSON Pointer (must start with "/")', () => {
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: { advertiser: 'text' } })),
    ).toThrow(/JSON Pointer/);
    expect(() =>
      parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: { '': 'text' } })),
    ).toThrow(/JSON Pointer/);
  });

  it('REJECTS a table key containing a purely-numeric token (unreachable — wants *)', () => {
    expect(() =>
      parseNormalizerTable(
        JSON.stringify({ docClass: 'x', normalizers: { '/line_items/0/sub_amount': 'currency' } }),
      ),
    ).toThrow(/unreachable.*\*/s);
  });

  it('accepts an empty normalizers table (all-strict class is coherent, if unusual)', () => {
    const table = parseNormalizerTable(JSON.stringify({ docClass: 'x', normalizers: {} }));
    expect(Object.keys(table.normalizers)).toHaveLength(0);
  });
});

describe('wildcardPointer — the mechanical rule, token by token', () => {
  it('replaces a purely-numeric token with *', () => {
    expect(wildcardPointer('/line_items/0/sub_amount')).toBe('/line_items/*/sub_amount');
    expect(wildcardPointer('/line_items/17/sub_amount')).toBe('/line_items/*/sub_amount');
  });

  it('replaces EVERY purely-numeric token, at any depth', () => {
    expect(wildcardPointer('/a/0/b/12/c')).toBe('/a/*/b/*/c');
    expect(wildcardPointer('/0')).toBe('/*');
  });

  it('leaves pointers without numeric tokens untouched (literal match)', () => {
    expect(wildcardPointer('/advertiser')).toBe('/advertiser');
    expect(wildcardPointer('/line_items')).toBe('/line_items');
  });

  it('"purely-numeric" means the WHOLE token: mixed tokens are not replaced', () => {
    expect(wildcardPointer('/a/1a/b')).toBe('/a/1a/b');
    expect(wildcardPointer('/a/x0')).toBe('/a/x0');
  });

  it('a token with leading zeros is still purely numeric', () => {
    expect(wildcardPointer('/a/007/b')).toBe('/a/*/b');
  });

  it('RFC 6901 escape tokens (~0, ~1) are not numeric and pass through raw', () => {
    expect(wildcardPointer('/a~0b/0')).toBe('/a~0b/*');
    expect(wildcardPointer('/a~1b')).toBe('/a~1b');
  });

  it('the array-append token "-" and empty tokens are not numeric', () => {
    expect(wildcardPointer('/items/-')).toBe('/items/-');
    expect(wildcardPointer('/a//b')).toBe('/a//b');
  });

  it('non-ASCII digits are not "purely numeric" (RFC 6901 array indices are ASCII decimal)', () => {
    expect(wildcardPointer('/a/٠/b')).toBe('/a/٠/b');
  });
});

describe('normalizerKindFor', () => {
  const table: NormalizerTable = parseNormalizerTable(VALID);

  it('resolves a concrete array leaf through its wildcard form', () => {
    expect(normalizerKindFor('/line_items/0/sub_amount', table)).toBe('currency');
    expect(normalizerKindFor('/line_items/42/sub_amount', table)).toBe('currency');
  });

  it('resolves a top-level leaf literally', () => {
    expect(normalizerKindFor('/advertiser', table)).toBe('text');
    expect(normalizerKindFor('/flight_from', table)).toBe('date');
  });

  it('returns undefined for an unlisted leaf (strict match)', () => {
    expect(normalizerKindFor('/contract_num', table)).toBeUndefined();
    expect(normalizerKindFor('/line_items/0/channel', table)).toBeUndefined();
  });

  it('an unlisted wildcard form does NOT fall back to a partial or prefix match', () => {
    // /line_items/0 wildcards to /line_items/* — not listed; the deeper sub_amount key must
    // not bleed onto the parent.
    expect(normalizerKindFor('/line_items/0', table)).toBeUndefined();
  });

  it('never resolves through the object prototype', () => {
    expect(normalizerKindFor('/toString', table)).toBeUndefined();
    expect(normalizerKindFor('/__proto__', table)).toBeUndefined();
    expect(normalizerKindFor('/constructor', table)).toBeUndefined();
  });

  it('a literal "*" member name in a golden pointer matches the table key (mechanical rule — no other pattern syntax exists)', () => {
    expect(normalizerKindFor('/line_items/*/sub_amount', table)).toBe('currency');
  });
});

describe('leafNormalizers — the concrete per-doc map handed to scoreAgainstGolden', () => {
  const table: NormalizerTable = parseNormalizerTable(VALID);

  it('maps only the leaves that resolve, keyed by the CONCRETE pointer', () => {
    const map = leafNormalizers(
      ['/advertiser', '/contract_num', '/line_items/0/sub_amount', '/line_items/1/sub_amount'],
      table,
    );
    expect(map).toEqual({
      '/advertiser': 'text',
      '/line_items/0/sub_amount': 'currency',
      '/line_items/1/sub_amount': 'currency',
    });
  });

  it('returns an empty map when nothing resolves', () => {
    expect(leafNormalizers(['/x', '/y/0/z'], table)).toEqual({});
  });
});
