// rng.ts — Deterministic RNG (mulberry32) + helpers.
// Pure data module: NO THREE imports, NO Math.random, NO Date.now.
// Threaded explicitly through every generation stage for bit-for-bit reproducibility.

export type RNG = {
  /** Advance the generator and return a uint32 (0 .. 2^32-1). */
  nextU32(): number;
  /** Float in [0, 1). */
  float(): number;
  /** Float in [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number;
  /** True with probability p (0..1). */
  chance(p: number): boolean;
  /** Deterministic pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Deterministic weighted pick. `weights` aligns with `arr`, all >= 0. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T;
  /** Gaussian via Box–Muller, mean mu, stddev sigma. */
  gaussian(mu: number, sigma: number): number;
  /** Fork a child RNG deterministically derived from this one + a tag string.
   *  Lets a sub-stage have its own stream without polluting the parent stream. */
  fork(tag: string): RNG;
  /** The original integer seed (read-only, for checksums / display). */
  readonly seed: number;
};

const STR_HASH_SEED = 2166136261 >>> 0; // FNV-1a 32-bit basis

/** FNV-1a hash of a string → uint32. Deterministic across JS engines. */
export function hashString(s: string): number {
  let h = STR_HASH_SEED;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Build a mulberry32 RNG from a 32-bit integer seed. */
export function makeRng(seed: number): RNG {
  let a = seed >>> 0;
  if (a === 0) a = 0x9e3779b9; // never let state be zero; kills the period

  const nextU32 = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };

  const float = (): number => nextU32() / 4294967296;

  const range = (a: number, b: number): number => a + (b - a) * float();

  const int = (a: number, b: number): number => {
    // inclusive [a, b]
    const lo = Math.ceil(a);
    const hi = Math.floor(b);
    if (hi < lo) return lo;
    return lo + (nextU32() % (hi - lo + 1));
  };

  const chance = (p: number): boolean => float() < p;

  const pick = <T,>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('pick: empty array');
    return arr[nextU32() % arr.length];
  };

  const weighted = <T,>(arr: readonly T[], weights: readonly number[]): T => {
    if (arr.length !== weights.length) throw new Error('weighted: length mismatch');
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (!(w >= 0) || !Number.isFinite(w)) throw new Error('weighted: bad weight');
      total += w;
    }
    if (total <= 0) return pick(arr);
    let r = float() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  };

  // Box–Muller. We always consume TWO u32 per gaussian for determinism,
  // even when returning one value, so the stream stays aligned.
  const gaussian = (mu: number, sigma: number): number => {
    const u1 = Math.max(float(), 1e-12);
    const u2 = float();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return mu + sigma * r * Math.cos(theta);
  };

  const fork = (tag: string): RNG => {
    // Mix parent state with a stable hash of the tag so different tags diverge.
    const childSeed = (nextU32() ^ hashString(tag)) >>> 0;
    return makeRng(childSeed);
  };

  return {
    nextU32, float, range, int, chance, pick, weighted, gaussian, fork,
    get seed() { return seed >>> 0; },
  };
}

/** Tiny helper: deterministic float in [0,1) directly from a seed, one-shot. */
export function seededFloat(seed: number): number {
  return makeRng(seed).float();
}
