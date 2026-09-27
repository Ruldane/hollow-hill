/**
 * Seedable RNG (sfc32). The whole colony draws from one of these so a seed
 * reproduces a run exactly in tests, while each visitor's colony is founded
 * from a fresh seed and diverges with time, interaction and chance.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | readonly number[]) {
    if (typeof seed === "number") {
      // Expand one number into four words with splitmix32.
      let s = seed >>> 0;
      const next = () => {
        s = (s + 0x9e3779b9) >>> 0;
        let z = s;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
        return (z ^ (z >>> 16)) >>> 0;
      };
      this.a = next();
      this.b = next();
      this.c = next();
      this.d = next();
      for (let i = 0; i < 12; i++) this.u32();
    } else {
      this.a = seed[0] >>> 0;
      this.b = seed[1] >>> 0;
      this.c = seed[2] >>> 0;
      this.d = seed[3] >>> 0;
    }
  }

  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiExclusive: number): number {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately normal, mean 0, sd 1 (sum of uniforms; cheap and bounded). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  state(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }
}

/** Stateless 32-bit hash, for deterministic per-cell and per-day values. */
export function hash32(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    let k = Math.floor(v) | 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash01(...values: number[]): number {
  return hash32(...values) / 4294967296;
}
