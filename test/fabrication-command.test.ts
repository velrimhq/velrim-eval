/**
 * `velrim-eval fabrication` — the verb around the judge: file loading, the strike overlay, the
 * arm-dir/corpora discovery, exit codes, and the published-arm round trip (the round-1 cells
 * re-derive from the shipped predictions and goldens).
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fabrication, type FabricationFile } from '../src/commands/fabrication.js';
import { applyStrikes, parsePredictionJsonl } from '../src/fabrication/inputs.js';
import { parseGoldenJsonl } from '../src/golden/loader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const golden = [
  {
    doc: 'a.pdf',
    docClass: 'inv',
    fields: {
      '/total': { state: 'present', value: '10' },
      '/tax': { state: 'missing' },
      '/po': { state: 'missing' },
    },
  },
  {
    doc: 'b.pdf',
    docClass: 'inv',
    fields: { '/total': { state: 'present', value: '20' }, '/tax': { state: 'missing' } },
  },
];

const record = (
  doc: string,
  repeat: number,
  fields: Record<string, unknown>,
  availability = 'completed',
) => JSON.stringify({ kind: 'prediction', doc, docClass: 'inv', repeat, fields, availability });

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'velrim-eval-fab-'));
  await writeFile(
    join(dir, 'golden.jsonl'),
    golden.map((g) => JSON.stringify(g)).join('\n') + '\n',
  );
  await writeFile(
    join(dir, 'predictions.repeat-001.jsonl'),
    [
      record('a.pdf', 1, {
        '/total': { value: '10' },
        '/tax': { value: '1' },
        '/po': { value: null },
      }),
      record('b.pdf', 1, { '/total': { value: '20' }, '/tax': { value: 'n/a' } }),
    ].join('\n') + '\n',
  );
  await writeFile(
    join(dir, 'predictions.repeat-002.jsonl'),
    [
      record('a.pdf', 2, {
        '/total': { value: '10' },
        '/tax': { value: '' },
        '/po': { value: 'PO-1' },
      }),
      record('b.pdf', 2, {}, 'transport_failure'),
    ].join('\n') + '\n',
  );
  await writeFile(
    join(dir, 'strikes.json'),
    JSON.stringify({
      auditedCells: 3,
      struck: [
        { docClass: 'inv', doc: 'a.pdf', field: '/po', reason: 'visible', page: 1, seen: 'PO-1' },
      ],
    }),
  );
  return dir;
}

describe('velrim-eval fabrication', () => {
  it('judges the headline rule over repeats and writes fabrication.json', async () => {
    const dir = await fixture();
    const code = await fabrication([
      '--predictions',
      join(dir, 'predictions.repeat-001.jsonl'),
      '--predictions',
      join(dir, 'predictions.repeat-002.jsonl'),
      '--golden',
      join(dir, 'golden.jsonl'),
      '--resamples',
      '50',
      '--out',
      join(dir, 'out'),
    ]);
    expect(code).toBe(0);
    const file = JSON.parse(
      await readFile(join(dir, 'out', 'fabrication.json'), 'utf8'),
    ) as FabricationFile;
    expect(file.version).toBe(1);
    expect(file.inputs.struck).toBe(0);
    // Cells: a/tax (1, 0 -> 0.5), a/po (0, 1 -> 0.5), b/tax (0 on the one usable repeat) -> 1/3.
    expect(file.breakout.pooled.cells).toBe(3);
    expect(file.breakout.pooled.estimate).toBeCloseTo(1 / 3, 6);
    // Strict: "" and "n/a" count -> a/tax 1.0, a/po 0.5, b/tax 1.0 -> 5/6.
    expect(file.breakout.strictPooled.estimate).toBeCloseTo(5 / 6, 6);
    // All-attempted: b's failed repeat scores 0 -> a/tax 0.5, a/po 0.5, b/tax 0.
    expect(file.breakout.dualAccounting.estimate).toBeCloseTo(1 / 3, 6);
    expect(file.breakout.availability).toEqual({
      attemptedDocRepeats: 4,
      completedDocRepeats: 3,
      availability: 0.75,
    });
    expect(file.kicker).toBeUndefined();
  });

  it('applies the strike overlay to the denominator without touching golden bytes', async () => {
    const dir = await fixture();
    const before = await readFile(join(dir, 'golden.jsonl'), 'utf8');
    const code = await fabrication([
      '--predictions',
      join(dir, 'predictions.repeat-001.jsonl'),
      '--golden',
      join(dir, 'golden.jsonl'),
      '--strikes',
      join(dir, 'strikes.json'),
      '--resamples',
      '50',
      '--out',
      join(dir, 'out'),
    ]);
    expect(code).toBe(0);
    const file = JSON.parse(
      await readFile(join(dir, 'out', 'fabrication.json'), 'utf8'),
    ) as FabricationFile;
    expect(file.inputs.struck).toBe(1);
    expect(file.breakout.pooled.cells).toBe(2);
    expect(await readFile(join(dir, 'golden.jsonl'), 'utf8')).toBe(before);
  });

  it('refuses without --out or without an input pair', async () => {
    expect(await fabrication(['--golden', 'x.jsonl', '--out', 'o'])).toBe(2);
    expect(await fabrication(['--predictions', 'p.jsonl', '--golden', 'g.jsonl'])).toBe(2);
    expect(
      await fabrication([
        '--predictions',
        'p.jsonl',
        '--golden',
        'g.jsonl',
        '--out',
        'o',
        '--pass',
        'x',
      ]),
    ).toBe(2);
    expect(await fabrication(['--bogus'])).toBe(2);
  });

  it('discovers an arm dir and a corpora dir', async () => {
    const dir = await fixture();
    await mkdir(join(dir, 'arm', 'inv', 'main'), { recursive: true });
    for (const n of ['predictions.repeat-001.jsonl', 'predictions.repeat-002.jsonl'])
      await writeFile(join(dir, 'arm', 'inv', 'main', n), await readFile(join(dir, n)));
    await mkdir(join(dir, 'corpora'), { recursive: true });
    await writeFile(
      join(dir, 'corpora', 'golden.inv.jsonl'),
      await readFile(join(dir, 'golden.jsonl')),
    );
    const code = await fabrication([
      '--arm-dir',
      join(dir, 'arm'),
      '--corpora',
      join(dir, 'corpora'),
      '--resamples',
      '50',
      '--out',
      join(dir, 'out'),
    ]);
    expect(code).toBe(0);
    const file = JSON.parse(
      await readFile(join(dir, 'out', 'fabrication.json'), 'utf8'),
    ) as FabricationFile;
    expect(file.inputs.predictions).toHaveLength(2);
    expect(file.inputs.goldens).toHaveLength(1);
    expect(file.breakout.pooled.cells).toBe(3);
  });

  it('re-derives the published round-1 cells for the Velrim arm, main and probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velrim-eval-fab-r1-'));
    const main = await fabrication([
      '--arm-dir',
      join(ROOT, 'results', 'matrix-out', 'velrim'),
      '--corpora',
      join(ROOT, 'corpora'),
      '--strikes',
      join(ROOT, 'corpora', 'natural-strikes.json'),
      '--resamples',
      '100',
      '--out',
      join(dir, 'main'),
    ]);
    expect(main).toBe(0);
    const m = JSON.parse(
      await readFile(join(dir, 'main', 'fabrication.json'), 'utf8'),
    ) as FabricationFile;
    expect(m.inputs.struck).toBe(46);
    expect(m.breakout.pooled.cells).toBe(96);
    expect(m.breakout.pooled.estimate).toBeCloseTo(0.114583, 5);
    expect(m.breakout.goldPresentAnswerRate.estimate).toBeCloseTo(0.88, 2);
    expect(m.breakout.availability.attemptedDocRepeats).toBe(372);
    expect(m.kicker?.meanConfidenceOnFabrications?.estimate).toBeCloseTo(0.3993, 3);

    const probe = await fabrication([
      '--arm-dir',
      join(ROOT, 'results', 'matrix-out', 'velrim'),
      '--corpora',
      join(ROOT, 'corpora'),
      '--pass',
      'probe',
      '--resamples',
      '100',
      '--out',
      join(dir, 'probe'),
    ]);
    expect(probe).toBe(0);
    const p = JSON.parse(
      await readFile(join(dir, 'probe', 'fabrication.json'), 'utf8'),
    ) as FabricationFile;
    expect(p.breakout.pooled.cells).toBe(198);
    expect(p.breakout.pooled.estimate).toBeCloseTo(0.207071, 5);
  }, 60_000);
});

describe('fabrication inputs', () => {
  it('parses prediction rows, skipping checkpoint headers and events', () => {
    const rows = parsePredictionJsonl(
      [
        JSON.stringify({ kind: 'header', version: 1 }),
        record('a.pdf', 1, { '/x': { value: 1 } }),
        '',
        JSON.stringify({ kind: 'event', event: 'circuit_open' }),
      ].join('\n'),
      'p',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields['/x']).toEqual({ value: 1 });
    expect(() => parsePredictionJsonl('{"doc":"a"}', 'p')).toThrow(/line 1/);
  });

  it('strikes only absent cells, never present ones', () => {
    const rows = parseGoldenJsonl(golden.map((g) => JSON.stringify(g)).join('\n'));
    const struck = applyStrikes(rows, {
      auditedCells: 3,
      struck: [
        { docClass: 'inv', doc: 'a.pdf', field: '/po', reason: 'visible', page: 1, seen: 'x' },
        { docClass: 'inv', doc: 'a.pdf', field: '/total', reason: 'visible', page: 1, seen: 'x' },
      ],
    });
    expect(Object.keys(struck[0]!.golden.fields)).toEqual(['/total', '/tax']);
    expect(Object.keys(struck[1]!.golden.fields)).toEqual(['/total', '/tax']);
  });
});
