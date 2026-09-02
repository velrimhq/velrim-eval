/**
 * Hugging Face dataset files (hf-dataset/data): the committed bytes equal a fresh derivation
 * from the published run data, the sweeps pass, the row counts match the frozen corpora, and
 * every fabricated flag agrees with the judge's own pooled estimate.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildDataset,
  FILES,
  parseDenylist,
  serialize,
  sweep,
  type Dataset,
} from '../src/fabrication/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'hf-dataset', 'data');

let cached: Promise<Dataset> | undefined;
const dataset = () =>
  (cached ??= buildDataset({
    resultsDir: join(ROOT, 'results', 'matrix-out'),
    corporaDir: join(ROOT, 'corpora'),
  }));

describe('hf-dataset/data', () => {
  it('matches a fresh derivation byte for byte', async () => {
    const files = serialize(await dataset());
    for (const name of Object.values(FILES)) {
      expect(existsSync(join(DATA, name)), name).toBe(true);
      expect(readFileSync(join(DATA, name), 'utf8') === files[name], `${name} drifted`).toBe(true);
    }
  }, 120_000);

  it('passes the sweeps', async () => {
    expect(sweep(serialize(await dataset()))).toEqual([]);
  }, 120_000);

  it('carries the frozen counts', async () => {
    const d = await dataset();
    const arms = new Set(d.predictions.map((r) => r.arm));
    expect(arms.size).toBe(6);
    expect(d.probes).toHaveLength(12);
    expect(d.probes.filter((p) => p.struck)).toHaveLength(4);
    expect(d.audit).toHaveLength(142);
    expect(d.audit.filter((a) => a.verdict === 'visible')).toHaveLength(40);
    expect(d.audit.filter((a) => a.verdict === 'unverifiable')).toHaveLength(6);
    for (const arm of arms) {
      const main = d.predictions.filter((r) => r.arm === arm && r.pass === 'main');
      const absent = new Set(
        main
          .filter((r) => r.gold_state !== 'present' && !r.struck)
          .map((r) => `${r.doc_class}|${r.doc}|${r.field}`),
      );
      expect(absent.size, arm).toBe(96);
      expect(main.filter((r) => r.struck).length, arm).toBe(46 * 3);
      const probe = new Set(
        d.predictions
          .filter((r) => r.arm === arm && r.pass === 'probe')
          .map((r) => `${r.doc_class}|${r.doc}|${r.field}`),
      );
      expect(probe.size, arm).toBe(198);
    }
  }, 120_000);

  it('agrees with the judge on the Velrim arm (per-cell repeat mean, pooled)', async () => {
    const d = await dataset();
    const cells = new Map<string, number[]>();
    for (const r of d.predictions) {
      if (r.arm !== 'velrim' || r.pass !== 'main' || r.fabricated === null) continue;
      const key = `${r.doc_class}|${r.doc}|${r.field}`;
      (cells.get(key) ?? cells.set(key, []).get(key)!).push(r.fabricated ? 1 : 0);
    }
    const means = [...cells.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    expect(means).toHaveLength(96);
    expect(means.reduce((a, b) => a + b, 0) / means.length).toBeCloseTo(0.114583, 5);
  }, 120_000);

  it('never judges a present, struck, or failed cell', async () => {
    const d = await dataset();
    for (const r of d.predictions) {
      if (r.gold_state === 'present' || r.struck || r.availability !== 'completed') {
        expect(r.fabricated).toBeNull();
        expect(r.fabricated_strict).toBeNull();
      } else {
        expect(typeof r.fabricated).toBe('boolean');
      }
      if (r.predicted_state === 'value') expect(r.fabricated ?? true).toBe(true);
      if (r.predicted_state === 'failed') expect(r.value).toBeNull();
    }
  }, 120_000);

  it('parses a denylist and refuses on a hit', () => {
    const extra = parseDenylist('# comment\n\nsecret-token\n');
    expect(extra).toHaveLength(1);
    expect(sweep({ 'x.jsonl': 'a Secret-Token here' }, extra)).toEqual([
      'x.jsonl: denylist line 1: Secret-Token',
    ]);
    expect(sweep({ 'x.jsonl': 'clean' }, extra)).toEqual([]);
  });
});
