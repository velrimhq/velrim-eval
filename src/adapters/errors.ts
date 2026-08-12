/**
 * Typed provider failures shared by every eval adapter and the runner.
 *
 * The runner retries only `TransportFailureError`: transient HTTP statuses, network resets, and
 * timeouts. `ContractFailureError` is a completed/non-retryable interaction whose response cannot
 * be used (including malformed 2xx bodies, terminal async jobs, and non-retryable 4xx responses).
 * Keeping this distinction typed prevents message-text heuristics from changing the protocol.
 */

import type { AdapterResponseProvenance } from './types.js';

export class TransportFailureError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportFailureError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class ContractFailureError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    cause?: unknown,
    readonly provenance?: AdapterResponseProvenance,
  ) {
    super(message);
    this.name = 'ContractFailureError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Non-retryable run/configuration failure (auth, billing, forbidden, or invalid request). */
export class FatalRunError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'FatalRunError';
    if (cause !== undefined) this.cause = cause;
  }
}

export function isTransportFailure(error: unknown): error is TransportFailureError {
  return error instanceof TransportFailureError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
