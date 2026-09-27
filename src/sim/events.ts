/**
 * Things that happen. The simulation emits these; the notebook grammar turns
 * them into Dr. Vance's live annotations, and the specimen card and census
 * read them too. Nothing here is scripted: each event is raised by the rule
 * that caused it.
 */
export type SimEvent =
  | { type: "food-found"; serial: number; kind: number; source: number; x: number }
  | { type: "trail"; source: number; kind: number; foragers: number }
  | { type: "food-exhausted"; kind: number; offered: boolean }
  | { type: "food-offered"; kind: number; x: number }
  | { type: "food-fell"; kind: number; x: number }
  | { type: "death"; serial: number; caste: number; cause: number; x: number; y: number; zone: string }
  | { type: "corpse-carried"; dead: number; bearer: number }
  | { type: "midden-founded"; x: number; y: number }
  | { type: "eclosion"; serial: number; caste: number }
  | { type: "alates-emerged"; count: number }
  | { type: "flight-begin"; count: number }
  | { type: "flight"; count: number; females: number; males: number }
  | { type: "rain-begin"; intensity: number }
  | { type: "rain-end" }
  | { type: "flood"; zone: string; cells: number }
  | { type: "brood-rescue"; serial: number; stage: number }
  | { type: "cave-in"; x: number; y: number; lost: number; region: string }
  | { type: "alarm"; x: number; y: number; source: "knock" | "chain" }
  | { type: "new-chamber"; x: number; y: number; region: string; count: number }
  | { type: "gap-found"; serial: number }
  | { type: "escape"; serial: number }
  | { type: "letter-taken"; serial: number; key: string; ch: string }
  | { type: "letter-stored"; serial: number; key: string; ch: string }
  | { type: "letters-restored"; count: number }
  | { type: "starving" }
  | { type: "recovered" }
  | { type: "egg-eaten"; count: number }
  | { type: "dawn" }
  | { type: "dusk" }
  | { type: "queen-laid"; count: number };

export type SimEventType = SimEvent["type"];
