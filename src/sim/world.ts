/**
 * The soil: a cell grid of materials that ants actually dig, plus the
 * ground height map (which rises as grains are deposited on the mound),
 * standing water, moisture, and floor piles (stores and the midden).
 */
import { HARDNESS, Mat, Pile, ROW, WORLD_H } from "./constants";
import { Rng, hash01 } from "./rng";

export interface World {
  W: number;
  H: number;
  soil: Uint8Array;
  /** First soil row of each column's surface (the mound raises it). */
  ground: Int16Array;
  /** 1 where an ant may stand. */
  walk: Uint8Array;
  water: Uint8Array;
  moisture: Uint8Array;
  pileType: Uint8Array;
  pileAmt: Uint8Array;
  entranceX: number;
  /** Open cells below the ground line: the nest's volume. */
  volume: number;
  /** Cell indices changed since the renderer last collected them. */
  changes: number[];
  changeSet: Uint8Array;
  /** Set when walkability changes so distance fields are rebuilt. */
  topologyVersion: number;
  pileVersion: number;
}

export const idx = (w: World, x: number, y: number) => y * w.W + x;

function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(seed, i);
  const b = hash01(seed, i + 1);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

export function createEmptyWorld(W: number, H = WORLD_H): World {
  const n = W * H;
  return {
    W,
    H,
    soil: new Uint8Array(n),
    ground: new Int16Array(W),
    walk: new Uint8Array(n),
    water: new Uint8Array(n),
    moisture: new Uint8Array(n),
    pileType: new Uint8Array(n),
    pileAmt: new Uint8Array(n),
    entranceX: Math.round(W * 0.42),
    volume: 0,
    changes: [],
    changeSet: new Uint8Array(n),
    topologyVersion: 0,
    pileVersion: 0,
  };
}

/** Lay down strata, pebbles, roots and grass stems. No tunnels yet. */
export function generateSoil(world: World, seed: number): void {
  const { W, H, soil, ground } = world;
  const rng = new Rng(seed ^ 0x51f00d);

  for (let x = 0; x < W; x++) {
    ground[x] = ROW.ground + Math.round((valueNoise(seed + 1, x / 23) - 0.5) * 3);
  }

  const wob = (k: number, x: number, amp: number) => Math.round((valueNoise(seed + 7 * k, x / 17) - 0.5) * 2 * amp);

  for (let x = 0; x < W; x++) {
    const top = ground[x];
    const topsoilEnd = ROW.ground + 34 + wob(1, x, 4);
    const s1 = ROW.stone1 + wob(2, x, 3);
    const s1e = ROW.stone1End + wob(3, x, 3);
    const s2 = ROW.stone2 + wob(4, x, 3);
    const s2e = ROW.stone2End + wob(5, x, 3);
    const bed = ROW.bedrock + wob(6, x, 6);
    for (let y = 0; y < H; y++) {
      let m: number = Mat.Open;
      if (y >= top) {
        if (y < topsoilEnd) m = Mat.Topsoil;
        else if (y < s1) m = Mat.Sand;
        else if (y < s1e) m = Mat.Gravel;
        else if (y < s2) m = Mat.Clay;
        else if (y < s2e) m = Mat.Gravel;
        else if (y < bed) m = Mat.DeepClay;
        else m = Mat.Bedrock;
      }
      soil[y * W + x] = m;
    }
  }

  // Pebbles: undiggable ovals the colony must dig around.
  const pebble = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1 && soil[y * W + x] !== Mat.Open && soil[y * W + x] !== Mat.Bedrock) {
          soil[y * W + x] = Mat.Stone;
        }
      }
    }
  };
  const area = W / 180;
  const bands: [number, number, number, number][] = [
    // [fromRow, toRow, count, maxRadius]
    [ROW.ground + 6, ROW.stone1, 26, 2.2],
    [ROW.stone1, ROW.stone1End, 34, 3.2],
    [ROW.stone1End, ROW.stone2, 22, 2.6],
    [ROW.stone2, ROW.stone2End, 30, 3.4],
    [ROW.stone2End, ROW.bedrock, 18, 3.0],
  ];
  for (const [a, b, count, maxR] of bands) {
    const n = Math.round(count * area);
    for (let i = 0; i < n; i++) {
      const cx = rng.range(2, W - 2);
      if (Math.abs(cx - world.entranceX) < 5) continue;
      const cy = rng.range(a, b);
      const r = rng.range(0.8, maxR);
      pebble(cx, cy, r * rng.range(1, 1.7), r);
    }
  }

  // Grass stems in the litter band, and their roots below.
  const stems: number[] = [];
  for (let x = 3; x < W - 8; x += rng.int(4, 9)) {
    if (Math.abs(x - world.entranceX) < 7) continue;
    stems.push(x);
    // Only the tuft at the base is an obstacle; ants pass over it.
    const h = rng.int(1, 3);
    for (let k = 1; k <= h; k++) {
      const y = ground[x] - k;
      if (y >= 0) soil[y * W + x] = Mat.Stem;
    }
    if (rng.chance(0.45)) {
      let rx = x;
      let ry = ground[x] + 1;
      const len = rng.int(18, 52);
      for (let k = 0; k < len; k++) {
        if (rx < 1 || rx >= W - 1 || ry >= ROW.stone1 - 4) break;
        if (Math.abs(rx - world.entranceX) < 4) break;
        const i = ry * W + rx;
        if (soil[i] === Mat.Topsoil || soil[i] === Mat.Sand) soil[i] = Mat.Root;
        ry += 1;
        if (rng.chance(0.35)) rx += rng.chance(0.5) ? 1 : -1;
      }
    }
  }
}

/** The effective surface at column x: the highest ground here or beside. */
export function surfaceRow(world: World, x: number): number {
  const xi = Math.max(0, Math.min(world.W - 1, x | 0));
  return Math.min(world.ground[xi], world.ground[Math.max(0, xi - 1)], world.ground[Math.min(world.W - 1, xi + 1)]);
}

export function isWalkable(world: World, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.W || y >= world.H) return false;
  return world.walk[y * world.W + x] === 1;
}

/** Recompute walkability of a single cell. */
export function refreshWalkCell(world: World, x: number, y: number): void {
  const i = y * world.W + x;
  const open = world.soil[i] === Mat.Open;
  // Air is walkable within a thin layer above the ground, measured from the
  // highest of this column and its neighbours so steep places (the crater at
  // the entrance, the mound's flanks) stay connected.
  const g = Math.min(world.ground[x], world.ground[Math.max(0, x - 1)], world.ground[Math.min(world.W - 1, x + 1)]);
  const v = open && y >= g - ROW.band ? 1 : 0;
  if (world.walk[i] !== v) {
    world.walk[i] = v;
    world.topologyVersion++;
  }
}

export function refreshWalkColumn(world: World, x: number, fromY = 0, toY = world.H): void {
  for (let y = Math.max(0, fromY); y < Math.min(world.H, toY); y++) refreshWalkCell(world, x, y);
}

export function refreshAllWalk(world: World): void {
  let vol = 0;
  for (let x = 0; x < world.W; x++) {
    refreshWalkColumn(world, x);
    for (let y = world.ground[x]; y < world.H; y++) if (world.soil[y * world.W + x] === Mat.Open) vol++;
  }
  world.volume = vol;
  world.topologyVersion++;
}

export function markChanged(world: World, i: number): void {
  if (world.changeSet[i]) return;
  world.changeSet[i] = 1;
  world.changes.push(i);
}

export function takeChanges(world: World): number[] {
  const out = world.changes;
  for (const i of out) world.changeSet[i] = 0;
  world.changes = [];
  return out;
}

export function isDiggable(world: World, x: number, y: number): boolean {
  if (x < 1 || x >= world.W - 1 || y >= world.H - 1) return false;
  const m = world.soil[y * world.W + x];
  if (m === Mat.Open) return false;
  if (!Number.isFinite(HARDNESS[m])) return false;
  // Never dig through the surface skin except at the entrance shaft.
  if (y <= world.ground[x] + 1 && Math.abs(x - world.entranceX) > 1) return false;
  return true;
}

/** Remove one cell of soil. Returns the material dug. */
export function digCell(world: World, x: number, y: number): number {
  const i = y * world.W + x;
  const m = world.soil[i];
  world.soil[i] = Mat.Open;
  if (y >= world.ground[x]) world.volume++;
  refreshWalkCell(world, x, y);
  markChanged(world, i);
  return m;
}

/** Fill an open cell (cave-in rubble). */
export function fillCell(world: World, x: number, y: number, m: number): void {
  const i = y * world.W + x;
  if (world.soil[i] !== Mat.Open) return;
  world.soil[i] = m;
  if (y >= world.ground[x]) world.volume--;
  world.water[i] = 0;
  if (world.pileAmt[i]) {
    world.pileAmt[i] = 0;
    world.pileType[i] = 0;
    world.pileVersion++;
  }
  refreshWalkCell(world, x, y);
  markChanged(world, i);
}

const MOUND_PEAK = 12;
const MOUND_SLOPE = 3;

/** Highest the mound may stand at column x: a cone around the entrance. */
function moundLimit(world: World, x: number): number {
  const d = Math.abs(x - (world.entranceX + 0.5));
  return ROW.ground - Math.max(0, Math.round(MOUND_PEAK - d / MOUND_SLOPE));
}

/**
 * Drop one grain on the surface near column x. Grains slide down the mound's
 * flanks until they rest at a stable slope, so the mound grows as a low cone
 * about the entrance; grains that find no footing roll away out of sight.
 */
export function depositGrain(world: World, x: number, rng: Rng): number {
  const { W } = world;
  let cx = Math.max(1, Math.min(W - 2, x));
  const e = world.entranceX;
  if (cx >= e - 1 && cx <= e + 2) cx = rng.chance(0.5) ? e - 2 : e + 3;
  const out = cx < e ? -1 : 1;
  for (let guard = 0; guard < 60; guard++) {
    const g = world.ground[cx];
    // Too high here for a stable cone: roll outward.
    if (g - 1 < moundLimit(world, cx)) {
      const nx = cx + out;
      if (nx < 1 || nx > W - 2) return -1;
      cx = nx;
      continue;
    }
    let moved = false;
    const order = rng.chance(0.5) ? [-1, 1] : [1, -1];
    for (const d of order) {
      const nx = cx + d;
      if (nx < 1 || nx > W - 2) continue;
      if (nx >= e && nx <= e + 1) continue;
      const drop = world.ground[nx] - g;
      if (drop > 1 || (drop === 1 && rng.chance(0.55))) {
        cx = nx;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  const g = world.ground[cx];
  const y = g - 1;
  if (y < moundLimit(world, cx) || y < 1) return -1;
  const i = y * W + cx;
  world.soil[i] = Mat.Mound;
  world.ground[cx] = y;
  for (const nx of [cx - 1, cx + 1]) if (nx >= 0 && nx < W) refreshWalkColumn(world, nx, y - ROW.band - 2, y + 2);
  // A buried grass stem: what is left of it above is flattened too.
  for (let k = y - 1; k >= 0 && world.soil[k * W + cx] === Mat.Stem; k--) {
    world.soil[k * W + cx] = Mat.Open;
    markChanged(world, k * W + cx);
  }
  refreshWalkColumn(world, cx, y - ROW.band - 1, y + 1);
  markChanged(world, i);
  return i;
}

/** Wash the top grain off the mound (rain erosion). */
export function erodeMound(world: World, x: number): boolean {
  const g = world.ground[x];
  if (g >= ROW.ground) return false;
  const i = g * world.W + x;
  if (world.soil[i] !== Mat.Mound) return false;
  world.soil[i] = Mat.Open;
  world.ground[x] = g + 1;
  for (let nx = Math.max(0, x - 1); nx <= Math.min(world.W - 1, x + 1); nx++) refreshWalkColumn(world, nx, g - ROW.band - 2, g + 3);
  markChanged(world, i);
  return true;
}

export function addPile(world: World, i: number, type: number, amount: number): number {
  if (world.pileType[i] !== Pile.None && world.pileType[i] !== type) return 0;
  const room = 255 - world.pileAmt[i];
  const add = Math.min(room, amount);
  if (add <= 0) return 0;
  world.pileType[i] = type;
  world.pileAmt[i] += add;
  world.pileVersion++;
  markChanged(world, i);
  return add;
}

export function takePile(world: World, i: number, type: number, amount: number): number {
  if (world.pileType[i] !== type) return 0;
  const take = Math.min(world.pileAmt[i], amount);
  world.pileAmt[i] -= take;
  if (world.pileAmt[i] === 0) world.pileType[i] = Pile.None;
  world.pileVersion++;
  markChanged(world, i);
  return take;
}

/** A floor is an open cell resting on something solid. */
export function isFloor(world: World, x: number, y: number): boolean {
  if (!isWalkable(world, x, y) || y + 1 >= world.H) return false;
  return world.soil[(y + 1) * world.W + x] !== Mat.Open;
}

// ---------------------------------------------------------------------------
// Distance fields (breadth-first search through walkable cells)
// ---------------------------------------------------------------------------

export const FAR = 65535;

export class FieldBuilder {
  private queue: Int32Array;
  constructor(n: number) {
    this.queue = new Int32Array(n);
  }

  build(world: World, sources: ArrayLike<number>, out: Uint16Array, maxDist = FAR - 1): void {
    out.fill(FAR);
    const { W, H, walk } = world;
    const q = this.queue;
    let head = 0;
    let tail = 0;
    for (let k = 0; k < sources.length; k++) {
      const s = sources[k];
      if (s < 0 || s >= walk.length || !walk[s] || out[s] === 0) continue;
      out[s] = 0;
      q[tail++] = s;
    }
    while (head < tail) {
      const i = q[head++];
      const d = out[i] + 1;
      if (d > maxDist) continue;
      const x = i % W;
      if (x > 0 && walk[i - 1] && out[i - 1] > d) {
        out[i - 1] = d;
        q[tail++] = i - 1;
      }
      if (x < W - 1 && walk[i + 1] && out[i + 1] > d) {
        out[i + 1] = d;
        q[tail++] = i + 1;
      }
      if (i >= W && walk[i - W] && out[i - W] > d) {
        out[i - W] = d;
        q[tail++] = i - W;
      }
      if (i < (H - 1) * W && walk[i + W] && out[i + W] > d) {
        out[i + W] = d;
        q[tail++] = i + W;
      }
    }
  }
}

/** Entrance cells: the mouth of the shaft at the surface. */
export function entranceCells(world: World): number[] {
  const out: number[] = [];
  const e = world.entranceX;
  // The mouth of the chimney through the mound, not its foot.
  for (let x = e; x <= e + 1; x++) {
    const y = surfaceRow(world, x) - 1;
    if (y >= 0) out.push(y * world.W + x);
  }
  return out;
}

/** Openness: Chebyshev distance to the nearest non-walkable cell, capped. */
export function opennessAt(world: World, x: number, y: number, cap = 4): number {
  for (let r = 1; r <= cap; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (!isWalkable(world, x + dx, y + dy)) return r - 1;
      }
    }
  }
  return cap;
}
