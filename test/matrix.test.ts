/**
 * Matrix orchestrator — config validation (refit passes excluded, a pre-registered phase-2 item), cap-branch
 * plan mechanics, and a fixture end-to-end over two arm-modes proving the cell
 * layout, per-repeat scoring + per-class scores.json, cost-log receipts harvest, and the
 * authoritative matrix validation (publicationReady stays false for fixture runs). ZERO
 * network — every cell executes the real `run` command against the recorded fixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matrix } from '../src/commands/matrix.js';
import { buildMatrixPlan, validateMatrixConfig, type MatrixConfig } from '../src/matrix/plan.js';

const GOLDEN_ROW =
  '{"doc":"a.pdf","docClass":"invoice","schema":"a.schema.json",' +
  '"fields":{"/vendor":{"state":"present","value":"ACME"}}}';

let work: string;

async function capture<T>(
  fn: () => Promise<T> | T,
): Promise<{ out: string; err: string; value: T }> {
  let out = '';
  let err = '';
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string): boolean => ((out += s), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string): boolean => ((err += s), true);
  try {
    const value = await fn();
    return { out, err, value };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'veval-matrix-'));
  const corpora = join(work, 'corpora');
  await mkdir(join(corpora, 'pdfs', 'invoice'), { recursive: true });
  await mkdir(join(corpora, 'probes'), { recursive: true });
  await writeFile(join(corpora, 'golden.invoice.jsonl'), GOLDEN_ROW + '\n');
  await writeFile(
    join(corpora, 'probes', 'golden.invoice.probe.jsonl'),
    '{"doc":"a.pdf","docClass":"invoice","schema":"invoice.probe-schema.json",' +
      '"fields":{"/agency":{"state":"missing"}}}\n',
  );
  await writeFile(join(corpora, 'pdfs', 'invoice', 'a.pdf'), '%PDF-1.7 matrix doc');
  // FD-10: every class needs its frozen normalizers table — matrix hard-requires it.
  await writeFile(
    join(corpora, 'normalizers.invoice.json'),
    JSON.stringify({ docClass: 'invoice', normalizers: { '/vendor': 'text' } }) + '\n',
  );
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const BASE_CONFIG: MatrixConfig = {
  formatVersion: 1,
  capBranch: 'unresolved',
  classes: ['invoice'],
  repeats: 2,
  passes: ['main'],
  armModes: [
    // Velrim is ONE arm-mode — the served product; no pass concept exists.
    { id: 'velrim', adapter: 'velrim' },
    { id: 'openai-structured', adapter: 'openai', extraArgs: ['--structured-mode'] },
  ],
};

describe('matrix config validation — refit is OUT, reserved flags stay owned', () => {
  it('rejects any refit/CAL-FIT pass by name, citing the pre-registered exclusion', () => {
    for (const pass of ['CAL-FIT-refit-pass', 'refit', 'calfit']) {
      expect(() => validateMatrixConfig({ ...BASE_CONFIG, passes: [pass] })).toThrow(
        /pre-registered: refit columns are a phase-2 item/,
      );
    }
    expect(() => validateMatrixConfig({ ...BASE_CONFIG, passes: ['fitted'] })).toThrow(
      /unknown pass/,
    );
  });

  it('rejects duplicate arm ids, unknown adapters, and reserved extraArgs', () => {
    expect(() =>
      validateMatrixConfig({
        ...BASE_CONFIG,
        armModes: [
          { id: 'a', adapter: 'velrim' },
          { id: 'a', adapter: 'openai' },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      // 'reducto' is consent-gated and has no adapter — a stand-in unknown adapter id.
      validateMatrixConfig({ ...BASE_CONFIG, armModes: [{ id: 'a', adapter: 'reducto' }] }),
    ).toThrow(/unknown adapter/);
    expect(() =>
      validateMatrixConfig({
        ...BASE_CONFIG,
        armModes: [{ id: 'a', adapter: 'velrim', extraArgs: ['--live'] }],
      }),
    ).toThrow(/matrix owns/);
  });
});

describe('matrix planning — cap branches and pass mechanics', () => {
  const PLAN_BASE = {
    corporaDir: '/c',
    pdfsDir: '/p',
    outDir: '/o',
    live: false,
    docCounts: { invoice: { main: 10, probe: 10 } },
    conditionalExclusions: [{ docClass: 'invoice', doc: 'big.pdf' }],
  };

  it('probe pass always runs 1 repeat against the probe golden', () => {
    const cells = buildMatrixPlan({
      ...PLAN_BASE,
      config: { ...BASE_CONFIG, passes: ['main', 'probe'] },
      conditionalExclusions: [],
    });
    const probe = cells.find((c) => c.pass === 'probe')!;
    expect(probe.repeats).toBe(1);
    expect(probe.runArgs.join(' ')).toContain('golden.invoice.probe.jsonl');
    expect(probe.runArgs.join(' ')).toContain('--repeat 1');
    const main = cells.find((c) => c.pass === 'main')!;
    expect(main.runArgs.join(' ')).toContain('--repeat 2');
  });

  it('cap-confirmed: mistral RUNS capped with the armed guard; others score primary capped + appendix full', () => {
    const cells = buildMatrixPlan({
      ...PLAN_BASE,
      config: {
        ...BASE_CONFIG,
        capBranch: 'cap-confirmed',
        armModes: [
          { id: 'mistral-arm', adapter: 'mistral' },
          { id: 'velrim', adapter: 'velrim' },
        ],
      },
    });
    const mistral = cells.find((c) => c.adapter === 'mistral')!;
    expect(mistral.runArgs.join(' ')).toContain('--mistral-cap-branch cap-confirmed');
    expect(mistral.runArgs.join(' ')).toContain('golden.invoice.capped.jsonl');
    expect(mistral.excludedDocs).toEqual(['big.pdf']);
    expect(mistral.scoring.every((j) => j.kind === 'primary')).toBe(true);

    const velrim = cells.find((c) => c.adapter === 'velrim')!;
    expect(velrim.runArgs.join(' ')).not.toContain('capped'); // runs ALL docs
    const primary = velrim.scoring.filter((j) => j.kind === 'primary');
    const appendix = velrim.scoring.filter((j) => j.kind === 'appendix-full-set');
    expect(primary.every((j) => j.goldenPath.includes('capped'))).toBe(true); // pairing preserved
    expect(appendix.length).toBe(primary.length); // the "you dropped documents" answer
    expect(appendix.every((j) => !j.goldenPath.includes('capped'))).toBe(true);
  });

  it('cap-removed: nothing is capped, the guard branch is still recorded on mistral cells', () => {
    const cells = buildMatrixPlan({
      ...PLAN_BASE,
      config: {
        ...BASE_CONFIG,
        capBranch: 'cap-removed',
        armModes: [{ id: 'mistral-arm', adapter: 'mistral' }],
      },
    });
    expect(cells[0]!.runArgs.join(' ')).toContain('--mistral-cap-branch cap-removed');
    expect(cells[0]!.runArgs.join(' ')).not.toContain('capped.jsonl');
    expect(cells.every((c) => c.scoring.every((j) => j.kind === 'primary'))).toBe(true);
  });

  it('a LIVE mistral cell before the smoke resolved the branch is a planning error', () => {
    expect(() =>
      buildMatrixPlan({
        ...PLAN_BASE,
        live: true,
        config: {
          ...BASE_CONFIG,
          capBranch: 'unresolved',
          armModes: [
            {
              id: 'mistral-arm',
              adapter: 'mistral',
              spend: { usdPerDocRepeat: 0.01, basis: 'x', asOf: '2026-07-15' },
            },
          ],
          calTestManifests: { invoice: '/m/invoice.manifest.json' },
        },
      }),
    ).toThrow(/protocol error/);
  });

  it('live cells require spend pricing and per-class manifests', () => {
    expect(() => buildMatrixPlan({ ...PLAN_BASE, live: true, config: BASE_CONFIG })).toThrow(
      /spend pricing/,
    );
    const SPEND = { usdPerDocRepeat: 0.02, basis: 'list', asOf: '2026-07-15' };
    expect(() =>
      buildMatrixPlan({
        ...PLAN_BASE,
        live: true,
        config: {
          ...BASE_CONFIG,
          armModes: [{ id: 'a', adapter: 'velrim', spend: SPEND }],
        },
      }),
    ).toThrow(/calTestManifests/);
    const cells = buildMatrixPlan({
      ...PLAN_BASE,
      live: true,
      config: {
        ...BASE_CONFIG,
        armModes: [{ id: 'a', adapter: 'velrim', spend: SPEND }],
        calTestManifests: { invoice: '/m/invoice.manifest.json' },
      },
    });
    // 10 docs × 2 repeats × $0.02 — the preflight prints honest per-cell spend.
    expect(cells[0]!.runArgs.join(' ')).toContain('--expected-spend-usd 0.4000');
    expect(cells[0]!.runArgs.join(' ')).toContain('--cal-test-manifest invoice=');
  });
});

describe('matrix end-to-end over fixtures (ZERO network)', () => {
  it('runs every cell, scores per repeat, writes scores.json + cost-log + manifest', async () => {
    const outDir = join(work, 'out-e2e');
    await writeFile(join(work, 'matrix.json'), JSON.stringify(BASE_CONFIG));
    const r = await capture(() =>
      matrix([
        '--config',
        join(work, 'matrix.json'),
        '--corpora',
        join(work, 'corpora'),
        '--out',
        outDir,
      ]),
    );
    expect(r.err).toBe('');
    expect(r.value).toBe(0);

    // Cell layout + per-repeat outputs from the composed run command.
    const cellDir = join(outDir, 'velrim', 'invoice', 'main');
    expect(existsSync(join(cellDir, 'predictions.repeat-001.jsonl'))).toBe(true);
    expect(existsSync(join(cellDir, 'predictions.repeat-002.jsonl'))).toBe(true);
    expect(existsSync(join(cellDir, 'score.repeat-001', 'scores.json'))).toBe(true);

    // Per-repeat scoring received the class's frozen normalizers table (FD-10 dual columns).
    const repeatScores = JSON.parse(
      await readFile(join(cellDir, 'score.repeat-001', 'scores.json'), 'utf8'),
    ) as { normalized?: { docClass: string; corpus: { f1: number } } };
    expect(repeatScores.normalized).toBeDefined();
    expect(repeatScores.normalized!.docClass).toBe('invoice');

    // Per-class scores.json summary: per-repeat corpus stats + their mean, BOTH columns.
    const scores = JSON.parse(await readFile(join(cellDir, 'scores.json'), 'utf8')) as {
      cell: { armMode: string; pass: string };
      repeats: Array<{ repeat: number; kind: string; normalizedCorpus?: { f1: number } }>;
      meanOverRepeats: { f1: number };
      meanOverRepeatsNormalized: { f1: number };
    };
    expect(scores.cell).toMatchObject({ armMode: 'velrim', pass: 'main' });
    expect(scores.repeats).toHaveLength(2);
    expect(scores.meanOverRepeats.f1).toBeGreaterThanOrEqual(0);
    expect(scores.repeats.every((r) => r.normalizedCorpus !== undefined)).toBe(true);
    // Normalization can only ADD matches, so the normalized mean never drops below strict.
    expect(scores.meanOverRepeatsNormalized.f1).toBeGreaterThanOrEqual(scores.meanOverRepeats.f1);

    // The cell manifest records that fixture mode made no stamp assertion, and the Velrim
    // pin gap stays open (the default recording carries no calibrator stamp).
    const cellManifest = JSON.parse(await readFile(join(cellDir, 'run-manifest.json'), 'utf8')) as {
      requestedConfiguration: { generationSettings: Record<string, unknown> };
      observedVersions: { calibrator: { status: string } };
      missingFields: string[];
    };
    expect(cellManifest.requestedConfiguration.generationSettings['requireFittedStamp']).toBe(
      false,
    );
    expect(cellManifest.observedVersions.calibrator.status).toBe('not_surfaced');
    expect(cellManifest.missingFields).toContain('observedVersions.calibrator.mintedFittedStamp');

    // Cost log: one row per cell, preflight + receipts harvested from the manifests.
    const costLog = JSON.parse(await readFile(join(outDir, 'cost-log.json'), 'utf8')) as {
      cells: Array<{ cell: string; status: string; spendPreflight: unknown; requestIds: string[] }>;
    };
    expect(costLog.cells).toHaveLength(2);
    for (const row of costLog.cells) {
      expect(row.status).toBe('completed');
      expect(row.spendPreflight).not.toBeNull();
      expect(Array.isArray(row.requestIds)).toBe(true);
    }

    // The authoritative matrix validation: fixture runs can NEVER be publication-ready.
    const manifest = JSON.parse(await readFile(join(outDir, 'matrix-manifest.json'), 'utf8')) as {
      validation: { owner: string; publicationReady: boolean; missingFields: string[] };
      cells: Array<{ status: string }>;
    };
    expect(manifest.validation.owner).toBe('matrix-orchestrator');
    expect(manifest.validation.publicationReady).toBe(false);
    expect(manifest.validation.missingFields.join('\n')).toContain('run.mode=live');
    expect(manifest.cells.every((c) => c.status === 'completed')).toBe(true);
  }, 30_000);

  it('--plan-only prints each cell argv and executes nothing', async () => {
    const outDir = join(work, 'out-plan');
    await writeFile(join(work, 'matrix-plan.json'), JSON.stringify(BASE_CONFIG));
    const r = await capture(() =>
      matrix([
        '--config',
        join(work, 'matrix-plan.json'),
        '--corpora',
        join(work, 'corpora'),
        '--out',
        outDir,
        '--plan-only',
      ]),
    );
    expect(r.value).toBe(0);
    expect(r.out).toContain('velrim/invoice/main');
    expect(r.out).toContain('--structured-mode');
    expect(existsSync(join(outDir, 'velrim'))).toBe(false);
  });

  it('an unknown --cell filter is a usage error naming the expected shape', async () => {
    await writeFile(join(work, 'matrix-cell.json'), JSON.stringify(BASE_CONFIG));
    const r = await capture(() =>
      matrix([
        '--config',
        join(work, 'matrix-cell.json'),
        '--corpora',
        join(work, 'corpora'),
        '--out',
        join(work, 'out-cell'),
        '--cell',
        'nope/invoice/main',
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('<armMode>/<class>/<pass>');
  });

  it('a missing normalizers table fails fast, BEFORE any cell runs (FD-10 hard requirement)', async () => {
    const corpora = join(work, 'corpora-nonorm');
    await mkdir(join(corpora, 'pdfs', 'invoice'), { recursive: true });
    await writeFile(join(corpora, 'golden.invoice.jsonl'), GOLDEN_ROW + '\n');
    await writeFile(join(corpora, 'pdfs', 'invoice', 'a.pdf'), '%PDF-1.7 matrix doc');
    await writeFile(join(work, 'matrix-nonorm.json'), JSON.stringify(BASE_CONFIG));
    const outDir = join(work, 'out-nonorm');
    const r = await capture(() =>
      matrix(['--config', join(work, 'matrix-nonorm.json'), '--corpora', corpora, '--out', outDir]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('normalizers.invoice.json');
    expect(existsSync(join(outDir, 'velrim'))).toBe(false); // nothing ran
  });

  it('a table frozen for another docClass fails fast with both class names', async () => {
    const corpora = join(work, 'corpora-wrongnorm');
    await mkdir(join(corpora, 'pdfs', 'invoice'), { recursive: true });
    await writeFile(join(corpora, 'golden.invoice.jsonl'), GOLDEN_ROW + '\n');
    await writeFile(join(corpora, 'pdfs', 'invoice', 'a.pdf'), '%PDF-1.7 matrix doc');
    await writeFile(
      join(corpora, 'normalizers.invoice.json'),
      JSON.stringify({ docClass: 'receipt', normalizers: { '/vendor': 'text' } }) + '\n',
    );
    await writeFile(join(work, 'matrix-wrongnorm.json'), JSON.stringify(BASE_CONFIG));
    const r = await capture(() =>
      matrix([
        '--config',
        join(work, 'matrix-wrongnorm.json'),
        '--corpora',
        corpora,
        '--out',
        join(work, 'out-wrongnorm'),
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('receipt');
    expect(r.err).toContain('invoice');
  });

  it('a missing probe golden fails fast, pointing at probes-cli generate', async () => {
    const corpora = join(work, 'corpora-noprobe');
    await mkdir(join(corpora, 'pdfs', 'invoice'), { recursive: true });
    await writeFile(join(corpora, 'golden.invoice.jsonl'), GOLDEN_ROW + '\n');
    await writeFile(
      join(work, 'matrix-probe.json'),
      JSON.stringify({ ...BASE_CONFIG, passes: ['main', 'probe'] }),
    );
    const r = await capture(() =>
      matrix([
        '--config',
        join(work, 'matrix-probe.json'),
        '--corpora',
        corpora,
        '--out',
        join(work, 'out-noprobe'),
      ]),
    );
    expect(r.value).toBe(2);
    expect(r.err).toContain('probes-cli generate');
  });
});
