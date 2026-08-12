import { describe, expect, it } from 'vitest';

import { escapeJsonPointerToken, flattenJsonLeaves } from '../src/adapters/flatten.js';

describe('flattenJsonLeaves', () => {
  it('recurses through nested objects and arrays to primitive and null leaves', () => {
    expect(
      flattenJsonLeaves({
        billing: { total: 0, paid: false, note: '', tax: null },
        items: [{ 'sku/id': 'A', 'meta~flag': true }, ['x', null]],
        'a~/b': { '': 1 },
      }),
    ).toEqual({
      '/billing/total': 0,
      '/billing/paid': false,
      '/billing/note': '',
      '/billing/tax': null,
      '/items/0/sku~1id': 'A',
      '/items/0/meta~0flag': true,
      '/items/1/0': 'x',
      '/items/1/1': null,
      '/a~0~1b/': 1,
    });
  });

  it('escapes every object-key token and leaves array indices unescaped', () => {
    expect(flattenJsonLeaves({ 'a/b': [{ 'm~n/o': true }] })).toEqual({
      '/a~1b/0/m~0n~1o': true,
    });
    expect(escapeJsonPointerToken('~a/b')).toBe('~0a~1b');
  });

  it('omits empty object and array containers instead of fabricating leaves', () => {
    expect(
      flattenJsonLeaves({ empty_object: {}, empty_array: [], nested: { empty: [] }, value: '' }),
    ).toEqual({ '/value': '' });
  });
});
