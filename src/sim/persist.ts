/**
 * Snapshots: the colony's persisted state, versioned. Typed arrays are kept as
 * typed arrays so IndexedDB stores them by structured clone without copying
 * through JSON. Scent (pheromone) is not saved: it would have evaporated.
 */
import { SCHEMA_VERSION, type DeviceClass } from "./constants";
import type { Corpse, DeadRecord, FoodSource, LetterItem } from "./colony";
import type { Place, WeatherOverride } from "./environment";
import { Rng } from "./rng";
import { Simulation, type AbsenceNote, type Visit } from "./sim";
import { createEmptyWorld, refreshAllWalk } from "./world";

export interface Snapshot {
  schema: number;
  savedAt: number;
  seed: number;
  deviceClass: DeviceClass;
  popCap: number;
  W: number;
  H: number;
  tick: number;
  colonyTime: number;
  foundedAt: number;
  rng: [number, number, number, number];
  world: {
    soil: Uint8Array;
    ground: Int16Array;
    pileType: Uint8Array;
    pileAmt: Uint8Array;
    moisture: Uint8Array;
    water: Uint8Array;
    entranceX: number;
  };
  ants: Record<string, ArrayLike<number>> & { count: number; free: number[]; nextSerial: number };
  brood: Record<string, ArrayLike<number>> & { count: number; free: number[] };
  queen: number;
  foods: FoodSource[];
  corpses: Corpse[];
  letters: LetterItem[];
  dead: DeadRecord[];
  visits: Visit[];
  absenceNotes: AbsenceNote[];
  scalars: Record<string, number | boolean>;
  chamberCentres: { x: number; y: number }[];
}

const ANT_FIELDS = [
  "alive",
  "gen",
  "x",
  "y",
  "heading",
  "caste",
  "task",
  "sub",
  "role",
  "carry",
  "carryRef",
  "birth",
  "lifespan",
  "hunger",
  "fatigue",
  "crop",
  "serial",
  "loads",
  "dug",
  "dist",
  "fedLarvae",
  "bore",
  "letters",
  "timer",
  "alarm",
  "speedK",
  "traits",
  "memX",
  "memY",
  "memKind",
  "where",
  "starve",
  "wet",
  "stuck",
  "histHead",
] as const;

const BROOD_FIELDS = ["alive", "x", "y", "stage", "age", "fed", "alate", "carriedBy", "hungry"] as const;

const SCALARS = [
  "feedPool",
  "eggsDue",
  "nextFoodId",
  "nextCorpseId",
  "nextWindfall",
  "seedDue",
  "lastFlightDay",
  "flightsTotal",
  "flownTotal",
  "births",
  "deaths",
  "eggsLaid",
  "foodGathered",
  "lettersTakenTotal",
  "knocks",
  "chamberCount",
  "storeSeed",
  "middenSeed",
  "gapFound",
  "starving",
] as const;

type Typed = Uint8Array | Int16Array | Int32Array | Uint16Array | Uint32Array | Float32Array | Float64Array;

export function serialize(sim: Simulation): Snapshot {
  const a = sim.ants as unknown as Record<string, Typed>;
  const ants: Record<string, ArrayLike<number>> = {};
  const n = sim.ants.count;
  for (const f of ANT_FIELDS) ants[f] = a[f].slice(0, n);
  const HL = sim.ants.hist.length / sim.ants.cap;
  ants.hist = sim.ants.hist.slice(0, n * HL);

  const b = sim.brood as unknown as Record<string, Typed>;
  const brood: Record<string, ArrayLike<number>> = {};
  for (const f of BROOD_FIELDS) brood[f] = b[f].slice(0, sim.brood.count);

  const scalars: Record<string, number | boolean> = {};
  const simRec = sim as unknown as Record<string, number | boolean>;
  for (const k of SCALARS) scalars[k] = simRec[k];
  sim.deathsByCause.forEach((v, i) => (scalars[`deathsByCause${i}`] = v));

  // Pull any in-flight page ants back into their slots so the snapshot is whole.
  const pageSlots = new Set(sim.pageAnts.map((p) => p.slot));
  const where = ants.where as Uint8Array;
  for (const s of pageSlots) if (s < n) where[s] = 0;

  return {
    schema: SCHEMA_VERSION,
    savedAt: sim.envNow,
    seed: sim.seed,
    deviceClass: sim.deviceClass,
    popCap: sim.popCap,
    W: sim.W,
    H: sim.H,
    tick: sim.tick,
    colonyTime: sim.colonyTime,
    foundedAt: sim.foundedAt,
    rng: sim.rng.state(),
    world: {
      soil: sim.world.soil.slice(),
      ground: sim.world.ground.slice(),
      pileType: sim.world.pileType.slice(),
      pileAmt: sim.world.pileAmt.slice(),
      moisture: sim.world.moisture.slice(),
      water: sim.world.water.slice(),
      entranceX: sim.world.entranceX,
    },
    ants: Object.assign(ants, { count: n, free: sim.ants.free.slice(), nextSerial: sim.ants.nextSerial }),
    brood: Object.assign(brood, { count: sim.brood.count, free: sim.brood.free.slice() }),
    queen: sim.queen,
    foods: sim.foods.map((f) => ({ ...f })),
    corpses: sim.corpses.map((c) => ({ ...c })),
    letters: [...sim.letters.values()].map((l) => ({ ...l, state: l.state === 0 ? 2 : l.state })),
    dead: sim.dead.slice(-160),
    visits: sim.visits.slice(-60),
    absenceNotes: sim.absenceNotes.slice(-30),
    scalars,
    chamberCentres: sim.chamberCentres.slice(),
  };
}

export type RestoreResult = { ok: true; sim: Simulation } | { ok: false; reason: "schema" | "corrupt" };

export function deserialize(
  snap: Snapshot | null | undefined,
  opts: { place: Place; weatherOverride?: WeatherOverride; popCap?: number },
): RestoreResult {
  if (!snap || typeof snap !== "object") return { ok: false, reason: "corrupt" };
  if (snap.schema !== SCHEMA_VERSION) return { ok: false, reason: "schema" };
  try {
    const world = createEmptyWorld(snap.W, snap.H);
    world.soil.set(snap.world.soil);
    world.ground.set(snap.world.ground);
    world.pileType.set(snap.world.pileType);
    world.pileAmt.set(snap.world.pileAmt);
    world.moisture.set(snap.world.moisture);
    world.water.set(snap.world.water);
    world.entranceX = snap.world.entranceX;
    refreshAllWalk(world);

    const sim = new Simulation(
      {
        seed: snap.seed,
        deviceClass: snap.deviceClass,
        now: snap.savedAt,
        place: opts.place,
        weatherOverride: opts.weatherOverride ?? null,
        popCap: opts.popCap ?? snap.popCap,
      },
      world,
    );
    sim.foundedAt = snap.foundedAt;
    sim.tick = snap.tick;
    sim.colonyTime = snap.colonyTime;
    sim.rng = new Rng(snap.rng);

    const a = sim.ants as unknown as Record<string, Typed>;
    const n = Math.min(snap.ants.count, sim.ants.cap);
    for (const f of ANT_FIELDS) a[f].set(Array.prototype.slice.call(snap.ants[f], 0, n));
    const HL = sim.ants.hist.length / sim.ants.cap;
    sim.ants.hist.set(Array.prototype.slice.call(snap.ants.hist, 0, n * HL));
    sim.ants.count = n;
    sim.ants.free = snap.ants.free.filter((s) => s < n);
    sim.ants.nextSerial = snap.ants.nextSerial;
    for (let s = 0; s < n; s++) sim.ants.where[s] = 0;

    const b = sim.brood as unknown as Record<string, Typed>;
    const bn = Math.min(snap.brood.count, sim.brood.cap);
    for (const f of BROOD_FIELDS) b[f].set(Array.prototype.slice.call(snap.brood[f], 0, bn));
    sim.brood.count = bn;
    sim.brood.free = snap.brood.free.filter((s) => s < bn);

    sim.queen = snap.queen;
    sim.foods = snap.foods.map((f) => ({ ...f }));
    sim.corpses = snap.corpses.map((c) => ({ ...c, carriedBy: -1 }));
    // Anyone who was carrying a corpse sets it down on load.
    for (let s = 0; s < n; s++) if (sim.ants.carry[s] === 9) sim.ants.carry[s] = 0;
    sim.letters = new Map(snap.letters.map((l) => [l.key, { ...l }]));
    sim.dead = snap.dead.slice();
    sim.visits = snap.visits.slice();
    sim.absenceNotes = snap.absenceNotes.slice();
    const simRec = sim as unknown as Record<string, number | boolean>;
    for (const k of SCALARS) if (k in snap.scalars) simRec[k] = snap.scalars[k];
    for (let i = 0; i < sim.deathsByCause.length; i++) sim.deathsByCause[i] = Number(snap.scalars[`deathsByCause${i}`] ?? 0);
    sim.chamberCentres = snap.chamberCentres.slice();
    sim.refreshEnv();
    sim.rebuildAllFields();
    sim.computeBroodTargets();
    sim.rebuildAllFields();
    return { ok: true, sim };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}
