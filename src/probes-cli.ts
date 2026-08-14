#!/usr/bin/env node

/**
 * Probes CLI — generate the mechanical probe artifacts, and run the tool-independent
 * text-layer absence search (ANALYSIS-PLAN.md §7.7). Zero network, zero spend, deterministic.
 *
 *   generate  — seed-published probe selection from the committed class schemas → probes.json,
 *               per-class probe-schema variants, per-class probe goldens (all `missing`), and
 *               the visual manual-pass WORKSHEET.md scaffold.
 *   verify    — text-layer search per probe×doc over local PDFs (pdfjs, same distribution the
 *               corpora converter uses) → absence-verification.json. Text search is the FIRST
 *               pass only; the maintainer's visual worksheet is authoritative on scan classes.
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseGoldenJsonl, type LoadedGolden } from './golden/loader.js';
import {
  PROBE_SELECTION_SEED,
  PROBES_PER_CLASS,
  buildProbeGoldenJsonl,
  buildProbeSchema,
  buildWorksheetMarkdown,
  parseWorksheetStrikes,
  probeSearchTokens,
  selectProbes,
  survivingProbes,
  type ProbeSelection,
} from './fabrication/probes.js';

const HELP = `Probe artifacts (zero network/spend; selection is seeded and deterministic).

USAGE
  node dist/probes-cli.js generate --corpora <dir> [--out <dir>]
  node dist/probes-cli.js verify --corpora <dir> --pdfs <dir> [--out <dir>]
  node dist/probes-cli.js strike --corpora <dir> [--out <dir>]

COMMANDS
  generate   Select probes mechanically (published seed ${PROBE_SELECTION_SEED}) from the
             committed class schemas; write probes.json, <class>.probe-schema.json,
             golden.<class>.probe.jsonl, and the visual manual-pass WORKSHEET.md.
  verify     Search each probe field's name tokens in each doc's PDF text layer; write
             absence-verification.json. A hit does NOT strike a probe by itself — the maintainer's
             visual worksheet pass is authoritative (text layers are unreliable on scans).
  strike     Finalize strikes from the COMPLETED WORKSHEET.md (§7.7): derive strikes.json
             mechanically (a probe is struck iff recorded visible on any doc), and rewrite the
             probe schema variants + probe goldens with surviving probes only. probes.json and
             WORKSHEET.md are never touched (the seeded selection and the pass stay auditable).

OPTIONS
  --corpora <dir>   the committed corpora dir (schemas + golden.<class>.jsonl) [required]
  --pdfs <dir>      root containing <class>/<doc>.pdf (verify only) [required for verify]
  --out <dir>       output dir (default: <corpora>/probes)
  -h, --help        Show this help
`;

interface ClassInputs {
  docClass: string;
  schema: object;
  goldens: LoadedGolden[];
}

async function loadClasses(corporaDir: string): Promise<ClassInputs[]> {
  const entries = await readdir(corporaDir);
  const classes = entries
    .filter((name) => /^golden\.[^.]+\.jsonl$/.test(name))
    .map((name) => name.slice('golden.'.length, -'.jsonl'.length))
    .sort();
  if (classes.length === 0) throw new Error(`no golden.<class>.jsonl files in ${corporaDir}`);
  const out: ClassInputs[] = [];
  for (const docClass of classes) {
    const schema = JSON.parse(
      await readFile(join(corporaDir, `${docClass}.schema.json`), 'utf8'),
    ) as object;
    const goldens = parseGoldenJsonl(
      await readFile(join(corporaDir, `golden.${docClass}.jsonl`), 'utf8'),
    );
    out.push({ docClass, schema, goldens });
  }
  return out;
}

async function generate(corporaDir: string, outDir: string): Promise<void> {
  const classes = await loadClasses(corporaDir);
  const schemas = Object.fromEntries(classes.map((c) => [c.docClass, c.schema]));
  const selection = selectProbes(schemas, PROBE_SELECTION_SEED, PROBES_PER_CLASS);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'probes.json'), JSON.stringify(selection, null, 2) + '\n');
  for (const { docClass, schema, goldens } of classes) {
    const probes = selection.probes[docClass]!;
    const schemaFile = `${docClass}.probe-schema.json`;
    await writeFile(
      join(outDir, schemaFile),
      JSON.stringify(buildProbeSchema(schema, probes), null, 2) + '\n',
    );
    await writeFile(
      join(outDir, `golden.${docClass}.probe.jsonl`),
      buildProbeGoldenJsonl(goldens, probes, schemaFile),
    );
  }
  const docsByClass = Object.fromEntries(
    classes.map((c) => [c.docClass, c.goldens.map((row) => row.doc)]),
  );
  await writeFile(join(outDir, 'WORKSHEET.md'), buildWorksheetMarkdown(selection, docsByClass));
  process.stdout.write(
    `probes: wrote selection (seed ${selection.seed}), ${classes.length} schema variants + goldens, and WORKSHEET.md to ${outDir}\n`,
  );
}

async function strike(corporaDir: string, outDir: string): Promise<void> {
  const selection = JSON.parse(
    await readFile(join(outDir, 'probes.json'), 'utf8'),
  ) as ProbeSelection;
  const strikes = parseWorksheetStrikes(await readFile(join(outDir, 'WORKSHEET.md'), 'utf8'));
  const surviving = survivingProbes(selection, strikes);

  await writeFile(join(outDir, 'strikes.json'), JSON.stringify(strikes, null, 2) + '\n');
  const classes = await loadClasses(corporaDir);
  for (const { docClass, schema, goldens } of classes) {
    const probes = surviving[docClass] ?? [];
    const schemaFile = `${docClass}.probe-schema.json`;
    await writeFile(
      join(outDir, schemaFile),
      JSON.stringify(buildProbeSchema(schema, probes), null, 2) + '\n',
    );
    await writeFile(
      join(outDir, `golden.${docClass}.probe.jsonl`),
      buildProbeGoldenJsonl(goldens, probes, schemaFile),
    );
  }
  const summary = Object.entries(surviving)
    .map(([docClass, probes]) => `${docClass}: ${probes.length} surviving`)
    .join(', ');
  process.stdout.write(
    `probes: ${strikes.struck.length} struck (${strikes.struck.map((s) => `${s.docClass}|${s.field}`).join(', ') || 'none'}); rewrote schema variants + goldens — ${summary}\n`,
  );
}

/** Extract a PDF's whole text layer with the same pdfjs distribution the converter uses. */
async function pdfTextLayer(pdfPath: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(pdfPath));
  const { getDocument } = await import('pdfjs-serverless');
  const loadingTask = getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  try {
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = (await page.getTextContent()) as { items: Array<{ str?: string }> };
      parts.push(content.items.map((item) => item.str ?? '').join(' '));
    }
    return parts.join('\n');
  } finally {
    await document.destroy();
  }
}

interface VerificationHit {
  docClass: string;
  doc: string;
  field: string;
  token: string;
}

async function verify(corporaDir: string, pdfsDir: string, outDir: string): Promise<void> {
  const selection = JSON.parse(
    await readFile(join(outDir, 'probes.json'), 'utf8'),
  ) as ProbeSelection;
  const classes = await loadClasses(corporaDir);
  const hits: VerificationHit[] = [];
  let searched = 0;
  for (const { docClass, goldens } of classes) {
    const probes = selection.probes[docClass] ?? [];
    for (const row of goldens) {
      const text = (await pdfTextLayer(join(pdfsDir, docClass, row.doc))).toLowerCase();
      for (const probe of probes) {
        searched++;
        for (const token of probeSearchTokens(probe.field)) {
          if (text.includes(token.toLowerCase())) {
            hits.push({ docClass, doc: row.doc, field: probe.field, token });
            break;
          }
        }
      }
    }
  }
  const report = {
    formatVersion: 1,
    seed: selection.seed,
    searchedProbeDocPairs: searched,
    note:
      'Text-layer search is the tool-independent FIRST pass only; the published visual ' +
      'manual-pass worksheet is authoritative (scan classes can carry values the text layer ' +
      'misses, and vice versa). A hit flags the pair for maintainer attention at the visual pass.',
    hits,
  };
  await writeFile(
    join(outDir, 'absence-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    `probes: searched ${searched} probe×doc pairs, ${hits.length} text-layer hits -> ${join(outDir, 'absence-verification.json')}\n`,
  );
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        corpora: { type: 'string' },
        pdfs: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(`probes: ${(error as Error).message}\n${HELP}`);
    return 2;
  }
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const verb = parsed.positionals[0];
  const corpora = parsed.values.corpora;
  if ((verb !== 'generate' && verb !== 'verify' && verb !== 'strike') || !corpora) {
    process.stderr.write(`probes: expected generate|verify|strike with --corpora\n${HELP}`);
    return 2;
  }
  const corporaDir = resolve(corpora);
  const outDir = resolve(parsed.values.out ?? join(corporaDir, 'probes'));
  try {
    if (verb === 'generate') {
      await generate(corporaDir, outDir);
    } else if (verb === 'strike') {
      await strike(corporaDir, outDir);
    } else {
      if (!parsed.values.pdfs) {
        process.stderr.write(`probes: verify requires --pdfs\n${HELP}`);
        return 2;
      }
      await verify(corporaDir, resolve(parsed.values.pdfs), outDir);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`probes: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `probes: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
