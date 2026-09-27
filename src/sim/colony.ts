/**
 * Colony state as structure-of-arrays. Every ant is a slot in these typed
 * arrays; the specimen card reads the same slot the renderer draws.
 */
import { Carry, Caste, HISTORY_LEN, Hist, LIFE, Stage, Task } from "./constants";
import type { Rng } from "./rng";

export interface Ants {
  cap: number;
  /** One past the highest slot ever used. */
  count: number;
  alive: Uint8Array;
  gen: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  caste: Uint8Array;
  task: Uint8Array;
  sub: Uint8Array;
  role: Uint8Array;
  carry: Uint8Array;
  carryRef: Int32Array;
  birth: Float64Array;
  lifespan: Float32Array;
  hunger: Float32Array;
  fatigue: Float32Array;
  crop: Uint8Array;
  serial: Uint32Array;
  loads: Uint16Array;
  dug: Uint16Array;
  dist: Float32Array;
  fedLarvae: Uint16Array;
  bore: Uint8Array;
  letters: Uint8Array;
  timer: Float32Array;
  alarm: Float32Array;
  speedK: Float32Array;
  /** bit0: seeks warmth; bit1: found food at least once; bit2: has escaped before; bit3: scout. */
  traits: Uint8Array;
  memX: Float32Array;
  memY: Float32Array;
  memKind: Int16Array;
  where: Uint8Array;
  starve: Float32Array;
  wet: Float32Array;
  stuck: Float32Array;
  /** History: pairs of [minutes since founding, (kind << 24) | value]. */
  hist: Uint32Array;
  histHead: Uint8Array;
  free: number[];
  nextSerial: number;
}

export const TRAIT_WARM = 1;
export const TRAIT_FOUND = 2;
export const TRAIT_ESCAPED = 4;
/** A restless explorer: ignores roads when free, and follows odd smells. */
export const TRAIT_SCOUT = 8;

export function createAnts(cap: number): Ants {
  return {
    cap,
    count: 0,
    alive: new Uint8Array(cap),
    gen: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    heading: new Float32Array(cap),
    caste: new Uint8Array(cap),
    task: new Uint8Array(cap),
    sub: new Uint8Array(cap),
    role: new Uint8Array(cap),
    carry: new Uint8Array(cap),
    carryRef: new Int32Array(cap).fill(-1),
    birth: new Float64Array(cap),
    lifespan: new Float32Array(cap),
    hunger: new Float32Array(cap),
    fatigue: new Float32Array(cap),
    crop: new Uint8Array(cap),
    serial: new Uint32Array(cap),
    loads: new Uint16Array(cap),
    dug: new Uint16Array(cap),
    dist: new Float32Array(cap),
    fedLarvae: new Uint16Array(cap),
    bore: new Uint8Array(cap),
    letters: new Uint8Array(cap),
    timer: new Float32Array(cap),
    alarm: new Float32Array(cap),
    speedK: new Float32Array(cap),
    traits: new Uint8Array(cap),
    memX: new Float32Array(cap),
    memY: new Float32Array(cap),
    memKind: new Int16Array(cap).fill(-1),
    where: new Uint8Array(cap),
    starve: new Float32Array(cap),
    wet: new Float32Array(cap),
    stuck: new Float32Array(cap),
    hist: new Uint32Array(cap * HISTORY_LEN * 2),
    histHead: new Uint8Array(cap),
    free: [],
    nextSerial: 1001,
  };
}

export interface SpawnOpts {
  caste: number;
  x: number;
  y: number;
  birth: number;
  minutes: number;
  rng: Rng;
  serial?: number;
}

export function spawnAnt(a: Ants, o: SpawnOpts): number {
  let s: number;
  if (a.free.length) s = a.free.pop()!;
  else if (a.count < a.cap) s = a.count++;
  else return -1;
  const rng = o.rng;
  a.alive[s] = 1;
  a.gen[s] = (a.gen[s] + 1) & 255;
  a.x[s] = o.x;
  a.y[s] = o.y;
  a.heading[s] = rng.range(0, Math.PI * 2);
  a.caste[s] = o.caste;
  a.task[s] = o.caste === Caste.Queen ? Task.Queen : Task.Idle;
  a.sub[s] = 0;
  a.role[s] = 0;
  a.carry[s] = Carry.None;
  a.carryRef[s] = -1;
  a.birth[s] = o.birth;
  const base =
    o.caste === Caste.Queen
      ? LIFE.queenLifespan
      : o.caste === Caste.Soldier
        ? LIFE.soldierLifespan
        : o.caste === Caste.Worker
          ? LIFE.workerLifespan
          : LIFE.alateLifespan;
  a.lifespan[s] = base * rng.range(0.7, 1.3);
  a.hunger[s] = rng.range(0, 0.3);
  a.fatigue[s] = rng.range(0, 0.4);
  a.crop[s] = 0;
  a.serial[s] = o.serial ?? a.nextSerial++;
  a.loads[s] = 0;
  a.dug[s] = 0;
  a.dist[s] = 0;
  a.fedLarvae[s] = 0;
  a.bore[s] = 0;
  a.letters[s] = 0;
  a.timer[s] = rng.range(0, 4);
  a.alarm[s] = 0;
  a.speedK[s] = rng.range(0.82, 1.18);
  a.traits[s] = (rng.chance(0.4) ? TRAIT_WARM : 0) | (rng.chance(0.13) ? TRAIT_SCOUT : 0);
  a.memX[s] = 0;
  a.memY[s] = 0;
  a.memKind[s] = -1;
  a.where[s] = 0;
  a.starve[s] = 0;
  a.wet[s] = 0;
  a.stuck[s] = 0;
  a.histHead[s] = 0;
  a.hist.fill(0, s * HISTORY_LEN * 2, (s + 1) * HISTORY_LEN * 2);
  logHistory(a, s, o.minutes, Hist.Born, 0);
  return s;
}

export function killAnt(a: Ants, s: number): void {
  if (!a.alive[s]) return;
  a.alive[s] = 0;
  a.carry[s] = Carry.None;
  a.carryRef[s] = -1;
  a.where[s] = 0;
  a.free.push(s);
}

export function logHistory(a: Ants, s: number, minutes: number, kind: number, value: number): void {
  const head = a.histHead[s] % HISTORY_LEN;
  const base = (s * HISTORY_LEN + head) * 2;
  a.hist[base] = Math.max(0, Math.floor(minutes)) >>> 0;
  a.hist[base + 1] = ((kind & 0xff) << 24) | (value & 0xffffff);
  a.histHead[s] = (a.histHead[s] + 1) & 255;
}

export interface HistoryEntry {
  minutes: number;
  kind: number;
  value: number;
}

export function readHistory(a: Ants, s: number): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const total = Math.min(a.histHead[s], HISTORY_LEN);
  const start = a.histHead[s] > HISTORY_LEN ? a.histHead[s] % HISTORY_LEN : 0;
  for (let k = 0; k < total; k++) {
    const slot = (start + k) % HISTORY_LEN;
    const base = (s * HISTORY_LEN + slot) * 2;
    const packed = a.hist[base + 1];
    out.push({ minutes: a.hist[base], kind: packed >>> 24, value: packed & 0xffffff });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brood
// ---------------------------------------------------------------------------

export interface Brood {
  cap: number;
  count: number;
  alive: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  stage: Uint8Array;
  age: Float32Array;
  fed: Uint8Array;
  alate: Uint8Array;
  carriedBy: Int32Array;
  hungry: Float32Array;
  free: number[];
}

export function createBrood(cap: number): Brood {
  return {
    cap,
    count: 0,
    alive: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    stage: new Uint8Array(cap),
    age: new Float32Array(cap),
    fed: new Uint8Array(cap),
    alate: new Uint8Array(cap),
    carriedBy: new Int32Array(cap).fill(-1),
    hungry: new Float32Array(cap),
    free: [],
  };
}

export function spawnBrood(b: Brood, x: number, y: number, stage: number, age: number, alate: boolean): number {
  let s: number;
  if (b.free.length) s = b.free.pop()!;
  else if (b.count < b.cap) s = b.count++;
  else return -1;
  b.alive[s] = 1;
  b.x[s] = x;
  b.y[s] = y;
  b.stage[s] = stage;
  b.age[s] = age;
  b.fed[s] = stage === Stage.Pupa ? 3 : 0;
  b.alate[s] = alate ? 1 : 0;
  b.carriedBy[s] = -1;
  b.hungry[s] = 0;
  return s;
}

export function killBrood(b: Brood, s: number): void {
  if (!b.alive[s]) return;
  b.alive[s] = 0;
  b.carriedBy[s] = -1;
  b.free.push(s);
}

// ---------------------------------------------------------------------------
// Corpses, food sources, letters
// ---------------------------------------------------------------------------

export interface Corpse {
  id: number;
  x: number;
  y: number;
  serial: number;
  caste: number;
  cause: number;
  diedAt: number;
  carriedBy: number;
  heading: number;
}

export interface FoodSource {
  id: number;
  kind: number;
  x: number;
  y: number;
  amount: number;
  initial: number;
  /** Set when the visitor offered it. */
  offered: boolean;
  foundBy: number;
  foundAt: number;
  trailNoted: boolean;
}

export interface LetterItem {
  key: string;
  ch: string;
  word?: number;
  /** 0 on the page (being carried there), 1 carried underground, 2 stored. */
  state: number;
  x: number;
  y: number;
  bearer: number;
  takenAt: number;
}

export interface DeadRecord {
  serial: number;
  caste: number;
  cause: number;
  diedAt: number;
  bearer: number;
  lifeLoads: number;
  lifeDist: number;
  bornMinutes: number;
}
