/** Repeat/retry/deadline/checkpoint runner. No provider-specific logic belongs here. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterFieldViolation,
  sanitizeResponseProvenance,
  type AdapterResponseProvenance,
  type EvalAdapter,
  type PageCapBranch,
  type Transport,
  type TrimmableParam,
} from '../adapters/types.js';
import { isMintedFittedStamp } from '../adapters/velrim.js';
import {
  ContractFailureError,
  TransportFailureError,
  errorMessage,
  isTransportFailure,
} from '../adapters/errors.js';
import { sleep as defaultSleep } from '../adapters/sleep.js';
import {
  RUN_CHECKPOINT_FILE,
  appendCheckpointLine,
  createRunCheckpoint,
  durableReplace,
  loadRunCheckpoint,
  predictionKey,
  runFingerprint,
  type CheckpointEvent,
  type PredictionRecord,
  type PreparedRunDoc,
  type RunFingerprintConfig,
} from './checkpoint.js';
import { acquireRunLock } from './lock.js';

export const DEFAULT_DOC_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_TRANSPORT_RETRIES = 2;
export const RETRY_BACKOFF_MS = [500, 1_000] as const;

export interface SpendEstimate {
  /** Expected total for all requested doc-repeat units, before any restored checkpoint records. */
  fullRunUsd: number;
  /** Human-readable source/date/rate used to derive the estimate. */
  basis: string;
  /** ISO date on which the pricing source was checked. */
  asOf: string;
}

export interface RunPolicy {
  docTimeoutMs: number;
  maxTransportRetries: number;
  contractFailureLimit: number;
  retryBackoffMs: readonly number[];
}

export interface RunExecutionOptions {
  adapter: EvalAdapter;
  implementationHash: string;
  provenance: RunStaticProvenance;
  mode: 'fixture' | 'live';
  structuredMode: boolean;
  /** Smoke-driven param trims (openai) — fingerprinted and recorded in run-meta. */
  trimParams?: readonly TrimmableParam[];
  /** Page-cap branch (mistral) — 'cap-confirmed' arms the over-cap loud-fail guard. */
  capBranch?: PageCapBranch;
  /** Velrim live runs — arms the served fitted-stamp assertion; recorded in run-meta. */
  requireFittedStamp?: boolean;
  /** Gemini only — Vertex endpoint substitution; recorded in run-meta, fingerprinted via the manifest endpoint. */
  geminiVertexProject?: string;
  repeats: number;
  docs: ReadonlyArray<PreparedRunDoc>;
  outDir: string;
  goldenPath: string;
  docsPath: string;
  transportFactory: (signal: AbortSignal) => Transport;
  resumePaused: boolean;
  recoverStaleLock: boolean;
  confirmSpend: boolean;
  /**
   * Resume a fingerprint-matching checkpoint even though the monorepo HEAD moved (an UNRELATED
   * commit — the velrim-eval implementation fingerprint still matches or the checkpoint would be
   * stale). The manifest keeps the checkpoint's original run-start commit; nothing is rewritten.
   */
  allowCommitDrift?: boolean;
  spend?: SpendEstimate;
  policy?: Partial<RunPolicy>;
  /** Called after checkpoint inspection and before any transport can be constructed or sent. */
  onPreflight?: (preflight: SpendPreflight) => void;
}

export interface RunFileHash {
  path: string;
  sha256: string;
}

export interface RunClassProvenance {
  docClass: string;
  schema: RunFileHash | null;
  publicGolden: RunFileHash;
  sourceManifest: RunFileHash | null;
  calTestGoldenHash: string | null;
}

export interface RunStaticProvenance {
  commitSha: string | null;
  worktreeDirty: boolean | null;
  implementationFiles: ReadonlyArray<RunFileHash>;
  fixtureInput:
    | { status: 'not_applicable' }
    | { status: 'hashed'; aggregateSha256: string; files: ReadonlyArray<RunFileHash> };
  classes: ReadonlyArray<RunClassProvenance>;
  sharedInstruction: string;
  scoring: { package: '@velrim/scoring'; version: string };
  requestedConfiguration: {
    endpoint: string;
    model: string | null;
    generationSettings: Record<string, unknown>;
    settingsAlpha: string | null;
    llamaExtractConfigurationVersion: string | null;
  };
  rerunPolicy: string;
}

export interface SpendPreflight {
  adapter: string;
  mode: 'fixture' | 'live';
  docs: number;
  repeats: number;
  plannedDocRepeats: number;
  remainingDocRepeats: number;
  maxTransportRetriesPerDocRepeat: number;
  expectedFullRunUsd?: number;
  expectedRemainingUsd?: number;
  pricingBasis?: string;
  pricingAsOf?: string;
}

export interface RunExecutionResult {
  status: 'completed' | 'paused' | 'confirmation_required';
  preflight: SpendPreflight;
  records: number;
  restored: number;
  health?: RunHealth;
}

export interface AvailabilitySummary {
  attempted: number;
  completed: number;
  transportFailures: number;
  contractFailures: number;
  availability: number | null;
}

export interface RunHealth {
  version: 1;
  adapter: string;
  unit: 'doc-repeat';
  status: 'running' | 'paused' | 'completed' | 'stopped';
  planned: number;
  aggregate: AvailabilitySummary;
  repeats: Array<AvailabilitySummary & { repeat: number }>;
  consecutiveContractFailures: number;
  contractFailureLimit: number;
  updatedAt: string;
}

interface ObservedSurface {
  status: 'not_surfaced' | 'surfaced' | 'mixed';
  values: string[];
  missingRecords: number;
}

interface RunManifest {
  formatVersion: 2;
  publicationReady: boolean;
  readinessOwner: 'matrix-orchestrator';
  missingFields: string[];
  run: {
    fingerprint: string;
    adapter: string;
    mode: 'fixture' | 'live';
    structuredMode: boolean;
    repeats: number;
    startedAt: string;
    completedAt: string | null;
    startedDate: string;
    completedDate: string | null;
  };
  code: {
    velrimEvalCommitSha: string | null;
    worktreeDirty: boolean | null;
    implementationHash: string;
    adapterFiles: ReadonlyArray<RunFileHash>;
    executedFiles: ReadonlyArray<RunFileHash>;
  };
  protocol: {
    sharedInstruction: string;
    scoring: RunStaticProvenance['scoring'];
    rerunPolicy: string;
  };
  classes: ReadonlyArray<RunClassProvenance>;
  fixtureInput: RunStaticProvenance['fixtureInput'];
  requestedConfiguration: RunStaticProvenance['requestedConfiguration'];
  observedVersions: {
    model: ObservedSurface;
    vendor: ObservedSurface;
    calibrator: ObservedSurface;
    api: ObservedSurface;
    requestIds: ObservedSurface;
  };
  policy: {
    docTimeoutMs: number;
    maxTransportRetries: number;
    contractFailureLimit: number;
    retryBackoffMs: readonly number[];
  };
  semanticInputs: SemanticInput[];
}

export interface SemanticInput {
  doc: string;
  docClass: string;
  documentSha256: string;
  schemaSemanticSha256: string;
  goldenRowSemanticSha256: string;
}

interface AttemptStats {
  requestAttempts: number;
  transportRetries: number;
}

function assertAdapterFields(
  value: unknown,
  adapterId: string,
): asserts value is PredictionRecord['fields'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractFailureError(`${adapterId}: adapter returned no usable fields object`);
  }
  for (const [pointer, field] of Object.entries(value)) {
    // The shared shape rule (single-sourced with the checkpoint's read side)...
    const violation = adapterFieldViolation(field);
    if (violation === 'not_an_object') {
      throw new ContractFailureError(`${adapterId}: field ${pointer} is not an object`);
    }
    // ...plus the write-only strictness: `undefined` would silently vanish in the JSON append.
    if (violation === 'no_value_key' || (field as Record<string, unknown>)['value'] === undefined) {
      throw new ContractFailureError(`${adapterId}: field ${pointer} has no JSON value`);
    }
    if (violation === 'invalid_confidence') {
      throw new ContractFailureError(`${adapterId}: field ${pointer} has invalid confidence`);
    }
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new ContractFailureError(`${adapterId}: fields are not JSON-serializable`);
  }
}

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Retry only typed transient transport failures; contract/fatal errors pass through immediately. */
export function retryingTransport(
  base: Transport,
  signal: AbortSignal,
  stats: AttemptStats,
  policy: Pick<RunPolicy, 'maxTransportRetries' | 'retryBackoffMs'>,
  sleep: Sleep = defaultSleep,
): Transport {
  return {
    mode: base.mode,
    ...(base.lastResponseProvenance === undefined
      ? {}
      : { lastResponseProvenance: () => base.lastResponseProvenance!() }),
    async send(request) {
      for (;;) {
        stats.requestAttempts++;
        try {
          return await base.send(request);
        } catch (error) {
          if (!isTransportFailure(error) || stats.transportRetries >= policy.maxTransportRetries) {
            throw error;
          }
          const retry = stats.transportRetries;
          const delay = policy.retryBackoffMs[retry] ?? policy.retryBackoffMs.at(-1) ?? 0;
          await sleep(delay, signal);
          stats.transportRetries++;
        }
      }
    },
  };
}

/** Per-adapter extras threaded verbatim into `EvalAdapterOpts` (param trims, page cap, Velrim stamp). */
export interface AdapterExtras {
  trimParams?: readonly TrimmableParam[];
  capBranch?: PageCapBranch;
  requireFittedStamp?: boolean;
  geminiVertexProject?: string;
}

/** Execute one logical doc-repeat under one wall-clock deadline. */
export async function executeDocRepeat(
  adapter: EvalAdapter,
  doc: PreparedRunDoc,
  repeat: number,
  mode: 'fixture' | 'live',
  structuredMode: boolean,
  transportFactory: (signal: AbortSignal) => Transport,
  policy: RunPolicy,
  extras: AdapterExtras = {},
): Promise<PredictionRecord> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + policy.docTimeoutMs;
  const stats: AttemptStats = { requestAttempts: 0, transportRetries: 0 };
  const transport = retryingTransport(
    transportFactory(controller.signal),
    controller.signal,
    stats,
    policy,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const failure = new TransportFailureError(
        `document exceeded the ${policy.docTimeoutMs}ms wall-clock cap`,
      );
      controller.abort(failure);
      reject(failure);
    }, policy.docTimeoutMs);
  });

  try {
    const result = await Promise.race([
      adapter.extract(doc.bytes, doc.schema, {
        mode,
        docClass: doc.docClass,
        structuredMode,
        signal: controller.signal,
        deadlineAt,
        ...(extras.trimParams === undefined ? {} : { trimParams: extras.trimParams }),
        ...(extras.capBranch === undefined ? {} : { capBranch: extras.capBranch }),
        ...(extras.requireFittedStamp === undefined
          ? {}
          : { requireFittedStamp: extras.requireFittedStamp }),
        ...(extras.geminiVertexProject === undefined
          ? {}
          : { geminiVertexProject: extras.geminiVertexProject }),
        transport,
      }),
      timeout,
    ]);
    assertAdapterFields(result.fields, adapter.id);
    const provenance = sanitizeResponseProvenance(result.provenance);
    return {
      kind: 'prediction',
      doc: doc.doc,
      docClass: doc.docClass,
      repeat,
      fields: result.fields,
      availability: 'completed',
      requestAttempts: stats.requestAttempts,
      transportRetries: stats.transportRetries,
      ...(provenance === undefined ? {} : { provenance }),
    };
  } catch (error) {
    if (error instanceof ContractFailureError || isTransportFailure(error)) {
      const provenance = sanitizeResponseProvenance(
        error instanceof ContractFailureError ? error.provenance : undefined,
      );
      return {
        kind: 'prediction',
        doc: doc.doc,
        docClass: doc.docClass,
        repeat,
        fields: {},
        availability: isTransportFailure(error) ? 'transport_failure' : 'contract_failure',
        requestAttempts: stats.requestAttempts,
        transportRetries: stats.transportRetries,
        error: errorMessage(error).slice(0, 500),
        ...(provenance === undefined ? {} : { provenance }),
      };
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function canonicalRecords(
  docs: ReadonlyArray<PreparedRunDoc>,
  repeats: number,
  records: ReadonlyMap<string, PredictionRecord>,
): PredictionRecord[] {
  const ordered: PredictionRecord[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const doc of docs) {
      const record = records.get(predictionKey(doc.docClass, doc.doc, repeat));
      if (record !== undefined) ordered.push(record);
    }
  }
  return ordered;
}

function summarize(records: ReadonlyArray<PredictionRecord>): AvailabilitySummary {
  const completed = records.filter((record) => record.availability === 'completed').length;
  const transportFailures = records.filter(
    (record) => record.availability === 'transport_failure',
  ).length;
  const contractFailures = records.filter(
    (record) => record.availability === 'contract_failure',
  ).length;
  return {
    attempted: records.length,
    completed,
    transportFailures,
    contractFailures,
    availability: records.length === 0 ? null : completed / records.length,
  };
}

function trailingContractFailures(records: ReadonlyArray<PredictionRecord>): number {
  let count = 0;
  for (const record of records) {
    if (record.availability === 'contract_failure') count++;
    else count = 0;
  }
  return count;
}

function buildHealth(
  adapter: string,
  status: RunHealth['status'],
  planned: number,
  repeats: number,
  records: ReadonlyArray<PredictionRecord>,
  consecutiveContractFailures: number,
  contractFailureLimit: number,
): RunHealth {
  return {
    version: 1,
    adapter,
    unit: 'doc-repeat',
    status,
    planned,
    aggregate: summarize(records),
    repeats: Array.from({ length: repeats }, (_unused, index) => {
      const repeat = index + 1;
      return { repeat, ...summarize(records.filter((record) => record.repeat === repeat)) };
    }),
    consecutiveContractFailures,
    contractFailureLimit,
    updatedAt: new Date().toISOString(),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function observedSurface(
  records: ReadonlyArray<PredictionRecord>,
  key: keyof AdapterResponseProvenance,
): ObservedSurface {
  const values = [
    ...new Set(
      records
        .map((record) => record.provenance?.[key])
        .filter((value): value is string => typeof value === 'string'),
    ),
  ].sort();
  const missingRecords =
    records.length - records.filter((record) => record.provenance?.[key]).length;
  return {
    status:
      values.length === 0
        ? 'not_surfaced'
        : values.length === 1 && missingRecords === 0
          ? 'surfaced'
          : 'mixed',
    values,
    missingRecords,
  };
}

function publicationGaps(
  options: RunExecutionOptions,
  completedAt: string | null,
  records: ReadonlyArray<PredictionRecord>,
): string[] {
  // A single run emits per-arm evidence only; the matrix orchestrator sees the whole matrix
  // and is the one that may certify publication.
  const gaps: string[] = ['matrix.authoritativeValidation'];
  if (options.mode !== 'live') gaps.push('run.mode=live');
  if (options.provenance.commitSha === null) gaps.push('code.velrimEvalCommitSha');
  if (options.provenance.worktreeDirty !== false) gaps.push('code.cleanWorktree');
  if (options.provenance.scoring.version !== '0.1.0') gaps.push('protocol.scoring.version=0.1.0');
  if (options.provenance.sharedInstruction.length === 0) gaps.push('protocol.sharedInstruction');
  if (
    options.provenance.requestedConfiguration.model === null &&
    !records.some((record) => record.provenance?.modelVersion !== undefined)
  ) {
    gaps.push('requestedConfiguration.model');
  }
  if (
    options.adapter.id === 'llamaextract' &&
    options.provenance.requestedConfiguration.llamaExtractConfigurationVersion === null
  ) {
    gaps.push('requestedConfiguration.llamaExtractConfigurationVersion');
  }
  if (options.adapter.id === 'velrim') {
    // THE Velrim pin: publication requires a uniformly-surfaced, minted-pattern calibrator
    // stamp across completed records — proof every scored response was served by the shipped
    // fitted stack. The adapter already hard-asserts per response on live runs (FatalRunError
    // on mismatch); this gate makes the manifest self-verifying — a completed record without a
    // minted stamp, or a non-uniform stamp set, keeps publicationReady false.
    const completed = records.filter((record) => record.availability === 'completed');
    const stamps = new Set(completed.map((record) => record.provenance?.calibratorVersion));
    if (
      completed.length === 0 ||
      stamps.size !== 1 ||
      !completed.every((record) => isMintedFittedStamp(record.provenance?.calibratorVersion))
    ) {
      gaps.push('observedVersions.calibrator.mintedFittedStamp');
    }
    if (!records.some((record) => record.provenance?.calibratorVersion !== undefined)) {
      gaps.push('observedVersions.calibrator');
    }
    if (!records.some((record) => record.provenance?.apiVersion !== undefined)) {
      gaps.push('observedVersions.api');
    }
  }
  for (const item of options.provenance.classes) {
    if (item.schema === null) gaps.push(`classes.${item.docClass}.schema`);
    if (item.sourceManifest === null) gaps.push(`classes.${item.docClass}.sourceManifest`);
    if (item.calTestGoldenHash === null) {
      gaps.push(`classes.${item.docClass}.calTestGoldenHash`);
    }
  }
  if (completedAt === null) gaps.push('run.completedAt');
  return gaps;
}

/**
 * Docs, schemas, and goldens are immutable for a run's whole lifetime (the fingerprint pins
 * them), so their hashes are computed ONCE per run — never per doc-repeat outcome.
 */
export function computeSemanticInputs(docs: ReadonlyArray<PreparedRunDoc>): SemanticInput[] {
  return docs.map((doc) => ({
    doc: doc.doc,
    docClass: doc.docClass,
    documentSha256: sha256(doc.bytes),
    schemaSemanticSha256: sha256(JSON.stringify(doc.schema)),
    goldenRowSemanticSha256: sha256(JSON.stringify(doc.golden)),
  }));
}

function buildManifest(
  options: RunExecutionOptions,
  policy: RunPolicy,
  fingerprint: string,
  startedAt: string,
  completedAt: string | null,
  records: ReadonlyMap<string, PredictionRecord>,
  semanticInputs: SemanticInput[],
): RunManifest {
  const ordered = canonicalRecords(options.docs, options.repeats, records);
  const missingFields = publicationGaps(options, completedAt, ordered);
  return {
    formatVersion: 2,
    publicationReady: false,
    readinessOwner: 'matrix-orchestrator',
    missingFields,
    run: {
      fingerprint,
      adapter: options.adapter.id,
      mode: options.mode,
      structuredMode: options.structuredMode,
      repeats: options.repeats,
      startedAt,
      completedAt,
      startedDate: startedAt.slice(0, 10),
      completedDate: completedAt?.slice(0, 10) ?? null,
    },
    code: {
      velrimEvalCommitSha: options.provenance.commitSha,
      worktreeDirty: options.provenance.worktreeDirty,
      implementationHash: options.implementationHash,
      adapterFiles: options.provenance.implementationFiles.filter((file) =>
        file.path.startsWith('adapters/'),
      ),
      executedFiles: options.provenance.implementationFiles,
    },
    protocol: {
      sharedInstruction: options.provenance.sharedInstruction,
      scoring: options.provenance.scoring,
      rerunPolicy: options.provenance.rerunPolicy,
    },
    classes: options.provenance.classes,
    fixtureInput: options.provenance.fixtureInput,
    requestedConfiguration: options.provenance.requestedConfiguration,
    observedVersions: {
      model: observedSurface(ordered, 'modelVersion'),
      vendor: observedSurface(ordered, 'vendorVersion'),
      calibrator: observedSurface(ordered, 'calibratorVersion'),
      api: observedSurface(ordered, 'apiVersion'),
      requestIds: observedSurface(ordered, 'requestId'),
    },
    policy: {
      docTimeoutMs: policy.docTimeoutMs,
      maxTransportRetries: policy.maxTransportRetries,
      contractFailureLimit: policy.contractFailureLimit,
      retryBackoffMs: policy.retryBackoffMs,
    },
    semanticInputs,
  };
}

function predictionFile(outDir: string, repeat: number): string {
  return join(outDir, `predictions.repeat-${String(repeat).padStart(3, '0')}.jsonl`);
}

async function materializePredictions(
  outDir: string,
  docs: ReadonlyArray<PreparedRunDoc>,
  repeats: number,
  records: ReadonlyMap<string, PredictionRecord>,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  // A stale checkpoint can legitimately reduce --repeat. Remove only runner-owned repeat files
  // before rebuilding them from the durable record map, so no obsolete column survives.
  for (const name of await readdir(outDir)) {
    if (/^predictions\.repeat-\d+\.jsonl$/.test(name)) {
      await rm(join(outDir, name), { force: true });
    }
  }
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const lines: string[] = [];
    for (const doc of docs) {
      const record = records.get(predictionKey(doc.docClass, doc.doc, repeat));
      if (record !== undefined) lines.push(JSON.stringify(record));
    }
    const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
    await durableReplace(predictionFile(outDir, repeat), text);
    if (repeats === 1) await durableReplace(join(outDir, 'predictions.jsonl'), text);
  }
  if (repeats > 1) await rm(join(outDir, 'predictions.jsonl'), { force: true });
}

async function appendPrediction(
  outDir: string,
  repeats: number,
  record: PredictionRecord,
): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  await appendFile(predictionFile(outDir, record.repeat), line, 'utf8');
  if (repeats === 1) await appendFile(join(outDir, 'predictions.jsonl'), line, 'utf8');
}

async function materializeEvents(
  outDir: string,
  events: ReadonlyArray<CheckpointEvent>,
): Promise<void> {
  const text =
    events.length === 0 ? '' : events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  await durableReplace(join(outDir, 'run-events.jsonl'), text);
}

/**
 * A completed run retires its checkpoint but run-events.jsonl remains the audit trail
 * (circuit_open/manual_resume). A FRESH run into the same outDir must archive that trail —
 * exactly like a stale checkpoint is archived — never silently overwrite it.
 */
async function archivePriorEvents(outDir: string): Promise<void> {
  const path = join(outDir, 'run-events.jsonl');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return; // No prior events (or no outDir yet) — nothing to preserve.
  }
  if (text.trim().length === 0) return;
  await rename(path, `${path}.prior-${Date.now()}`);
}

async function materializeManifest(outDir: string, manifest: RunManifest): Promise<void> {
  await durableReplace(join(outDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function writeDerivedState(
  options: RunExecutionOptions,
  policy: RunPolicy,
  status: RunHealth['status'],
  records: ReadonlyMap<string, PredictionRecord>,
  consecutiveContractFailures: number,
  preflight: SpendPreflight,
  events: ReadonlyArray<CheckpointEvent>,
  manifest: RunManifest,
  stoppedReason?: string,
): Promise<RunHealth> {
  const ordered = canonicalRecords(options.docs, options.repeats, records);
  const planned = options.docs.length * options.repeats;
  const health = buildHealth(
    options.adapter.id,
    status,
    planned,
    options.repeats,
    ordered,
    consecutiveContractFailures,
    policy.contractFailureLimit,
  );
  await durableReplace(
    join(options.outDir, 'run-health.json'),
    JSON.stringify(health, null, 2) + '\n',
  );
  await durableReplace(
    join(options.outDir, 'run-meta.json'),
    JSON.stringify(
      {
        version: 2,
        adapter: options.adapter.id,
        mode: options.mode,
        structuredMode: options.structuredMode,
        // Smoke-driven trims are part of the run's identity — recorded here AND in the
        // manifest's requestedConfiguration; an empty list means the full documented body ran.
        trimmedParams: options.trimParams ?? [],
        ...(options.capBranch === undefined ? {} : { pageCapBranch: options.capBranch }),
        ...(options.adapter.id === 'gemini'
          ? {
              geminiEndpointRoute:
                options.geminiVertexProject === undefined ? 'aistudio' : 'vertex',
            }
          : {}),
        // For the velrim arm the assertion state is ALWAYS recorded — whether the served
        // fitted stamp was asserted (live) or not (fixture/dogfood) is itself a fact
        // run-meta must state (the serving stack is proven by the stamp, never assumed).
        ...(options.adapter.id === 'velrim'
          ? { requireFittedStamp: options.requireFittedStamp === true }
          : {}),
        repeats: options.repeats,
        status,
        golden: options.goldenPath,
        docs: options.docs.length,
        docsPath: options.docsPath,
        generatedAt: health.updatedAt,
        updatedAt: health.updatedAt,
        runWindow: manifest.run,
        policy: {
          docTimeoutMs: policy.docTimeoutMs,
          maxTransportRetries: policy.maxTransportRetries,
          contractFailureLimit: policy.contractFailureLimit,
          retryBackoffMs: policy.retryBackoffMs,
        },
        spendPreflight: preflight,
        runManifest: {
          path: 'run-manifest.json',
          fingerprint: manifest.run.fingerprint,
          implementationHash: manifest.code.implementationHash,
        },
        events,
        health,
        ...(stoppedReason === undefined ? {} : { stoppedReason }),
      },
      null,
      2,
    ) + '\n',
  );
  await materializeManifest(options.outDir, manifest);
  return health;
}

/**
 * Run all missing doc-repeat units, writing the checkpoint first and derived outputs immediately
 * after every outcome. A paused circuit requires explicit `resumePaused` acknowledgement.
 */
export async function executeRun(options: RunExecutionOptions): Promise<RunExecutionResult> {
  if (options.mode === 'live') {
    if (
      options.spend === undefined ||
      !Number.isFinite(options.spend.fullRunUsd) ||
      options.spend.fullRunUsd <= 0 ||
      options.spend.basis.trim().length === 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(options.spend.asOf) ||
      Number.isNaN(Date.parse(`${options.spend.asOf}T00:00:00Z`)) ||
      new Date(`${options.spend.asOf}T00:00:00Z`).toISOString().slice(0, 10) !== options.spend.asOf
    ) {
      throw new Error('live execution requires a positive spend estimate and pricing basis');
    }
    if (options.onPreflight === undefined) {
      throw new Error('live execution requires a preflight callback before transport dispatch');
    }
  }
  const policy: RunPolicy = {
    docTimeoutMs: options.policy?.docTimeoutMs ?? DEFAULT_DOC_TIMEOUT_MS,
    maxTransportRetries: options.policy?.maxTransportRetries ?? MAX_TRANSPORT_RETRIES,
    contractFailureLimit: options.policy?.contractFailureLimit ?? options.repeats,
    retryBackoffMs: options.policy?.retryBackoffMs ?? RETRY_BACKOFF_MS,
  };
  const fingerprintConfig: RunFingerprintConfig = {
    adapter: options.adapter.id,
    implementationHash: options.implementationHash,
    provenanceHash: sha256(
      JSON.stringify({
        fixtureInput: options.provenance.fixtureInput,
        classes: options.provenance.classes,
        sharedInstruction: options.provenance.sharedInstruction,
        scoring: options.provenance.scoring,
        requestedConfiguration: options.provenance.requestedConfiguration,
      }),
    ),
    mode: options.mode,
    structuredMode: options.structuredMode,
    trimParams: options.trimParams ?? [],
    capBranch: options.capBranch ?? null,
    repeats: options.repeats,
    docTimeoutMs: policy.docTimeoutMs,
    maxTransportRetries: policy.maxTransportRetries,
    contractFailureLimit: policy.contractFailureLimit,
    retryBackoffMs: policy.retryBackoffMs,
  };
  const fingerprint = runFingerprint(fingerprintConfig, options.docs);
  const releaseLock = await acquireRunLock(options.outDir, fingerprint, options.recoverStaleLock);
  try {
    const checkpointPath = join(options.outDir, RUN_CHECKPOINT_FILE);
    let checkpoint = await loadRunCheckpoint(checkpointPath, fingerprint);
    if (
      checkpoint.state === 'valid' &&
      checkpoint.codeState !== undefined &&
      checkpoint.codeState.commitSha !== options.provenance.commitSha &&
      options.allowCommitDrift !== true
    ) {
      // The fingerprint already proves the velrim-eval implementation is unchanged; this extra
      // gate catches surprise drift. An UNRELATED monorepo commit (e.g. a docs-only change) is the
      // acknowledged escape: --allow-commit-drift resumes with the checkpoint's original commit
      // preserved in the manifest.
      throw new Error(
        'velrim-eval commit changed since this checkpoint started; refusing to mix run commits ' +
          '(checkout the checkpoint commit, or pass --allow-commit-drift for an unrelated commit)',
      );
    }
    if (
      checkpoint.state === 'valid' &&
      checkpoint.codeState?.worktreeDirty === false &&
      options.provenance.worktreeDirty !== false
    ) {
      throw new Error(
        'worktree became dirty since this checkpoint started; refusing to mix run code states',
      );
    }
    // The CLI excludes the dedicated outDir from its Git probe, so a clean checkpoint must remain
    // clean on every resume. Preserve a dirty run-start state conservatively: it can never become
    // publication-ready merely because later edits happen to be removed.
    const manifestOptions: RunExecutionOptions =
      checkpoint.state === 'valid' && checkpoint.codeState !== undefined
        ? {
            ...options,
            provenance: {
              ...options.provenance,
              commitSha: checkpoint.codeState.commitSha,
              worktreeDirty: checkpoint.codeState.worktreeDirty,
            },
          }
        : options;
    const planned = options.docs.length * options.repeats;
    // Immutable for the run's lifetime — hashed ONCE, reused by every manifest rebuild below.
    const semanticInputs = computeSemanticInputs(options.docs);
    const restored = checkpoint.state === 'valid' ? checkpoint.records.size : 0;
    const restoredOrdered =
      checkpoint.state === 'valid'
        ? canonicalRecords(options.docs, options.repeats, checkpoint.records)
        : [];
    const restoredConsecutive = trailingContractFailures(
      restoredOrdered.slice(checkpoint.manualResumeAtRecord),
    );
    const effectivelyPaused =
      checkpoint.state === 'valid' &&
      (checkpoint.paused || restoredConsecutive >= policy.contractFailureLimit);
    const remaining = planned - restored;
    const startedAt =
      checkpoint.state === 'valid' && checkpoint.startedAt !== undefined
        ? checkpoint.startedAt
        : new Date().toISOString();
    const preflight: SpendPreflight = {
      adapter: options.adapter.id,
      mode: options.mode,
      docs: options.docs.length,
      repeats: options.repeats,
      plannedDocRepeats: planned,
      remainingDocRepeats: remaining,
      maxTransportRetriesPerDocRepeat: policy.maxTransportRetries,
      ...(options.spend === undefined
        ? {}
        : {
            expectedFullRunUsd: options.spend.fullRunUsd,
            expectedRemainingUsd:
              planned === 0 ? 0 : options.spend.fullRunUsd * (remaining / planned),
            pricingBasis: options.spend.basis,
            pricingAsOf: options.spend.asOf,
          }),
    };
    options.onPreflight?.(preflight);

    // If a crash landed after the threshold record but before its event append, reconstruct the
    // protocol event from the durable streak before allowing any continuation.
    if (effectivelyPaused && checkpoint.state === 'valid' && !checkpoint.paused) {
      const event: CheckpointEvent = {
        kind: 'event',
        event: 'circuit_open',
        atRecord: checkpoint.records.size,
        at: new Date().toISOString(),
      };
      await appendCheckpointLine(checkpointPath, event);
      checkpoint.events.push(event);
      checkpoint.paused = true;
    }

    if (effectivelyPaused && !options.resumePaused) {
      const manifest = buildManifest(
        manifestOptions,
        policy,
        fingerprint,
        startedAt,
        null,
        checkpoint.records,
        semanticInputs,
      );
      await materializePredictions(
        options.outDir,
        options.docs,
        options.repeats,
        checkpoint.records,
      );
      await materializeEvents(options.outDir, checkpoint.events);
      const health = await writeDerivedState(
        options,
        policy,
        'paused',
        checkpoint.records,
        restoredConsecutive,
        preflight,
        checkpoint.events,
        manifest,
      );
      return { status: 'paused', preflight, records: checkpoint.records.size, restored, health };
    }
    if (options.mode === 'live' && remaining > 0 && !options.confirmSpend) {
      return { status: 'confirmation_required', preflight, records: restored, restored };
    }

    if (checkpoint.state !== 'valid') {
      // A fresh run supersedes prior derived outputs, but the audit trail is archived —
      // never silently erased (symmetric with stale-checkpoint archiving).
      await archivePriorEvents(options.outDir);
      await createRunCheckpoint(
        checkpointPath,
        fingerprint,
        planned,
        checkpoint.state === 'stale',
        startedAt,
        {
          commitSha: options.provenance.commitSha,
          worktreeDirty: options.provenance.worktreeDirty,
        },
      );
      checkpoint = {
        state: 'valid',
        records: new Map(),
        ordered: [],
        paused: false,
        manualResumeAtRecord: 0,
        events: [],
        startedAt,
        codeState: {
          commitSha: options.provenance.commitSha,
          worktreeDirty: options.provenance.worktreeDirty,
        },
      };
    }
    await materializePredictions(options.outDir, options.docs, options.repeats, checkpoint.records);
    await materializeEvents(options.outDir, checkpoint.events);

    let consecutive = restoredConsecutive;
    if (effectivelyPaused && options.resumePaused) {
      const event: CheckpointEvent = {
        kind: 'event',
        event: 'manual_resume',
        atRecord: checkpoint.records.size,
        at: new Date().toISOString(),
      };
      await appendCheckpointLine(checkpointPath, event);
      checkpoint.events.push(event);
      await materializeEvents(options.outDir, checkpoint.events);
      consecutive = 0;
      checkpoint.manualResumeAtRecord = checkpoint.records.size;
    }
    await writeDerivedState(
      options,
      policy,
      'running',
      checkpoint.records,
      consecutive,
      preflight,
      checkpoint.events,
      buildManifest(
        manifestOptions,
        policy,
        fingerprint,
        startedAt,
        null,
        checkpoint.records,
        semanticInputs,
      ),
    );

    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const doc of options.docs) {
        const key = predictionKey(doc.docClass, doc.doc, repeat);
        if (checkpoint.records.has(key)) continue;
        let record: PredictionRecord;
        try {
          record = await executeDocRepeat(
            options.adapter,
            doc,
            repeat,
            options.mode,
            options.structuredMode,
            options.transportFactory,
            policy,
            {
              ...(options.trimParams === undefined ? {} : { trimParams: options.trimParams }),
              ...(options.capBranch === undefined ? {} : { capBranch: options.capBranch }),
              ...(options.requireFittedStamp === undefined
                ? {}
                : { requireFittedStamp: options.requireFittedStamp }),
              ...(options.geminiVertexProject === undefined
                ? {}
                : { geminiVertexProject: options.geminiVertexProject }),
            },
          );
        } catch (error) {
          await writeDerivedState(
            options,
            policy,
            'stopped',
            checkpoint.records,
            consecutive,
            preflight,
            checkpoint.events,
            buildManifest(
              manifestOptions,
              policy,
              fingerprint,
              startedAt,
              null,
              checkpoint.records,
              semanticInputs,
            ),
            'non_retryable_runner_or_provider_error',
          );
          throw error;
        }
        await appendCheckpointLine(checkpointPath, record);
        checkpoint.records.set(key, record);
        await appendPrediction(options.outDir, options.repeats, record);

        if (record.availability === 'contract_failure') consecutive++;
        else consecutive = 0;

        const willPause = consecutive >= policy.contractFailureLimit;
        if (willPause) {
          const event: CheckpointEvent = {
            kind: 'event',
            event: 'circuit_open',
            atRecord: checkpoint.records.size,
            at: new Date().toISOString(),
          };
          await appendCheckpointLine(checkpointPath, event);
          checkpoint.events.push(event);
          checkpoint.paused = true;
          await materializeEvents(options.outDir, checkpoint.events);
        }
        const status: RunHealth['status'] = willPause ? 'paused' : 'running';
        const health = await writeDerivedState(
          options,
          policy,
          status,
          checkpoint.records,
          consecutive,
          preflight,
          checkpoint.events,
          buildManifest(
            manifestOptions,
            policy,
            fingerprint,
            startedAt,
            null,
            checkpoint.records,
            semanticInputs,
          ),
        );
        if (willPause) {
          return {
            status: 'paused',
            preflight,
            records: checkpoint.records.size,
            restored,
            health,
          };
        }
      }
    }

    // Prediction/event outputs are complete before the stable completion stamp is finalized.
    await materializePredictions(options.outDir, options.docs, options.repeats, checkpoint.records);
    await materializeEvents(options.outDir, checkpoint.events);
    const completedAt = new Date().toISOString();
    const manifest = buildManifest(
      manifestOptions,
      policy,
      fingerprint,
      startedAt,
      completedAt,
      checkpoint.records,
      semanticInputs,
    );
    const health = await writeDerivedState(
      options,
      policy,
      'completed',
      checkpoint.records,
      consecutive,
      preflight,
      checkpoint.events,
      manifest,
    );
    // Derived outputs + metadata are durable; only now retire the recovery sidecar.
    await rm(checkpointPath, { force: true });
    return {
      status: 'completed',
      preflight,
      records: checkpoint.records.size,
      restored,
      health,
    };
  } finally {
    await releaseLock();
  }
}
