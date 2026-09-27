/**
 * The Hollow Hill colony simulation.
 *
 * A fixed-step, headless, seeded agent model. Every ant is a slot in typed
 * arrays with a caste, an age, needs (hunger, fatigue), a task and a compact
 * history. Behaviour is local: ants follow scent on the surface, follow the
 * shape of the nest underground (distance fields stand in for their memory
 * of the tunnels), dig where digging is needed, carry the dead to the midden,
 * move brood toward warmth and away from water, and notice the observer.
 */
import {
  CELL_MM,
  Carry,
  Caste,
  DT,
  DeathCause,
  FEEDS_PER_LOAD,
  FOOD_CARRY,
  FoodKind,
  HARDNESS,
  Hist,
  LIFE,
  Mat,
  POP_CAPS,
  Pile,
  ROW,
  Role,
  SPEED,
  Stage,
  TICK_HZ,
  Task,
  WORLD_H,
  WORLD_WIDTHS,
  zoneOfRow,
  type DeviceClass,
} from "./constants";
import {
  Rng,
} from "./rng";
import {
  createAnts,
  createBrood,
  killAnt,
  killBrood,
  logHistory,
  spawnAnt,
  spawnBrood,
  TRAIT_ESCAPED,
  TRAIT_FOUND,
  TRAIT_SCOUT,
  TRAIT_WARM,
  type Ants,
  type Brood,
  type Corpse,
  type DeadRecord,
  type FoodSource,
  type LetterItem,
} from "./colony";
import { sampleEnv, temperatureAt, type EnvSample, type Place, type WeatherOverride } from "./environment";
import type { SimEvent } from "./events";
import { chooseDigCell, pickDigZone, type DigIntent } from "./excavation";
import { createFields, deposit, depositRadius, sample, updateField, fieldTotal, clearField, type Fields } from "./fields";
import {
  FAR,
  FieldBuilder,
  addPile,
  createEmptyWorld,
  depositGrain,
  digCell,
  entranceCells,
  erodeMound,
  fillCell,
  isDiggable,
  isFloor,
  isWalkable,
  opennessAt,
  surfaceRow,
  takePile,
  type World,
} from "./world";

export interface SimOptions {
  seed: number;
  deviceClass: DeviceClass;
  now: number;
  place: Place;
  weatherOverride?: WeatherOverride;
  popCap?: number;
}

export interface PageLetter {
  key: string;
  ch: string;
  /** Index of the word within its passage, so neighbouring words are spared. */
  word?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageInfo {
  letters: PageLetter[];
  gapX: number;
  gapY: number;
  width: number;
  height: number;
  cellPx: number;
  maxAnts: number;
  maxStolen: number;
}

export interface PageAnt {
  slot: number;
  x: number;
  y: number;
  heading: number;
  target: string | null;
  carrying: string | null;
  ch: string;
  t: number;
  returning: boolean;
}

export interface Flyer {
  serial: number;
  female: boolean;
  x: number;
  y: number;
}

export interface Visit {
  at: number;
  seconds: number;
}

export interface AbsenceNote {
  at: number;
  text: string;
  elapsedMs: number;
}

const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DY = [0, 0, 1, -1, 1, 1, -1, -1];
const DODGE = [0, 0.55, -0.55, 1.15, -1.15, 1.9, -1.9];

/** Food richness: how strongly a returning forager marks the trail. */
const RICHNESS = [0.35, 1.1, 1.0, 0.8, 0.8];
/** How far each food can be smelled, in cells. */
const ODOUR = [2.5, 11, 13, 8, 5];
/** Initial loads per food kind. */
export const FOOD_LOADS = [1, 360, 240, 160, 90];

export const SUB = {
  // Forage
  Exit: 0,
  Search: 1,
  Return: 2,
  Home: 3,
  // Dig
  Seek: 0,
  Haul: 1,
  Back: 2,
  // Nurse
  Tend: 0,
  Fetch: 1,
  Feed: 2,
  Carry: 3,
  Pickup: 4,
  // Undertake
  ToCorpse: 0,
  ToMidden: 1,
  // Flight
  Rise: 0,
  Climb: 1,
} as const;

export class Simulation {
  readonly W: number;
  readonly H: number;
  readonly seed: number;
  readonly deviceClass: DeviceClass;
  popCap: number;
  place: Place;
  weatherSeed: number;
  weatherOverride: WeatherOverride;

  world: World;
  ants: Ants;
  brood: Brood;
  fields: Fields;
  rng: Rng;

  tick = 0;
  colonyTime = 0;
  envNow: number;
  foundedAt: number;
  /** In headless runs the environment clock follows the ticks. */
  clockFollowsTicks = true;
  env: EnvSample;

  queen = -1;
  foods: FoodSource[] = [];
  corpses: Corpse[] = [];
  letters = new Map<string, LetterItem>();
  dead: DeadRecord[] = [];
  events: SimEvent[] = [];
  flyers: Flyer[] = [];
  pageAnts: PageAnt[] = [];
  page: PageInfo | null = null;
  gapFound = false;
  gapRow: number;
  visits: Visit[] = [];
  absenceNotes: AbsenceNote[] = [];

  feedPool = 0;
  eggsDue = 0;
  nextFoodId = 1;
  nextCorpseId = 1;
  nextWindfall = 0;
  seedDue = 0;
  flightActive = false;
  lastFlightDay = -1;
  flightsTotal = 0;
  flownTotal = 0;
  recruit = 0;
  lamp = { x: 0, y: 0, on: false };

  births = 0;
  deaths = 0;
  deathsByCause = [0, 0, 0, 0, 0, 0];
  eggsLaid = 0;
  foodGathered = 0;
  lettersTakenTotal = 0;
  knocks = 0;
  offersThisVisit = 0;

  chamberCount = 0;
  chamberCentres: { x: number; y: number }[] = [];
  floodCells = 0;
  starving = false;
  raining = false;
  daytime = false;
  storeSeed = -1;
  middenSeed = -1;

  // Distance fields: each ant's "knowledge of the way".
  dUp: Uint16Array;
  dStore: Uint16Array;
  dBrood: Uint16Array;
  dQueen: Uint16Array;
  dMidden: Uint16Array;
  dCorpse: Uint16Array;
  dPickup: Uint16Array;
  private fieldVersions = new Int32Array(7).fill(-1);
  private fieldDirty = new Uint8Array(7).fill(1);
  private fieldRR = 0;
  private builder: FieldBuilder;
  broodTargets: number[] = [];
  storeCells: number[] = [];
  private storeVersion = -1;
  private hashHead: Int32Array;
  private hashNext: Int32Array;
  private HW: number;
  private roleCounts = [0, 0, 0, 0];
  private digNeed = 0;
  private nurseryVolume = 0;

  constructor(opts: SimOptions, world?: World) {
    this.seed = opts.seed >>> 0;
    this.deviceClass = opts.deviceClass;
    this.W = world ? world.W : WORLD_WIDTHS[opts.deviceClass];
    this.H = WORLD_H;
    this.popCap = opts.popCap ?? POP_CAPS[opts.deviceClass];
    this.place = opts.place;
    this.weatherSeed = (this.seed * 2654435761) >>> 0;
    this.weatherOverride = opts.weatherOverride ?? null;
    this.rng = new Rng(this.seed);
    this.world = world ?? createEmptyWorld(this.W, this.H);
    const n = this.W * this.H;
    const antCap = Math.ceil(this.popCap * 1.3) + 128;
    this.ants = createAnts(antCap);
    this.brood = createBrood(Math.ceil(this.popCap * 0.6) + 128);
    this.fields = createFields(n);
    this.builder = new FieldBuilder(n);
    this.dUp = new Uint16Array(n).fill(FAR);
    this.dStore = new Uint16Array(n).fill(FAR);
    this.dBrood = new Uint16Array(n).fill(FAR);
    this.dQueen = new Uint16Array(n).fill(FAR);
    this.dMidden = new Uint16Array(n).fill(FAR);
    this.dCorpse = new Uint16Array(n).fill(FAR);
    this.dPickup = new Uint16Array(n).fill(FAR);
    this.HW = Math.ceil(this.W / 2);
    this.hashHead = new Int32Array(this.HW * Math.ceil(this.H / 2));
    this.hashNext = new Int32Array(antCap);
    this.envNow = opts.now;
    this.foundedAt = opts.now;
    this.gapRow = ROW.ground - 3;
    this.env = sampleEnv(this.envNow, this.place, this.weatherSeed, this.weatherOverride);
    this.daytime = this.env.daylight > 0.5;
    this.raining = this.env.rain > 0.05;
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  get minutes(): number {
    return (this.envNow - this.foundedAt) / 60000;
  }

  get colonyDay(): number {
    return Math.floor((this.envNow - this.foundedAt) / 86_400_000) + 1;
  }

  setNow(ms: number): void {
    this.envNow = ms;
  }

  refreshEnv(): void {
    this.env = sampleEnv(this.envNow, this.place, this.weatherSeed, this.weatherOverride);
  }

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.colonyTime += DT;
    if (this.clockFollowsTicks) this.envNow += DT * 1000;

    this.rebuildOneField();
    this.buildHash();

    const a = this.ants;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.where[s] !== 0) continue;
      this.updateAnt(s);
    }
    this.updatePageAnts();

    if (this.tick % 4 === 0) {
      const f = this.fields;
      updateField(f.food, this.world, f.scratch, DT * 4);
      updateField(f.home, this.world, f.scratch, DT * 4);
      updateField(f.alarm, this.world, f.scratch, DT * 4);
      this.waterPass(DT * 4);
    }
    if (this.tick % TICK_HZ === 0) this.secondly();
  }

  // -------------------------------------------------------------------------
  // Spatial hash (2-cell buckets), rebuilt every tick
  // -------------------------------------------------------------------------

  private buildHash(): void {
    const a = this.ants;
    const head = this.hashHead;
    const next = this.hashNext;
    head.fill(-1);
    const HW = this.HW;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.where[s] !== 0) continue;
      const b = (a.y[s] >> 1) * HW + (a.x[s] >> 1);
      next[s] = head[b];
      head[b] = s;
    }
  }

  /** Neighbours within radius r (cells). Calls fn for each; stop by returning true. */
  forNeighbours(x: number, y: number, r: number, fn: (j: number) => boolean | void): void {
    const HW = this.HW;
    const HH = this.hashHead.length / HW;
    const bx0 = Math.max(0, ((x - r) >> 1));
    const bx1 = Math.min(HW - 1, ((x + r) >> 1));
    const by0 = Math.max(0, ((y - r) >> 1));
    const by1 = Math.min(HH - 1, ((y + r) >> 1));
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let j = this.hashHead[by * HW + bx]; j >= 0; j = this.hashNext[j]) {
          if (fn(j)) return;
        }
      }
    }
  }

  /** Traffic: slow down behind others in narrow tunnels. Returns a speed factor. */
  private congestion(s: number): number {
    const a = this.ants;
    const x = a.x[s];
    const y = a.y[s];
    const h = a.heading[s];
    const hx = Math.cos(h);
    const hy = Math.sin(h);
    const HW = this.HW;
    const bx = x >> 1;
    const by = y >> 1;
    let factor = 1;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = by + oy;
      if (yy < 0) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = bx + ox;
        if (xx < 0 || xx >= HW) continue;
        const b = yy * HW + xx;
        if (b >= this.hashHead.length) continue;
        for (let j = this.hashHead[b]; j >= 0; j = this.hashNext[j]) {
          if (j === s) continue;
          const dx = a.x[j] - x;
          const dy = a.y[j] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1.3) continue;
          const along = dx * hx + dy * hy;
          if (along < 0.2) continue;
          const t = a.task[j];
          if (t === Task.Rest || t === Task.Queen) {
            factor = Math.min(factor, 0.2);
          } else {
            const same = Math.cos(a.heading[j] - h);
            factor = Math.min(factor, same > 0.3 ? 0.5 : 0.28);
          }
        }
      }
    }
    return factor;
  }

  // -------------------------------------------------------------------------
  // Navigation primitives
  // -------------------------------------------------------------------------

  walkable(x: number, y: number): boolean {
    const xi = x | 0;
    const yi = y | 0;
    if (x < 0 || y < 0 || xi >= this.W || yi >= this.H) return false;
    const i = yi * this.W + xi;
    return this.world.walk[i] === 1 && this.world.water[i] < 200;
  }

  /** Angle toward the neighbouring cell that best descends (or ascends) a field. */
  private gradAngle(field: Uint16Array, x: number, y: number, ascend: boolean): number {
    const W = this.W;
    const walk = this.world.walk;
    const cx = x | 0;
    const cy = y | 0;
    const i0 = cy * W + cx;
    let best = field[i0];
    if (best === FAR) best = ascend ? 0 : FAR;
    let bdx = 0;
    let bdy = 0;
    let ties = 0;
    for (let k = 0; k < 8; k++) {
      const dx = DX[k];
      const dy = DY[k];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
      const ni = ny * W + nx;
      if (!walk[ni]) continue;
      if (dx !== 0 && dy !== 0 && !walk[i0 + dx] && !walk[i0 + dy * W]) continue;
      const v = field[ni];
      if (v === FAR) continue;
      if (ascend ? v > best : v < best) {
        best = v;
        bdx = dx;
        bdy = dy;
        ties = 1;
      } else if (v === best && (bdx !== 0 || bdy !== 0)) {
        ties++;
        if (this.rng.next() * ties < 1) {
          bdx = dx;
          bdy = dy;
        }
      }
    }
    if (bdx === 0 && bdy === 0) return NaN;
    return Math.atan2(cy + bdy + 0.5 - y, cx + bdx + 0.5 - x);
  }

  private steer(s: number, angle: number, rate: number): void {
    if (Number.isNaN(angle)) return;
    const a = this.ants;
    let d = angle - a.heading[s];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const max = rate * DT;
    a.heading[s] += d > max ? max : d < -max ? -max : d;
  }

  private jitter(s: number, amount: number): void {
    this.ants.heading[s] += this.rng.gauss() * amount;
  }

  /** Move along heading, sliding around walls. Returns distance moved. */
  private move(s: number, speed: number): number {
    const a = this.ants;
    const step = speed * DT;
    if (step <= 0) return 0;
    const x = a.x[s];
    const y = a.y[s];
    const h = a.heading[s];
    const flip = this.rng.next() < 0.5 ? 1 : -1;
    for (let k = 0; k < DODGE.length; k++) {
      const hh = h + DODGE[k] * flip;
      const nx = x + Math.cos(hh) * step;
      const ny = y + Math.sin(hh) * step;
      if (this.walkable(nx, ny)) {
        a.x[s] = nx;
        a.y[s] = ny;
        if (k > 0) a.heading[s] = h + (hh - h) * 0.6;
        a.dist[s] += step;
        a.stuck[s] = Math.max(0, a.stuck[s] - DT);
        return step;
      }
    }
    a.heading[s] += Math.PI * (0.5 + this.rng.next());
    a.stuck[s] += DT;
    return 0;
  }

  private onSurface(s: number): boolean {
    const a = this.ants;
    return a.y[s] < surfaceRow(this.world, a.x[s]);
  }

  private cellOf(s: number): number {
    return (this.ants.y[s] | 0) * this.W + (this.ants.x[s] | 0);
  }

  // -------------------------------------------------------------------------
  // Per-ant update
  // -------------------------------------------------------------------------

  private updateAnt(s: number): void {
    const a = this.ants;
    const w = this.world;
    const caste = a.caste[s];

    // Displaced by the mound or buried by a cave-in.
    const ci = this.cellOf(s);
    if (!w.walk[ci]) {
      if (!this.rescueFromSolid(s)) {
        this.kill(s, DeathCause.CaveIn);
        return;
      }
    }

    // Needs.
    a.hunger[s] = Math.min(1, a.hunger[s] + DT / LIFE.hungerPeriod);
    const task = a.task[s];
    if (task === Task.Rest) a.fatigue[s] = Math.max(0, a.fatigue[s] - DT / 420);
    else if (task !== Task.Queen) a.fatigue[s] = Math.min(1, a.fatigue[s] + DT / 2400);

    if (a.hunger[s] >= 1) {
      a.starve[s] += DT;
      if (a.starve[s] > LIFE.starveGrace && caste !== Caste.Queen) {
        this.kill(s, DeathCause.Starvation);
        return;
      }
    } else a.starve[s] = 0;

    if (w.water[ci] > 90) {
      a.wet[s] += DT;
      if (a.wet[s] > 28 && caste !== Caste.Queen) {
        this.kill(s, DeathCause.Drowned);
        return;
      }
    } else a.wet[s] = Math.max(0, a.wet[s] - DT * 0.5);

    if (this.colonyTime - a.birth[s] > a.lifespan[s]) {
      this.kill(s, DeathCause.Age);
      return;
    }

    // Alarm: soldiers run toward it, others away; alarmed ants pass it on.
    if (a.alarm[s] < 0) a.alarm[s] = Math.min(0, a.alarm[s] + DT);
    const scent = sample(this.fields.alarm, w, a.x[s], a.y[s]);
    if (a.alarm[s] === 0 && scent > 0.7 && caste !== Caste.Queen) {
      a.alarm[s] = 2 + this.rng.next() * 2.5;
      if (this.rng.chance(0.08)) logHistory(a, s, this.minutes, Hist.Alarmed, 0);
    }
    if (a.alarm[s] > 0) {
      a.alarm[s] -= DT;
      if (a.alarm[s] <= 0) a.alarm[s] = -75;
      else {
        // Alarmed ants pass the alarm on briefly; it spreads, then fades.
        if (this.rng.next() < 0.35) deposit(this.fields.alarm, w, a.x[s], a.y[s], caste === Caste.Soldier ? 0.3 : 0.12);
        if (task !== Task.Rest || this.rng.chance(0.2)) {
          const up = this.senseGradient(this.fields.alarm.v, s);
          if (!Number.isNaN(up)) this.steer(s, caste === Caste.Soldier ? up : up + Math.PI, 9);
          if (a.task[s] === Task.Rest) a.task[s] = Task.Idle;
          this.move(s, this.speedOf(s) * 1.6 * this.congestion(s));
          return;
        }
      }
    }

    // Decide.
    a.timer[s] -= DT;
    if (a.timer[s] <= 0) {
      a.timer[s] = 5 + this.rng.next() * 9;
      this.decide(s);
    }

    switch (a.task[s]) {
      case Task.Queen:
        this.doQueen(s);
        break;
      case Task.Forage:
        this.doForage(s);
        break;
      case Task.Dig:
        this.doDig(s);
        break;
      case Task.Nurse:
        this.doNurse(s);
        break;
      case Task.Attend:
        this.doAttend(s);
        break;
      case Task.Undertake:
        this.doUndertake(s);
        break;
      case Task.Eat:
        this.doEat(s);
        break;
      case Task.Rest:
        this.doRest(s);
        break;
      case Task.Patrol:
        this.doPatrol(s);
        break;
      case Task.Flight:
        this.doFlight(s);
        break;
      default:
        this.doIdle(s);
    }

    // The observation lamp: some seek its warmth, most shy from its light.
    if (this.lamp.on && a.task[s] !== Task.Queen && a.where[s] === 0) {
      const dx = this.lamp.x - a.x[s];
      const dy = this.lamp.y - a.y[s];
      const d2 = dx * dx + dy * dy;
      if (d2 < 256 && d2 > 1) {
        const toward = Math.atan2(dy, dx);
        const warm = (a.traits[s] & TRAIT_WARM) !== 0 && a.carry[s] === Carry.None;
        this.steer(s, warm ? toward : toward + Math.PI, warm ? 1.4 : 3.2);
      }
    }
  }

  private rescueFromSolid(s: number): boolean {
    const a = this.ants;
    const x = a.x[s] | 0;
    const y = a.y[s] | 0;
    // Surface ants lifted by the growing mound simply climb onto it.
    const g = this.world.ground[x];
    if (y >= g && y <= g + 2 && isWalkable(this.world, x, g - 1)) {
      a.y[s] = g - 0.5;
      return true;
    }
    for (let r = 1; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (isWalkable(this.world, x + dx, y + dy)) {
            a.x[s] = x + dx + 0.5;
            a.y[s] = y + dy + 0.5;
            return true;
          }
        }
      }
    }
    return false;
  }

  private senseGradient(v: Float32Array, s: number): number {
    const a = this.ants;
    const x = a.x[s];
    const y = a.y[s];
    const W = this.W;
    let best = -1;
    let bestA = NaN;
    for (let k = 0; k < 8; k++) {
      const nx = (x | 0) + DX[k];
      const ny = (y | 0) + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
      const i = ny * W + nx;
      if (!this.world.walk[i]) continue;
      if (v[i] > best) {
        best = v[i];
        bestA = Math.atan2(ny + 0.5 - y, nx + 0.5 - x);
      }
    }
    return bestA;
  }

  speedOf(s: number): number {
    const a = this.ants;
    const c = a.caste[s];
    let v: number =
      c === Caste.Queen ? SPEED.queen : c === Caste.Soldier ? SPEED.soldier : c >= Caste.AlateF ? SPEED.alate : SPEED.worker;
    v *= a.speedK[s];
    const carry = a.carry[s];
    if (carry === Carry.Corpse || carry === Carry.Pupa || carry === Carry.Meat) v *= 0.72;
    else if (carry !== Carry.None) v *= 0.88;
    if (a.fatigue[s] > 0.75) v *= 0.7;
    if (a.hunger[s] > 0.9) v *= 0.75;
    // Cold slows everyone.
    const temp = temperatureAt(a.y[s], this.world.ground[a.x[s] | 0], this.env, (ROW.stone1End + ROW.stone2) / 2);
    if (temp < 12) v *= Math.max(0.3, (temp - 2) / 10);
    return v;
  }

  // -------------------------------------------------------------------------
  // Decisions and role allocation (age polyethism + colony need)
  // -------------------------------------------------------------------------

  private decide(s: number): void {
    const a = this.ants;
    const c = a.caste[s];
    const t = a.task[s];
    if (c === Caste.Queen) return;
    if (a.where[s] !== 0) return;
    // Never drop what you're carrying just because the clock ticked.
    if (a.carry[s] !== Carry.None) return;
    if (t === Task.Flight) return;
    if ((t === Task.Undertake || t === Task.Eat) && this.rng.chance(0.85)) return;

    if (c === Caste.AlateF || c === Caste.AlateM) {
      if (this.flightActive) {
        a.task[s] = Task.Flight;
        a.sub[s] = SUB.Rise;
      } else a.task[s] = this.rng.chance(0.6) ? Task.Rest : Task.Idle;
      return;
    }

    if (a.hunger[s] > 0.62 && (this.storeCells.length > 0 || this.feedPool >= 1)) {
      a.task[s] = Task.Eat;
      return;
    }
    if (a.fatigue[s] > 0.85 || (t === Task.Rest && a.fatigue[s] > 0.25)) {
      a.task[s] = Task.Rest;
      return;
    }

    if (c === Caste.Soldier) {
      a.task[s] = this.env.daylight > 0.3 || this.rng.chance(0.3) ? Task.Patrol : Task.Rest;
      return;
    }

    // Unclaimed dead take precedence for reserve and digger workers.
    if ((a.role[s] === Role.Reserve || a.role[s] === Role.Digger) && this.unclaimedCorpse() >= 0 && this.rng.chance(0.3)) {
      a.task[s] = Task.Undertake;
      a.sub[s] = SUB.ToCorpse;
      return;
    }

    switch (a.role[s]) {
      case Role.Nurse: {
        const attendants = this.roleCounts[0] > 0 ? this.countTask(Task.Attend) : 0;
        if (attendants < 10 && this.rng.chance(0.18)) a.task[s] = Task.Attend;
        else if (t !== Task.Nurse) {
          a.task[s] = Task.Nurse;
          a.sub[s] = SUB.Tend;
        }
        break;
      }
      case Role.Digger:
        if (this.digNeed > 0.02 && this.rng.chance(0.3 + this.digNeed)) {
          if (t !== Task.Dig) {
            a.task[s] = Task.Dig;
            a.sub[s] = SUB.Seek;
            const [top, bottom] = pickDigZone(this.rng, this.digZoneWeights());
            a.memX[s] = top;
            a.memY[s] = bottom;
            a.memKind[s] = this.rng.chance(top > ROW.stone2 ? 0.5 : 0.28) ? 1 : 0;
          }
        } else a.task[s] = this.rng.chance(0.5) ? Task.Rest : Task.Idle;
        break;
      case Role.Forager: {
        const willing = this.env.activity + (this.starving ? 0.2 : 0);
        if (this.rng.next() < willing * 1.15 || (t === Task.Forage && this.rng.next() < willing * 1.6)) {
          if (t !== Task.Forage) {
            a.task[s] = Task.Forage;
            a.sub[s] = SUB.Exit;
          }
        } else if (t === Task.Forage && this.onSurface(s)) {
          a.sub[s] = SUB.Home;
        } else if (t !== Task.Forage) a.task[s] = this.rng.chance(0.7) ? Task.Rest : Task.Idle;
        break;
      }
      default:
        a.task[s] = this.rng.chance(0.55) ? Task.Rest : Task.Idle;
    }
  }

  private countCache = new Int32Array(12);
  private countCacheTick = -1;
  countTask(task: number): number {
    if (this.countCacheTick !== this.tick) {
      this.countCache.fill(0);
      const a = this.ants;
      for (let s = 0; s < a.count; s++) if (a.alive[s]) this.countCache[a.task[s]]++;
      this.countCacheTick = this.tick;
    }
    return this.countCache[task];
  }

  private digZoneWeights() {
    const broodTotal = this.broodCount();
    const nurseryShort = this.nurseryVolume < broodTotal * 3 + 200;
    return { upper: 0.5, nursery: nurseryShort ? 0.6 : 0.3, royal: 0.12 };
  }

  broodCount(): number {
    const b = this.brood;
    let n = 0;
    for (let i = 0; i < b.count; i++) if (b.alive[i]) n++;
    return n;
  }

  /** Assign roles by age against the colony's current needs. */
  allocateRoles(): void {
    const a = this.ants;
    const workers: number[] = [];
    for (let s = 0; s < a.count; s++) {
      if (a.alive[s] && a.caste[s] === Caste.Worker && a.where[s] === 0) workers.push(s);
    }
    const n = workers.length;
    if (!n) return;
    workers.sort((p, q) => a.birth[q] - a.birth[p]); // youngest first

    const brood = this.broodCount();
    const stores = this.storeLoads();
    const pressure = Math.max(0, Math.min(1, 1 - stores / (n * 0.07 + 20)));
    const nurses = Math.min(Math.round(n * 0.38), Math.round(brood * 0.42) + 14);
    const foragers = Math.round(n * Math.min(0.5, 0.16 + 0.26 * pressure + this.recruit));
    const targetVolume = n * 5.2 + 700;
    this.digNeed = Math.max(0.06, Math.min(1, (targetVolume - this.world.volume) / (targetVolume * 0.12)));
    const diggers = Math.round(n * (0.03 + 0.13 * this.digNeed)) + 2;

    const counts = [0, 0, 0, 0];
    for (let k = 0; k < n; k++) {
      const s = workers[k];
      let role: number;
      if (k < nurses) role = Role.Nurse;
      else if (k >= n - foragers) role = Role.Forager;
      else if (k < nurses + diggers) role = Role.Digger;
      else role = Role.Reserve;
      if (a.role[s] !== role) {
        const busy = a.carry[s] !== Carry.None || a.task[s] === Task.Undertake;
        if (!busy) {
          a.role[s] = role;
          if (this.rng.chance(0.3)) logHistory(a, s, this.minutes, Hist.Role, role);
          // Let the next decision pick a task that fits the new role.
          if (a.task[s] !== Task.Rest && a.task[s] !== Task.Eat) a.timer[s] = Math.min(a.timer[s], this.rng.next() * 2);
        }
      }
      counts[a.role[s]]++;
    }
    this.roleCounts = counts;
    this.recruit *= 0.9;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  private doQueen(s: number): void {
    const a = this.ants;
    // She shifts a little in her chamber and turns slowly.
    if (this.rng.chance(0.01)) a.heading[s] += this.rng.gauss() * 0.6;
    if (this.rng.chance(0.25)) this.move(s, SPEED.queen * 0.4);
  }

  private doForage(s: number): void {
    const a = this.ants;
    const w = this.world;
    const f = this.fields;
    const surface = this.onSurface(s);
    const sub = a.sub[s];

    if (sub === SUB.Exit) {
      if (surface) {
        a.sub[s] = SUB.Search;
        a.stuck[s] = 0;
        a.timer[s] = 60 + this.rng.next() * 120;
      } else {
        this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
        this.jitter(s, 0.15);
      }
    } else if (sub === SUB.Search) {
      if (!surface) {
        // Wandered back down the hole.
        this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
      } else {
        this.forageSearch(s);
        deposit(f.home, w, a.x[s], a.y[s], 0.05);
        if (a.timer[s] < 1 && this.rng.chance(0.02)) a.sub[s] = SUB.Home;
      }
    } else if (sub === SUB.Return || sub === SUB.Home) {
      const carrying = a.carry[s] !== Carry.None;
      if (surface) {
        const g = this.gradAngle(this.dUp, a.x[s], a.y[s], false);
        const pher = this.sensorSteer(f.home.v, s);
        if (!Number.isNaN(pher) && this.rng.chance(0.35)) this.steer(s, pher, 5);
        this.steer(s, g, 6);
        this.jitter(s, 0.2);
        if (carrying && a.carry[s] !== Carry.Letter) {
          const src = this.foods.find((q) => q.id === a.memKind[s]);
          const rich = src ? RICHNESS[src.kind] : 0.4;
          deposit(f.food, w, a.x[s], a.y[s], 0.55 * rich);
        }
      } else if (carrying) {
        const g = this.gradAngle(this.dStore, a.x[s], a.y[s], false);
        if (Number.isNaN(g) || this.dStore[this.cellOf(s)] <= 1) {
          this.depositFood(s);
        } else {
          this.steer(s, g, 8);
          this.jitter(s, 0.1);
          if (a.carry[s] !== Carry.Letter) deposit(f.food, w, a.x[s], a.y[s], 0.08);
        }
      } else {
        // Empty-handed and below ground: back out, or rest if the day is over.
        if (sub === SUB.Home || this.env.activity < 0.15) {
          a.task[s] = Task.Rest;
          return;
        }
        a.sub[s] = SUB.Exit;
      }
    }
    this.move(s, this.speedOf(s) * this.congestion(s));
  }

  /** Surface search: follow the food trail, the smell of food, and memory. */
  private forageSearch(s: number): void {
    const a = this.ants;
    const w = this.world;
    const x = a.x[s];
    const y = a.y[s];

    const scout = (a.traits[s] & TRAIT_SCOUT) !== 0 && a.memKind[s] < 0;
    // Trail (explorers with nothing to fetch keep off the roads).
    if (!scout) {
      const trail = this.sensorSteer(this.fields.food.v, s);
      if (!Number.isNaN(trail)) this.steer(s, trail, 5.5);
    }

    // Memory of a known source.
    if (a.memKind[s] >= 0) {
      const src = this.foods.find((q) => q.id === a.memKind[s]);
      if (src) {
        const d = Math.hypot(src.x - x, src.y - y);
        if (d > 2.5) this.steer(s, Math.atan2(src.y - y, src.x - x), 1.8);
      } else a.memKind[s] = -1;
    }

    // Smell, checked a quarter of the ticks.
    if ((s + this.tick) % 4 === 0) {
      let best: FoodSource | null = null;
      let bestD = Infinity;
      for (const q of this.foods) {
        const dx = q.x - x;
        const dy = q.y - y;
        const d = Math.hypot(dx, dy);
        if (d < 1.6 + (q.kind === FoodKind.Seed ? 0 : 0.8)) {
          this.pickUpFood(s, q);
          return;
        }
        if (d < ODOUR[q.kind] && d < bestD) {
          bestD = d;
          best = q;
        }
      }
      if (best) this.steer(s, Math.atan2(best.y - y, best.x - x), 3.5);
    }

    // The gum in Dr. Vance's ink smells faintly of sugar through the fault in the frame.
    if (this.page && this.page.letters.length && this.pageAnts.length < this.page.maxAnts) {
      const dx = this.W - 0.5 - x;
      const dy = this.gapRow - y;
      const d = Math.hypot(dx, dy);
      if (scout && d < 150) this.steer(s, Math.atan2(dy, dx), this.gapFound ? 2.8 : 2);
      else if (d < 50 && a.memKind[s] < 0) this.steer(s, Math.atan2(dy, dx), 0.8);
      if (d < 2.4) this.escape(s);
    }

    this.jitter(s, scout ? 0.2 : 0.32);
    // Keep to the litter band rather than hugging the frame edge.
    if (x < 1.5) this.steer(s, 0, 4);
    if (x > this.W - 1.5 && !this.page) this.steer(s, Math.PI, 4);
    // Stay low in the litter band, near the ground.
    const g = surfaceRow(w, x);
    if (y < g - ROW.band + 2) this.steer(s, Math.PI / 2, 2);
  }

  /** Three-sensor steering on a scent field (classic ant sensing). */
  private sensorSteer(v: Float32Array, s: number): number {
    const a = this.ants;
    const h = a.heading[s];
    const x = a.x[s];
    const y = a.y[s];
    const W = this.W;
    let bestV = 0.02;
    let bestA = NaN;
    for (let k = -1; k <= 1; k++) {
      const ang = h + k * 0.62;
      const sx = (x + Math.cos(ang) * 2.4) | 0;
      const sy = (y + Math.sin(ang) * 2.4) | 0;
      if (sx < 0 || sy < 0 || sx >= W || sy >= this.H) continue;
      const val = v[sy * W + sx] * (1 + (this.rng.next() - 0.5) * 0.25);
      if (val > bestV) {
        bestV = val;
        bestA = ang;
      }
    }
    return bestA;
  }

  private pickUpFood(s: number, q: FoodSource): void {
    const a = this.ants;
    q.amount -= 1;
    a.carry[s] = FOOD_CARRY[q.kind];
    a.carryRef[s] = q.kind;
    a.memKind[s] = q.amount > 0 ? q.id : -1;
    a.memX[s] = q.x;
    a.memY[s] = q.y;
    a.sub[s] = SUB.Return;
    a.heading[s] += Math.PI;
    if (!(a.traits[s] & TRAIT_FOUND)) {
      a.traits[s] |= TRAIT_FOUND;
      logHistory(a, s, this.minutes, Hist.FoundFood, q.kind);
    }
    if (q.foundBy < 0) {
      q.foundBy = a.serial[s];
      q.foundAt = this.envNow;
      if (q.kind !== FoodKind.Seed) {
        this.events.push({ type: "food-found", serial: a.serial[s], kind: q.kind, source: q.id, x: q.x });
        logHistory(a, s, this.minutes, Hist.FoundFood, q.kind);
      }
    }
    if (q.amount > 40) this.recruit = Math.min(0.2, this.recruit + 0.006);
    if (q.amount <= 0) {
      this.foods = this.foods.filter((f) => f !== q);
      if (q.kind !== FoodKind.Seed) this.events.push({ type: "food-exhausted", kind: q.kind, offered: q.offered });
    }
  }

  private depositFood(s: number): void {
    const a = this.ants;
    const w = this.world;
    const x = a.x[s] | 0;
    const y = a.y[s] | 0;
    if (a.carry[s] === Carry.Letter) {
      const key = this.letterKeyOf(s);
      const item = key ? this.letters.get(key) : undefined;
      if (item) {
        item.state = 2;
        const spot = this.findStoreSpot(x, y);
        item.x = (spot % this.W) + 0.5;
        item.y = ((spot / this.W) | 0) + 0.5;
        this.events.push({ type: "letter-stored", serial: a.serial[s], key: item.key, ch: item.ch });
      }
    } else {
      const spot = this.findStoreSpot(x, y);
      addPile(w, spot, Pile.Food, 1);
      this.foodGathered++;
      a.loads[s]++;
      if (a.loads[s] % 10 === 0) logHistory(a, s, this.minutes, Hist.Loads, a.loads[s]);
    }
    a.carry[s] = Carry.None;
    a.carryRef[s] = -1;
    a.sub[s] = SUB.Exit;
    // Tired foragers go home to rest between trips.
    if (a.fatigue[s] > 0.7 || this.env.activity < 0.12) a.task[s] = Task.Rest;
  }

  private findStoreSpot(x: number, y: number): number {
    const w = this.world;
    const W = this.W;
    let fallback = y * W + x;
    let bestEmpty = -1;
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!isFloor(w, nx, ny)) continue;
          const i = ny * W + nx;
          if (w.pileType[i] === Pile.Food && w.pileAmt[i] < 14) return i;
          if (w.pileType[i] === Pile.None && bestEmpty < 0) bestEmpty = i;
        }
      }
    }
    if (bestEmpty >= 0) return bestEmpty;
    if (!isWalkable(w, x, y)) fallback = this.storeSeed >= 0 ? this.storeSeed : fallback;
    return fallback;
  }

  private letterKeyOf(s: number): string | null {
    for (const [key, item] of this.letters) if (item.bearer === this.ants.serial[s] && item.state < 2) return key;
    return null;
  }

  private doDig(s: number): void {
    const a = this.ants;
    const w = this.world;
    const sub = a.sub[s];
    const surface = this.onSurface(s);
    const zoneTop = a.memX[s];
    const zoneBottom = a.memY[s];

    if (sub === SUB.Seek) {
      if (surface) {
        this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
      } else {
        const y = a.y[s];
        const inZone = y >= zoneTop && y <= zoneBottom;
        if (!inZone || this.rng.chance(0.25)) {
          // Head away from the entrance: dead ends are where tunnels grow.
          let g = this.gradAngle(this.dUp, a.x[s], y, true);
          if (y > zoneBottom) g = this.gradAngle(this.dUp, a.x[s], y, false);
          if (!Number.isNaN(g)) this.steer(s, g, 6);
        }
        this.jitter(s, 0.22);
        // Try to dig.
        const need = Math.max(0.15, this.digNeed);
        if (this.rng.next() < DT * 1.1 * need) {
          const intent: DigIntent = { zoneTop, zoneBottom, chamber: a.memKind[s] === 1, cx: a.x[s], cy: a.y[s] };
          const target = chooseDigCell(w, a.x[s], y, a.heading[s], intent, this.rng);
          if (target >= 0) {
            const tx = target % this.W;
            const ty = (target / this.W) | 0;
            const hard = HARDNESS[w.soil[target]];
            if (this.rng.next() < 1 / hard) {
              digCell(w, tx, ty);
              a.carry[s] = Carry.Grain;
              a.dug[s]++;
              if (a.dug[s] % 25 === 0) logHistory(a, s, this.minutes, Hist.Dug, a.dug[s]);
              a.sub[s] = SUB.Haul;
              a.heading[s] = Math.atan2(ty + 0.5 - y, tx + 0.5 - a.x[s]) + Math.PI;
            }
          }
        }
      }
    } else if (sub === SUB.Haul) {
      if (surface) {
        // Walk out onto the mound a little way before dropping the grain.
        const e = w.entranceX + 1;
        const side = a.serial[s] % 2 === 0 ? -1 : 1;
        const tx = e + side * (4 + (a.serial[s] % 11));
        this.steer(s, Math.atan2(w.ground[Math.max(0, Math.min(this.W - 1, tx))] - 1 - a.y[s], tx - a.x[s]), 5);
        if (Math.abs(a.x[s] - tx) < 1.5 || a.stuck[s] > 1) {
          depositGrain(w, a.x[s] | 0, this.rng);
          a.carry[s] = Carry.None;
          a.sub[s] = SUB.Back;
        }
      } else {
        this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
        this.jitter(s, 0.1);
      }
    } else {
      // Back underground.
      if (surface) this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 7);
      else a.sub[s] = SUB.Seek;
      if (this.digNeed < 0.01) a.task[s] = Task.Idle;
    }
    this.move(s, this.speedOf(s) * this.congestion(s));
  }

  private doNurse(s: number): void {
    const a = this.ants;
    const b = this.brood;
    const sub = a.sub[s];
    const x = a.x[s];
    const y = a.y[s];
    const ci = this.cellOf(s);

    if (a.carry[s] === Carry.Egg || a.carry[s] === Carry.Larva || a.carry[s] === Carry.Pupa) {
      const item = a.carryRef[s];
      const wet = this.world.water[ci] > 0 || this.world.moisture[ci] > 170;
      if (this.dBrood[ci] <= 2 && !wet) {
        this.dropBrood(s, item);
      } else {
        this.steer(s, this.gradAngle(this.dBrood, x, y, false), 8);
        this.jitter(s, 0.12);
      }
      this.move(s, this.speedOf(s) * this.congestion(s));
      return;
    }

    if (sub === SUB.Pickup) {
      if (this.dPickup[ci] <= 1) {
        const item = this.broodNear(x, y, 1.8, (k) => b.carriedBy[k] < 0 && this.broodNeedsMove(k));
        if (item >= 0) {
          b.carriedBy[item] = s;
          a.carry[s] = Carry.Egg + b.stage[item];
          a.carryRef[s] = item;
          const bi = (b.y[item] | 0) * this.W + (b.x[item] | 0);
          if (this.world.water[bi] > 0 || this.world.moisture[bi] > 170) {
            logHistory(a, s, this.minutes, Hist.RescuedBrood, b.stage[item]);
            if (this.rng.chance(0.2)) this.events.push({ type: "brood-rescue", serial: a.serial[s], stage: b.stage[item] });
          }
        }
        a.sub[s] = SUB.Tend;
      } else {
        const g = this.gradAngle(this.dPickup, x, y, false);
        if (Number.isNaN(g)) a.sub[s] = SUB.Tend;
        else this.steer(s, g, 8);
      }
    } else if (sub === SUB.Fetch) {
      if (this.dStore[ci] <= 1 || Number.isNaN(this.gradAngle(this.dStore, x, y, false))) {
        let got = 0;
        for (let k = 0; k < 3; k++) if (this.eatOne()) got++;
        a.crop[s] = got;
        a.sub[s] = got ? SUB.Feed : SUB.Tend;
      } else this.steer(s, this.gradAngle(this.dStore, x, y, false), 8);
    } else if (sub === SUB.Feed) {
      if (this.dBrood[ci] > 3) this.steer(s, this.gradAngle(this.dBrood, x, y, false), 8);
      else if ((s + this.tick) % 6 === 0) {
        const larva = this.broodNear(x, y, 3, (k) => b.stage[k] === Stage.Larva && b.carriedBy[k] < 0 && this.larvaHungry(k));
        if (larva >= 0) {
          b.fed[larva]++;
          b.hungry[larva] = 0;
          a.crop[s]--;
          a.fedLarvae[s]++;
          if (a.crop[s] === 0) a.sub[s] = SUB.Tend;
        } else this.jitter(s, 0.8);
      }
    } else {
      // Tend: decide what the brood needs most.
      if ((s + this.tick) % 10 === 0) {
        if (this.dPickup[ci] < 260 && this.pickupCount > 0 && this.rng.chance(0.6)) a.sub[s] = SUB.Pickup;
        else if (this.hungryLarvae > 0 && this.storeCells.length && this.rng.chance(0.5)) a.sub[s] = SUB.Fetch;
      }
      if (this.dBrood[ci] > 4) this.steer(s, this.gradAngle(this.dBrood, x, y, false), 6);
      this.jitter(s, 0.5);
      // Nurses linger over the brood: slow, attentive movement.
      this.move(s, this.speedOf(s) * 0.35 * this.congestion(s));
      return;
    }
    this.move(s, this.speedOf(s) * this.congestion(s));
  }

  private dropBrood(s: number, item: number): void {
    const a = this.ants;
    const b = this.brood;
    if (item >= 0 && b.alive[item]) {
      b.carriedBy[item] = -1;
      // Settle on a floor near the carrier, beside brood of the same stage if possible.
      let bx = a.x[s];
      let by = a.y[s];
      const x = bx | 0;
      const y = by | 0;
      outer: for (let r = 0; r <= 2; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (isFloor(this.world, x + dx, y + dy)) {
              bx = x + dx + 0.2 + this.rng.next() * 0.6;
              by = y + dy + 0.55 + this.rng.next() * 0.3;
              break outer;
            }
          }
        }
      }
      b.x[item] = bx;
      b.y[item] = by;
    }
    a.carry[s] = Carry.None;
    a.carryRef[s] = -1;
    a.sub[s] = SUB.Tend;
  }

  private broodNear(x: number, y: number, r: number, pred: (k: number) => boolean): number {
    const b = this.brood;
    let best = -1;
    let bestD = r * r;
    for (let k = 0; k < b.count; k++) {
      if (!b.alive[k]) continue;
      const dx = b.x[k] - x;
      const dy = b.y[k] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD && pred(k)) {
        bestD = d2;
        best = k;
      }
    }
    return best;
  }

  private larvaHungry(k: number): boolean {
    const b = this.brood;
    const progress = b.age[k] / LIFE.larva;
    return b.fed[k] < Math.min(LIFE.larvaFeeds, Math.ceil(progress * LIFE.larvaFeeds + 0.3));
  }

  /** Brood that should be carried somewhere: eggs by the queen, wet brood, strays. */
  private broodNeedsMove(k: number): boolean {
    const b = this.brood;
    const i = (b.y[k] | 0) * this.W + (b.x[k] | 0);
    if (this.world.water[i] > 0 || this.world.moisture[i] > 170) return true;
    return this.dBrood[i] > 6 && this.dBrood[i] !== FAR;
  }

  private doAttend(s: number): void {
    const a = this.ants;
    const q = this.queen;
    if (q < 0 || !a.alive[q]) {
      a.task[s] = Task.Nurse;
      return;
    }
    const dx = a.x[q] - a.x[s];
    const dy = a.y[q] - a.y[s];
    const d = Math.hypot(dx, dy);
    if (d > 3.2) {
      this.steer(s, this.gradAngle(this.dQueen, a.x[s], a.y[s], false), 8);
      this.move(s, this.speedOf(s) * this.congestion(s));
    } else {
      // Face her, antennae working.
      this.steer(s, Math.atan2(dy, dx), 4);
      if (this.rng.chance(0.08)) this.move(s, this.speedOf(s) * 0.3);
      if (a.hunger[q] > 0.4 && this.rng.chance(0.02) && this.eatOne()) {
        a.hunger[q] = 0;
        logHistory(a, s, this.minutes, Hist.FedQueen, 0);
      }
    }
  }

  private unclaimedCorpse(): number {
    for (let k = 0; k < this.corpses.length; k++) if (this.corpses[k].carriedBy < 0) return k;
    return -1;
  }

  private doUndertake(s: number): void {
    const a = this.ants;
    const ci = this.cellOf(s);
    if (a.sub[s] === SUB.ToCorpse) {
      if (!this.corpses.some((c) => c.carriedBy < 0)) {
        a.task[s] = Task.Idle;
        return;
      }
      let picked = -1;
      for (let k = 0; k < this.corpses.length; k++) {
        const c = this.corpses[k];
        if (c.carriedBy >= 0) continue;
        if (Math.hypot(c.x - a.x[s], c.y - a.y[s]) < 1.6) {
          picked = k;
          break;
        }
      }
      if (picked >= 0) {
        const c = this.corpses[picked];
        c.carriedBy = s;
        a.carry[s] = Carry.Corpse;
        a.carryRef[s] = c.id;
        a.sub[s] = SUB.ToMidden;
        const rec = this.dead.find((d) => d.serial === c.serial);
        if (rec) rec.bearer = a.serial[s];
        logHistory(a, s, this.minutes, Hist.CarriedDead, c.serial & 0xffffff);
        this.events.push({ type: "corpse-carried", dead: c.serial, bearer: a.serial[s] });
      } else {
        const g = this.gradAngle(this.dCorpse, a.x[s], a.y[s], false);
        if (Number.isNaN(g) && this.dCorpse[ci] === FAR) {
          a.task[s] = Task.Idle;
          return;
        }
        this.steer(s, g, 8);
      }
    } else {
      const g = this.gradAngle(this.dMidden, a.x[s], a.y[s], false);
      if (this.dMidden[ci] <= 1 || Number.isNaN(g)) {
        const cIdx = this.corpses.findIndex((c) => c.id === a.carryRef[s]);
        if (cIdx >= 0) this.corpses.splice(cIdx, 1);
        const spot = this.middenSpot(a.x[s] | 0, a.y[s] | 0);
        const founding = this.middenSeed < 0 || !this.hasPile(Pile.Husk);
        addPile(this.world, spot, Pile.Husk, 1);
        if (founding) {
          this.middenSeed = spot;
          this.events.push({ type: "midden-founded", x: spot % this.W, y: (spot / this.W) | 0 });
        }
        a.bore[s] = Math.min(255, a.bore[s] + 1);
        a.carry[s] = Carry.None;
        a.carryRef[s] = -1;
        a.task[s] = Task.Idle;
        this.fieldDirty[4] = 1;
        this.fieldDirty[5] = 1;
      } else this.steer(s, g, 8);
    }
    this.move(s, this.speedOf(s) * this.congestion(s));
  }

  private hasPile(type: number): boolean {
    const t = this.world.pileType;
    for (let i = 0; i < t.length; i++) if (t[i] === type) return true;
    return false;
  }

  private middenSpot(x: number, y: number): number {
    const w = this.world;
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!isFloor(w, nx, ny)) continue;
          const i = ny * this.W + nx;
          if ((w.pileType[i] === Pile.Husk && w.pileAmt[i] < 10) || w.pileType[i] === Pile.None) return i;
        }
      }
    }
    return y * this.W + x;
  }

  private doEat(s: number): void {
    const a = this.ants;
    const ci = this.cellOf(s);
    const g = this.gradAngle(this.dStore, a.x[s], a.y[s], false);
    // A fed nestmate close by will share from her crop.
    if ((s + this.tick) % 8 === 0) {
      let shared = false;
      this.forNeighbours(a.x[s], a.y[s], 1.5, (j) => {
        if (j !== s && a.crop[j] > 0 && a.task[j] === Task.Nurse) {
          a.crop[j]--;
          shared = true;
          return true;
        }
      });
      if (shared) {
        a.hunger[s] = 0;
        a.task[s] = Task.Idle;
        return;
      }
    }
    if (this.dStore[ci] <= 1 || Number.isNaN(g)) {
      if (this.eatOne()) a.hunger[s] = 0;
      a.task[s] = Task.Idle;
      a.timer[s] = 2;
      return;
    }
    this.steer(s, g, 8);
    this.jitter(s, 0.12);
    this.move(s, this.speedOf(s) * this.congestion(s));
  }

  /** Take one feed from the colony's stores. */
  eatOne(): boolean {
    if (this.feedPool >= 1) {
      this.feedPool -= 1;
      return true;
    }
    this.refreshStoreCells();
    const cells = this.storeCells;
    if (!cells.length) return false;
    const i = cells[(this.rng.next() * cells.length) | 0];
    if (takePile(this.world, i, Pile.Food, 1) > 0) {
      this.feedPool += FEEDS_PER_LOAD - 1;
      return true;
    }
    return false;
  }

  refreshStoreCells(): void {
    if (this.storeVersion === this.world.pileVersion) return;
    this.storeVersion = this.world.pileVersion;
    const out: number[] = [];
    const t = this.world.pileType;
    for (let i = 0; i < t.length; i++) if (t[i] === Pile.Food) out.push(i);
    this.storeCells = out;
  }

  storeLoads(): number {
    this.refreshStoreCells();
    let n = 0;
    for (const i of this.storeCells) n += this.world.pileAmt[i];
    return n + this.feedPool / FEEDS_PER_LOAD;
  }

  private doRest(s: number): void {
    const a = this.ants;
    // Resting ants drift together into small clusters.
    if ((s + this.tick) % 16 === 0) {
      let near = 0;
      let sx = 0;
      let sy = 0;
      this.forNeighbours(a.x[s], a.y[s], 3, (j) => {
        if (j !== s && a.task[j] === Task.Rest) {
          near++;
          sx += a.x[j];
          sy += a.y[j];
        }
      });
      if (near > 0 && near < 8) this.steer(s, Math.atan2(sy / near - a.y[s], sx / near - a.x[s]), 30);
      a.sub[s] = near >= 2 ? 1 : 0;
    }
    // Foragers resting on the surface go below first.
    if (this.onSurface(s)) {
      this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
      this.move(s, this.speedOf(s) * 0.8);
      return;
    }
    if (a.sub[s] === 0 && this.rng.chance(0.3)) this.move(s, this.speedOf(s) * 0.2);
  }

  private doIdle(s: number): void {
    const a = this.ants;
    if (this.onSurface(s) && a.caste[s] !== Caste.Soldier) {
      this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 6);
    } else {
      this.jitter(s, 0.45);
      // Idle workers drift toward the brood and the stores, where company is.
      if (this.rng.chance(0.05)) this.steer(s, this.gradAngle(this.rng.chance(0.5) ? this.dBrood : this.dStore, a.x[s], a.y[s], false), 3);
    }
    this.move(s, this.speedOf(s) * 0.45 * this.congestion(s));
  }

  private doPatrol(s: number): void {
    const a = this.ants;
    const y = a.y[s];
    if (y > ROW.stone1) this.steer(s, this.gradAngle(this.dUp, a.x[s], y, false), 4);
    else if (this.onSurface(s) && this.dUp[this.cellOf(s)] > 24) this.steer(s, this.gradAngle(this.dUp, a.x[s], y, false), 4);
    this.jitter(s, 0.35);
    this.move(s, this.speedOf(s) * 0.6 * this.congestion(s));
  }

  private doFlight(s: number): void {
    const a = this.ants;
    const w = this.world;
    if (!this.flightActive) {
      a.task[s] = Task.Idle;
      return;
    }
    if (a.sub[s] === SUB.Rise) {
      if (this.onSurface(s)) {
        a.sub[s] = SUB.Climb;
        // Choose a grass stem to climb.
        let best = -1;
        let bestD = Infinity;
        for (let x = 1; x < this.W - 1; x++) {
          if (w.soil[(w.ground[x] - 1) * this.W + x] !== Mat.Stem) continue;
          const d = Math.abs(x + 0.5 - a.x[s]) + this.rng.next() * 6;
          if (d < bestD) {
            bestD = d;
            best = x;
          }
        }
        a.memX[s] = best >= 0 ? best + 0.5 : a.x[s];
      } else {
        this.steer(s, this.gradAngle(this.dUp, a.x[s], a.y[s], false), 8);
        this.move(s, this.speedOf(s) * this.congestion(s));
      }
      return;
    }
    // Climb: walk to the stem, then up it, and go.
    const dx = a.memX[s] - a.x[s];
    if (Math.abs(dx) > 1.2) {
      this.steer(s, Math.atan2(w.ground[a.x[s] | 0] - 1 - a.y[s], dx), 6);
      this.move(s, this.speedOf(s));
      if (a.stuck[s] > 2) a.memX[s] = a.x[s];
    } else {
      a.y[s] -= DT * 3;
      a.heading[s] = -Math.PI / 2;
      if (a.y[s] < w.ground[a.x[s] | 0] - ROW.band + 1 || this.rng.chance(DT * 0.5)) this.takeOff(s);
    }
  }

  flightTakeoffs = 0;
  flightPlanned = { count: 0, females: 0 };

  private takeOff(s: number): void {
    const a = this.ants;
    if (this.flightTakeoffs++ === 0) {
      const p = this.flightPlanned;
      this.events.push({ type: "flight", count: p.count, females: p.females, males: p.count - p.females });
    }
    this.flyers.push({ serial: a.serial[s], female: a.caste[s] === Caste.AlateF, x: a.x[s], y: a.y[s] });
    this.flownTotal++;
    this.dead.push({
      serial: a.serial[s],
      caste: a.caste[s],
      cause: DeathCause.Flight,
      diedAt: this.envNow,
      bearer: 0,
      lifeLoads: 0,
      lifeDist: a.dist[s],
      bornMinutes: this.minutesAt(a.birth[s]),
    });
    if (this.dead.length > 240) this.dead.splice(0, this.dead.length - 240);
    killAnt(a, s);
  }

  minutesAt(colonyTime: number): number {
    return this.minutes - (this.colonyTime - colonyTime) / 60;
  }

  // -------------------------------------------------------------------------
  // Death
  // -------------------------------------------------------------------------

  kill(s: number, cause: number): void {
    const a = this.ants;
    if (!a.alive[s]) return;
    const x = a.x[s];
    const y = a.y[s];
    // Whatever it carried is dropped where it fell.
    const carry = a.carry[s];
    if (carry >= Carry.Egg && carry <= Carry.Pupa) {
      const item = a.carryRef[s];
      if (item >= 0 && this.brood.alive[item]) {
        this.brood.carriedBy[item] = -1;
        this.brood.x[item] = x;
        this.brood.y[item] = y;
      }
    } else if (carry === Carry.Corpse) {
      const c = this.corpses.find((q) => q.id === a.carryRef[s]);
      if (c) {
        c.carriedBy = -1;
        c.x = x;
        c.y = y;
      }
    } else if (carry === Carry.Letter) {
      const key = this.letterKeyOf(s);
      if (key) {
        const item = this.letters.get(key)!;
        item.state = 2;
        item.x = x;
        item.y = y;
      }
    }
    const zone = zoneOfRow(y);
    this.deaths++;
    this.deathsByCause[cause]++;
    this.dead.push({
      serial: a.serial[s],
      caste: a.caste[s],
      cause,
      diedAt: this.envNow,
      bearer: 0,
      lifeLoads: a.loads[s],
      lifeDist: a.dist[s],
      bornMinutes: this.minutesAt(a.birth[s]),
    });
    if (this.dead.length > 240) this.dead.splice(0, this.dead.length - 240);
    this.events.push({ type: "death", serial: a.serial[s], caste: a.caste[s], cause, x, y, zone });
    // The buried and the drowned leave no body to carry; the rest do.
    if (cause !== DeathCause.CaveIn && this.corpses.length < 160 && isWalkable(this.world, x | 0, y | 0)) {
      this.corpses.push({
        id: this.nextCorpseId++,
        x,
        y,
        serial: a.serial[s],
        caste: a.caste[s],
        cause,
        diedAt: this.envNow,
        carriedBy: -1,
        heading: a.heading[s],
      });
      this.fieldDirty[5] = 1;
    }
    if (s === this.queen) this.queen = -1;
    // Drop any carried corpse's bearer link.
    for (const c of this.corpses) if (c.carriedBy === s) c.carriedBy = -1;
    // Page ant bookkeeping.
    this.pageAnts = this.pageAnts.filter((p) => p.slot !== s);
    killAnt(a, s);
  }

  // -------------------------------------------------------------------------
  // Once per second
  // -------------------------------------------------------------------------

  private secondly(): void {
    const prevRain = this.raining;
    const prevDay = this.daytime;
    this.refreshEnv();
    const env = this.env;
    this.raining = env.rain > 0.05;
    if (this.raining && !prevRain) this.events.push({ type: "rain-begin", intensity: env.rain });
    if (!this.raining && prevRain) this.events.push({ type: "rain-end" });
    this.daytime = env.daylight > 0.5;
    if (this.daytime && !prevDay) this.events.push({ type: "dawn" });
    if (!this.daytime && prevDay) this.events.push({ type: "dusk" });

    this.broodPass(1);
    this.queenPass(1);
    if (this.tick % (TICK_HZ * 5) === 0) this.allocateRoles();
    this.foodPass(1);
    this.caveInPass();
    this.flightPass();
    if (this.tick % (TICK_HZ * 20) === 0) this.computeBroodTargets();
    if (this.tick % (TICK_HZ * 30) === 0) this.chamberPass(true);
    this.pickupPass();
    this.starvationPass();
    // Moisture slowly dries.
    if (!this.raining) this.dryPass();
  }

  hungryLarvae = 0;
  pickupCount = 0;

  broodPass(dt: number): void {
    const b = this.brood;
    const a = this.ants;
    const nurseryRow = (ROW.stone1End + ROW.stone2) / 2;
    let hungry = 0;
    let emerged = 0;
    let alatesEmerged = 0;
    for (let k = 0; k < b.count; k++) {
      if (!b.alive[k]) continue;
      const g = this.world.ground[Math.min(this.W - 1, b.x[k] | 0)];
      const temp = temperatureAt(b.y[k], g, this.env, nurseryRow);
      const rate = Math.max(0.15, Math.min(1.35, (temp - 9) / 15));
      b.age[k] += dt * rate;
      const stage = b.stage[k];
      if (stage === Stage.Egg) {
        if (b.age[k] >= LIFE.egg) {
          b.stage[k] = Stage.Larva;
          b.age[k] = 0;
        }
      } else if (stage === Stage.Larva) {
        if (this.larvaHungry(k)) {
          hungry++;
          b.hungry[k] += dt;
          if (b.hungry[k] > 50 * 60) {
            killBrood(b, k);
            continue;
          }
        }
        if (b.age[k] >= LIFE.larva && b.fed[k] >= LIFE.larvaFeeds) {
          b.stage[k] = Stage.Pupa;
          b.age[k] = 0;
        } else if (b.age[k] >= LIFE.larva) b.age[k] = LIFE.larva;
      } else if (stage === Stage.Pupa && b.age[k] >= LIFE.pupa && b.carriedBy[k] < 0) {
        const pop = this.population();
        if (pop < this.popCap || b.alate[k]) {
          let caste: number = Caste.Worker;
          if (b.alate[k]) caste = this.rng.chance(0.4) ? Caste.AlateF : Caste.AlateM;
          else if (pop > 250 && this.rng.chance(0.07)) caste = Caste.Soldier;
          const s = spawnAnt(a, { caste, x: b.x[k], y: b.y[k] - 0.3, birth: this.colonyTime, minutes: this.minutes, rng: this.rng });
          if (s >= 0) {
            this.births++;
            emerged++;
            if (caste >= Caste.AlateF) alatesEmerged++;
            a.role[s] = Role.Nurse;
            if (this.rng.chance(0.05)) this.events.push({ type: "eclosion", serial: a.serial[s], caste });
          }
          killBrood(b, k);
        } else b.age[k] = LIFE.pupa * 0.9; // no room: pupa waits
      }
    }
    this.hungryLarvae = hungry;
    if (alatesEmerged > 0 && this.rng.chance(0.3)) this.events.push({ type: "alates-emerged", count: alatesEmerged });
    void emerged;
  }

  queenPass(dt: number): void {
    const q = this.queen;
    if (q < 0 || !this.ants.alive[q]) return;
    const a = this.ants;
    a.hunger[q] = Math.min(1, a.hunger[q] + dt / 1800);
    const stores = this.storeLoads();
    const pop = this.population();
    const food = stores <= 0 ? 0.04 : Math.max(0.2, Math.min(1, stores / (pop * 0.05 + 12)));
    const season = Math.max(0.06, Math.min(1, (this.env.deepTemp - 6) / 10));
    const room = Math.max(0, 1 - pop / this.popCap);
    const fed = a.hunger[q] < 0.8 ? 1 : 0.3;
    const rate = (1 / 64) * food * season * Math.sqrt(room) * fed;
    this.eggsDue += rate * dt;
    let laid = 0;
    while (this.eggsDue >= 1) {
      this.eggsDue -= 1;
      if (this.broodCount() >= this.brood.cap - 4) break;
      const alate =
        pop > this.popCap * 0.42 && stores > pop * 0.04 && this.env.warmth > -0.2 && this.alateTotal() < 48 && this.rng.chance(0.14);
      const k = spawnBrood(this.brood, a.x[q] + this.rng.gauss() * 1.2, a.y[q] + 0.6, Stage.Egg, 0, alate);
      if (k >= 0) {
        laid++;
        this.eggsLaid++;
      }
    }
    if (laid && this.rng.chance(0.02)) this.events.push({ type: "queen-laid", count: laid });
  }

  alateTotal(): number {
    const a = this.ants;
    let n = 0;
    for (let s = 0; s < a.count; s++) if (a.alive[s] && a.caste[s] >= Caste.AlateF) n++;
    const b = this.brood;
    for (let k = 0; k < b.count; k++) if (b.alive[k] && b.alate[k]) n++;
    return n;
  }

  population(): number {
    const a = this.ants;
    let n = 0;
    for (let s = 0; s < a.count; s++) if (a.alive[s]) n++;
    return n;
  }

  foodPass(dt: number): void {
    const env = this.env;
    // Seeds fall from the grass heads.
    this.seedDue += ((env.seedRate * (this.W / 180)) / 3600) * dt;
    while (this.seedDue >= 1) {
      this.seedDue -= 1;
      if (this.foods.length > 60) break;
      const x = this.rng.range(2, this.W - 3);
      this.addFood(FoodKind.Seed, x, false);
    }
    // Windfalls: a dead beetle, a crust, a crumb from the bench.
    if (this.nextWindfall === 0) this.nextWindfall = this.envNow + this.rng.range(20, 50) * 60000;
    if (this.envNow >= this.nextWindfall) {
      this.nextWindfall = this.envNow + this.rng.range(50, 130) * 60000;
      const kind = this.rng.pick([FoodKind.Beetle, FoodKind.Crust, FoodKind.Crumb, FoodKind.Beetle]);
      const x = this.rng.range(6, this.W - 8);
      this.addFood(kind, x, false);
      this.events.push({ type: "food-fell", kind, x });
    }
    // Trails become roads.
    for (const q of this.foods) {
      if (q.trailNoted || q.kind === FoodKind.Seed || q.foundBy < 0) continue;
      let n = 0;
      const a = this.ants;
      for (let s = 0; s < a.count; s++) if (a.alive[s] && a.memKind[s] === q.id) n++;
      if (n >= 10) {
        q.trailNoted = true;
        this.events.push({ type: "trail", source: q.id, kind: q.kind, foragers: n });
      }
    }
  }

  addFood(kind: number, x: number, offered: boolean): FoodSource {
    const xi = Math.max(1, Math.min(this.W - 2, Math.round(x)));
    const q: FoodSource = {
      id: this.nextFoodId++,
      kind,
      x: xi + 0.5,
      y: this.world.ground[xi] - 0.6,
      amount: FOOD_LOADS[kind],
      initial: FOOD_LOADS[kind],
      offered,
      foundBy: -1,
      foundAt: 0,
      trailNoted: false,
    };
    this.foods.push(q);
    return q;
  }

  private starvationPass(): void {
    const stores = this.storeLoads();
    const a = this.ants;
    let hungry = 0;
    let n = 0;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s]) continue;
      n++;
      if (a.hunger[s] > 0.8) hungry++;
    }
    const starving = stores < 1 && n > 0 && hungry / n > 0.25;
    if (starving && !this.starving) {
      this.events.push({ type: "starving" });
      // Nurses fall back on the eggs.
      let eaten = 0;
      const b = this.brood;
      for (let k = 0; k < b.count && eaten < 12; k++) {
        if (b.alive[k] && b.stage[k] === Stage.Egg && b.carriedBy[k] < 0 && this.rng.chance(0.3)) {
          killBrood(b, k);
          this.feedPool += 2;
          eaten++;
        }
      }
      if (eaten) this.events.push({ type: "egg-eaten", count: eaten });
    }
    if (!starving && this.starving && stores > 5) this.events.push({ type: "recovered" });
    this.starving = starving;
  }

  private pickupPass(): void {
    const b = this.brood;
    let n = 0;
    for (let k = 0; k < b.count; k++) if (b.alive[k] && b.carriedBy[k] < 0 && this.broodNeedsMove(k)) n++;
    if (n !== this.pickupCount) this.fieldDirty[6] = 1;
    this.pickupCount = n;
    if (this.tick % (TICK_HZ * 3) === 0) this.fieldDirty[6] = 1;
  }

  // -------------------------------------------------------------------------
  // Water, rain, moisture and cave-ins
  // -------------------------------------------------------------------------

  private waterMin = Infinity;
  private waterMax = -Infinity;

  private waterPass(dt: number): void {
    const w = this.world;
    const W = this.W;
    const rain = this.env.rain;
    if (rain > 0.05) {
      const drops = Math.round(rain * W * 0.35 * dt * 5);
      for (let k = 0; k < drops; k++) {
        const x = this.rng.int(1, W - 1);
        const y = w.ground[x] - 1;
        const i = y * W + x;
        if (w.walk[i]) {
          w.water[i] = Math.min(255, w.water[i] + 60);
          this.waterMin = Math.min(this.waterMin, y);
          this.waterMax = Math.max(this.waterMax, y);
        }
        // Rain soaks the topsoil.
        const depth = this.rng.int(0, 14);
        const si = (w.ground[x] + depth) * W + x;
        if (si < w.moisture.length && w.soil[si] !== Mat.Open) w.moisture[si] = Math.min(255, w.moisture[si] + 18);
      }
      if (this.rng.chance(rain * 0.3 * dt)) {
        const x = this.rng.int(2, W - 2);
        erodeMound(w, x);
      }
    }
    if (this.waterMin > this.waterMax) return;
    let flood = 0;
    let newMin = Infinity;
    let newMax = -Infinity;
    const y1 = Math.min(this.H - 2, this.waterMax + 1);
    for (let y = y1; y >= Math.max(0, this.waterMin); y--) {
      const dir = (y + this.tick) % 2 === 0 ? 1 : -1;
      for (let xx = 0; xx < W; xx++) {
        const x = dir > 0 ? xx : W - 1 - xx;
        const i = y * W + x;
        let v = w.water[i];
        if (!v) continue;
        // Fall.
        const below = i + W;
        if (w.soil[below] === Mat.Open && w.water[below] < 255) {
          const move = Math.min(v, 255 - w.water[below]);
          w.water[below] += move;
          v -= move;
          newMax = Math.max(newMax, y + 1);
        }
        // Spread sideways.
        if (v > 8) {
          for (const d of [dir, -dir]) {
            const nx = x + d;
            if (nx < 0 || nx >= W) continue;
            const ni = i + d;
            if (w.soil[ni] !== Mat.Open) continue;
            if (w.water[ni] < v - 4) {
              const move = (v - w.water[ni]) >> 2;
              w.water[ni] += move;
              v -= move;
            }
          }
        }
        // Seep into the surrounding soil and evaporate.
        if (this.rng.next() < 0.5) {
          const loss = y < w.ground[x] ? 3 : 1;
          v = Math.max(0, v - loss);
          for (let k = 0; k < 4; k++) {
            const ni = i + (k === 0 ? 1 : k === 1 ? -1 : k === 2 ? W : -W);
            if (ni >= 0 && ni < w.soil.length && w.soil[ni] !== Mat.Open) w.moisture[ni] = Math.min(255, w.moisture[ni] + 3);
          }
        }
        w.water[i] = v;
        if (v) {
          newMin = Math.min(newMin, y);
          newMax = Math.max(newMax, y);
          if (y > w.ground[x] + 2) flood++;
        }
      }
    }
    this.waterMin = newMin;
    this.waterMax = newMax;
    if (flood > 40 && this.floodCells <= 40) {
      const zone = zoneOfRow(newMax);
      this.events.push({ type: "flood", zone, cells: flood });
    }
    this.floodCells = flood;
  }

  private dryPass(): void {
    const w = this.world;
    for (let k = 0; k < 600; k++) {
      const i = this.rng.int(0, w.moisture.length);
      if (w.moisture[i]) w.moisture[i] = Math.max(0, w.moisture[i] - 12);
    }
  }

  private caveInPass(): void {
    const w = this.world;
    const W = this.W;
    const wet = this.raining || this.floodCells > 0;
    const samples = wet ? 90 : 12;
    for (let k = 0; k < samples; k++) {
      const x = this.rng.int(2, W - 2);
      const y = this.rng.int(ROW.ground + 3, wet ? ROW.stone1 : ROW.bedrock - 2);
      const i = y * W + x;
      if (w.soil[i] === Mat.Open || w.soil[i + W] !== Mat.Open) continue;
      if (!Number.isFinite(HARDNESS[w.soil[i]])) continue;
      // Measure the unsupported span beneath.
      let span = 1;
      for (let d = 1; d < 16 && w.soil[i + W + d] === Mat.Open; d++) span++;
      for (let d = 1; d < 16 && w.soil[i + W - d] === Mat.Open; d++) span++;
      const moist = w.moisture[i];
      let p = 0;
      if (moist > 140 && span >= 6) p = 0.04 * (moist / 255) * (span / 8);
      else if (span >= 14) p = 0.0004;
      if (p > 0 && this.rng.next() < p) this.collapse(x, y + 1, 2 + Math.min(3, span / 5));
    }
  }

  /** A section of ceiling falls; open cells nearby fill with rubble. */
  collapse(cx: number, cy: number, r: number): number {
    const w = this.world;
    const a = this.ants;
    let lost = 0;
    const filled: number[] = [];
    for (let y = Math.floor(cy - r * 0.6); y <= Math.ceil(cy + r * 0.8); y++) {
      for (let x = Math.floor(cx - r * 1.6); x <= Math.ceil(cx + r * 1.6); x++) {
        if (x < 1 || x >= this.W - 1 || y <= w.ground[x] + 1 || y >= this.H - 1) continue;
        const dx = (x - cx) / (r * 1.6);
        const dy = (y - cy) / r;
        if (dx * dx + dy * dy > 1) continue;
        const i = y * this.W + x;
        if (w.soil[i] !== Mat.Open) continue;
        fillCell(w, x, y, Mat.Rubble);
        w.moisture[i] = 200;
        filled.push(i);
      }
    }
    if (!filled.length) return 0;
    const set = new Set(filled);
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.where[s] !== 0 || a.caste[s] === Caste.Queen) continue;
      if (set.has(this.cellOf(s))) {
        if (!this.rescueFromSolid(s) || this.rng.chance(0.5)) {
          this.kill(s, DeathCause.CaveIn);
          lost++;
        } else logHistory(a, s, this.minutes, Hist.SurvivedCaveIn, 0);
      }
    }
    const b = this.brood;
    for (let k = 0; k < b.count; k++) {
      if (b.alive[k] && b.carriedBy[k] < 0 && set.has((b.y[k] | 0) * this.W + (b.x[k] | 0))) killBrood(b, k);
    }
    for (const [key, item] of this.letters) {
      if (item.state === 2 && set.has((item.y | 0) * this.W + (item.x | 0))) {
        // A buried letter is lost to the hill.
        this.letters.delete(key);
      }
    }
    this.events.push({ type: "cave-in", x: cx, y: cy, lost, region: this.regionName(cx, cy) });
    return lost;
  }

  regionName(x: number, y: number): string {
    const zone = zoneOfRow(y);
    const side = x < this.W * 0.36 ? "western" : x > this.W * 0.64 ? "eastern" : "central";
    if (zone === "upper") return `the ${side} gallery`;
    if (zone === "nursery") return `the ${side} nursery`;
    if (zone === "royal") return side === "central" ? "the royal passage" : `the ${side} deep chamber`;
    if (zone === "surface") return `the ${side} surface`;
    return "the bedrock";
  }

  private flightPass(): void {
    const env = this.env;
    if (this.flightActive) {
      const a = this.ants;
      let remaining = 0;
      for (let s = 0; s < a.count; s++) if (a.alive[s] && a.caste[s] >= Caste.AlateF) remaining++;
      if (remaining === 0 || !env.flightWeather) {
        this.flightActive = false;
        const a2 = this.ants;
        for (let s = 0; s < a2.count; s++) if (a2.alive[s] && a2.task[s] === Task.Flight) a2.task[s] = Task.Idle;
      }
      return;
    }
    if (!env.flightWeather || this.lastFlightDay === env.dayNumber) return;
    const a = this.ants;
    let alates = 0;
    let females = 0;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.caste[s] < Caste.AlateF) continue;
      alates++;
      if (a.caste[s] === Caste.AlateF) females++;
    }
    if (alates < 6) return;
    if (this.rng.next() > 0.3 / 60) return;
    this.startFlight(alates, females);
  }

  startFlight(alates?: number, females?: number): void {
    const a = this.ants;
    let n = 0;
    let f = 0;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.caste[s] < Caste.AlateF) continue;
      a.task[s] = Task.Flight;
      a.sub[s] = SUB.Rise;
      n++;
      if (a.caste[s] === Caste.AlateF) f++;
    }
    if (!n) return;
    this.flightActive = true;
    this.lastFlightDay = this.env.dayNumber;
    this.flightsTotal++;
    this.flightTakeoffs = 0;
    this.flightPlanned = { count: alates ?? n, females: females ?? f };
    this.events.push({ type: "flight-begin", count: alates ?? n });
  }

  // -------------------------------------------------------------------------
  // Chambers, brood targets, distance fields
  // -------------------------------------------------------------------------

  /** Count chambers: connected regions of open cells at least two cells from any wall. */
  chamberPass(announce: boolean): { x: number; y: number; size: number }[] {
    const w = this.world;
    const W = this.W;
    const H = this.H;
    const n = W * H;
    const core = new Uint8Array(n);
    let nursery = 0;
    for (let y = ROW.ground + 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (!w.walk[i] || y < w.ground[x] + 2) continue;
        if (y >= ROW.stone1End && y < ROW.stone2) nursery++;
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) if (!w.walk[i + dy * W + dx]) ok = false;
        if (ok) core[i] = 1;
      }
    }
    this.nurseryVolume = nursery;
    const seen = new Uint8Array(n);
    const out: { x: number; y: number; size: number }[] = [];
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!core[i] || seen[i]) continue;
      let size = 0;
      let sx = 0;
      let sy = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        size++;
        sx += c % W;
        sy += (c / W) | 0;
        for (const d of [1, -1, W, -W]) {
          const nb = c + d;
          if (nb >= 0 && nb < n && core[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
      if (size >= 8) out.push({ x: sx / size, y: sy / size, size });
    }
    if (announce && out.length > this.chamberCount && this.chamberCount > 0) {
      // Announce the chamber that is new: the one farthest from all known centres.
      let pick = out[0];
      let bestD = -1;
      for (const c of out) {
        let dmin = Infinity;
        for (const k of this.chamberCentres) dmin = Math.min(dmin, Math.hypot(c.x - k.x, c.y - k.y));
        if (dmin > bestD) {
          bestD = dmin;
          pick = c;
        }
      }
      this.events.push({ type: "new-chamber", x: pick.x, y: pick.y, region: this.regionName(pick.x, pick.y), count: out.length });
    }
    this.chamberCount = out.length;
    this.chamberCentres = out.map((c) => ({ x: c.x, y: c.y }));
    return out;
  }

  /** Where nurses want the brood: warm, dry floors in open chambers. */
  computeBroodTargets(): void {
    const w = this.world;
    const W = this.W;
    const nurseryRow = (ROW.stone1End + ROW.stone2) / 2;
    const scored: [number, number][] = [];
    for (let y = ROW.ground + 6; y < ROW.bedrock; y += 1) {
      const t = temperatureAt(y, ROW.ground, this.env, nurseryRow);
      const tScore = -Math.abs(t - 27) * 0.35;
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (!w.walk[i] || w.soil[i + W] === Mat.Open) continue;
        if (y < w.ground[x] + 4) continue;
        if (w.pileType[i] !== Pile.None) continue;
        const open = opennessAt(w, x, y - 1, 3);
        if (open < 1) continue;
        let score = tScore + open * 0.5;
        score -= w.moisture[i] / 60 + (w.water[i] ? 5 : 0);
        if (y >= ROW.stone1End && y < ROW.stone2) score += 2;
        if (y >= ROW.stone2End) score -= 1.5;
        if (this.middenSeed >= 0) {
          const mx = this.middenSeed % W;
          const my = (this.middenSeed / W) | 0;
          if (Math.hypot(mx - x, my - y) < 14) score -= 4;
        }
        scored.push([score + this.rng.next() * 0.3, i]);
      }
    }
    scored.sort((p, q) => q[0] - p[0]);
    this.broodTargets = scored.slice(0, 70).map((p) => p[1]);
    this.fieldDirty[2] = 1;
  }

  private sourcesFor(k: number): number[] {
    const w = this.world;
    const W = this.W;
    switch (k) {
      case 0:
        return entranceCells(w);
      case 1: {
        this.refreshStoreCells();
        if (this.storeCells.length) return this.storeCells;
        return this.storeSeed >= 0 ? [this.storeSeed] : [];
      }
      case 2:
        return this.broodTargets;
      case 3: {
        const q = this.queen;
        if (q < 0) return [];
        return [(this.ants.y[q] | 0) * W + (this.ants.x[q] | 0)];
      }
      case 4: {
        const out: number[] = [];
        for (let i = 0; i < w.pileType.length; i++) if (w.pileType[i] === Pile.Husk) out.push(i);
        if (!out.length) {
          if (this.middenSeed < 0) this.middenSeed = this.chooseMiddenSite();
          if (this.middenSeed >= 0) out.push(this.middenSeed);
        }
        return out;
      }
      case 5:
        return this.corpses.filter((c) => c.carriedBy < 0).map((c) => (c.y | 0) * W + (c.x | 0));
      case 6: {
        const out: number[] = [];
        const b = this.brood;
        for (let j = 0; j < b.count; j++) {
          if (b.alive[j] && b.carriedBy[j] < 0 && this.broodNeedsMove(j)) out.push((b.y[j] | 0) * W + (b.x[j] | 0));
        }
        return out;
      }
    }
    return [];
  }

  /** The midden goes in a dead end of the upper galleries, away from the brood. */
  private chooseMiddenSite(): number {
    const w = this.world;
    const W = this.W;
    let best = -1;
    let bestScore = -Infinity;
    for (let y = ROW.ground + 12; y < ROW.stone1 - 4; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (!isFloor(w, x, y) || this.dUp[i] === FAR) continue;
        const score = this.dUp[i] * 0.6 + Math.abs(x - w.entranceX) * 0.8 - (y - ROW.ground) * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  private rebuildOneField(): void {
    const fields = [this.dUp, this.dStore, this.dBrood, this.dQueen, this.dMidden, this.dCorpse, this.dPickup];
    const topo = this.world.topologyVersion;
    for (let t = 0; t < 7; t++) {
      const k = (this.fieldRR + t) % 7;
      const intervalOk = this.tick % 2 === 0;
      if ((this.fieldVersions[k] !== topo && intervalOk) || this.fieldDirty[k]) {
        if (k === 1) this.refreshStoreCells();
        this.builder.build(this.world, this.sourcesFor(k), fields[k]);
        this.fieldVersions[k] = topo;
        this.fieldDirty[k] = 0;
        this.fieldRR = (k + 1) % 7;
        return;
      }
    }
  }

  /** Rebuild every distance field now (used after founding, loading and catch-up). */
  rebuildAllFields(): void {
    this.fieldDirty.fill(1);
    for (let k = 0; k < 7; k++) this.rebuildOneField();
  }

  // -------------------------------------------------------------------------
  // The page: escaped foragers and borrowed letters
  // -------------------------------------------------------------------------

  private escape(s: number): void {
    const a = this.ants;
    const page = this.page;
    if (!page || a.carry[s] !== Carry.None) return;
    if (this.pageAnts.length >= page.maxAnts) return;
    if (this.lettersOut() >= page.maxStolen) return;
    if (!this.gapFound) {
      this.gapFound = true;
      this.events.push({ type: "gap-found", serial: a.serial[s] });
    } else if (this.rng.next() > 0.25) return;
    a.where[s] = 1;
    a.task[s] = Task.Escaped;
    a.traits[s] |= TRAIT_ESCAPED;
    logHistory(a, s, this.minutes, Hist.Escaped, 0);
    this.pageAnts.push({
      slot: s,
      x: page.gapX,
      y: page.gapY + this.rng.range(-3, 3),
      heading: this.rng.range(-0.6, 0.6),
      target: null,
      carrying: null,
      ch: "",
      t: 0,
      returning: false,
    });
    this.events.push({ type: "escape", serial: a.serial[s] });
  }

  lettersOut(): number {
    let n = 0;
    for (const item of this.letters.values()) if (item.state <= 2) n++;
    return n;
  }

  setPage(info: PageInfo | null): void {
    this.page = info;
    if (!info) {
      // Recall anyone abroad.
      for (const p of this.pageAnts) this.reenter(p);
      this.pageAnts = [];
    }
  }

  private updatePageAnts(): void {
    const page = this.page;
    if (!page || !this.pageAnts.length) return;
    const a = this.ants;
    const taken = new Set<string>();
    const robbed = new Set<string>();
    const blockOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
    for (const [key, item] of this.letters) {
      if (item.state > 2) continue;
      taken.add(key);
      if (item.word !== undefined) for (let d = -1; d <= 1; d++) robbed.add(`${blockOf(key)}#${item.word + d}`);
    }
    for (const p of this.pageAnts) if (p.target) taken.add(p.target);
    const speedPx = SPEED.worker * page.cellPx;
    const keep: PageAnt[] = [];
    for (const p of this.pageAnts) {
      const s = p.slot;
      if (!a.alive[s]) continue;
      p.t += DT;
      const v = speedPx * a.speedK[s];
      if (p.carrying || p.returning) {
        const dx = page.gapX - p.x;
        const dy = page.gapY - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 5) {
          this.reenter(p);
          continue;
        }
        steerAngle(p, Math.atan2(dy, dx), 3.2 * DT);
        p.heading += this.rng.gauss() * 0.12;
      } else {
        if (!p.target || (this.tick + s) % 20 === 0) {
          // The nearest untaken letter within reach smells of gum arabic.
          let best: PageLetter | null = null;
          let bestD = 320;
          for (const l of page.letters) {
            if (taken.has(l.key) && l.key !== p.target) continue;
            if (l.word !== undefined && robbed.has(`${blockOf(l.key)}#${l.word}`)) continue;
            const d = Math.hypot(l.x + l.w / 2 - p.x, l.y + l.h * 0.6 - p.y);
            if (d < bestD) {
              bestD = d;
              best = l;
            }
          }
          if (best) {
            if (p.target) taken.delete(p.target);
            p.target = best.key;
            taken.add(best.key);
          }
        }
        const target = p.target ? page.letters.find((l) => l.key === p.target) : undefined;
        if (target) {
          const tx = target.x + target.w / 2;
          const ty = target.y + target.h * 0.6;
          const d = Math.hypot(tx - p.x, ty - p.y);
          const spoiled = target.word !== undefined && robbed.has(`${blockOf(target.key)}#${target.word}`);
          if (d < 3.2) {
            if (!spoiled && this.lettersOut() < page.maxStolen) {
              p.carrying = target.key;
              p.ch = target.ch;
              for (let dd = -1; dd <= 1; dd++) if (target.word !== undefined) robbed.add(`${blockOf(target.key)}#${target.word + dd}`);
              this.letters.set(target.key, {
                key: target.key,
                ch: target.ch,
                word: target.word,
                state: 0,
                x: 0,
                y: 0,
                bearer: a.serial[s],
                takenAt: this.envNow,
              });
              this.lettersTakenTotal++;
              a.letters[s] = Math.min(255, a.letters[s] + 1);
              logHistory(a, s, this.minutes, Hist.TookLetter, target.ch.charCodeAt(0));
              this.events.push({ type: "letter-taken", serial: a.serial[s], key: target.key, ch: target.ch });
              p.heading += Math.PI;
            } else p.returning = true;
            p.target = null;
          } else {
            steerAngle(p, Math.atan2(ty - p.y, tx - p.x), 2.6 * DT);
            p.heading += this.rng.gauss() * 0.18;
          }
        } else {
          p.heading += this.rng.gauss() * 0.3;
        }
        if (p.t > 170) p.returning = true;
      }
      // Pause now and then, as ants do.
      const pausing = (Math.sin(p.t * 1.3 + s) > 0.93 ? 0.15 : 1);
      p.x += Math.cos(p.heading) * v * DT * pausing;
      p.y += Math.sin(p.heading) * v * DT * pausing;
      if (p.x < 4) {
        p.x = 4;
        p.heading = Math.PI - p.heading;
      }
      if (p.x > page.width - 4) {
        p.x = page.width - 4;
        p.heading = Math.PI - p.heading;
      }
      if (p.y < 4) {
        p.y = 4;
        p.heading = -p.heading;
      }
      if (p.y > page.height - 4) {
        p.y = page.height - 4;
        p.heading = -p.heading;
      }
      keep.push(p);
    }
    this.pageAnts = keep;
  }

  private reenter(p: PageAnt): void {
    const a = this.ants;
    const s = p.slot;
    if (!a.alive[s]) return;
    a.where[s] = 0;
    a.x[s] = this.W - 1.5;
    a.y[s] = this.gapRow + 0.5;
    if (!this.walkable(a.x[s], a.y[s])) {
      a.y[s] = this.world.ground[this.W - 2] - 1.5;
    }
    a.heading[s] = Math.PI;
    a.task[s] = Task.Forage;
    logHistory(a, s, this.minutes, Hist.Returned, 0);
    if (p.carrying) {
      const item = this.letters.get(p.carrying);
      if (item) {
        item.state = 1;
        a.carry[s] = Carry.Letter;
        a.carryRef[s] = -1;
        a.sub[s] = SUB.Return;
      }
    } else {
      a.sub[s] = SUB.Search;
    }
  }

  /** Dr. Vance restores the notebook: every borrowed letter goes back. */
  restoreLetters(): number {
    const count = this.letters.size;
    this.letters.clear();
    const a = this.ants;
    for (let s = 0; s < a.count; s++) {
      if (a.alive[s] && a.carry[s] === Carry.Letter) {
        a.carry[s] = Carry.None;
        a.carryRef[s] = -1;
      }
    }
    for (const p of this.pageAnts) {
      p.carrying = null;
      p.ch = "";
      p.returning = true;
    }
    if (count) this.events.push({ type: "letters-restored", count });
    return count;
  }

  // -------------------------------------------------------------------------
  // The observer
  // -------------------------------------------------------------------------

  /** A tap on the glass: vibration through the soil and a burst of alarm. */
  knock(x: number, y: number): void {
    this.knocks++;
    depositRadius(this.fields.alarm, this.world, x, y, 5, 9);
    const a = this.ants;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.where[s] !== 0 || a.caste[s] === Caste.Queen) continue;
      const d = Math.hypot(a.x[s] - x, a.y[s] - y);
      if (d < 24 && a.alarm[s] >= 0) {
        a.alarm[s] = 2 + this.rng.next() * 3 * (1 - d / 24);
        if (a.task[s] === Task.Rest) a.task[s] = Task.Idle;
      }
    }
    this.events.push({ type: "alarm", x, y, source: "knock" });
  }

  offerFood(kind: number, x: number): FoodSource {
    this.offersThisVisit++;
    const q = this.addFood(kind, x, true);
    this.events.push({ type: "food-offered", kind, x: q.x });
    return q;
  }

  setLamp(x: number, y: number, on: boolean): void {
    this.lamp.x = x;
    this.lamp.y = y;
    this.lamp.on = on;
  }

  alarmLevel(): number {
    return fieldTotal(this.fields.alarm);
  }

  clearScents(): void {
    clearField(this.fields.food);
    clearField(this.fields.home);
    clearField(this.fields.alarm);
  }

  findSlotBySerial(serial: number): number {
    const a = this.ants;
    for (let s = 0; s < a.count; s++) if (a.alive[s] && a.serial[s] === serial) return s;
    return -1;
  }
}

function steerAngle(p: { heading: number }, target: number, max: number): void {
  let d = target - p.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  p.heading += d > max ? max : d < -max ? -max : d;
}

export const MM_PER_CELL = CELL_MM;
export { isDiggable };
