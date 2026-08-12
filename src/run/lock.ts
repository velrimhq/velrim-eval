/** Exclusive output-directory lease for paid/resumable runs. */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_LOCK_FILE = 'run.lock.json';
export const RUN_LOCK_RECOVERY_FILE = 'run.lock.recovery.json';

interface RunLockOwner {
  version: 1;
  nonce: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  fingerprint: string;
}

function isOwner(value: unknown): value is RunLockOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    owner['version'] === 1 &&
    typeof owner['nonce'] === 'string' &&
    Number.isSafeInteger(owner['pid']) &&
    (owner['pid'] as number) > 0 &&
    typeof owner['hostname'] === 'string' &&
    typeof owner['acquiredAt'] === 'string' &&
    typeof owner['fingerprint'] === 'string'
  );
}

function localPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means a process owns the PID. Only ESRCH proves that it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readOwner(path: string): Promise<RunLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function createOwnerFile(path: string, owner: RunLockOwner): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function releaseOwned(path: string, nonce: string): Promise<void> {
  const current = await readOwner(path);
  if (current?.nonce === nonce) await rm(path, { force: true });
}

function assertRecoverableOwner(
  owner: RunLockOwner | undefined,
  localHostname: string,
): asserts owner is RunLockOwner {
  if (owner === undefined) {
    throw new Error(
      `output directory has an unreadable ${RUN_LOCK_FILE}; verify the other run before ` +
        'removing it manually',
    );
  }
  if (owner.hostname !== localHostname) {
    throw new Error(
      `output directory is locked by pid ${owner.pid} on ${owner.hostname}; ` +
        `verify that run before removing ${RUN_LOCK_FILE}`,
    );
  }
  if (localPidIsAlive(owner.pid)) {
    throw new Error(
      `output directory is already in use by live pid ${owner.pid}; choose another --out`,
    );
  }
}

/**
 * Acquire an atomic `wx` lease. A same-host lock is reclaimed only when its PID is definitely
 * dead. A foreign-host or recent malformed lock fails closed; no TTL can steal a legitimate run.
 */
export async function acquireRunLock(
  outDir: string,
  fingerprint: string,
  recoverStale: boolean,
): Promise<() => Promise<void>> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, RUN_LOCK_FILE);
  const recoveryPath = join(outDir, RUN_LOCK_RECOVERY_FILE);
  const localHostname = hostname();
  const owner: RunLockOwner = {
    version: 1,
    nonce: randomUUID(),
    pid: process.pid,
    hostname: localHostname,
    acquiredAt: new Date().toISOString(),
    fingerprint,
  };

  for (;;) {
    if (await exists(recoveryPath)) {
      throw new Error('output-directory stale-lock recovery is already in progress');
    }
    try {
      await createOwnerFile(path, owner);
      // A recoverer may have acquired its guard after our first check. Relinquish our new owner
      // rather than racing its path-based stale rename.
      if (await exists(recoveryPath)) {
        await releaseOwned(path, owner.nonce);
        throw new Error('output-directory stale-lock recovery began concurrently; rerun');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const inspected = await readOwner(path);
    assertRecoverableOwner(inspected, localHostname);
    if (!recoverStale) {
      throw new Error(
        `output directory has a dead-owner ${RUN_LOCK_FILE}; inspect it, then rerun with ` +
          '--recover-stale-lock',
      );
    }

    const recoveryOwner: RunLockOwner = { ...owner, nonce: randomUUID() };
    try {
      await createOwnerFile(recoveryPath, recoveryOwner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('output-directory stale-lock recovery is already in progress');
      }
      throw error;
    }
    try {
      // Re-read under the recovery lease. This is the CAS-equivalent check that prevents a second
      // recoverer from renaming the first recoverer's newly live canonical lock.
      const current = await readOwner(path);
      assertRecoverableOwner(current, localHostname);
      if (current?.nonce !== inspected?.nonce) {
        throw new Error('output-directory lock owner changed during stale recovery; rerun');
      }
      const claimed = `${path}.stale-${Date.now()}-${current.nonce}`;
      await rename(path, claimed);
      await createOwnerFile(path, owner);
      // Retain the claimed owner record as an audit artifact.
    } finally {
      await releaseOwned(recoveryPath, recoveryOwner.nonce);
    }
    break;
  }

  return async () => releaseOwned(path, owner.nonce);
}
