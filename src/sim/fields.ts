/**
 * Pheromone fields on the cell grid: food trail, home trail and alarm.
 * Each diffuses through walkable cells and evaporates with its own half-life.
 * Work is bounded to the band of rows that currently holds any scent.
 */
import type { World } from "./world";

export interface Field {
  v: Float32Array;
  halfLife: number;
  diffusion: number;
  max: number;
  minRow: number;
  maxRow: number;
}

export interface Fields {
  food: Field;
  home: Field;
  alarm: Field;
  scratch: Float32Array;
}

function field(n: number, halfLife: number, diffusion: number, max: number): Field {
  return { v: new Float32Array(n), halfLife, diffusion, max, minRow: Infinity, maxRow: -Infinity };
}

export function createFields(n: number): Fields {
  return {
    food: field(n, 80, 0.05, 6),
    home: field(n, 120, 0.04, 6),
    alarm: field(n, 6.5, 0.24, 10),
    scratch: new Float32Array(n),
  };
}

export function deposit(f: Field, world: World, x: number, y: number, amount: number): void {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= world.W || yi >= world.H) return;
  const i = yi * world.W + xi;
  if (!world.walk[i]) return;
  const nv = f.v[i] + amount;
  f.v[i] = nv > f.max ? f.max : nv;
  if (yi < f.minRow) f.minRow = yi;
  if (yi > f.maxRow) f.maxRow = yi;
}

export function depositRadius(f: Field, world: World, cx: number, cy: number, r: number, amount: number): void {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      deposit(f, world, x, y, amount * (1 - d2 / r2));
    }
  }
}

export function sample(f: Field, world: World, x: number, y: number): number {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= world.W || yi >= world.H) return 0;
  return f.v[yi * world.W + xi];
}

/** Advance one field by dt seconds. */
export function updateField(f: Field, world: World, scratch: Float32Array, dt: number): void {
  if (f.minRow > f.maxRow) return;
  const { W, H, walk } = world;
  const decay = Math.pow(0.5, dt / f.halfLife);
  const d = f.diffusion;
  const y0 = Math.max(0, f.minRow - 1);
  const y1 = Math.min(H - 1, f.maxRow + 1);
  const v = f.v;
  let newMin = Infinity;
  let newMax = -Infinity;
  for (let y = y0; y <= y1; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!walk[i]) {
        scratch[i] = 0;
        continue;
      }
      const c = v[i];
      let sum = 0;
      let n = 0;
      if (x > 0 && walk[i - 1]) {
        sum += v[i - 1];
        n++;
      }
      if (x < W - 1 && walk[i + 1]) {
        sum += v[i + 1];
        n++;
      }
      if (y > 0 && walk[i - W]) {
        sum += v[i - W];
        n++;
      }
      if (y < H - 1 && walk[i + W]) {
        sum += v[i + W];
        n++;
      }
      const mixed = n > 0 ? c * (1 - d) + (sum / n) * d : c;
      const out = mixed * decay;
      scratch[i] = out < 0.004 ? 0 : out;
      if (scratch[i] > 0) {
        if (y < newMin) newMin = y;
        if (y > newMax) newMax = y;
      }
    }
  }
  v.set(scratch.subarray(y0 * W, (y1 + 1) * W), y0 * W);
  f.minRow = newMin;
  f.maxRow = newMax;
}

export function fieldTotal(f: Field): number {
  if (f.minRow > f.maxRow) return 0;
  let s = 0;
  for (let i = 0; i < f.v.length; i++) s += f.v[i];
  return s;
}

export function clearField(f: Field): void {
  f.v.fill(0);
  f.minRow = Infinity;
  f.maxRow = -Infinity;
}
