/** `velrim-eval run` — repeat-safe, resumable adapter runner. Does NOT score. */

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvalAdapterId, PageCapBranch, Transport, TrimmableParam } from '../adapters/types.js';
import {
  errorMessage,
  fixtureTransport,
  getAdapter,
  liveTransport,
  LIVE_ENV_KEY,
  LIVE_AUTH_STYLE,
} from '../adapters/index.js';
import { parseGoldenJsonl } from '../golden/loader.js';
import { RUN_HELP } from '../help.js';
import { executeRun, type SpendEstimate, type SpendPreflight } from '../run/runner.js';
import type { RunFileHash, RunStaticProvenance } from '../run/runner.js';
import { docKey, type PreparedRunDoc } from '../run/checkpoint.js';
import { SHARED_EXTRACTION_INSTRUCTION } from '../protocol.js';
import { OPENAI_CHAT_URL, OPENAI_MODEL } from '../adapters/openai.js';
import { VELRIM_EXTRACT_URL, VELRIM_FITTED_STAMP_PATTERN } from '../adapters/velrim.js';
import { LLAMAEXTRACT_EXTRACT_URL } from '../adapters/llamaextract.js';
import { MISTRAL_MODEL, MISTRAL_OCR_URL, MISTRAL_PAGE_CAP } from '../adapters/mistral.js';
import { GEMINI_GENERATE_URL, GEMINI_MODEL } from '../adapters/gemini.js';

const ADAPTER_IDS: readonly EvalAdapterId[] = [
  'velrim',
  'openai',
  'llamaextract',
  'mistral',
  'gemini',
];
const TRIMMABLE_PARAMS: readonly TrimmableParam[] = ['logprobs', 'temperature'];
const CAP_BRANCHES: readonly PageCapBranch[] = ['cap-confirmed', 'cap-removed'];
const execFileAsync = promisify(execFile);

interface ImplementationFingerprint {
  aggregateSha256: string;
  files: RunFileHash[];
  fixtureInput: RunStaticProvenance['fixtureInput'];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Walk a fixture tree into forward-slash relative paths in BYTE order. The order feeds the
 * fixture aggregate SHA-256 (and through it the run fingerprint), so it must be identical on
 * every host: default `sort()` is code-unit order; `localeCompare` would vary with the ICU
 * locale, and platform path separators would vary the sort across OSes.
 */
export async function recursiveFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await recursiveFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out.sort();
}

async function implementationFingerprint(
  adapterId: EvalAdapterId,
  mode: 'fixture' | 'live',
): Promise<ImplementationFingerprint> {
  const commandPath = fileURLToPath(import.meta.url);
  const extension = commandPath.endsWith('.ts') ? '.ts' : '.js';
  const sourceRoot = dirname(dirname(commandPath));
  const projectRoot = dirname(sourceRoot);
  const relativeFiles = [
    'commands/run',
    'run/runner',
    'run/checkpoint',
    'run/lock',
    'protocol',
    'adapters/index',
    'adapters/types',
    'adapters/errors',
    'adapters/transport',
    'adapters/sleep',
    'adapters/bytes',
    'adapters/flatten',
    `adapters/${adapterId}`,
  ];
  // The gemini adapter reuses the eval-local prompt/SAP-lite code from OpenAI. Hash that runtime
  // dependency so a resumed run can never mix prompt/parser implementations.
  if (adapterId === 'gemini') relativeFiles.push('adapters/openai');
  const hash = createHash('sha256');
  const files: RunFileHash[] = [];
  for (const relative of relativeFiles) {
    const bytes = await readFile(join(sourceRoot, relative + extension));
    hash.update(relative);
    hash.update('\n');
    hash.update(bytes);
    hash.update('\n');
    files.push({ path: relative + extension, sha256: sha256(bytes) });
  }
  let fixtureInput: RunStaticProvenance['fixtureInput'] = { status: 'not_applicable' };
  if (mode === 'fixture') {
    const fixtureRoot = join(projectRoot, 'test', 'recorded', adapterId);
    const fixtureFiles = await recursiveFiles(fixtureRoot);
    if (fixtureFiles.length === 0) throw new Error(`${adapterId}: fixture corpus is empty`);
    const fixtureHash = createHash('sha256');
    const fixtureProvenance: RunFileHash[] = [];
    for (const path of fixtureFiles) {
      const bytes = await readFile(join(fixtureRoot, path));
      const manifestPath = join('test', 'recorded', adapterId, path).replaceAll('\\', '/');
      fixtureHash.update(manifestPath);
      fixtureHash.update('\n');
      fixtureHash.update(bytes);
      fixtureHash.update('\n');
      fixtureProvenance.push({ path: manifestPath, sha256: sha256(bytes) });
    }
    const aggregateSha256 = fixtureHash.digest('hex');
    fixtureInput = { status: 'hashed', aggregateSha256, files: fixtureProvenance };
    hash.update('fixture-input\n');
    hash.update(aggregateSha256);
    hash.update('\n');
  }
  return { aggregateSha256: hash.digest('hex'), files, fixtureInput };
}

async function gitMetadata(
  projectRoot: string,
  outDir: string,
): Promise<{ commitSha: string | null; worktreeDirty: boolean | null }> {
  const safe = [projectRoot, dirname(projectRoot)].flatMap((path) => [
    '-c',
    `safe.directory=${path}`,
  ]);
  try {
    const commit = await execFileAsync('git', [...safe, 'rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const topLevel = await execFileAsync('git', [...safe, 'rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const repositoryRoot = topLevel.stdout.trim();
    const outputRelative = relative(repositoryRoot, resolve(outDir)).replaceAll('\\', '/');
    const outputIsDedicatedChild =
      outputRelative.length > 0 &&
      outputRelative !== '..' &&
      !outputRelative.startsWith('../') &&
      !isAbsolute(outputRelative);
    const pathspec = outputIsDedicatedChild
      ? ['--', '.', `:(exclude)${outputRelative}`, `:(exclude)${outputRelative}/**`]
      : [];
    const status = await execFileAsync(
      'git',
      [...safe, 'status', '--porcelain', '--untracked-files=all', ...pathspec],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const commitSha = commit.stdout.trim();
    return {
      commitSha: /^[a-f0-9]{40,64}$/i.test(commitSha) ? commitSha : null,
      worktreeDirty: status.stdout.trim().length > 0,
    };
  } catch {
    return { commitSha: null, worktreeDirty: null };
  }
}

function parseClassHashes(
  raw: string[] | undefined,
  classes: ReadonlyArray<string>,
  required: boolean,
): Record<string, string | null> {
  const hashes: Record<string, string | null> = Object.fromEntries(
    classes.map((docClass) => [docClass, null]),
  );
  for (const item of raw ?? []) {
    const match = /^([^=]+)=([a-f0-9]{64})$/i.exec(item);
    if (match === null || !classes.includes(match[1]!)) {
      throw new Error('--cal-test-golden-hash must be <docClass>=<64-hex-sha256>');
    }
    hashes[match[1]!] = match[2]!.toLowerCase();
  }
  if (required) {
    const missing = classes.filter((docClass) => hashes[docClass] === null);
    if (missing.length > 0) {
      throw new Error(
        `--live requires --cal-test-golden-hash for every class (missing ${missing.join(', ')})`,
      );
    }
  }
  return hashes;
}

function parseClassPaths(
  raw: string[] | undefined,
  classes: ReadonlyArray<string>,
  label: string,
  required: boolean,
): Record<string, string | null> {
  const paths: Record<string, string | null> = Object.fromEntries(
    classes.map((docClass) => [docClass, null]),
  );
  for (const item of raw ?? []) {
    const separator = item.indexOf('=');
    const docClass = separator > 0 ? item.slice(0, separator) : '';
    const path = separator > 0 ? item.slice(separator + 1) : '';
    if (!classes.includes(docClass) || path.length === 0) {
      throw new Error(`${label} must be <docClass>=<path>`);
    }
    paths[docClass] = path;
  }
  if (required) {
    const missing = classes.filter((docClass) => paths[docClass] === null);
    if (missing.length > 0) throw new Error(`${label} is missing ${missing.join(', ')}`);
  }
  return paths;
}

function positiveInteger(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseSpend(
  live: boolean,
  rawUsd: string | undefined,
  basis: string | undefined,
  asOf: string | undefined,
): SpendEstimate | undefined {
  if (!live) return undefined;
  if (rawUsd === undefined) {
    throw new Error(
      '--live requires --expected-spend-usd; the runner never fabricates a $0 estimate',
    );
  }
  const fullRunUsd = Number(rawUsd);
  if (!Number.isFinite(fullRunUsd) || fullRunUsd <= 0) {
    throw new Error('--expected-spend-usd must be a finite positive number');
  }
  if (basis === undefined || basis.trim().length === 0) {
    throw new Error('--live requires --pricing-basis with the rate/source behind the estimate');
  }
  if (
    asOf === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) ||
    new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf
  ) {
    throw new Error('--live requires --pricing-as-of in YYYY-MM-DD form');
  }
  return { fullRunUsd, basis: basis.trim(), asOf };
}

function printPreflight(preflight: SpendPreflight): void {
  if (preflight.mode !== 'live') return;
  process.stdout.write(
    [
      'run: LIVE SPEND PREFLIGHT',
      `  adapter/mode: ${preflight.adapter}/live`,
      `  documents x repeats: ${preflight.docs} x ${preflight.repeats} = ${preflight.plannedDocRepeats} doc-repeats`,
      `  remaining doc-repeats: ${preflight.remainingDocRepeats}`,
      `  transport policy: at most ${preflight.maxTransportRetriesPerDocRepeat} retries across the whole doc-repeat`,
      `  expected full-run spend: $${(preflight.expectedFullRunUsd ?? 0).toFixed(2)}`,
      `  expected remaining spend (doc-repeat prorated): $${(preflight.expectedRemainingUsd ?? 0).toFixed(2)}`,
      `  pricing basis: ${preflight.pricingBasis ?? 'MISSING'}`,
      `  pricing checked: ${preflight.pricingAsOf ?? 'MISSING'}`,
      '  estimate warning: retries and provider-side billing after ambiguous failures can increase actual spend',
      '',
    ].join('\n'),
  );
}

export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        golden: { type: 'string' },
        adapter: { type: 'string' },
        docs: { type: 'string' },
        out: { type: 'string' },
        live: { type: 'boolean' },
        repeat: { type: 'string' },
        'structured-mode': { type: 'boolean' },
        'trim-param': { type: 'string', multiple: true },
        'mistral-cap-branch': { type: 'string' },
        'expected-spend-usd': { type: 'string' },
        'pricing-basis': { type: 'string' },
        'pricing-as-of': { type: 'string' },
        'confirm-spend': { type: 'boolean' },
        'resume-paused': { type: 'boolean' },
        'recover-stale-lock': { type: 'boolean' },
        'cal-test-golden-hash': { type: 'string', multiple: true },
        'cal-test-manifest': { type: 'string', multiple: true },
        'commit-sha': { type: 'string' },
        'allow-commit-drift': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n${RUN_HELP}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(RUN_HELP);
    return 0;
  }

  const goldenPath = values.golden;
  const adapterId = values.adapter as EvalAdapterId | undefined;
  const docsPath = values.docs;
  const outDir = values.out;
  const live = values.live === true;
  if (!goldenPath || !adapterId || !docsPath || !outDir) {
    process.stderr.write('run: --golden, --adapter, --docs and --out are all required\n');
    return 2;
  }
  if (!ADAPTER_IDS.includes(adapterId)) {
    process.stderr.write(
      `run: unknown --adapter "${adapterId}" (expected ${ADAPTER_IDS.join('|')})\n`,
    );
    return 2;
  }
  // Fail the statically-invalid combination at PARSE time: mid-run it would die only after the
  // lock and a checkpoint fingerprinted with structuredMode:true already exist.
  if (values['structured-mode'] === true && adapterId !== 'openai' && adapterId !== 'gemini') {
    process.stderr.write(
      `run: --structured-mode is only supported by --adapter openai|gemini (${adapterId} is free-decode only)\n`,
    );
    return 2;
  }
  // The smoke-driven param trim is an openai/gemini request-body change.
  const trimParams = [...new Set(values['trim-param'] ?? [])] as TrimmableParam[];
  if (trimParams.length > 0 && adapterId !== 'openai' && adapterId !== 'gemini') {
    process.stderr.write(`run: --trim-param is only supported by --adapter openai|gemini\n`);
    return 2;
  }
  for (const trim of trimParams) {
    if (!TRIMMABLE_PARAMS.includes(trim)) {
      process.stderr.write(
        `run: unknown --trim-param "${trim}" (expected ${TRIMMABLE_PARAMS.join('|')})\n`,
      );
      return 2;
    }
    if (adapterId === 'gemini' && trim !== 'temperature') {
      // Gemini never sends a logprobs param — recording that trim would misstate the manifest.
      process.stderr.write(
        `run: --trim-param ${trim} is not a gemini request param (gemini supports temperature only)\n`,
      );
      return 2;
    }
  }
  // The page-cap branch only means anything to the Mistral arm.
  const capBranchRaw = values['mistral-cap-branch'];
  if (capBranchRaw !== undefined && adapterId !== 'mistral') {
    process.stderr.write(`run: --mistral-cap-branch is only supported by --adapter mistral\n`);
    return 2;
  }
  if (capBranchRaw !== undefined && !CAP_BRANCHES.includes(capBranchRaw as PageCapBranch)) {
    process.stderr.write(
      `run: unknown --mistral-cap-branch "${capBranchRaw}" (expected ${CAP_BRANCHES.join('|')})\n`,
    );
    return 2;
  }
  const capBranch = capBranchRaw as PageCapBranch | undefined;
  // Velrim live runs always assert the served fitted stamp — not a flag, a protocol
  // invariant (ANALYSIS-PLAN.md §6.2): a live response not served by the shipped fitted stack
  // is a mislabeled column, a run-stopping protocol error. Fixture/dogfood runs never assert
  // (a fixture's stamp may be anything).
  const requireFittedStamp = live && adapterId === 'velrim';

  let repeats: number;
  try {
    repeats = positiveInteger(values.repeat, '--repeat', 1);
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n`);
    return 2;
  }

  // Preserve the existing key fail-fast guarantee: construction reads the env only and performs
  // no network call. Every actual doc-repeat receives a fresh signal-bound transport below.
  if (live) {
    try {
      liveTransport(LIVE_ENV_KEY[adapterId]);
    } catch (error) {
      process.stderr.write(`run: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  let spend: SpendEstimate | undefined;
  try {
    spend = parseSpend(
      live,
      values['expected-spend-usd'],
      values['pricing-basis'],
      values['pricing-as-of'],
    );
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n`);
    return 2;
  }

  let rows;
  let goldenBytes: Uint8Array;
  try {
    goldenBytes = await readFile(goldenPath);
    rows = parseGoldenJsonl(new TextDecoder().decode(goldenBytes));
  } catch (error) {
    process.stderr.write(`run: failed to load golden: ${errorMessage(error)}\n`);
    return 2;
  }

  let adapter;
  try {
    adapter = getAdapter(adapterId);
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n`);
    return 2;
  }

  let docFiles: Set<string>;
  try {
    docFiles = new Set(await readdir(docsPath));
  } catch (error) {
    process.stderr.write(`run: cannot read --docs dir "${docsPath}": ${errorMessage(error)}\n`);
    return 2;
  }

  // Preload every schema and every document byte before the first possible paid call. Besides
  // failing fast, these exact inputs feed the checkpoint fingerprint.
  const prepared: PreparedRunDoc[] = [];
  const identities = new Set<string>();
  const goldenDir = dirname(goldenPath);
  const schemaArtifacts = new Map<string, RunFileHash>();
  for (const row of rows) {
    const identity = docKey(row.golden.docClass, row.doc);
    if (identities.has(identity)) {
      process.stderr.write(
        `run: duplicate golden identity docClass="${row.golden.docClass}" doc="${row.doc}"\n`,
      );
      return 2;
    }
    identities.add(identity);
    if (!docFiles.has(row.doc)) {
      process.stderr.write(`run: golden references doc "${row.doc}" not found in ${docsPath}\n`);
      return 2;
    }

    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(docsPath, row.doc));
    } catch (error) {
      process.stderr.write(`run: cannot read doc "${row.doc}": ${errorMessage(error)}\n`);
      return 2;
    }

    let schema: object = {};
    if (live) {
      if (row.schema === undefined) {
        process.stderr.write(
          `run: --live requires a "schema" on every golden row; "${row.doc}" has none\n`,
        );
        return 2;
      }
      const schemaPath = isAbsolute(row.schema) ? row.schema : join(goldenDir, row.schema);
      let parsedSchema: unknown;
      try {
        const schemaBytes = await readFile(schemaPath);
        parsedSchema = JSON.parse(new TextDecoder().decode(schemaBytes));
        const existing = schemaArtifacts.get(row.golden.docClass);
        const artifact = {
          path: relative(goldenDir, schemaPath).replaceAll('\\', '/'),
          sha256: sha256(schemaBytes),
        };
        if (existing !== undefined && existing.sha256 !== artifact.sha256) {
          throw new Error(`class ${row.golden.docClass} references more than one schema artifact`);
        }
        schemaArtifacts.set(row.golden.docClass, artifact);
      } catch (error) {
        process.stderr.write(
          `run: cannot load schema "${row.schema}" for "${row.doc}": ${errorMessage(error)}\n`,
        );
        return 2;
      }
      if (
        parsedSchema === null ||
        typeof parsedSchema !== 'object' ||
        Array.isArray(parsedSchema)
      ) {
        process.stderr.write(`run: schema "${row.schema}" for "${row.doc}" is not a JSON object\n`);
        return 2;
      }
      schema = parsedSchema;
    }
    prepared.push({
      doc: row.doc,
      docClass: row.golden.docClass,
      bytes,
      schema,
      golden: row.golden,
    });
  }

  const transportFactory = (signal: AbortSignal): Transport =>
    live
      ? // Per-adapter auth style — Gemini keys ride in the x-goog-api-key header, not Bearer.
        liveTransport(LIVE_ENV_KEY[adapterId], { signal, authStyle: LIVE_AUTH_STYLE[adapterId] })
      : fixtureTransport(adapterId);

  let implementation: ImplementationFingerprint;
  try {
    implementation = await implementationFingerprint(adapterId, live ? 'live' : 'fixture');
  } catch (error) {
    process.stderr.write(`run: cannot fingerprint runner implementation: ${errorMessage(error)}\n`);
    return 2;
  }

  const classes = [...new Set(prepared.map((doc) => doc.docClass))].sort();
  let calTestGoldenHashes: Record<string, string | null>;
  try {
    calTestGoldenHashes = parseClassHashes(values['cal-test-golden-hash'], classes, false);
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n`);
    return 2;
  }
  let sourceManifestPaths: Record<string, string | null>;
  try {
    sourceManifestPaths = parseClassPaths(
      values['cal-test-manifest'],
      classes,
      '--cal-test-manifest',
      live,
    );
  } catch (error) {
    process.stderr.write(`run: ${errorMessage(error)}\n`);
    return 2;
  }
  const sourceManifests = new Map<string, RunFileHash>();
  for (const docClass of classes) {
    const rawPath = sourceManifestPaths[docClass];
    if (rawPath === null || rawPath === undefined) continue;
    const path = isAbsolute(rawPath) ? rawPath : join(goldenDir, rawPath);
    try {
      const bytes = await readFile(path);
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (
        manifest['class'] !== docClass ||
        typeof manifest['calTestGoldenHash'] !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(manifest['calTestGoldenHash'])
      ) {
        throw new Error('class/hash fields do not match the frozen-manifest contract');
      }
      const frozenHash = manifest['calTestGoldenHash'].toLowerCase();
      const suppliedHash = calTestGoldenHashes[docClass];
      if (suppliedHash !== null && suppliedHash !== frozenHash) {
        throw new Error('supplied hash does not match the frozen source manifest');
      }
      calTestGoldenHashes[docClass] = frozenHash;
      sourceManifests.set(docClass, {
        path: relative(goldenDir, path).replaceAll('\\', '/'),
        sha256: sha256(bytes),
      });
    } catch (error) {
      process.stderr.write(
        `run: cannot verify CAL-TEST manifest for ${docClass}: ${errorMessage(error)}\n`,
      );
      return 2;
    }
  }

  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const projectRoot = dirname(sourceRoot);
  let scoringVersion = 'unknown';
  try {
    const scoringPackage = JSON.parse(
      await readFile(
        join(projectRoot, 'node_modules', '@velrim', 'scoring', 'package.json'),
        'utf8',
      ),
    ) as { version?: unknown };
    if (typeof scoringPackage.version === 'string') scoringVersion = scoringPackage.version;
  } catch {
    // The manifest remains explicitly non-publication-ready instead of inventing a version.
  }
  const git = await gitMetadata(projectRoot, outDir);
  let commitSha = values['commit-sha'] ?? git.commitSha;
  if (commitSha !== null && !/^[a-f0-9]{40,64}$/i.test(commitSha)) {
    process.stderr.write('run: --commit-sha must be a full 40- or 64-hex commit id\n');
    return 2;
  }
  if (
    values['commit-sha'] !== undefined &&
    git.commitSha !== null &&
    values['commit-sha'].toLowerCase() !== git.commitSha.toLowerCase()
  ) {
    process.stderr.write('run: --commit-sha does not match the detected Git HEAD\n');
    return 2;
  }
  commitSha = commitSha?.toLowerCase() ?? null;

  const requestedConfiguration: RunStaticProvenance['requestedConfiguration'] =
    adapterId === 'openai'
      ? {
          endpoint: OPENAI_CHAT_URL,
          model: OPENAI_MODEL,
          generationSettings: {
            // A trimmed param is OMITTED from the live body — the setting record says so
            // instead of implying the documented default was sent.
            temperature: trimParams.includes('temperature') ? 'trimmed_at_smoke' : 0,
            logprobs: trimParams.includes('logprobs') ? 'trimmed_at_smoke' : true,
            structuredMode: values['structured-mode'] === true,
            trimmedParams: trimParams,
          },
          settingsAlpha: null,
          llamaExtractConfigurationVersion: null,
        }
      : adapterId === 'gemini'
        ? {
            endpoint: GEMINI_GENERATE_URL,
            model: GEMINI_MODEL,
            generationSettings: {
              // A2/A3: vendor defaults everywhere except the one pre-registered rule.
              temperature: trimParams.includes('temperature') ? 'trimmed_at_smoke' : 0,
              confidence: 'not_requested',
              structuredMode: values['structured-mode'] === true,
              responseJsonSchema: values['structured-mode'] === true,
              trimmedParams: trimParams,
            },
            settingsAlpha: null,
            llamaExtractConfigurationVersion: null,
          }
        : adapterId === 'mistral'
          ? {
              endpoint: MISTRAL_OCR_URL,
              model: MISTRAL_MODEL,
              generationSettings: {
                documentAnnotationFormat: 'json_schema',
                confidence: 'none_surfaced',
                structuredMode: false,
                pageCapBranch: capBranch ?? 'unresolved',
                conditionalPageLimit: MISTRAL_PAGE_CAP,
              },
              settingsAlpha: null,
              llamaExtractConfigurationVersion: null,
            }
          : adapterId === 'llamaextract'
            ? {
                endpoint: LLAMAEXTRACT_EXTRACT_URL,
                model: 'llamaextract-v2',
                generationSettings: { extractionTarget: 'per_doc' },
                settingsAlpha: null,
                llamaExtractConfigurationVersion: null,
              }
            : {
                endpoint: VELRIM_EXTRACT_URL,
                model: null,
                generationSettings: {
                  providerManaged: true,
                  // The assertion never changes the request — the body is the default
                  // public request always. The served stamp lands in
                  // observedVersions.calibrator; the label reads from THAT, never from here.
                  requireFittedStamp,
                  expectedCalibratorStamp: requireFittedStamp
                    ? VELRIM_FITTED_STAMP_PATTERN.source
                    : null,
                },
                settingsAlpha: null,
                llamaExtractConfigurationVersion: null,
              };
  const publicGolden: RunFileHash = {
    path: basename(goldenPath),
    sha256: sha256(goldenBytes),
  };
  const provenance: RunStaticProvenance = {
    commitSha,
    worktreeDirty: git.worktreeDirty,
    implementationFiles: implementation.files,
    fixtureInput: implementation.fixtureInput,
    classes: classes.map((docClass) => ({
      docClass,
      schema: schemaArtifacts.get(docClass) ?? null,
      publicGolden,
      sourceManifest: sourceManifests.get(docClass) ?? null,
      calTestGoldenHash: calTestGoldenHashes[docClass] ?? null,
    })),
    sharedInstruction: SHARED_EXTRACTION_INSTRUCTION,
    scoring: { package: '@velrim/scoring', version: scoringVersion },
    requestedConfiguration,
    rerunPolicy:
      'Major competitor version bump or vendor PR triggers a budget-capped re-run requested via PR.',
  };

  try {
    const result = await executeRun({
      adapter,
      implementationHash: implementation.aggregateSha256,
      provenance,
      mode: live ? 'live' : 'fixture',
      structuredMode: values['structured-mode'] === true,
      trimParams,
      ...(capBranch === undefined ? {} : { capBranch }),
      ...(requireFittedStamp ? { requireFittedStamp } : {}),
      repeats,
      docs: prepared,
      outDir,
      goldenPath,
      docsPath,
      transportFactory,
      resumePaused: values['resume-paused'] === true,
      recoverStaleLock: values['recover-stale-lock'] === true,
      confirmSpend: values['confirm-spend'] === true,
      allowCommitDrift: values['allow-commit-drift'] === true,
      onPreflight: printPreflight,
      ...(spend === undefined ? {} : { spend }),
    });
    if (result.status === 'confirmation_required') {
      process.stderr.write(
        'run: no paid call was made; review the preflight and rerun with --confirm-spend\n',
      );
      return 2;
    }
    if (result.status === 'paused') {
      process.stderr.write(
        `run: circuit paused after ${result.health?.consecutiveContractFailures ?? repeats} consecutive contract failures; ` +
          'perform the manual check, then rerun with --resume-paused (and --confirm-spend for live)\n',
      );
      return 1;
    }
    process.stdout.write(
      `run: ${result.records} doc-repeats -> ${outDir} (adapter=${adapterId}, ${live ? 'live' : 'fixture'}, repeats=${repeats}, restored=${result.restored})\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `run: stopped on a non-retryable runner/provider error: ${errorMessage(error)}; checkpoint preserved\n`,
    );
    return 1;
  }
}
