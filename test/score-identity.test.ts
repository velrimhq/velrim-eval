import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { score, type ScoresFile } from '../src/commands/score.js';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('score prediction identity', () => {
  it('keys runner rows by docClass + doc while retaining legacy doc-only compatibility', async () => {
    root = await mkdtemp(join(tmpdir(), 'veval-score-id-'));
    const goldenPath = join(root, 'golden.jsonl');
    const predictionsPath = join(root, 'predictions.jsonl');
    const golden = [
      {
        doc: 'shared.pdf',
        docClass: 'class-a',
        fields: { '/value': { state: 'present', value: 'A' } },
      },
      {
        doc: 'shared.pdf',
        docClass: 'class-b',
        fields: { '/value': { state: 'present', value: 'B' } },
      },
    ];
    const predictions = [
      { doc: 'shared.pdf', docClass: 'class-a', fields: { '/value': { value: 'A' } } },
      { doc: 'shared.pdf', docClass: 'class-b', fields: { '/value': { value: 'B' } } },
    ];
    await writeFile(goldenPath, golden.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(
      predictionsPath,
      predictions.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );

    const originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (): boolean => true;
    let result: number;
    try {
      result = await score([
        '--predictions',
        predictionsPath,
        '--golden',
        goldenPath,
        '--out',
        root,
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(result).toBe(0);
    const scores = JSON.parse(await readFile(join(root, 'scores.json'), 'utf8')) as ScoresFile;
    expect(scores.corpus).toMatchObject({ docs: 2, f1: 1 });
  });
});
