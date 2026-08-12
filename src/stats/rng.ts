/**
 * Deterministic seeded RNG for the stats module. Every bootstrap/simulation in this
 * directory takes an explicit seed and is bit-reproducible — the seed is a published,
 * pre-registered artifact, so a reader can re-derive every CI and every simulated table from
 * the repo. Math.random / Date are never used anywhere in src/stats.
 */

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. Uniform on [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded generator with the distributions the simulations need. Deterministic per seed. */
export class Rng {
  private readonly u: () => number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.u = mulberry32(seed);
  }

  /** Uniform on [0, 1). */
  next(): number {
    return this.u();
  }

  /** Integer uniform on [0, n). */
  int(n: number): number {
    return Math.floor(this.u() * n);
  }

  /** Standard normal via Box–Muller (cached spare keeps the stream deterministic). */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u1 = this.u();
    // Guard log(0); the generator emits [0,1) so 0 is possible.
    while (u1 <= Number.EPSILON) u1 = this.u();
    const u2 = this.u();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  /** Gamma(shape, 1) via Marsaglia–Tsang; shape < 1 boosted through Gamma(shape+1). */
  gamma(shape: number): number {
    if (!(shape > 0)) throw new Error(`gamma: shape must be > 0, got ${shape}`);
    if (shape < 1) {
      const g = this.gamma(shape + 1);
      let u = this.u();
      while (u <= Number.EPSILON) u = this.u();
      return g * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.u();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Beta(a, b) via two gammas. */
  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }
}
