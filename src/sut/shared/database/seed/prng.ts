/**
 * Deterministic PRNG (mulberry32). Same seed => same sequence on every
 * platform, which keeps dataset checksums stable across machines.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** RFC 4122 version-4 shaped UUID built from PRNG bytes. */
  uuid(): string {
    const bytes = new Array<number>(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = this.int(0, 255);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Fisher-Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

/**
 * Zipf-like sampler over ranks 0..n-1: P(rank k) ∝ 1 / (k + 1)^s.
 * Uses a precomputed CDF and binary search.
 */
export class ZipfSampler {
  private readonly cdf: Float64Array;

  constructor(
    readonly n: number,
    readonly s: number,
  ) {
    this.cdf = new Float64Array(n);
    let sum = 0;
    for (let k = 0; k < n; k += 1) {
      sum += 1 / Math.pow(k + 1, s);
      this.cdf[k] = sum;
    }
    for (let k = 0; k < n; k += 1) this.cdf[k] = (this.cdf[k] ?? 0) / sum;
  }

  sample(prng: Prng): number {
    const u = prng.next();
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.cdf[mid] ?? 1) < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
