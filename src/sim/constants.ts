/**
 * Shared vocabulary of the colony. Everything here is plain data so the
 * simulation core stays headless: it runs in a Web Worker in the browser
 * and directly in Node for tests.
 */

export const SCHEMA_VERSION = 3;

/** Fixed simulation step. Rendering is decoupled and interpolates. */
export const TICK_HZ = 20;
export const DT = 1 / TICK_HZ;

/** One soil cell is two millimetres of earth, roughly one grain load. */
export const CELL_MM = 2;

/** World height is fixed; width depends on the device class at founding. */
export const WORLD_H = 720;

export const WORLD_WIDTHS = { large: 180, medium: 150, small: 100 } as const;
export type DeviceClass = keyof typeof WORLD_WIDTHS;

/** Population caps per device class (upper bound on adult ants). */
export const POP_CAPS: Record<DeviceClass, number> = { large: 3200, medium: 1900, small: 900 };

/** Rows (cells from the top of the world). */
export const ROW = {
  /** First soil row at founding; the ground rises locally as the mound grows. */
  ground: 84,
  /** How far above the ground the walkable litter band reaches. */
  band: 7,
  upperEnd: 262,
  stone1: 262,
  stone1End: 276,
  nurseryEnd: 468,
  stone2: 468,
  stone2End: 482,
  royalEnd: 648,
  bedrock: 648,
} as const;

export const ZONES = [
  { id: "surface", name: "The Surface", from: 0, to: ROW.ground },
  { id: "upper", name: "The Upper Galleries", from: ROW.ground, to: ROW.stone1End },
  { id: "nursery", name: "The Deep Nursery", from: ROW.stone1End, to: ROW.stone2End },
  { id: "royal", name: "The Royal Chamber", from: ROW.stone2End, to: ROW.bedrock },
  { id: "bedrock", name: "Bedrock", from: ROW.bedrock, to: WORLD_H },
] as const;
export type ZoneId = (typeof ZONES)[number]["id"];

export function zoneOfRow(y: number): ZoneId {
  for (const z of ZONES) if (y < z.to) return z.id;
  return "bedrock";
}

/** Soil materials. */
export const Mat = {
  Open: 0,
  Topsoil: 1,
  Sand: 2,
  Gravel: 3,
  Clay: 4,
  DeepClay: 5,
  Stone: 6,
  Bedrock: 7,
  Mound: 8,
  Rubble: 9,
  Root: 10,
  Stem: 11,
} as const;
export type Mat = (typeof Mat)[keyof typeof Mat];

/** Digging resistance per material (Infinity: cannot be dug). */
export const HARDNESS: readonly number[] = [0, 1, 0.8, 3, 1.8, 2.3, Infinity, Infinity, 0.5, 0.45, Infinity, Infinity];

export const Caste = {
  Worker: 0,
  Soldier: 1,
  Queen: 2,
  AlateF: 3,
  AlateM: 4,
} as const;
export type Caste = (typeof Caste)[keyof typeof Caste];

export const CASTE_NAMES = ["worker", "soldier", "queen", "winged female", "winged male"] as const;

export const Task = {
  Idle: 0,
  Rest: 1,
  Nurse: 2,
  Dig: 3,
  Forage: 4,
  Undertake: 5,
  Eat: 6,
  Patrol: 7,
  Flight: 8,
  Attend: 9,
  Queen: 10,
  Escaped: 11,
} as const;
export type Task = (typeof Task)[keyof typeof Task];

export const TASK_NAMES = [
  "idling",
  "resting",
  "nursing brood",
  "digging",
  "foraging",
  "bearing the dead",
  "feeding",
  "patrolling",
  "preparing to fly",
  "attending the queen",
  "laying",
  "abroad on the page",
] as const;

/** Worker roles, used for the census. Distinct from the moment-to-moment task. */
export const Role = {
  Nurse: 0,
  Digger: 1,
  Forager: 2,
  Reserve: 3,
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLE_NAMES = ["nurse", "digger", "forager", "reserve"] as const;

export const Carry = {
  None: 0,
  Grain: 1,
  Seed: 2,
  Honey: 3,
  Meat: 4,
  Crumb: 5,
  Egg: 6,
  Larva: 7,
  Pupa: 8,
  Corpse: 9,
  Letter: 10,
} as const;
export type Carry = (typeof Carry)[keyof typeof Carry];
export const CARRY_NAMES = [
  "nothing",
  "a grain of soil",
  "a seed",
  "a bead of honey",
  "a morsel of beetle",
  "a crumb",
  "an egg",
  "a larva",
  "a pupa",
  "a dead nestmate",
  "a letter",
] as const;

export const FoodKind = {
  Seed: 0,
  Honey: 1,
  Beetle: 2,
  Crust: 3,
  Crumb: 4,
} as const;
export type FoodKind = (typeof FoodKind)[keyof typeof FoodKind];
export const FOOD_NAMES = ["seed", "honey", "beetle", "crust", "crumb"] as const;
export const FOOD_CARRY: readonly Carry[] = [Carry.Seed, Carry.Honey, Carry.Meat, Carry.Crumb, Carry.Crumb];

export const Stage = { Egg: 0, Larva: 1, Pupa: 2 } as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

/** Cell piles: what lies on a chamber floor. */
export const Pile = { None: 0, Food: 1, Husk: 2 } as const;

export const DeathCause = {
  Age: 0,
  Starvation: 1,
  CaveIn: 2,
  Drowned: 3,
  Surface: 4,
  Flight: 5,
} as const;
export type DeathCause = (typeof DeathCause)[keyof typeof DeathCause];
export const DEATH_NAMES = ["old age", "hunger", "a cave-in", "drowning", "misadventure abroad", "the flight"] as const;

/** Life cycle timings, in seconds of colony time (compressed biology). */
export const LIFE = {
  egg: 15 * 60,
  larva: 32 * 60,
  pupa: 26 * 60,
  larvaFeeds: 3,
  workerLifespan: 38 * 3600,
  soldierLifespan: 46 * 3600,
  alateLifespan: 20 * 24 * 3600,
  queenLifespan: 20 * 365 * 24 * 3600,
  hungerPeriod: 2.6 * 3600,
  starveGrace: 25 * 60,
} as const;

/** Food units: one carried load feeds this many adult meals. */
export const FEEDS_PER_LOAD = 6;

/** Movement speed in cells per second. */
export const SPEED = { worker: 7, soldier: 6, queen: 0.6, alate: 5 } as const;

export const HISTORY_LEN = 10;

/** History event kinds written into each ant's compact log. */
export const Hist = {
  Born: 1,
  Role: 2,
  FoundFood: 3,
  Loads: 4,
  Dug: 5,
  CarriedDead: 6,
  RescuedBrood: 7,
  Escaped: 8,
  TookLetter: 9,
  Alarmed: 10,
  FedQueen: 11,
  SurvivedCaveIn: 12,
  Returned: 13,
  Absence: 14,
} as const;
