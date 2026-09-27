/**
 * Adaptive quality from sustained frame intervals (not just JS cost):
 * two-second windows, the 90th percentile interval, with hysteresis.
 * Steps render detail down first; the colony's population cap is lowered
 * only at the last tier.
 */
export interface PerfSample {
  fps: number;
  p90: number;
  tier: number;
}

export class FrameMonitor {
  private intervals: number[] = [];
  private windowStart = 0;
  private last = 0;
  private bad = 0;
  private good = 0;
  tier: number;
  fps = 60;
  p90 = 16;
  onTier: (tier: number) => void = () => {};
  private maxTier: number;

  constructor(startTier: number, maxTier: number) {
    this.tier = startTier;
    this.maxTier = maxTier;
  }

  /** Record one animation frame. Returns true if the tier changed. */
  tick(now: number, rendering: boolean): boolean {
    if (!rendering) {
      this.last = 0;
      return false;
    }
    if (this.last) {
      const dt = now - this.last;
      // Ignore gaps from hidden tabs or long pauses.
      if (dt < 250) this.intervals.push(dt);
    }
    this.last = now;
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < 2000 || this.intervals.length < 20) return false;
    const sorted = this.intervals.slice().sort((a, b) => a - b);
    this.p90 = sorted[Math.floor(sorted.length * 0.9)];
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    this.fps = 1000 / mean;
    this.intervals = [];
    this.windowStart = now;
    if (this.p90 > 26) {
      this.bad++;
      this.good = 0;
    } else if (this.p90 < 18) {
      this.good++;
      this.bad = 0;
    } else {
      this.bad = 0;
      this.good = 0;
    }
    if (this.bad >= 2 && this.tier < this.maxTier) {
      this.tier++;
      this.bad = 0;
      this.onTier(this.tier);
      return true;
    }
    if (this.good >= 8 && this.tier > 0) {
      this.tier--;
      this.good = 0;
      this.onTier(this.tier);
      return true;
    }
    return false;
  }
}

/** A first guess at the device's ability, before measuring anything. */
export function initialDeviceClass(width: number): { device: "large" | "medium" | "small"; tier: number } {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const cores = nav?.hardwareConcurrency ?? 4;
  const memory = nav?.deviceMemory ?? 4;
  const weak = cores <= 4 || memory <= 2;
  if (width < 700) return { device: "small", tier: weak ? 2 : 1 };
  if (width < 1100) return { device: "medium", tier: weak ? 2 : 0 };
  return { device: weak ? "medium" : "large", tier: weak ? 1 : 0 };
}
