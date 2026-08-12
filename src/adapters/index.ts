/**
 * The adapter registry + public barrel for `velrim-eval/src/adapters/*`.
 *
 * The commands import `getAdapter` + `fixtureTransport` from here (the frozen runtime seam); they
 * import the `EvalAdapter`/`EvalAdapterId`/`Transport` types from `./types.js`. This barrel keeps
 * the concrete adapters behind one lookup so a command never `switch`es on the id itself.
 *
 * NO import of `@velrim/core`. The only `@velrim/*` import in this directory is the published name
 * `@velrim/scoring` (type-only, in `./types.ts`).
 */

import type { EvalAdapter, EvalAdapterId } from './types.js';
import { velrimAdapter } from './velrim.js';
import { openaiAdapter } from './openai.js';
import { llamaextractAdapter } from './llamaextract.js';
import { mistralAdapter } from './mistral.js';
import { geminiAdapter } from './gemini.js';

/** The id→adapter registry. The single place the concrete adapters are wired. */
const REGISTRY: Record<EvalAdapterId, EvalAdapter> = {
  velrim: velrimAdapter,
  openai: openaiAdapter,
  llamaextract: llamaextractAdapter,
  mistral: mistralAdapter,
  gemini: geminiAdapter,
};

/** Look up an adapter by id; throws on an unknown id (caller maps the throw to exit 2). */
export function getAdapter(id: EvalAdapterId): EvalAdapter {
  const adapter = REGISTRY[id];
  if (adapter === undefined) {
    throw new Error(`unknown adapter "${id}" (expected velrim|openai|llamaextract|mistral|gemini)`);
  }
  return adapter;
}

// Re-exports so a consumer has one import site for the adapter runtime.
export { velrimAdapter } from './velrim.js';
export { openaiAdapter } from './openai.js';
export { llamaextractAdapter } from './llamaextract.js';
export { mistralAdapter } from './mistral.js';
export { geminiAdapter } from './gemini.js';
export {
  fixtureTransport,
  liveTransport,
  LIVE_ENV_KEY,
  LIVE_AUTH_STYLE,
  MissingLiveKeyError,
  FixtureNotFoundError,
} from './transport.js';
export {
  ContractFailureError,
  FatalRunError,
  TransportFailureError,
  isTransportFailure,
  errorMessage,
} from './errors.js';
export { toScoringField, toScoringFields } from './types.js';
export type {
  EvalAdapter,
  EvalAdapterId,
  EvalAdapterOpts,
  AdapterField,
  AdapterExtractResult,
  Transport,
  TransportRequest,
} from './types.js';
