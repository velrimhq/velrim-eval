#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildCorpora, formatCorpusSummary } from './corpora/convert.js';

const HELP = `Build the bake-off CAL-TEST goldens and nullable per-class schemas (zero network/spend).

USAGE
  npm run corpora:convert -- --source <data-dir> --cal-test <cal-test-dir> \\
    --manifests <manifest-dir> --out <out-dir> [options]

OPTIONS
  --source <dir>     Root containing <class>/golden.jsonl [required]
  --cal-test <dir>   Root containing <class>/*.pdf [required]
  --manifests <dir>  Root containing frozen <class>.manifest.json files [required]
  --out <dir>        Output directory [required]
  --class <name>     Build only this class; repeat for multiple classes (default: discover all)
  -h, --help         Show this help
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        source: { type: 'string' },
        'cal-test': { type: 'string' },
        manifests: { type: 'string' },
        out: { type: 'string' },
        class: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(`corpora: ${(error as Error).message}\n${HELP}`);
    return 2;
  }
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const source = parsed.values.source;
  const calTest = parsed.values['cal-test'];
  const manifests = parsed.values.manifests;
  const out = parsed.values.out;
  if (!source || !calTest || !manifests || !out) {
    process.stderr.write(
      `corpora: --source, --cal-test, --manifests and --out are required\n${HELP}`,
    );
    return 2;
  }

  try {
    const summary = await buildCorpora({
      sourceRoot: resolve(source),
      calTestRoot: resolve(calTest),
      manifestRoot: resolve(manifests),
      outDir: resolve(out),
      ...(parsed.values.class ? { classes: parsed.values.class } : {}),
    });
    process.stdout.write(formatCorpusSummary(summary));
    process.stdout.write(`wrote corpora artifacts to ${resolve(out)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`corpora: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `corpora: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
