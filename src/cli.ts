#!/usr/bin/env node
/**
 * velrim-eval dispatcher — node:util parseArgs, applied twice.
 *
 * Pass 1: read the leading positional (the verb) with a loose parse. Pass 2: each command re-runs
 * parseArgs with its OWN strict options map and returns an exit code. We set process.exitCode
 * (never process.exit) so stdout/stderr flush before the process ends.
 */

import { parseArgs } from 'node:util';
import { TOP_HELP } from './help.js';

type Verb = (argv: string[]) => number | Promise<number>;

/**
 * Verbs are loaded lazily (dynamic import on dispatch) so a single command's dependency cannot
 * crash the whole CLI at module-load time — e.g. `run` pulls in the adapter registry, and a verb
 * the user did not ask for should never block the one they did.
 */
const VERBS: Record<string, () => Promise<Verb>> = {
  run: async () => (await import('./commands/run.js')).run,
  matrix: async () => (await import('./commands/matrix.js')).matrix,
  score: async () => (await import('./commands/score.js')).score,
  fabrication: async () => (await import('./commands/fabrication.js')).fabrication,
  report: async () => (await import('./commands/report.js')).report,
  ci: async () => (await import('./commands/ci.js')).ci,
  calibrate: async () => (await import('./commands/calibrate.js')).calibrate,
  curves: async () => (await import('./commands/curves.js')).curves,
};

export async function main(argv: string[]): Promise<number> {
  // Pass 1 — loose, just to find the verb (and surface a bare --help). `tokens:true` lets us
  // locate the verb by POSITION (the first positional token's index) instead of a string match,
  // so a future value-taking global flag whose value equals a verb name can't mis-slice `rest`.
  const { positionals, values, tokens } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });

  const verb = positionals[0];
  if (verb === undefined) {
    process.stdout.write(TOP_HELP);
    return 0;
  }
  const load = VERBS[verb];
  if (load === undefined) {
    // `--help foo`/`-h foo` with an unknown verb: a bare help intent wins over the unknown verb.
    if (values.help) {
      process.stdout.write(TOP_HELP);
      return 0;
    }
    process.stderr.write(`velrim-eval: unknown command "${verb}"\n\n`);
    process.stdout.write(TOP_HELP);
    return 2;
  }

  // `velrim-eval --help <verb>` / `-h <verb>`: the reversed form should show the VERB's help, not
  // run it with empty args. Forward `--help` so the command prints its own usage and exits 0.
  if (values.help) {
    const handler = await load();
    return handler(['--help']);
  }

  // Pass 2 — hand the remaining args (everything after the verb) to the command's strict parser.
  // Find the verb's token index by position (first positional token), not by `argv.indexOf`.
  const verbToken = tokens.find((t) => t.kind === 'positional');
  const verbIndex = verbToken ? verbToken.index : argv.indexOf(verb);
  const rest = argv.slice(verbIndex + 1);
  const handler = await load();
  return handler(rest);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`velrim-eval: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  });
