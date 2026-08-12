/**
 * Injectable Transport — mirrors Velrim's production recording transport.
 *
 * TWO implementations, one contract (`Transport`, in `./types.js`):
 *
 *   - `fixtureTransport` — the BUILD DEFAULT. Resolves a request's fixture `key` to
 *     `test/recorded/<adapter>/<name>.json` and returns the parsed body. ZERO network: it never
 *     touches `fetch`, `req.url`, or `req.body`. Every unit test and the dogfood run use it.
 *
 *   - `liveTransport` — the `run --live` path. Does a real `fetch` with the API key read from the
 *     environment ONLY (never hardcoded, never committed, never printed). It THROWS at CONSTRUCTION
 *     if the key is missing — before any network call, never silently falling back to fixtures.
 *     A `FormData` body passes through untouched (multipart upload — LlamaExtract); anything else
 *     is JSON. No test ever invokes it against the network (tests inject `fetchImpl`).
 *
 * AUTH-STYLE EXTENSION (the one deliberate extension to this frozen seam):
 * Google AI Studio (the A2/A3 Gemini arms) authenticates with an `x-goog-api-key` request header,
 * not an `Authorization: Bearer` header. `liveTransport` therefore takes an explicit
 * `authStyle: 'bearer' | 'x-goog-api-key'` option, defaulting to `'bearer'` so every existing
 * caller is byte-for-byte unchanged. Under `'x-goog-api-key'` the key rides ONLY in that header —
 * no Authorization header is sent — and the key stays out of logs and error messages exactly like
 * the bearer path (it is only ever placed in the auth header, never echoed anywhere).
 *
 * Pure TS, ESM, zero runtime deps. No import of `@velrim/core`.
 */

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { Transport, TransportRequest } from './types.js';
import { ContractFailureError, FatalRunError, TransportFailureError } from './errors.js';

/** The env var that holds each adapter's live API key (read ONLY from `process.env`). */
export const LIVE_ENV_KEY = {
  velrim: 'VELRIM_API_KEY',
  openai: 'OPENAI_API_KEY',
  llamaextract: 'LLAMA_CLOUD_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY',
} as const;

/** How the live key rides on the wire (the auth-style seam extension — see the header comment). */
export type LiveAuthStyle = 'bearer' | 'x-goog-api-key';

/**
 * Per-adapter live auth style. Every arm is standard Bearer except Gemini: Google AI Studio
 * auths by the `x-goog-api-key` header. `run` threads this into `liveTransport`.
 */
export const LIVE_AUTH_STYLE: Record<keyof typeof LIVE_ENV_KEY, LiveAuthStyle> = {
  velrim: 'bearer',
  openai: 'bearer',
  llamaextract: 'bearer',
  mistral: 'bearer',
  gemini: 'x-goog-api-key',
};

/** Thrown when `--live` is requested but the adapter's API key is not in the environment. */
export class MissingLiveKeyError extends Error {
  constructor(readonly envVar: string) {
    super(
      `--live requested but ${envVar} is not set. Set it in the environment; ` +
        `velrim-eval never hardcodes keys and never falls back to fixtures.`,
    );
    this.name = 'MissingLiveKeyError';
  }
}

/** Thrown when a fixture file for a request key cannot be found/read (fail closed, never network). */
export class FixtureNotFoundError extends Error {
  constructor(
    readonly key: string,
    readonly path: string,
    cause?: unknown,
  ) {
    super(`no recorded fixture for key "${key}" (looked for ${path})`);
    this.name = 'FixtureNotFoundError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Eval-adapter ids (kept local so transport names no `@velrim/*` runtime symbol). */
const ADAPTER_IDS = new Set(['velrim', 'openai', 'llamaextract', 'mistral', 'gemini']);

/**
 * The BUILD-DEFAULT transport: resolve `req.key` (`<adapter>/<name>`) to a recorded JSON file
 * under the recorded root and return its parsed body. ZERO network — `req.url`/`req.body` are
 * ignored.
 *
 * The optional argument is overloaded for the command↔adapter seam: the `run` command calls
 * `fixtureTransport(adapterId)` (an adapter-id namespace hint) while tests call
 * `fixtureTransport('/abs/test/recorded')` (an explicit root). Resolution is driven by `req.key`
 * (which already carries the `<adapter>/` subdir), so an adapter-id argument is treated as a hint
 * and the default `<pkg>/test/recorded` root is used; anything else is treated as an explicit root.
 * With no argument the default root is used.
 */
export function fixtureTransport(adapterIdOrRoot?: string): Transport {
  // Default root: this file is src/adapters/transport.ts (or dist/adapters/...); the recorded
  // fixtures live at <pkg>/test/recorded. Resolve up from this module's URL, build-location-safe.
  const root =
    adapterIdOrRoot === undefined || ADAPTER_IDS.has(adapterIdOrRoot)
      ? defaultRecordedRoot()
      : adapterIdOrRoot;
  return {
    mode: 'fixture',
    async send(req: TransportRequest): Promise<unknown> {
      const rel = req.key.endsWith('.json') ? req.key : `${req.key}.json`;
      const path = isAbsolute(rel) ? rel : join(root, rel);
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (cause) {
        throw new FixtureNotFoundError(req.key, path, cause);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new FixtureNotFoundError(req.key, path, cause);
      }
    },
  };
}

/**
 * The `run --live` transport: a real `fetch`, key from `process.env[envVar]` ONLY.
 *
 * Throws `MissingLiveKeyError` at CONSTRUCTION if the key is absent — so a `--live` run with a
 * missing key dies before any doc is read or any socket opens (NEVER falls back to fixtures).
 * `fetchImpl` is injectable so tests can assert the exact request without a real socket;
 * production passes nothing and the global `fetch` (Node ≥20) is used. The key is only ever
 * placed in the auth header — never logged, never included in an error message.
 *
 * `authStyle` (default `'bearer'`, so every non-Gemini caller is unchanged): `'bearer'` sends
 * `Authorization: Bearer <key>`; `'x-goog-api-key'` sends the key in the `x-goog-api-key`
 * header and NO Authorization header (Google AI Studio's auth contract).
 *
 * Bodies: a `FormData` body is handed to fetch untouched (multipart — fetch sets the boundary
 * Content-Type itself); any other defined body is JSON-serialized with an application/json
 * Content-Type. A body-less request (GET polling) sends no Content-Type.
 */
export function liveTransport(
  envVar: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal; authStyle?: LiveAuthStyle },
): Transport {
  const apiKey = process.env[envVar];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new MissingLiveKeyError(envVar);
  }
  const authStyle: LiveAuthStyle = opts?.authStyle ?? 'bearer';
  const authHeader: Record<string, string> =
    authStyle === 'x-goog-api-key'
      ? { 'x-goog-api-key': apiKey }
      : { Authorization: `Bearer ${apiKey}` };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  let lastResponseProvenance: ReturnType<NonNullable<Transport['lastResponseProvenance']>> = {};
  return {
    mode: 'live',
    lastResponseProvenance: () => lastResponseProvenance,
    async send(req: TransportRequest): Promise<unknown> {
      const isForm = req.body instanceof FormData;
      const headers: Record<string, string> = {
        ...authHeader,
        // JSON Content-Type ONLY for a JSON body; FormData sets its own multipart boundary.
        ...(req.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(req.headers ?? {}),
      };
      const init: RequestInit = {
        method: req.method ?? 'POST',
        headers,
        ...(req.body !== undefined
          ? { body: isForm ? (req.body as FormData) : JSON.stringify(req.body) }
          : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      };
      let res: Response;
      try {
        res = await fetchImpl(req.url, init);
      } catch (cause) {
        throw new TransportFailureError(
          `live transport request failed for ${req.url}`,
          undefined,
          cause,
        );
      }
      const getHeader = (name: string): string | null =>
        typeof res.headers?.get === 'function' ? res.headers.get(name) : null;
      const apiVersion =
        // `velrim-version` is the header prod echoes on every response
        // (`x-velrim-api-version` is the legacy header name, kept as a fallback).
        getHeader('velrim-version') ??
        getHeader('x-velrim-api-version') ??
        getHeader('x-api-version') ??
        getHeader('api-version') ??
        getHeader('openai-version');
      const requestId = getHeader('x-request-id') ?? getHeader('request-id');
      lastResponseProvenance = {
        ...(apiVersion === null ? {} : { apiVersion: apiVersion.slice(0, 200) }),
        ...(requestId === null ? {} : { requestId: requestId.slice(0, 200) }),
      };
      if (!res.ok) {
        // Classify from the status before touching the body. Apart from avoiding provider error
        // bodies that may contain customer data, this prevents a broken error stream from
        // disguising a fatal auth/configuration response as a retryable transport failure.
        // Undici response bodies must still be released; cancellation does not inspect or retain
        // the sensitive body, and a cancellation failure must not override the HTTP taxonomy.
        try {
          await res.body?.cancel();
        } catch {
          // Best effort: the status remains the authoritative failure classification.
        }
        const message = `live transport ${res.status} for ${req.url}`;
        if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
          throw new TransportFailureError(message, res.status);
        }
        // Auth/billing/proxy-auth statuses poison every subsequent request identically — fatal to
        // the whole run. Any other non-retryable 4xx is doc-specific (oversized payload, content
        // rejection, unprocessable input) and lands in the per-doc contract taxonomy, per
        // errors.ts: one bad document must never brick a paid run's checkpoint.
        if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 407) {
          throw new FatalRunError(message, res.status);
        }
        throw new ContractFailureError(message, res.status, undefined, lastResponseProvenance);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (cause) {
        throw new TransportFailureError(
          `live transport response stream failed for ${req.url}`,
          res.status,
          cause,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new ContractFailureError(
          `live transport received a non-JSON 2xx response from ${req.url}`,
          res.status,
          cause,
          lastResponseProvenance,
        );
      }
    },
  };
}

/** Resolve `<pkg>/test/recorded` from this module's location (works from src/ and dist/). */
function defaultRecordedRoot(): string {
  // import.meta.url → .../velrim-eval/{src,dist}/adapters/transport.{ts,js}
  const here = new URL('.', import.meta.url).pathname;
  // here = .../{src,dist}/adapters/ → go up two to the package root, then test/recorded.
  const normalized = process.platform === 'win32' && here.startsWith('/') ? here.slice(1) : here;
  return join(normalized, '..', '..', 'test', 'recorded');
}
