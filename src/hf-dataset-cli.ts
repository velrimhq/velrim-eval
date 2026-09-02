#!/usr/bin/env node

/**
 * Dataset packaging CLI — derive the Hugging Face dataset files under `hf-dataset/data/` from
 * the published run data (`results/matrix-out`) and the frozen corpora. Deterministic, zero
 * network, zero spend: the same inputs always produce the same bytes. The derivation lives in
 * `src/fabrication/dataset.ts`; this file only parses flags, sweeps, and writes.
 *
 * Before writing, every output byte is swept for local paths, machine names, foreign emails and
 * key-shaped strings; `--denylist <file>` adds one regex per line. Any hit aborts the run.
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildDataset, parseDenylist, serialize, summarize, sweep } from './fabrication/dataset.js';

const HELP = `Hugging Face dataset files from the published run data (zero network/spend; deterministic).

USAGE
  node dist/hf-dataset-cli.js [--results <dir>] [--corpora <dir>] [--out <dir>] [--denylist <file>] [--check]

OPTIONS
  --results <dir>    matrix output root (default results/matrix-out)
  --corpora <dir>    frozen corpora dir (default corpora)
  --out <dir>        output dir (default hf-dataset/data)
  --denylist <file>  extra sweep patterns, one JavaScript regex source per line (# comments allowed),
                     applied case-insensitively; any hit aborts before a byte is written
  --check            do not write; exit 1 if the committed files differ from a fresh build
  -h, --help         Show this help
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        results: { type: 'string' },
        corpora: { type: 'string' },
        out: { type: 'string' },
        denylist: { type: 'string' },
        check: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`hf-dataset: ${(e as Error).message}\n${HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const resultsDir = resolve(values.results ?? 'results/matrix-out');
  const corporaDir = resolve(values.corpora ?? 'corpora');
  const outDir = resolve(values.out ?? 'hf-dataset/data');

  const data = await buildDataset({ resultsDir, corporaDir });
  const files = serialize(data);
  const extra =
    values.denylist === undefined ? [] : parseDenylist(await readFile(values.denylist, 'utf8'));
  const hits = sweep(files, extra);
  if (hits.length > 0) {
    process.stderr.write(`hf-dataset: sweep failed, nothing written:\n  ${hits.join('\n  ')}\n`);
    return 1;
  }

  if (values.check) {
    const drifted: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      const committed = await readFile(join(outDir, name), 'utf8').catch(() => null);
      if (committed !== text) drifted.push(name);
    }
    if (drifted.length > 0) {
      process.stderr.write(
        `hf-dataset: committed files differ from a fresh build: ${drifted.join(', ')}\n`,
      );
      return 1;
    }
    process.stdout.write('hf-dataset: committed files match a fresh build\n');
    return 0;
  }

  await mkdir(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(outDir, name), text);
  process.stdout.write(summarize(data));
  process.stdout.write(`wrote ${Object.keys(files).length} files to ${outDir}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`hf-dataset: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  });
