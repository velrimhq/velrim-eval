/**
 * The salt reveal (SALT.md) must keep matching the frozen manifests: sha256(salt) equals every
 * manifest's saltCommitment, and every golden document hashes into its class's cal-test id set
 * under the manifest's own scheme. If either drifts, the held-out claim is no longer checkable.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const CLASSES = ['cord-v2', 'deepform', 'vrdu-ad-buy', 'vrdu-registration'];

const salt = (): string => {
  const md = readFileSync(join(ROOT, 'SALT.md'), 'utf8');
  const m = /^salt\s+([0-9a-f]{32})$/m.exec(md);
  if (!m) throw new Error('SALT.md carries no salt line');
  return m[1]!;
};

describe('SALT.md', () => {
  it('hashes to the commitment stamped in every frozen manifest', () => {
    const s = salt();
    for (const cls of CLASSES) {
      const m = JSON.parse(
        readFileSync(join(ROOT, 'results', 'manifests', `${cls}.manifest.json`), 'utf8'),
      ) as {
        saltCommitment: string;
      };
      expect(sha(s), cls).toBe(m.saltCommitment);
    }
  });

  it('places every golden document in its class cal-test set', () => {
    const s = salt();
    for (const cls of CLASSES) {
      const m = JSON.parse(
        readFileSync(join(ROOT, 'results', 'manifests', `${cls}.manifest.json`), 'utf8'),
      ) as {
        splits: { 'cal-test': { ids: string[] } };
      };
      const ids = new Set(m.splits['cal-test'].ids);
      const docs = readFileSync(join(ROOT, 'corpora', `golden.${cls}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { doc: string }).doc.replace(/\.pdf$/, ''));
      const misses = docs.filter((d) => !ids.has(sha(`${s}:${cls}:${d}`)));
      expect(misses, cls).toEqual([]);
      expect(docs.length, cls).toBe(ids.size);
    }
  });
});
