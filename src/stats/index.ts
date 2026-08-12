/**
 * Stats module — the pre-registered statistics for the bake-off report layer. Pure TS,
 * fully seeded/deterministic, composed with @velrim/scoring (never forking its math).
 * Refit-column statistics are deliberately absent (pre-registered: the symmetric CAL-FIT refit is
 * a phase-2 register slot, not a v1 column).
 */

export { mulberry32, Rng } from './rng.js';
export { normalCdf, normalQuantile } from './gauss.js';
export {
  bcaCI,
  pooledMeanCI,
  pairedMeanDeltaCI,
  type BootstrapOptions,
  type BootstrapCI,
} from './bootstrap.js';
export { holm, type HolmEntry } from './holm.js';
export {
  equalMassBins,
  debiasedEce,
  eceNoiseFloor,
  consistencyBands,
  type NoiseFloorOptions,
  type NoiseFloor,
  type ConsistencyBandOptions,
  type ConsistencyBand,
} from './ece.js';
export {
  canonicalSignature,
  instabilityRate,
  type DocRepeats,
  type InstabilityResult,
} from './instability.js';
export { simulateMde, probitAccuracy, type MdeOptions, type MdeResult } from './mde.js';
