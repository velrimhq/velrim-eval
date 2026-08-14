/**
 * `velrim-eval score --normalizers` — the FD-10 dual-column plumbing, end to end.
 *
 * Contract under test (ANALYSIS-PLAN.md §5.2 + the scores.json back-compat pledge):
 *   - the EXISTING scores.json fields stay the STRICT column, byte-identical with or without
 *     the flag (ci/report/calibrate/curves keep reading version 1 unchanged);
 *   - the flag adds an additive `normalized` block (corpus + points + table provenance) and a
 *     per-doc `normalized` sub-object;
 *   - a wrong table is a hard exit 2 — docClass mismatch, unreadable file, malformed table.
 *     Both columns publish for every arm; silently degrading to strict-only is forbidden.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { score, type ScoresFile } from '../src/commands/score.js';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Run the command with stdout/stderr captured; returns { exit, stderr }. */
async function runScore(args: string[]): Promise<{ exit: number; stderr: string }> {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (): boolean => true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    return { exit: await score(args), stderr };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

const GOLDEN_ROWS = [
  {
    doc: 'a.pdf',
    docClass: 'invoice',
    fields: {
      '/amount': { state: 'present', value: '1880' },
      '/issued': { state: 'present', value: '2020-02-07' },
      '/id': { state: 'present', value: 'X-1' },
    },
  },
  {
    doc: 'b.pdf',
    docClass: 'invoice',
    fields: {
      '/amount': { state: 'present', value: '-2000' },
      '/id': { state: 'missing' },
    },
  },
];

const PRED_ROWS = [
  {
    doc: 'a.pdf',
    docClass: 'invoice',
    fields: {
      '/amount': { value: '$1,880.00', confidence: 0.9 }, // normalized match only
      '/issued': { value: '2020-02-07', confidence: 0.8 }, // strict match
      '/id': { value: ' X-1 ', confidence: 0.7 }, // UNLISTED leaf: wrong in both columns
    },
  },
  {
    doc: 'b.pdf',
    docClass: 'invoice',
    fields: {
      '/amount': { value: '(2,000.00)', confidence: 0.6 }, // normalized match only
      '/id': { value: null }, // explicit null vs golden missing: correct negative (FD-8)
    },
  },
];

const TABLE = {
  docClass: 'invoice',
  normalizers: { '/amount': 'currency', '/issued': 'date' },
};

async function writeFixture(
  dir: string,
  table: unknown = TABLE,
): Promise<{
  golden: string;
  predictions: string;
  normalizers: string;
}> {
  const golden = join(dir, 'golden.jsonl');
  const predictions = join(dir, 'predictions.jsonl');
  const normalizers = join(dir, 'normalizers.invoice.json');
  await writeFile(golden, GOLDEN_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(predictions, PRED_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(normalizers, JSON.stringify(table, null, 2) + '\n');
  return { golden, predictions, normalizers };
}

async function readScores(dir: string): Promise<ScoresFile> {
  return JSON.parse(await readFile(join(dir, 'scores.json'), 'utf8')) as ScoresFile;
}

describe('score --normalizers (FD-10 dual columns)', () => {
  it('emits the normalized block alongside a byte-identical strict column', async () => {
    root = await mkdtemp(join(tmpdir(), 'veval-score-norm-'));
    const paths = await writeFixture(root);

    const strictDir = join(root, 'out-strict');
    const dualDir = join(root, 'out-dual');
    expect(
      (
        await runScore([
          '--predictions',
          paths.predictions,
          '--golden',
          paths.golden,
          '--out',
          strictDir,
        ])
      ).exit,
    ).toBe(0);
    expect(
      (
        await runScore([
          '--predictions',
          paths.predictions,
          '--golden',
          paths.golden,
          '--out',
          dualDir,
          '--normalizers',
          paths.normalizers,
        ])
      ).exit,
    ).toBe(0);

    const strictOnly = await readScores(strictDir);
    const dual = await readScores(dualDir);

    // Back-compat pledge: every pre-existing field is byte-identical with or without the flag.
    expect(strictOnly.normalized).toBeUndefined();
    expect(dual.version).toBe(1);
    expect(dual.corpus).toEqual(strictOnly.corpus);
    expect(dual.points).toEqual(strictOnly.points);
    expect(dual.perDoc.map((d) => ({ ...d, normalized: undefined }))).toEqual(
      strictOnly.perDoc.map((d) => ({ ...d, normalized: undefined })),
    );

    // Strict column: only /issued (a.pdf) matches byte-wise → TP=1 of 4 positives; the
    // null-vs-missing /id (b.pdf) is a correct negative.
    expect(dual.corpus.cells).toEqual({ tp: 1, fp: 3, fn: 3 });

    // Normalized column: /amount flips on both docs; unlisted /id stays wrong.
    expect(dual.normalized).toBeDefined();
    expect(dual.normalized!.corpus.cells).toEqual({ tp: 3, fp: 1, fn: 1 });
    expect(dual.normalized!.corpus.f1).toBeGreaterThan(dual.corpus.f1);
    expect(dual.normalized!.docClass).toBe('invoice');
    expect(dual.normalized!.points).toHaveLength(dual.points.length);
    // Confidence order is shared between the columns; only the labels move.
    expect(dual.normalized!.points.map((p) => p.confidence)).toEqual(
      dual.points.map((p) => p.confidence),
    );

    // Table provenance: sha256 over the table file's exact bytes.
    const tableBytes = await readFile(paths.normalizers);
    expect(dual.normalized!.tableSha256).toBe(
      createHash('sha256').update(tableBytes).digest('hex'),
    );

    // Per-doc dual column: normalized sub-object with the same metric shape.
    for (const d of dual.perDoc) {
      expect(d.normalized).toBeDefined();
      expect(Object.keys(d.normalized!.perField).sort()).toEqual(Object.keys(d.perField).sort());
    }
    const aStrict = dual.perDoc.find((d) => d.doc === 'a.pdf')!;
    expect(aStrict.perField['/amount']!.f1).toBe(0); // strict: formatting mismatch
    expect(aStrict.normalized!.perField['/amount']!.f1).toBe(1); // normalized: match
    expect(aStrict.normalized!.perField['/id']!.f1).toBe(0); // unlisted: wrong in both
  });

  it('exits 2 when the table docClass does not match the golden rows', async () => {
    root = await mkdtemp(join(tmpdir(), 'veval-score-norm-'));
    const paths = await writeFixture(root, { ...TABLE, docClass: 'receipt' });
    const { exit, stderr } = await runScore([
      '--predictions',
      paths.predictions,
      '--golden',
      paths.golden,
      '--out',
      join(root, 'out'),
      '--normalizers',
      paths.normalizers,
    ]);
    expect(exit).toBe(2);
    expect(stderr).toMatch(/docClass/);
    expect(stderr).toMatch(/receipt/);
    expect(stderr).toMatch(/invoice/);
  });

  it('exits 2 on a malformed table (never silently degrades to strict-only)', async () => {
    root = await mkdtemp(join(tmpdir(), 'veval-score-norm-'));
    const paths = await writeFixture(root, {
      docClass: 'invoice',
      normalizers: { '/amount': 'money' },
    });
    const { exit, stderr } = await runScore([
      '--predictions',
      paths.predictions,
      '--golden',
      paths.golden,
      '--out',
      join(root, 'out'),
      '--normalizers',
      paths.normalizers,
    ]);
    expect(exit).toBe(2);
    expect(stderr).toMatch(/money/);
  });

  it('exits 2 when the table file does not exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'veval-score-norm-'));
    const paths = await writeFixture(root);
    const { exit } = await runScore([
      '--predictions',
      paths.predictions,
      '--golden',
      paths.golden,
      '--out',
      join(root, 'out'),
      '--normalizers',
      join(root, 'nope.json'),
    ]);
    expect(exit).toBe(2);
  });
});
