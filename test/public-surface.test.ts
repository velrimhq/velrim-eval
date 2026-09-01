/**
 * Exposure lint for the published run data. Everything under results/, figures/, corpora/pdfs/
 * and the write-up ships as-is; these assertions fail the suite if a local path, a machine
 * name, a non-Velrim email, a key-shaped string, or a lock leftover slips into the tree, and
 * pin that the reproduce commands in BAKE-OFF.md point at files that exist.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const SWEEPS: Array<[string, RegExp]> = [
  ['local path', /[A-Za-z]:\\|\/Users\/|\/home\//],
  ['machine identity', /hostname|DESKTOP-|LAPTOP-/i],
  ['non-velrim email', /[A-Za-z0-9._%+-]+@(?!velrim\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['key-shaped string', /AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{15,}/],
];

describe('published run data (results/, figures/, corpora/pdfs/)', () => {
  const results = join(ROOT, 'results');
  const textFiles = ['results', 'smoke-out', 'figures']
    .map((d) => join(ROOT, d))
    .filter((d) => existsSync(d))
    .flatMap((d) => walk(d))
    .filter((p) => /\.(json|jsonl|md|txt|csv|svg)$/.test(p));

  it('exists with the matrix, archive and manifests the article cites', () => {
    for (const d of ['matrix-out', 'archive', 'manifests'])
      expect(existsSync(join(results, d))).toBe(true);
    expect(textFiles.length).toBeGreaterThan(100);
  });

  it('contains no lock leftovers', () => {
    expect(walk(results).filter((p) => /run\.lock\.json/.test(p))).toEqual([]);
  });

  it('carries no local path, machine name, foreign email, key, or internal id', () => {
    const hits: string[] = [];
    for (const p of textFiles) {
      const raw = readFileSync(p, 'utf8');
      for (const [name, re] of SWEEPS) {
        const m = raw.match(re);
        if (m) hits.push(`${relative(ROOT, p)}: ${name}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('ships one PDF per golden document, and nothing else', () => {
    for (const cls of ['cord-v2', 'deepform', 'vrdu-ad-buy', 'vrdu-registration']) {
      const docs = readFileSync(join(ROOT, 'corpora', `golden.${cls}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { doc: string }).doc)
        .sort();
      const pdfs = readdirSync(join(ROOT, 'corpora', 'pdfs', cls))
        .filter((f) => !f.startsWith('.'))
        .sort();
      expect(pdfs).toEqual(docs);
    }
  });

  it('BAKE-OFF.md reproduce commands point at files that exist', () => {
    const md = readFileSync(join(ROOT, 'BAKE-OFF.md'), 'utf8');
    const paths = [...md.matchAll(/(?:results|corpora)\/[A-Za-z0-9_./-]+\.(?:jsonl|json)/g)].map(
      (m) => m[0],
    );
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });
});
