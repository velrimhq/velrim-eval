/** Durable, fingerprinted JSONL checkpoint for paid eval runs. */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AdapterField,
  AdapterResponseProvenance,
  EvalAdapterId,
  PageCapBranch,
  TrimmableParam,
} from '../adapters/types.js';
import { adapterFieldViolation, isResponseProvenance } from '../adapters/types.js';

export const RUN_CHECKPOINT_VERSION = 3;
export const RUN_CHECKPOINT_FILE = 'run.checkpoint.jsonl';

export type Availability = 'completed' | 'transport_failure' | 'contract_failure';

export interface PreparedRunDoc {
  doc: string;
  docClass: string;
  bytes: Uint8Array;
  schema: object;
  golden: unknown;
}

export interface RunFingerprintConfig {
  adapter: EvalAdapterId;
  /** SHA-256 over the runner, selected adapter, transport, and shared helper bytes. */
  implementationHash: string;
  /** Hash of raw artifact/config provenance, including fixture bytes in fixture mode. */
  provenanceHash: string;
  mode: 'fixture' | 'live';
  structuredMode: boolean;
  /** Smoke-driven param trims — a different request body is a different run. */
  trimParams: readonly TrimmableParam[];
  /** Page-cap branch — arming the over-cap guard changes run behavior. */
  capBranch: PageCapBranch | null;
  repeats: number;
  docTimeoutMs: number;
  maxTransportRetries: number;
  contractFailureLimit: number;
  retryBackoffMs: readonly number[];
}

export interface PredictionRecord {
  kind: 'prediction';
  doc: string;
  docClass: string;
  repeat: number;
  fields: Record<string, AdapterField>;
  availability: Availability;
  requestAttempts: number;
  transportRetries: number;
  error?: string;
  provenance?: AdapterResponseProvenance;
}

interface CheckpointHeader {
  kind: 'header';
  version: number;
  fingerprint: string;
  records: number;
  startedAt: string;
  codeState: RunCodeState;
}

export interface RunCodeState {
  commitSha: string | null;
  worktreeDirty: boolean | null;
}

export interface CheckpointEvent {
  kind: 'event';
  event: 'circuit_open' | 'manual_resume';
  atRecord: number;
  at: string;
}

export interface LoadedRunCheckpoint {
  state: 'missing' | 'valid' | 'stale';
  records: Map<string, PredictionRecord>;
  ordered: PredictionRecord[];
  paused: boolean;
  /** Number of prediction records present when the last manual-resume event was appended. */
  manualResumeAtRecord: number;
  events: CheckpointEvent[];
  startedAt?: string;
  codeState?: RunCodeState;
}

const KEY_SEP = String.fromCharCode(0);

/** THE composite doc identity — every (docClass, doc) join (run dedup, score) derives from it. */
export function docKey(docClass: string, doc: string): string {
  return `${docClass}${KEY_SEP}${doc}`;
}

export function predictionKey(docClass: string, doc: string, repeat: number): string {
  return `${docKey(docClass, doc)}${KEY_SEP}${repeat}`;
}

/** Fingerprint every input that can change a paid prediction or its run policy. */
export function runFingerprint(
  config: RunFingerprintConfig,
  docs: ReadonlyArray<PreparedRunDoc>,
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ version: RUN_CHECKPOINT_VERSION, ...config }));
  hash.update('\n');
  for (const doc of docs) {
    hash.update(
      JSON.stringify({
        doc: doc.doc,
        docClass: doc.docClass,
        schema: doc.schema,
        golden: doc.golden,
        byteLength: doc.bytes.byteLength,
      }),
    );
    hash.update('\n');
    hash.update(doc.bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function isPredictionRecord(value: unknown): value is PredictionRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['kind'] === 'prediction' &&
    typeof record['doc'] === 'string' &&
    typeof record['docClass'] === 'string' &&
    Number.isInteger(record['repeat']) &&
    (record['repeat'] as number) > 0 &&
    isAdapterFields(record['fields']) &&
    (record['availability'] === 'completed' ||
      record['availability'] === 'transport_failure' ||
      record['availability'] === 'contract_failure') &&
    Number.isInteger(record['requestAttempts']) &&
    Number.isInteger(record['transportRetries']) &&
    (record['provenance'] === undefined || isResponseProvenance(record['provenance']))
  );
}

// Read-side validation is the single-sourced shape in adapters/types.ts (adapterFieldViolation +
// isResponseProvenance): the checkpoint accepts exactly what the runner's write side persists,
// so a validator change can never orphan (and truncate away) already-paid records on resume.
function isAdapterFields(value: unknown): value is Record<string, AdapterField> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const field of Object.values(value as Record<string, unknown>)) {
    if (adapterFieldViolation(field) !== null) return false;
  }
  return true;
}

let tempSequence = 0;

/** Durable atomic replace (temp + fsync + rename) — THE primitive for every derived/state file. */
export async function durableReplace(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${tempSequence++}`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

async function durableAppend(path: string, text: string): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Load a matching checkpoint. A torn/malformed final line is ignored; all complete records before
 * it remain resumable. A fingerprint mismatch is reported as stale and never mixed into the run.
 */
export async function loadRunCheckpoint(
  path: string,
  fingerprint: string,
): Promise<LoadedRunCheckpoint> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'missing',
        records: new Map(),
        ordered: [],
        paused: false,
        manualResumeAtRecord: 0,
        events: [],
      };
    }
    throw error;
  }

  const lines = text.split(/\r?\n/);
  let header: CheckpointHeader;
  try {
    header = JSON.parse(lines[0] ?? '') as CheckpointHeader;
  } catch {
    return {
      state: 'stale',
      records: new Map(),
      ordered: [],
      paused: false,
      manualResumeAtRecord: 0,
      events: [],
    };
  }
  if (
    header.kind !== 'header' ||
    header.version !== RUN_CHECKPOINT_VERSION ||
    header.fingerprint !== fingerprint ||
    typeof header.startedAt !== 'string' ||
    Number.isNaN(Date.parse(header.startedAt)) ||
    !isRunCodeState(header.codeState)
  ) {
    return {
      state: 'stale',
      records: new Map(),
      ordered: [],
      paused: false,
      manualResumeAtRecord: 0,
      events: [],
    };
  }

  const records = new Map<string, PredictionRecord>();
  const ordered: PredictionRecord[] = [];
  let paused = false;
  let manualResumeAtRecord = 0;
  const events: CheckpointEvent[] = [];
  const validLines = [lines[0] ?? ''];
  let tornTail = false;
  // A crash can only tear the FINAL append. An invalid line with more data after it is NOT a
  // torn tail — auto-"repairing" there would silently truncate already-paid records — so that
  // case refuses and demands manual inspection instead.
  const tearOrRefuse = (index: number, reason: string): void => {
    if (lines.slice(index + 1).some((rest) => rest.trim().length > 0)) {
      throw new Error(
        `checkpoint ${path} line ${index + 1} is ${reason} but is followed by more records; ` +
          'refusing to auto-repair (paid records would be truncated — inspect the file manually)',
      );
    }
    tornTail = true;
  };
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      tearOrRefuse(index, 'not valid JSON');
      break;
    }
    if (isPredictionRecord(parsed)) {
      const key = predictionKey(parsed.docClass, parsed.doc, parsed.repeat);
      if (records.has(key)) {
        tearOrRefuse(index, 'a duplicate doc-repeat record');
        break;
      }
      records.set(key, parsed);
      ordered.push(parsed);
      validLines.push(line);
      continue;
    }
    const event = parsed as Partial<CheckpointEvent>;
    if (
      event.kind !== 'event' ||
      (event.event !== 'circuit_open' && event.event !== 'manual_resume') ||
      !Number.isInteger(event.atRecord) ||
      typeof event.at !== 'string'
    ) {
      tearOrRefuse(index, 'neither a prediction record nor a protocol event');
      break;
    }
    paused = event.event === 'circuit_open';
    if (event.event === 'manual_resume') manualResumeAtRecord = event.atRecord ?? ordered.length;
    events.push(event as CheckpointEvent);
    validLines.push(line);
  }
  // Repair a genuinely torn final append to its verified prefix before any resume appends;
  // otherwise new paid records would sit after invalid bytes and vanish on the next load.
  if (tornTail) await durableReplace(path, validLines.join('\n') + '\n');
  return {
    state: 'valid',
    records,
    ordered,
    paused,
    manualResumeAtRecord,
    events,
    startedAt: header.startedAt,
    codeState: header.codeState,
  };
}

function isRunCodeState(value: unknown): value is RunCodeState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    (state['commitSha'] === null || typeof state['commitSha'] === 'string') &&
    (state['worktreeDirty'] === null || typeof state['worktreeDirty'] === 'boolean')
  );
}

export async function createRunCheckpoint(
  path: string,
  fingerprint: string,
  totalRecords: number,
  archiveStale: boolean,
  startedAt = new Date().toISOString(),
  codeState: RunCodeState = { commitSha: null, worktreeDirty: null },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (archiveStale) {
    const archived = `${path}.stale-${Date.now()}`;
    await rename(path, archived);
  }
  const header: CheckpointHeader = {
    kind: 'header',
    version: RUN_CHECKPOINT_VERSION,
    fingerprint,
    records: totalRecords,
    startedAt,
    codeState,
  };
  await durableReplace(path, JSON.stringify(header) + '\n');
}

export async function appendCheckpointLine(
  path: string,
  line: PredictionRecord | CheckpointEvent,
): Promise<void> {
  await durableAppend(path, JSON.stringify(line) + '\n');
}
