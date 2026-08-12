import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterExtractResult,
  EvalAdapter,
  EvalAdapterOpts,
  Transport,
} from '../src/adapters/types.js';
import { isResponseProvenance, sanitizeResponseProvenance } from '../src/adapters/types.js';
import {
  ContractFailureError,
  FatalRunError,
  TransportFailureError,
} from '../src/adapters/errors.js';
import {
  computeSemanticInputs,
  executeDocRepeat,
  executeRun,
  type RunExecutionOptions,
  type RunPolicy,
} from '../src/run/runner.js';
import {
  appendCheckpointLine,
  createRunCheckpoint,
  docKey,
  loadRunCheckpoint,
  predictionKey,
  runFingerprint,
  type PredictionRecord,
  type PreparedRunDoc,
  type RunFingerprintConfig,
} from '../src/run/checkpoint.js';

const roots: string[] = [];
const POLICY: RunPolicy = {
  docTimeoutMs: 1_000,
  maxTransportRetries: 2,
  contractFailureLimit: 3,
  retryBackoffMs: [0, 0],
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'veval-runner-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function docs(...names: string[]): PreparedRunDoc[] {
  return names.map((name) => ({
    doc: `${name}.pdf`,
    docClass: 'test',
    bytes: new TextEncoder().encode(name),
    schema: { type: 'object', properties: { value: { type: 'string' } } },
    golden: {
      docClass: 'test',
      fields: { '/value': { state: 'present', value: name } },
    },
  }));
}

function transportFactory(send: Transport['send']): (signal: AbortSignal) => Transport {
  return () => ({ mode: 'fixture', send });
}

function successfulAdapter(onExtract?: (name: string) => void): EvalAdapter {
  return {
    id: 'velrim',
    async extract(bytes, _schema, opts): Promise<AdapterExtractResult> {
      const name = new TextDecoder().decode(bytes);
      onExtract?.(name);
      await opts.transport.send({ key: 'test', url: 'https://invalid.test' });
      return { fields: { '/value': { value: name } }, raw: {} };
    },
  };
}

function options(
  root: string,
  adapter: EvalAdapter,
  runDocs: PreparedRunDoc[],
  overrides: Partial<RunExecutionOptions> = {},
): RunExecutionOptions {
  return {
    adapter,
    implementationHash: 'test-implementation-v1',
    provenance: {
      commitSha: 'a'.repeat(40),
      worktreeDirty: false,
      implementationFiles: [
        { path: 'run/runner.ts', sha256: '1'.repeat(64) },
        { path: 'adapters/velrim.ts', sha256: '2'.repeat(64) },
      ],
      fixtureInput: {
        status: 'hashed',
        aggregateSha256: '3'.repeat(64),
        files: [{ path: 'test/recorded/velrim/extract.json', sha256: '4'.repeat(64) }],
      },
      classes: [
        {
          docClass: 'test',
          schema: { path: 'test.schema.json', sha256: '5'.repeat(64) },
          publicGolden: { path: 'golden.jsonl', sha256: '6'.repeat(64) },
          sourceManifest: { path: 'test.manifest.json', sha256: '0'.repeat(64) },
          calTestGoldenHash: '7'.repeat(64),
        },
      ],
      sharedInstruction: 'test shared instruction',
      scoring: { package: '@velrim/scoring', version: '0.1.0' },
      requestedConfiguration: {
        endpoint: 'https://invalid.test',
        model: 'test-model-pin',
        generationSettings: {},
        settingsAlpha: null,
        llamaExtractConfigurationVersion: null,
      },
      rerunPolicy: 'test rerun policy',
    },
    mode: 'fixture',
    structuredMode: false,
    repeats: 1,
    docs: runDocs,
    outDir: root,
    goldenPath: 'golden.jsonl',
    docsPath: 'docs',
    transportFactory: transportFactory(async () => ({})),
    resumePaused: false,
    recoverStaleLock: false,
    confirmSpend: false,
    policy: POLICY,
    ...overrides,
  };
}

describe('repeat outputs and availability', () => {
  it('runs every doc independently for each repeat and writes score-compatible ordered files', async () => {
    const root = await tempRoot();
    const calls: string[] = [];
    const events: string[] = [];
    const result = await executeRun(
      options(
        root,
        successfulAdapter((name) => {
          calls.push(name);
          events.push(`extract:${name}`);
        }),
        docs('a', 'b'),
        { repeats: 3, onPreflight: () => events.push('preflight') },
      ),
    );

    expect(result.status).toBe('completed');
    expect(events[0]).toBe('preflight');
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    for (let repeat = 1; repeat <= 3; repeat++) {
      const text = await readFile(
        join(root, `predictions.repeat-${String(repeat).padStart(3, '0')}.jsonl`),
        'utf8',
      );
      const rows = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows.map((row) => row['doc'])).toEqual(['a.pdf', 'b.pdf']);
      expect(rows.every((row) => row['repeat'] === repeat)).toBe(true);
      expect(rows.every((row) => row['availability'] === 'completed')).toBe(true);
    }
    await expect(readFile(join(root, 'predictions.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const health = JSON.parse(await readFile(join(root, 'run-health.json'), 'utf8')) as {
      aggregate: { attempted: number; completed: number; availability: number };
    };
    expect(health.aggregate).toMatchObject({ attempted: 6, completed: 6, availability: 1 });
    const manifest = JSON.parse(await readFile(join(root, 'run-manifest.json'), 'utf8')) as {
      formatVersion: number;
      code: { implementationHash: string };
      semanticInputs: Array<{ documentSha256: string }>;
      observedVersions: { model: { status: string } };
      run: { startedAt: string; completedAt: string };
    };
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.code.implementationHash).toBe('test-implementation-v1');
    expect(manifest.semanticInputs).toHaveLength(2);
    expect(manifest.semanticInputs[0]?.documentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.observedVersions.model.status).toBe('not_surfaced');
    expect(Date.parse(manifest.run.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(manifest.run.startedAt),
    );
    expect(await readdir(root)).not.toContain('run.checkpoint.jsonl');
  });

  it('aggregates allowlisted response versions without persisting provider bodies', async () => {
    const root = await tempRoot();
    const adapter: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        return {
          fields: { '/value': { value: name } },
          raw: { secretProviderBody: 'must-not-persist' },
          provenance: { modelVersion: `model-${name}`, requestId: `request-${name}` },
        };
      },
    };
    await executeRun(options(root, adapter, docs('a', 'b')));
    const text = await readFile(join(root, 'run-manifest.json'), 'utf8');
    const manifest = JSON.parse(text) as {
      observedVersions: {
        model: { status: string; values: string[] };
        vendor: { status: string; values: string[] };
      };
    };
    expect(manifest.observedVersions.model).toMatchObject({
      status: 'mixed',
      values: ['model-a', 'model-b'],
    });
    expect(manifest.observedVersions.vendor.status).toBe('not_surfaced');
    expect(text).not.toContain('secretProviderBody');
    expect(text).not.toContain('must-not-persist');
  });
});

describe('exclusive output-directory lease', () => {
  it('rejects a concurrent same-output run before constructing any transport', async () => {
    const root = await tempRoot();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const adapter: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        enter();
        await blocked;
        return { fields: { '/value': { value: 'a' } }, raw: {} };
      },
    };
    const first = executeRun(options(root, adapter, docs('a')));
    await entered;

    let transportFactories = 0;
    await expect(
      executeRun(
        options(root, successfulAdapter(), docs('a'), {
          transportFactory: () => {
            transportFactories++;
            return { mode: 'fixture', send: async () => ({}) };
          },
        }),
      ),
    ).rejects.toThrow(/already in use/);
    expect(transportFactories).toBe(0);

    unblock();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(await readdir(root)).not.toContain('run.lock.json');
  });

  it('recovers only an explicitly acknowledged same-host dead-PID lock and retains it', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'run.lock.json'),
      JSON.stringify({
        version: 1,
        nonce: 'dead-owner',
        pid: 999_999,
        hostname: hostname(),
        acquiredAt: '2026-07-14T00:00:00.000Z',
        fingerprint: 'old-run',
      }) + '\n',
    );
    await expect(executeRun(options(root, successfulAdapter(), docs('a')))).rejects.toThrow(
      /recover-stale-lock/,
    );
    await expect(
      executeRun(
        options(root, successfulAdapter(), docs('a'), {
          recoverStaleLock: true,
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    expect((await readdir(root)).some((name) => name.startsWith('run.lock.json.stale-'))).toBe(
      true,
    );
  });

  it('serializes two stale-lock recoverers so exactly one can enter the adapter', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'run.lock.json'),
      JSON.stringify({
        version: 1,
        nonce: 'dead-owner-race',
        pid: 999_999,
        hostname: hostname(),
        acquiredAt: '2026-07-14T00:00:00.000Z',
        fingerprint: 'old-run',
      }) + '\n',
    );
    let entered!: () => void;
    const firstEntry = new Promise<void>((resolve) => (entered = resolve));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    let extracts = 0;
    const adapter: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        extracts++;
        entered();
        await blocked;
        return { fields: { '/value': { value: 'a' } }, raw: {} };
      },
    };
    const first = executeRun(options(root, adapter, docs('a'), { recoverStaleLock: true }));
    const second = executeRun(options(root, adapter, docs('a'), { recoverStaleLock: true }));
    const firstFailure = first.catch((error: unknown) => error);
    const secondFailure = second.catch((error: unknown) => error);
    await firstEntry;
    const rejected = await Promise.race([
      firstFailure,
      secondFailure,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    expect(rejected).toBeInstanceOf(Error);
    expect(extracts).toBe(1);
    unblock();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

describe('failure taxonomy and whole-doc deadline', () => {
  it('fails closed when a programmatic live caller omits spend or preflight rails', async () => {
    const root = await tempRoot();
    const base = options(root, successfulAdapter(), docs('a'), {
      mode: 'live',
      confirmSpend: true,
    });
    await expect(executeRun(base)).rejects.toThrow(/spend estimate/);
    await expect(
      executeRun({
        ...base,
        spend: { fullRunUsd: 1, basis: 'test fixture rate', asOf: '2026-07-14' },
      }),
    ).rejects.toThrow(/preflight callback/);
  });

  it('retries a transient transport failure at most twice and counts eventual success available', async () => {
    let sends = 0;
    const adapter = successfulAdapter();
    const record = await executeDocRepeat(
      adapter,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => {
        sends++;
        if (sends < 3) throw new TransportFailureError('temporary reset');
        return {};
      }),
      POLICY,
    );
    expect(record).toMatchObject({
      availability: 'completed',
      requestAttempts: 3,
      transportRetries: 2,
    });
  });

  it('shares the two-retry ceiling across every transport step in one doc-repeat', async () => {
    let sends = 0;
    const multiStep: EvalAdapter = {
      id: 'velrim',
      async extract(_bytes, _schema, opts): Promise<AdapterExtractResult> {
        for (let step = 0; step < 3; step++) {
          await opts.transport.send({ key: String(step), url: 'https://invalid.test' });
        }
        return { fields: { '/value': { value: 'a' } }, raw: {} };
      },
    };
    const record = await executeDocRepeat(
      multiStep,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => {
        sends++;
        if (sends % 2 === 1) throw new TransportFailureError('step reset');
        return {};
      }),
      POLICY,
    );
    expect(record).toMatchObject({
      availability: 'transport_failure',
      requestAttempts: 5,
      transportRetries: 2,
    });
  });

  it('classifies malformed adapter leaves as contract failures for future adapters too', async () => {
    const malformed: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        return {
          fields: { '/value': null as unknown as { value: unknown } },
          raw: {},
        };
      },
    };
    const record = await executeDocRepeat(
      malformed,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => ({})),
      POLICY,
    );
    expect(record.availability).toBe('contract_failure');
  });

  it('persists exhausted transport and contract failures as distinct empty predictions', async () => {
    const transient = await executeDocRepeat(
      successfulAdapter(),
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => {
        throw new TransportFailureError('still unavailable');
      }),
      POLICY,
    );
    expect(transient).toMatchObject({
      fields: {},
      availability: 'transport_failure',
      requestAttempts: 3,
      transportRetries: 2,
    });

    let sends = 0;
    const contract = await executeDocRepeat(
      successfulAdapter(),
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => {
        sends++;
        throw new ContractFailureError('unusable 2xx');
      }),
      POLICY,
    );
    expect(contract).toMatchObject({ fields: {}, availability: 'contract_failure' });
    expect(sends).toBe(1);
  });

  it('retains allowlisted version metadata on a typed contract failure', async () => {
    const adapter: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        throw new ContractFailureError('unusable 2xx', undefined, undefined, {
          modelVersion: 'model-v1',
          apiVersion: 'api-v2',
          requestId: 'request-safe-id',
        });
      },
    };
    const record = await executeDocRepeat(
      adapter,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => ({})),
      POLICY,
    );
    expect(record).toMatchObject({
      availability: 'contract_failure',
      provenance: {
        modelVersion: 'model-v1',
        apiVersion: 'api-v2',
        requestId: 'request-safe-id',
      },
    });
  });

  it('drops malformed response provenance without changing the failure taxonomy', async () => {
    const adapter: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        throw new ContractFailureError('unusable 2xx', undefined, undefined, {
          modelVersion: '',
          requestId: 'x'.repeat(201),
        });
      },
    };
    const record = await executeDocRepeat(
      adapter,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => ({})),
      POLICY,
    );
    expect(record).toMatchObject({ availability: 'contract_failure', fields: {} });
    expect(record.provenance).toBeUndefined();
  });

  it('aborts the adapter at the shared wall-clock cap and records a transport failure', async () => {
    let aborted = false;
    const hanging: EvalAdapter = {
      id: 'velrim',
      async extract(_bytes, _schema, opts: EvalAdapterOpts): Promise<AdapterExtractResult> {
        return await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(opts.signal?.reason);
            },
            { once: true },
          );
        });
      },
    };
    const record = await executeDocRepeat(
      hanging,
      docs('a')[0]!,
      1,
      'fixture',
      false,
      transportFactory(async () => ({})),
      { ...POLICY, docTimeoutMs: 20 },
    );
    expect(aborted).toBe(true);
    expect(record.availability).toBe('transport_failure');
    expect(record.error).toContain('wall-clock cap');
  });

  it('does not fold auth/billing/configuration errors into availability', async () => {
    await expect(
      executeDocRepeat(
        successfulAdapter(),
        docs('a')[0]!,
        1,
        'fixture',
        false,
        transportFactory(async () => {
          throw new FatalRunError('HTTP 401', 401);
        }),
        POLICY,
      ),
    ).rejects.toBeInstanceOf(FatalRunError);
  });
});

describe('checkpoint resume and the circuit breaker', () => {
  it('truncates a torn tail before later records append, preserving them across a second load', async () => {
    const root = await tempRoot();
    const path = join(root, 'run.checkpoint.jsonl');
    const runDocs = docs('a', 'b');
    const config: RunFingerprintConfig = {
      adapter: 'velrim',
      implementationHash: 'test-implementation-v1',
      provenanceHash: 'test-provenance-v1',
      mode: 'fixture',
      structuredMode: false,
      trimParams: [],
      capBranch: null,
      repeats: 1,
      docTimeoutMs: POLICY.docTimeoutMs,
      maxTransportRetries: POLICY.maxTransportRetries,
      contractFailureLimit: POLICY.contractFailureLimit,
      retryBackoffMs: POLICY.retryBackoffMs,
    };
    const fingerprint = runFingerprint(config, runDocs);
    await createRunCheckpoint(path, fingerprint, 2, false);
    const record = (doc: string): PredictionRecord => ({
      kind: 'prediction',
      doc: `${doc}.pdf`,
      docClass: 'test',
      repeat: 1,
      fields: { '/value': { value: doc } },
      availability: 'completed',
      requestAttempts: 1,
      transportRetries: 0,
    });
    await appendCheckpointLine(path, record('a'));
    await appendFile(path, '{"torn":');

    expect((await loadRunCheckpoint(path, fingerprint)).records.size).toBe(1);
    await appendCheckpointLine(path, record('b'));
    expect((await loadRunCheckpoint(path, fingerprint)).records.size).toBe(2);
  });

  it('preserves a deterministic prefix across a fatal interruption and resumes without re-calls', async () => {
    const resumedRoot = await tempRoot();
    const straightRoot = await tempRoot();
    const runDocs = docs('a', 'b', 'c');
    const firstCalls: string[] = [];
    const crashing: EvalAdapter = {
      id: 'velrim',
      async extract(bytes, _schema, opts): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'c') throw new FatalRunError('manual stop');
        firstCalls.push(name);
        await opts.transport.send({ key: 'test', url: 'https://invalid.test' });
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(executeRun(options(resumedRoot, crashing, runDocs))).rejects.toBeInstanceOf(
      FatalRunError,
    );
    expect(firstCalls).toEqual(['a', 'b']);
    expect(await readdir(resumedRoot)).toContain('run.checkpoint.jsonl');
    const startedAt = (
      JSON.parse(
        (await readFile(join(resumedRoot, 'run.checkpoint.jsonl'), 'utf8')).split('\n')[0]!,
      ) as {
        startedAt: string;
      }
    ).startedAt;
    await appendFile(join(resumedRoot, 'run.checkpoint.jsonl'), '{"torn":');

    const resumedCalls: string[] = [];
    const resumedOptions = options(
      resumedRoot,
      successfulAdapter((name) => resumedCalls.push(name)),
      runDocs,
    );
    const resumed = await executeRun({
      ...resumedOptions,
      provenance: {
        ...resumedOptions.provenance,
        worktreeDirty: false,
      },
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.restored).toBe(2);
    expect(resumedCalls).toEqual(['c']);
    const resumedManifest = JSON.parse(
      await readFile(join(resumedRoot, 'run-manifest.json'), 'utf8'),
    ) as {
      run: { startedAt: string; completedAt: string };
      code: { velrimEvalCommitSha: string; worktreeDirty: boolean };
    };
    expect(resumedManifest.run.startedAt).toBe(startedAt);
    expect(Date.parse(resumedManifest.run.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(startedAt),
    );
    expect(resumedManifest.code).toMatchObject({
      velrimEvalCommitSha: 'a'.repeat(40),
      worktreeDirty: false,
    });

    await executeRun(options(straightRoot, successfulAdapter(), runDocs));
    expect(await readFile(join(resumedRoot, 'predictions.repeat-001.jsonl'), 'utf8')).toBe(
      await readFile(join(straightRoot, 'predictions.repeat-001.jsonl'), 'utf8'),
    );
  });

  it('refuses to resume a checkpoint under a different commit before any adapter call', async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop after first record');
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(executeRun(options(root, interrupted, runDocs))).rejects.toBeInstanceOf(
      FatalRunError,
    );

    let calls = 0;
    const resumed = options(
      root,
      successfulAdapter(() => calls++),
      runDocs,
    );
    await expect(
      executeRun({
        ...resumed,
        provenance: { ...resumed.provenance, commitSha: 'b'.repeat(40) },
      }),
    ).rejects.toThrow(/commit changed/);
    expect(calls).toBe(0);
  });

  it('refuses to resume a clean checkpoint after the worktree becomes dirty', async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop after first record');
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(executeRun(options(root, interrupted, runDocs))).rejects.toBeInstanceOf(
      FatalRunError,
    );

    let calls = 0;
    const resumed = options(
      root,
      successfulAdapter(() => calls++),
      runDocs,
    );
    await expect(
      executeRun({
        ...resumed,
        provenance: { ...resumed.provenance, worktreeDirty: true },
      }),
    ).rejects.toThrow(/worktree became dirty/);
    expect(calls).toBe(0);
  });

  it('archives a stale checkpoint and starts fresh when document bytes change', async () => {
    const root = await tempRoot();
    const original = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes, _schema, opts): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop after first record');
        await opts.transport.send({ key: 'test', url: 'https://invalid.test' });
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(
      executeRun(options(root, interrupted, original, { repeats: 3 })),
    ).rejects.toBeInstanceOf(FatalRunError);

    const changed = docs('a', 'b');
    changed[0] = { ...changed[0]!, bytes: new TextEncoder().encode('a-changed') };
    const calls: string[] = [];
    const result = await executeRun(
      options(
        root,
        successfulAdapter((name) => calls.push(name)),
        changed,
      ),
    );
    expect(result).toMatchObject({ status: 'completed', restored: 0 });
    expect(calls).toEqual(['a-changed', 'b']);
    expect(
      (await readdir(root)).some((name) => name.startsWith('run.checkpoint.jsonl.stale-')),
    ).toBe(true);
    expect(await readdir(root)).not.toContain('predictions.repeat-002.jsonl');
    expect(await readdir(root)).not.toContain('predictions.repeat-003.jsonl');
  });

  it('invalidates resume when the runner/adapter implementation hash changes', async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes, _schema, opts): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop');
        await opts.transport.send({ key: 'test', url: 'https://invalid.test' });
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(executeRun(options(root, interrupted, runDocs))).rejects.toBeInstanceOf(
      FatalRunError,
    );
    const calls: string[] = [];
    const result = await executeRun(
      options(
        root,
        successfulAdapter((name) => calls.push(name)),
        runDocs,
        {
          implementationHash: 'test-implementation-v2',
        },
      ),
    );
    expect(result.restored).toBe(0);
    expect(calls).toEqual(['a', 'b']);
  });

  it('invalidates resume when fixture bytes or raw schema provenance changes', async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop');
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    const initial = options(root, interrupted, runDocs);
    await expect(executeRun(initial)).rejects.toBeInstanceOf(FatalRunError);

    const changedProvenance = {
      ...initial.provenance,
      fixtureInput: {
        status: 'hashed' as const,
        aggregateSha256: '8'.repeat(64),
        files: [{ path: 'test/recorded/velrim/extract.json', sha256: '9'.repeat(64) }],
      },
      classes: initial.provenance.classes.map((item) => ({
        ...item,
        schema: { path: 'test.schema.json', sha256: 'a'.repeat(64) },
      })),
    };
    const calls: string[] = [];
    const result = await executeRun(
      options(
        root,
        successfulAdapter((name) => calls.push(name)),
        runDocs,
        {
          provenance: changedProvenance,
        },
      ),
    );
    expect(result.restored).toBe(0);
    expect(calls).toEqual(['a', 'b']);
    expect(
      (await readdir(root)).some((name) => name.startsWith('run.checkpoint.jsonl.stale-')),
    ).toBe(true);
  });

  it('resets the consecutive-contract streak on a transport failure', async () => {
    const root = await tempRoot();
    let call = 0;
    const outcomes: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        call++;
        if (call === 2) throw new TransportFailureError('transient outage');
        throw new ContractFailureError('unusable response');
      },
    };
    const result = await executeRun(
      options(root, outcomes, docs('a', 'b', 'c', 'd'), { repeats: 3 }),
    );
    expect(result.status).toBe('paused');
    expect(result.records).toBe(5);
  });

  it('pauses before the fourth consecutive contract failure and requires explicit manual resume', async () => {
    const root = await tempRoot();
    const calls: string[] = [];
    const broken: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        calls.push(new TextDecoder().decode(bytes));
        throw new ContractFailureError('systematic response break');
      },
    };
    const runDocs = docs('a', 'b', 'c', 'd');
    const base = options(root, broken, runDocs, { repeats: 3 });

    const paused = await executeRun(base);
    expect(paused.status).toBe('paused');
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(paused.health).toMatchObject({
      status: 'paused',
      consecutiveContractFailures: 3,
      aggregate: { attempted: 3, contractFailures: 3, completed: 0 },
    });

    // Simulate a crash after the third durable prediction but before the circuit-open event.
    // The restored streak must still prevent a fourth paid call.
    const checkpointPath = join(root, 'run.checkpoint.jsonl');
    const checkpointLines = (await readFile(checkpointPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(checkpointLines.at(-1)!) as { event: string }).toMatchObject({
      event: 'circuit_open',
    });
    await writeFile(checkpointPath, checkpointLines.slice(0, -1).join('\n') + '\n');
    await writeFile(join(root, 'predictions.repeat-001.jsonl'), '');
    await writeFile(join(root, 'run-health.json'), '{"status":"completed"}\n');

    const stillPaused = await executeRun(base);
    expect(stillPaused.status).toBe('paused');
    expect(calls).toHaveLength(3);
    expect(
      (await readFile(join(root, 'predictions.repeat-001.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(3);
    expect(JSON.parse(await readFile(join(root, 'run-health.json'), 'utf8'))).toMatchObject({
      status: 'paused',
      aggregate: { attempted: 3 },
    });
    expect(await readFile(join(root, 'run-events.jsonl'), 'utf8')).toContain('circuit_open');

    const pausedAgain = await executeRun({ ...base, resumePaused: true });
    expect(pausedAgain.status).toBe('paused');
    expect(calls).toEqual(['a', 'b', 'c', 'd', 'a', 'b']);
    expect(pausedAgain.records).toBe(6);
    const events = (await readFile(join(root, 'run-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual([
      'circuit_open',
      'manual_resume',
      'circuit_open',
    ]);
  });
});

describe('commit-drift acknowledgement (resume after an unrelated monorepo commit)', () => {
  it('resumes a fingerprint-matching checkpoint under --allow-commit-drift, keeping the ORIGINAL commit in the manifest', async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b');
    const interrupted: EvalAdapter = {
      id: 'velrim',
      async extract(bytes): Promise<AdapterExtractResult> {
        const name = new TextDecoder().decode(bytes);
        if (name === 'b') throw new FatalRunError('stop after first record');
        return { fields: { '/value': { value: name } }, raw: {} };
      },
    };
    await expect(executeRun(options(root, interrupted, runDocs))).rejects.toBeInstanceOf(
      FatalRunError,
    );

    // An unrelated commit landed (e.g. a docs-only commit): HEAD changed, the velrim-eval
    // implementation fingerprint did NOT. Without acknowledgement the gate still refuses...
    const calls: string[] = [];
    const resumed = options(
      root,
      successfulAdapter((name) => calls.push(name)),
      runDocs,
    );
    const drifted = { ...resumed.provenance, commitSha: 'b'.repeat(40) };
    await expect(executeRun({ ...resumed, provenance: drifted })).rejects.toThrow(/commit changed/);
    expect(calls).toHaveLength(0);

    // ...and with the explicit flag the paid record is preserved and only the missing doc runs.
    const result = await executeRun({ ...resumed, provenance: drifted, allowCommitDrift: true });
    expect(result.status).toBe('completed');
    expect(result.restored).toBe(1);
    expect(calls).toEqual(['b']);
    const manifest = JSON.parse(await readFile(join(root, 'run-manifest.json'), 'utf8')) as {
      code: { velrimEvalCommitSha: string };
    };
    // The manifest keeps the checkpoint's run-start commit — the drift never rewrites provenance.
    expect(manifest.code.velrimEvalCommitSha).toBe('a'.repeat(40));
  });
});

describe('run-events audit-trail retention across fresh runs', () => {
  it("archives a completed run's run-events.jsonl instead of silently overwriting it", async () => {
    const root = await tempRoot();
    const runDocs = docs('a', 'b', 'c');
    const broken: EvalAdapter = {
      id: 'velrim',
      async extract(): Promise<AdapterExtractResult> {
        throw new ContractFailureError('systematic response break');
      },
    };
    const base = options(root, broken, runDocs);
    const paused = await executeRun(base);
    expect(paused.status).toBe('paused');

    // Manual resume: all doc-repeats already have durable records, so the run completes and the
    // checkpoint retires — run-events.jsonl now holds the circuit_open/manual_resume audit trail.
    const completed = await executeRun({ ...base, resumePaused: true });
    expect(completed.status).toBe('completed');
    const auditTrail = await readFile(join(root, 'run-events.jsonl'), 'utf8');
    expect(auditTrail).toContain('circuit_open');
    expect(auditTrail).toContain('manual_resume');

    // A fresh run into the same outDir must not erase the paid run's protocol audit trail.
    const rerun = await executeRun(options(root, successfulAdapter(), runDocs));
    expect(rerun.status).toBe('completed');
    expect(await readFile(join(root, 'run-events.jsonl'), 'utf8')).toBe('');
    const archived = (await readdir(root)).filter((name) =>
      name.startsWith('run-events.jsonl.prior-'),
    );
    expect(archived).toHaveLength(1);
    const archivedText = await readFile(join(root, archived[0]!), 'utf8');
    expect(archivedText).toContain('circuit_open');
    expect(archivedText).toContain('manual_resume');
  });
});

describe('checkpoint load safety — auto-repair only ever trims a genuine tail', () => {
  const FP = 'fp-load-safety';
  const record = (doc: string, repeat = 1): PredictionRecord => ({
    kind: 'prediction',
    doc,
    docClass: 'test',
    repeat,
    fields: { '/value': { value: doc } },
    availability: 'completed',
    requestAttempts: 1,
    transportRetries: 0,
  });

  it('repairs a torn FINAL line and keeps every complete record before it', async () => {
    const root = await tempRoot();
    const path = join(root, 'run.checkpoint.jsonl');
    await createRunCheckpoint(path, FP, 2, false);
    await appendCheckpointLine(path, record('a.pdf'));
    await appendFile(path, '{"kind":"predicti', 'utf8'); // a crash-torn append, no newline

    const loaded = await loadRunCheckpoint(path, FP);
    expect(loaded.state).toBe('valid');
    expect(loaded.records.size).toBe(1);
    const repaired = (await readFile(path, 'utf8')).trim().split('\n');
    expect(repaired).toHaveLength(2); // header + the surviving record; the torn tail is gone
  });

  it('REFUSES to repair when an invalid line is followed by more records (paid data would vanish)', async () => {
    const root = await tempRoot();
    const path = join(root, 'run.checkpoint.jsonl');
    await createRunCheckpoint(path, FP, 2, false);
    await appendCheckpointLine(path, record('a.pdf'));
    await appendFile(path, 'THIS IS NOT JSON\n', 'utf8');
    await appendCheckpointLine(path, record('b.pdf')); // a valid PAID record after the bad line

    await expect(loadRunCheckpoint(path, FP)).rejects.toThrow(/refus/i);
    // The file is untouched: nothing was truncated behind the operator's back.
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(4);
  });

  it('REFUSES to repair when an unrecognized record shape is followed by more data', async () => {
    const root = await tempRoot();
    const path = join(root, 'run.checkpoint.jsonl');
    await createRunCheckpoint(path, FP, 2, false);
    // Valid JSON, but neither a prediction record nor an event (e.g. written by a newer validator).
    await appendFile(path, '{"kind":"prediction","doc":"a.pdf"}\n', 'utf8');
    await appendCheckpointLine(path, record('b.pdf'));

    await expect(loadRunCheckpoint(path, FP)).rejects.toThrow(/refus/i);
  });
});

describe('shared write/read validators (checkpoint reload accepts everything the runner persists)', () => {
  it('reloads a record carrying every provenance key sanitizeResponseProvenance can emit', async () => {
    const root = await tempRoot();
    const path = join(root, 'run.checkpoint.jsonl');
    const provenance = sanitizeResponseProvenance({
      modelVersion: 'model-1',
      vendorVersion: 'vendor-1',
      calibratorVersion: 'cal-1',
      apiVersion: '2026-07-15',
      requestId: 'req-1',
      leakedExtraKey: 'must-be-stripped',
    });
    expect(provenance).toBeDefined();
    // The single source of truth: whatever the write-side sanitizer emits, the read side accepts.
    expect(isResponseProvenance(provenance)).toBe(true);

    await createRunCheckpoint(path, 'fp-provenance', 2, false);
    await appendCheckpointLine(path, {
      kind: 'prediction',
      doc: 'a.pdf',
      docClass: 'test',
      repeat: 1,
      fields: { '/value': { value: 'x', confidence: 0.5 } },
      availability: 'completed',
      requestAttempts: 1,
      transportRetries: 0,
      provenance: provenance!,
    });
    await appendCheckpointLine(path, {
      kind: 'prediction',
      doc: 'b.pdf',
      docClass: 'test',
      repeat: 1,
      fields: {},
      availability: 'transport_failure',
      requestAttempts: 3,
      transportRetries: 2,
    });
    const loaded = await loadRunCheckpoint(path, 'fp-provenance');
    expect(loaded.state).toBe('valid');
    expect(loaded.records.size).toBe(2); // NOTHING truncated: both paid records restored
  });
});

describe('one composite identity for (docClass, doc[, repeat])', () => {
  it('predictionKey extends docKey — a separator/order change cannot drift between them', () => {
    expect(predictionKey('invoice', 'a.pdf', 3)).toBe(`${docKey('invoice', 'a.pdf')}\u00003`);
    expect(docKey('invoice', 'a.pdf')).toBe(`invoice\u0000a.pdf`);
  });
});

describe('computeSemanticInputs — hashed once per run, not per doc-repeat outcome', () => {
  it('hashes doc bytes and semantic schema/golden JSON deterministically', () => {
    const [doc] = docs('a');
    const [input] = computeSemanticInputs([doc!]);
    const digest = (value: string | Uint8Array): string =>
      createHash('sha256').update(value).digest('hex');
    expect(input).toEqual({
      doc: 'a.pdf',
      docClass: 'test',
      documentSha256: digest(doc!.bytes),
      schemaSemanticSha256: digest(JSON.stringify(doc!.schema)),
      goldenRowSemanticSha256: digest(JSON.stringify(doc!.golden)),
    });
  });
});
