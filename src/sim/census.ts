/**
 * The census: what Dr. Vance would tally in the ledger, computed from the
 * live state. Also the facts behind "What is happening now?" and the
 * specimen card's reading of one real ant.
 */
import { CELL_MM, Carry, Caste, FoodKind, Role, Stage, Task, zoneOfRow } from "./constants";
import { readHistory, type HistoryEntry } from "./colony";
import type { NowFacts } from "../notes/grammar";
import type { Simulation } from "./sim";
import { surfaceRow } from "./world";

export interface Census {
  tick: number;
  envNow: number;
  foundedAt: number;
  colonyDay: number;
  population: number;
  workers: number;
  soldiers: number;
  alatesF: number;
  alatesM: number;
  queenAlive: boolean;
  roles: [number, number, number, number];
  tasks: number[];
  abroad: number;
  onPage: number;
  eggs: number;
  larvae: number;
  pupae: number;
  stores: number;
  surfaceFood: number;
  sources: { kind: number; amount: number; initial: number; offered: boolean }[];
  births: number;
  deaths: number;
  deathsByCause: number[];
  flights: number;
  flown: number;
  chambers: number;
  volume: number;
  tunnelFeet: number;
  deepestInches: number;
  midden: number;
  lettersOut: number;
  lettersStored: number;
  lettersTakenTotal: number;
  alarm: number;
  hungerMean: number;
  starving: boolean;
  flightActive: boolean;
  flood: number;
  gapFound: boolean;
  foodGathered: number;
  eggsLaid: number;
  env: {
    localHour: number;
    season: string;
    daylight: number;
    rain: number;
    surfaceTemp: number;
    pressure: number;
    moonPhase: number;
    lampLit: boolean;
    sunAltitude: number;
    flightWeather: boolean;
    warmth: number;
  };
  offersLeft: number;
}

export const OFFERS_PER_VISIT = 3;

export function takeCensus(sim: Simulation): Census {
  const a = sim.ants;
  const tasks = new Array(12).fill(0);
  const roles: [number, number, number, number] = [0, 0, 0, 0];
  let workers = 0;
  let soldiers = 0;
  let alatesF = 0;
  let alatesM = 0;
  let abroad = 0;
  let onPage = 0;
  let hunger = 0;
  let pop = 0;
  for (let s = 0; s < a.count; s++) {
    if (!a.alive[s]) continue;
    pop++;
    hunger += a.hunger[s];
    tasks[a.task[s]]++;
    const c = a.caste[s];
    if (c === Caste.Worker) {
      workers++;
      roles[a.role[s]]++;
    } else if (c === Caste.Soldier) soldiers++;
    else if (c === Caste.AlateF) alatesF++;
    else if (c === Caste.AlateM) alatesM++;
    if (a.where[s] === 1) onPage++;
    else if (a.y[s] < surfaceRow(sim.world, a.x[s])) abroad++;
  }
  let eggs = 0;
  let larvae = 0;
  let pupae = 0;
  const b = sim.brood;
  for (let k = 0; k < b.count; k++) {
    if (!b.alive[k]) continue;
    if (b.stage[k] === Stage.Egg) eggs++;
    else if (b.stage[k] === Stage.Larva) larvae++;
    else pupae++;
  }
  let midden = 0;
  const pt = sim.world.pileType;
  for (let i = 0; i < pt.length; i++) if (pt[i] === 2) midden += sim.world.pileAmt[i];
  let lettersOut = 0;
  let lettersStored = 0;
  for (const l of sim.letters.values()) {
    lettersOut++;
    if (l.state === 2) lettersStored++;
  }
  let deepest = 0;
  const w = sim.world;
  for (let y = sim.H - 1; y > 0 && !deepest; y--) {
    for (let x = 0; x < sim.W; x++) {
      if (w.walk[y * sim.W + x] && y > w.ground[x]) {
        deepest = y - 84;
        break;
      }
    }
  }
  const env = sim.env;
  return {
    tick: sim.tick,
    envNow: sim.envNow,
    foundedAt: sim.foundedAt,
    colonyDay: sim.colonyDay,
    population: pop,
    workers,
    soldiers,
    alatesF,
    alatesM,
    queenAlive: sim.queen >= 0 && a.alive[sim.queen] === 1,
    roles,
    tasks,
    abroad,
    onPage,
    eggs,
    larvae,
    pupae,
    stores: Math.round(sim.storeLoads()),
    surfaceFood: sim.foods.reduce((s, f) => s + f.amount, 0),
    sources: sim.foods.filter((f) => f.kind !== FoodKind.Seed).map((f) => ({ kind: f.kind, amount: f.amount, initial: f.initial, offered: f.offered })),
    births: sim.births,
    deaths: sim.deaths,
    deathsByCause: sim.deathsByCause.slice(),
    flights: sim.flightsTotal,
    flown: sim.flownTotal,
    chambers: sim.chamberCount,
    volume: sim.world.volume,
    tunnelFeet: (sim.world.volume * CELL_MM) / 304.8,
    deepestInches: (deepest * CELL_MM) / 25.4,
    midden,
    lettersOut,
    lettersStored,
    lettersTakenTotal: sim.lettersTakenTotal,
    alarm: sim.alarmLevel(),
    hungerMean: pop ? hunger / pop : 0,
    starving: sim.starving,
    flightActive: sim.flightActive,
    flood: sim.floodCells,
    gapFound: sim.gapFound,
    foodGathered: sim.foodGathered,
    eggsLaid: sim.eggsLaid,
    env: {
      localHour: env.localHour,
      season: env.season,
      daylight: env.daylight,
      rain: env.rain,
      surfaceTemp: env.surfaceTemp,
      pressure: env.pressure,
      moonPhase: env.moonPhase,
      lampLit: env.lampLit,
      sunAltitude: env.sunAltitude,
      flightWeather: env.flightWeather,
      warmth: env.warmth,
    },
    offersLeft: Math.max(0, OFFERS_PER_VISIT - sim.offersThisVisit),
  };
}

export function nowFacts(sim: Simulation, c: Census): NowFacts {
  // Which source has the most foragers remembering it?
  const counts = new Map<number, number>();
  const a = sim.ants;
  for (let s = 0; s < a.count; s++) if (a.alive[s] && a.memKind[s] >= 0) counts.set(a.memKind[s], (counts.get(a.memKind[s]) ?? 0) + 1);
  let trailTo: number | null = null;
  let best = 5;
  for (const [id, n] of counts) {
    const src = sim.foods.find((f) => f.id === id);
    if (src && n > best) {
      best = n;
      trailTo = src.kind;
    }
  }
  return {
    localHour: c.env.localHour,
    season: c.env.season,
    rain: c.env.rain,
    daylight: c.env.daylight,
    population: c.population,
    abroad: c.abroad,
    onPage: c.onPage,
    foragers: c.tasks[Task.Forage],
    nurses: c.tasks[Task.Nurse] + c.tasks[Task.Attend],
    diggers: c.tasks[Task.Dig],
    resting: c.tasks[Task.Rest],
    eggs: c.eggs,
    larvae: c.larvae,
    pupae: c.pupae,
    stores: c.stores,
    alarm: c.alarm,
    starving: c.starving,
    flightActive: c.flightActive,
    flood: c.flood,
    trailTo,
    lampLit: c.env.lampLit,
    lettersOut: c.lettersOut,
  };
}

export interface SpecimenData {
  serial: number;
  alive: boolean;
  caste: number;
  role: number;
  task: number;
  carry: number;
  ageSeconds: number;
  hunger: number;
  fatigue: number;
  loads: number;
  dug: number;
  distanceMm: number;
  fedLarvae: number;
  bore: number;
  letters: number;
  foundFood: boolean;
  escaped: boolean;
  onPage: boolean;
  zone: string;
  x: number;
  y: number;
  history: HistoryEntry[];
  bornMinutes: number;
  death?: { cause: number; at: number; bearer: number };
}

export function readSpecimen(sim: Simulation, serial: number): SpecimenData | null {
  const s = sim.findSlotBySerial(serial);
  const a = sim.ants;
  if (s < 0) {
    const d = sim.dead.find((r) => r.serial === serial);
    if (!d) return null;
    return {
      serial,
      alive: false,
      caste: d.caste,
      role: Role.Reserve,
      task: Task.Rest,
      carry: Carry.None,
      ageSeconds: 0,
      hunger: 0,
      fatigue: 0,
      loads: d.lifeLoads,
      dug: 0,
      distanceMm: d.lifeDist * CELL_MM,
      fedLarvae: 0,
      bore: 0,
      letters: 0,
      foundFood: false,
      escaped: false,
      onPage: false,
      zone: "",
      x: 0,
      y: 0,
      history: [],
      bornMinutes: d.bornMinutes,
      death: { cause: d.cause, at: d.diedAt, bearer: d.bearer },
    };
  }
  const page = a.where[s] === 1 ? sim.pageAnts.find((p) => p.slot === s) : undefined;
  return {
    serial,
    alive: true,
    caste: a.caste[s],
    role: a.role[s],
    task: a.task[s],
    carry: page?.carrying ? Carry.Letter : a.carry[s],
    ageSeconds: sim.colonyTime - a.birth[s],
    hunger: a.hunger[s],
    fatigue: a.fatigue[s],
    loads: a.loads[s],
    dug: a.dug[s],
    distanceMm: a.dist[s] * CELL_MM,
    fedLarvae: a.fedLarvae[s],
    bore: a.bore[s],
    letters: a.letters[s],
    foundFood: (a.traits[s] & 2) !== 0,
    escaped: (a.traits[s] & 4) !== 0,
    onPage: a.where[s] === 1,
    zone: a.where[s] === 1 ? "page" : zoneOfRow(a.y[s]),
    x: a.x[s],
    y: a.y[s],
    history: readHistory(a, s),
    bornMinutes: sim.minutesAt(a.birth[s]),
  };
}
