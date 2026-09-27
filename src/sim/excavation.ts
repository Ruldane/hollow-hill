/**
 * Digging rules, shared by live diggers, the founding excavation and the
 * absence model. Tunnel architecture emerges from these local choices:
 * persistence of heading makes galleries, a downward bias above the target
 * depth makes shafts, and a "chamber mode" that digs isotropically around a
 * point makes rooms.
 */
import { HARDNESS, Mat, ROW } from "./constants";
import type { Rng } from "./rng";
import { FieldBuilder, FAR, digCell, depositGrain, entranceCells, isDiggable, isWalkable, type World } from "./world";

export interface DigIntent {
  zoneTop: number;
  zoneBottom: number;
  chamber: boolean;
  cx: number;
  cy: number;
}

/** Tunnels must connect edge to edge: an ant cannot squeeze through a corner. */
const DIRS4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** Choose a neighbouring cell to dig, or -1. Weighted, not greedy. */
export function chooseDigCell(world: World, x: number, y: number, heading: number, intent: DigIntent, rng: Rng): number {
  const cx = x | 0;
  const cy = y | 0;
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  let total = 0;
  const cand: number[] = [];
  const weights: number[] = [];
  for (const [dx, dy] of DIRS4) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (!isDiggable(world, nx, ny)) continue;
    // Keep a skin of soil against the bedrock and between neighbouring tunnels.
    if (ny >= ROW.bedrock + 4) continue;
    const len = Math.hypot(dx, dy);
    const align = (dx * hx + dy * hy) / len;
    let w = 0.25 + Math.max(0, align) * 2.4;
    if (cy < intent.zoneTop) {
      w *= dy > 0 ? 3.2 : dy < 0 ? 0.08 : 0.9;
    } else if (cy > intent.zoneBottom) {
      w *= dy < 0 ? 3 : dy > 0 ? 0.05 : 0.8;
    } else if (intent.chamber) {
      const ddx = nx - intent.cx;
      const ddy = (ny - intent.cy) * 1.8;
      const r = Math.hypot(ddx, ddy);
      w = r < 6.5 ? 1.4 - r / 6.5 + 0.2 : 0.02;
    } else {
      w *= dy === 0 ? 1.7 : dy > 0 ? 0.7 : 0.45;
    }
    // Avoid breaking into another tunnel from a thin wall too eagerly.
    const beyondX = nx + dx;
    const beyondY = ny + dy;
    if (isWalkable(world, beyondX, beyondY) && !intent.chamber) w *= 0.25;
    w /= HARDNESS[world.soil[ny * world.W + nx]];
    if (w <= 0) continue;
    cand.push(ny * world.W + nx);
    weights.push(w);
    total += w;
  }
  if (!cand.length) return -1;
  let r = rng.next() * total;
  for (let k = 0; k < cand.length; k++) {
    r -= weights[k];
    if (r <= 0) return cand[k];
  }
  return cand[cand.length - 1];
}

export interface ZoneWeights {
  upper: number;
  nursery: number;
  royal: number;
}

export function pickDigZone(rng: Rng, w: ZoneWeights): [number, number] {
  const t = w.upper + w.nursery + w.royal;
  const r = rng.next() * t;
  if (r < w.upper) return [ROW.ground + 10, ROW.stone1 - 4];
  if (r < w.upper + w.nursery) return [ROW.stone1End + 4, ROW.stone2 - 4];
  return [ROW.stone2End + 4, ROW.bedrock - 8];
}

/**
 * Coarse excavation: abstract diggers extend the existing nest by `cells`
 * cells, depositing every grain on the mound. Each digger walks out along the
 * nest to a frontier, drives a gallery forward (keeping its heading, sloping
 * gently, turning at stones, stopping when it breaks into another gallery),
 * and sometimes widens the gallery's end into a low chamber. Used at founding
 * and to model the digging done while nobody watched. Cost is bounded by
 * `cells` and a fixed number of distance-field rebuilds.
 */
export function coarseExcavate(
  world: World,
  cells: number,
  weights: ZoneWeights,
  rng: Rng,
  builder: FieldBuilder,
  onDig?: (x: number, y: number, m: number) => void,
): number {
  if (cells <= 0) return 0;
  const { W } = world;
  const distUp = new Uint16Array(W * world.H);
  const rebuild = () => builder.build(world, entranceCells(world), distUp);
  rebuild();

  let dug = 0;
  let sinceRebuild = 0;
  let guard = 0;
  const maxGuard = Math.ceil(cells / 4) + 400;
  const e = world.entranceX;

  // Open cells by zone, so each zone's diggers start from its own galleries.
  const zoneOf = (y: number) => (y < ROW.stone1End ? 0 : y < ROW.stone2End ? 1 : 2);
  const openByZone: number[][] = [[], [], []];
  for (let i = 0; i < distUp.length; i++) {
    const y = (i / W) | 0;
    if (distUp[i] !== FAR && y >= world.ground[i % W] + 6) openByZone[zoneOf(y)].push(i);
  }

  const canDig = (x: number, y: number) => {
    if (!isDiggable(world, x, y)) return false;
    if (y >= ROW.bedrock + 2) return false;
    // Leave the topsoil whole but for the entrance shaft.
    if (y < ROW.ground + 9 && Math.abs(x - e) > 2) return false;
    return true;
  };
  const dig = (x: number, y: number) => {
    const m = digCell(world, x, y);
    depositGrain(world, e + (rng.chance(0.5) ? -1 : 2) * rng.int(1, 14), rng);
    onDig?.(x, y, m);
    openByZone[zoneOf(y)].push(y * W + x);
    dug++;
    sinceRebuild++;
  };

  while (dug < cells && guard++ < maxGuard) {
    const [zTop, zBottom] = pickDigZone(rng, weights);
    const zi = zoneOf((zTop + zBottom) >> 1);
    let pool = openByZone[zi];
    if (!pool.length) pool = openByZone[0].length ? openByZone[0] : openByZone[1].length ? openByZone[1] : openByZone[2];
    if (!pool.length) break;
    const start = pool[rng.int(0, pool.length)];
    let x = (start % W) + 0.5;
    let y = ((start / W) | 0) + 0.5;

    // Walk outward along existing galleries toward the zone.
    for (let step = 0; step < 400; step++) {
      const cx = x | 0;
      const cy = y | 0;
      if (cy >= zTop && cy <= zBottom && rng.chance(0.12)) break;
      let bestI = -1;
      let bestV = -Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!isWalkable(world, nx, ny) || ny < world.ground[nx]) continue;
        const d = distUp[ny * W + nx];
        if (d === FAR) continue;
        let v = d * 0.4 + rng.next() * 4;
        if (cy < zTop) v += dy * 6;
        if (cy > zBottom) v -= dy * 6;
        if (v > bestV) {
          bestV = v;
          bestI = ny * W + nx;
        }
      }
      if (bestI < 0) break;
      x = (bestI % W) + 0.5;
      y = ((bestI / W) | 0) + 0.5;
    }

    // Drive a gallery.
    const inZone = y >= zTop && y <= zBottom;
    const side = rng.chance(0.5) ? 0 : Math.PI;
    const tilt = (side === 0 ? 1 : -1) * rng.range(0.05, 0.32);
    const prefer = y < zTop ? Math.PI / 2 + rng.range(-0.55, 0.55) : y > zBottom ? -Math.PI / 2 : side + tilt;
    let heading = prefer;
    const len = inZone ? rng.int(12, 40) : rng.int(8, 26);
    let made = 0;
    for (let k = 0; k < len && dug < cells; k++) {
      heading += rng.gauss() * 0.14 + (prefer - heading) * 0.08;
      let nx = x + Math.cos(heading);
      let ny = y + Math.sin(heading);
      let cx = nx | 0;
      let cy = ny | 0;
      if (isWalkable(world, cx, cy)) {
        // Broke through into another gallery: the network closes a loop.
        if (made > 3) break;
        x = nx;
        y = ny;
        continue;
      }
      if (!canDig(cx, cy)) {
        heading += rng.chance(0.5) ? 0.9 : -0.9;
        nx = x + Math.cos(heading);
        ny = y + Math.sin(heading);
        cx = nx | 0;
        cy = ny | 0;
        if (!canDig(cx, cy)) break;
      }
      // Keep the gallery edge-connected: a diagonal step needs a shoulder.
      const pcx = x | 0;
      const pcy = y | 0;
      if (pcx !== cx && pcy !== cy && !isWalkable(world, cx, pcy) && !isWalkable(world, pcx, cy)) {
        if (canDig(cx, pcy)) dig(cx, pcy);
        else if (canDig(pcx, cy)) dig(pcx, cy);
        else break;
      }
      dig(cx, cy);
      made++;
      // Galleries are two cells wide, now and then three.
      if (rng.chance(0.9)) {
        const px = cx + Math.round(-Math.sin(heading));
        const py = cy + Math.round(Math.cos(heading));
        if (canDig(px, py)) dig(px, py);
      }
      x = nx;
      y = ny;
      // Leave the zone's bounds and the gallery bends back.
      const cyn = y | 0;
      if (inZone && (cyn < zTop || cyn > zBottom)) heading = side + (cyn < zTop ? 0.4 : -0.4) * (side === 0 ? 1 : -1);
    }

    // Sometimes the end of the gallery is opened into a chamber: wide and low.
    const pChamber = zTop > ROW.stone2 ? 0.5 : zTop > ROW.stone1 ? 0.5 : 0.4;
    if (made > 5 && dug < cells && (y | 0) >= zTop - 4 && rng.chance(pChamber)) {
      const rx = rng.range(4, zTop > ROW.stone2 ? 9 : 7.5);
      const ry = rng.range(1.9, 3.3);
      const cxr = x + Math.cos(heading) * rx * 0.5;
      const cyr = y - ry * 0.35;
      const wob = rng.range(0, 10);
      for (let yy = Math.floor(cyr - ry - 1); yy <= Math.ceil(cyr + ry + 1) && dug < cells; yy++) {
        for (let xx = Math.floor(cxr - rx - 1); xx <= Math.ceil(cxr + rx + 1) && dug < cells; xx++) {
          const dx = (xx + 0.5 - cxr) / rx;
          // Flat floor, domed roof.
          const dyRaw = (yy + 0.5 - cyr) / ry;
          const dy = dyRaw > 0 ? dyRaw * 1.5 : dyRaw;
          const edge = 1 + Math.sin(xx * 0.9 + wob) * 0.08 + Math.sin(yy * 1.7 + wob) * 0.06;
          if (dx * dx + dy * dy > edge) continue;
          if (isWalkable(world, xx, yy) || !canDig(xx, yy)) continue;
          dig(xx, yy);
        }
      }
    }
    if (sinceRebuild > 220) {
      rebuild();
      sinceRebuild = 0;
    }
  }
  return dug;
}

/** The founding queen's shaft: a biased random walk that digs as it descends. */
export function digFoundingShaft(world: World, rng: Rng, bottomRow: number): { x: number; y: number } {
  const e = world.entranceX;
  let x = e + 0.5;
  let y = world.ground[e];
  // Straight mouth through the topsoil.
  for (let yy = world.ground[e] - 1; yy < ROW.ground + 18; yy++) {
    for (let xx = e; xx <= e + 1; xx++) {
      if (world.soil[yy * world.W + xx] !== Mat.Open && Number.isFinite(HARDNESS[world.soil[yy * world.W + xx]])) {
        digCell(world, xx, yy);
      }
    }
    y = yy;
  }
  let heading = Math.PI / 2;
  let guard = 0;
  while (y < bottomRow && guard++ < 4000) {
    heading += rng.gauss() * 0.28;
    // Pull back toward straight down.
    heading += (Math.PI / 2 - heading) * 0.12;
    const nx = x + Math.cos(heading) * 0.9;
    const ny = y + Math.sin(heading) * 0.9;
    const cx = nx | 0;
    const cy = ny | 0;
    if (cx < 4 || cx > world.W - 5) {
      heading = Math.PI / 2;
      continue;
    }
    const m = world.soil[cy * world.W + cx];
    if (!Number.isFinite(HARDNESS[m])) {
      heading += rng.chance(0.5) ? 0.9 : -0.9;
      continue;
    }
    const pcx = x | 0;
    const pcy = y | 0;
    if (pcx !== cx && pcy !== cy) {
      const a = world.soil[pcy * world.W + cx];
      const b = world.soil[cy * world.W + pcx];
      if (a !== Mat.Open && b !== Mat.Open) {
        if (Number.isFinite(HARDNESS[a])) digCell(world, cx, pcy);
        else if (Number.isFinite(HARDNESS[b])) digCell(world, pcx, cy);
        else {
          heading += rng.chance(0.5) ? 0.9 : -0.9;
          continue;
        }
      }
    }
    if (m !== Mat.Open) digCell(world, cx, cy);
    // Two cells wide in places, so traffic can pass.
    if (rng.chance(0.55)) {
      const sx = cx + (rng.chance(0.5) ? 1 : -1);
      const sm = world.soil[cy * world.W + sx];
      if (sm !== Mat.Open && Number.isFinite(HARDNESS[sm]) && sx > 1 && sx < world.W - 2) digCell(world, sx, cy);
    }
    x = nx;
    y = ny;
  }
  return { x, y };
}

export function digEllipse(world: World, cx: number, cy: number, rx: number, ry: number, rng: Rng): number {
  let n = 0;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const edge = 1 + rng.gauss() * 0.08;
      if (dx * dx + dy * dy > edge) continue;
      if (!isDiggable(world, x, y)) continue;
      digCell(world, x, y);
      n++;
    }
  }
  return n;
}
