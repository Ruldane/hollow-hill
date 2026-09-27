/**
 * Dr. Vance's voice. A small template grammar that turns simulation events
 * into notebook entries. It is pure (no DOM) so the worker can also write the
 * "while you were away" entry into the colony's saved record.
 *
 * Style rules: plain Victorian observation, first person, no scientific claims
 * presented as fact, no em-dashes.
 */
import { CARRY_NAMES, DEATH_NAMES, FOOD_NAMES, Stage } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { AbsenceReport } from "../sim/catchup";

export interface Note {
  id: number;
  text: string;
  /** Local time the note refers to (ms). */
  at: number;
  /** 1 minor, 2 notable, 3 remarkable. */
  weight: number;
  kind: SimEvent["type"] | "absence" | "summary";
}

export interface NoteContext {
  now: number;
  localHour: number;
  stores: number;
  population: number;
  chambers: number;
  random: () => number;
}

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export function numberWords(n: number, capital = false): string {
  let s: string;
  const r = Math.round(n);
  if (r <= 12) s = SMALL[Math.max(0, r)];
  else if (r < 20) s = String(r);
  else if (r < 100) s = `some ${Math.round(r / 10) * 10}`;
  else if (r < 1000) s = `some ${Math.round(r / 10) * 10}`;
  else s = `above ${Math.floor(r / 500) * 500}`;
  return capital ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function clockPhrase(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const names = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
  let hh = h % 12;
  let prefix: string;
  if (m < 8) prefix = "";
  else if (m < 23) prefix = "a quarter past ";
  else if (m < 38) prefix = "half past ";
  else if (m < 53) {
    prefix = "a quarter to ";
    hh = (hh + 1) % 12;
  } else {
    prefix = "";
    hh = (hh + 1) % 12;
  }
  const hourEnd = m >= 38 ? h + 1 : h;
  const onTheHour = m < 8 || m >= 53;
  if (onTheHour && hourEnd % 24 === 0) return "midnight";
  if (onTheHour && hourEnd === 12) return "noon";
  const part =
    hourEnd === 12
      ? ""
      : hourEnd < 5 || hourEnd >= 24
        ? " in the small hours"
        : hourEnd < 12
          ? " in the morning"
          : hourEnd < 18
            ? " in the afternoon"
            : " in the evening";
  const base = `${prefix}${names[hh]}`;
  return `${base}${part}`;
}

export function durationPhrase(ms: number): string {
  const min = ms / 60000;
  if (min < 90) return `${numberWords(Math.max(1, Math.round(min)))} minute${Math.round(min) === 1 ? "" : "s"}`;
  const hours = min / 60;
  if (hours < 36) return `${numberWords(Math.round(hours))} hours`;
  const days = hours / 24;
  if (days < 14) return `${numberWords(Math.round(days))} days`;
  const weeks = days / 7;
  if (weeks < 9) return `${numberWords(Math.round(weeks))} weeks`;
  return `${numberWords(Math.round(days / 30))} months`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const q = (ch: string) => `‘${ch}’`;
const no = (serial: number) => `No. ${serial}`;

const FOOD_PLAIN = ["a seed", "the honey", "the beetle", "the crust", "the crumb"];
const FOOD_A = ["a seed", "a drop of honey", "a dead beetle", "a crust of bread", "a crumb of cake"];

type Template = (e: never, c: NoteContext) => string | null;

const T: Partial<Record<SimEvent["type"], { weight: number; gap: number; variants: Template[] }>> = {
  "food-found": {
    weight: 2,
    gap: 20,
    variants: [
      ((e: Extract<SimEvent, { type: "food-found" }>) => `A scout, ${no(e.serial)}, has found ${FOOD_PLAIN[e.kind]}.`) as Template,
      ((e: Extract<SimEvent, { type: "food-found" }>, c: NoteContext) =>
        `${cap(clockPhrase(c.localHour))}: ${no(e.serial)} came upon ${FOOD_PLAIN[e.kind]}. She did not linger over it but turned for home at once.`) as Template,
      ((e: Extract<SimEvent, { type: "food-found" }>) =>
        `${no(e.serial)} has discovered ${FOOD_PLAIN[e.kind]}. I watched her touch it with her antennae, twice, and hurry off.`) as Template,
    ],
  },
  trail: {
    weight: 3,
    gap: 60,
    variants: [
      ((e: Extract<SimEvent, { type: "trail" }>) => `Within the hour the trail to ${FOOD_PLAIN[e.kind]} was a road.`) as Template,
      ((e: Extract<SimEvent, { type: "trail" }>) =>
        `${cap(numberWords(e.foragers))} foragers now keep the path to ${FOOD_PLAIN[e.kind]}. One could almost draw it with a rule.`) as Template,
      ((e: Extract<SimEvent, { type: "trail" }>) =>
        `The way to ${FOOD_PLAIN[e.kind]} is laid down. They go out light and come back heavy, and no one told them where.`) as Template,
    ],
  },
  "food-exhausted": {
    weight: 2,
    gap: 40,
    variants: [
      ((e: Extract<SimEvent, { type: "food-exhausted" }>) =>
        `${cap(FOOD_PLAIN[e.kind])} is finished. The trail outlasts it; for a while they follow it out to nothing.`) as Template,
      ((e: Extract<SimEvent, { type: "food-exhausted" }>) => `Nothing left of ${FOOD_PLAIN[e.kind]} but the stain on the earth.`) as Template,
    ],
  },
  "food-offered": {
    weight: 1,
    gap: 0,
    variants: [
      ((e: Extract<SimEvent, { type: "food-offered" }>) => `I have set down ${FOOD_A[e.kind]} upon the surface. We shall see who finds it.`) as Template,
      ((e: Extract<SimEvent, { type: "food-offered" }>) => `${cap(FOOD_A[e.kind])}, placed with the forceps. Now to wait.`) as Template,
    ],
  },
  "food-fell": {
    weight: 1,
    gap: 120,
    variants: [
      ((e: Extract<SimEvent, { type: "food-fell" }>) =>
        e.kind === 2
          ? "A beetle lies dead upon the surface. I did not see it fall."
          : `${cap(FOOD_A[e.kind])} on the grass. Brushed from the bench, I suppose; I take the blame.`) as Template,
    ],
  },
  death: {
    weight: 1,
    gap: 150,
    variants: [
      ((e: Extract<SimEvent, { type: "death" }>) =>
        e.caste === 2
          ? "The queen is dead. I do not know what the colony will do."
          : `${no(e.serial)} is dead, of ${DEATH_NAMES[e.cause]}.`) as Template,
      ((e: Extract<SimEvent, { type: "death" }>) =>
        e.cause === 0 ? `${no(e.serial)} has died, worn out, I think. Her legs had been failing since morning.` : null) as Template,
      ((e: Extract<SimEvent, { type: "death" }>, c: NoteContext) =>
        e.cause === 1 ? `${no(e.serial)} has died of hunger. The stores stand at ${numberWords(c.stores)} loads.` : null) as Template,
    ],
  },
  "corpse-carried": {
    weight: 2,
    gap: 150,
    variants: [
      ((e: Extract<SimEvent, { type: "corpse-carried" }>) => `${no(e.bearer)} carried ${no(e.dead)} to the midden. The dead are not left lying here.`) as Template,
      ((e: Extract<SimEvent, { type: "corpse-carried" }>) =>
        `${no(e.dead)} has been taken away by ${no(e.bearer)}, to the heap where they put the husks and the dead.`) as Template,
      ((e: Extract<SimEvent, { type: "corpse-carried" }>) =>
        `A bearer, ${no(e.bearer)}, with ${no(e.dead)} in her jaws. She walks as if it weighed nothing, which it nearly does.`) as Template,
    ],
  },
  "midden-founded": {
    weight: 3,
    gap: 0,
    variants: [(() => "They have begun a midden. The dead go there, and the husks of seeds, and nothing else.") as Template],
  },
  eclosion: {
    weight: 1,
    gap: 240,
    variants: [
      ((e: Extract<SimEvent, { type: "eclosion" }>) =>
        e.caste === 1
          ? `A soldier has emerged, ${no(e.serial)}. The great head is unmistakable.`
          : e.caste >= 3
            ? `A winged one has come out of the cocoon, ${no(e.serial)}. The wings are crumpled still.`
            : `A new worker, ${no(e.serial)}, has come out of her cocoon, pale as paper. She will darken in a day.`) as Template,
      ((e: Extract<SimEvent, { type: "eclosion" }>) =>
        e.caste === 0 ? `The nurses helped ${no(e.serial)} out of her silk. I have given her a number; she has given me nothing.` : null) as Template,
    ],
  },
  "alates-emerged": {
    weight: 2,
    gap: 600,
    variants: [
      (() => "More winged ones among the brood. Males, and queens that are not yet queens. They do no work; they wait.") as Template,
      (() => "The winged ones grow in number. The workers feed them and step around them, like servants round a guest.") as Template,
    ],
  },
  "flight-begin": {
    weight: 3,
    gap: 0,
    variants: [
      ((e: Extract<SimEvent, { type: "flight-begin" }>) =>
        `The winged ones are restless. ${cap(numberWords(e.count))} of them are coming up through the galleries toward the light.`) as Template,
      (() => "Something is happening below: the winged ones are climbing, and the workers are hurrying them up the shaft.") as Template,
    ],
  },
  flight: {
    weight: 3,
    gap: 0,
    variants: [
      ((e: Extract<SimEvent, { type: "flight" }>) =>
        `They are going. The winged ones climb the grass and are gone into the evening: ${numberWords(e.females)} queens, ${numberWords(e.males)} males.`) as Template,
      ((e: Extract<SimEvent, { type: "flight" }>, c: NoteContext) =>
        `The flight, at ${clockPhrase(c.localHour)}. ${cap(numberWords(e.count))} rose from the mound. I opened the window for them.`) as Template,
    ],
  },
  "rain-begin": {
    weight: 2,
    gap: 300,
    variants: [
      (() => "Rain on the window. The surface darkens by degrees.") as Template,
      (() => "Rain. The foragers came in before the first drops; I cannot say how they knew.") as Template,
    ],
  },
  "rain-end": {
    weight: 1,
    gap: 300,
    variants: [(() => "The rain has stopped. The earth steams a little under the lamp.") as Template],
  },
  flood: {
    weight: 3,
    gap: 300,
    variants: [
      (() => "The water has found the entrance and run down into the galleries.") as Template,
      (() => "Flooding in the upper galleries. They are moving everything that can be moved.") as Template,
    ],
  },
  "brood-rescue": {
    weight: 3,
    gap: 120,
    variants: [
      ((e: Extract<SimEvent, { type: "brood-rescue" }>) =>
        `The nurses are carrying the brood down out of the wet. ${no(e.serial)} has ${e.stage === Stage.Egg ? "an egg" : e.stage === Stage.Larva ? "a larva" : "a pupa"} in her jaws.`) as Template,
      (() => "Rescue. Every nurse with something in her mouth, all going down.") as Template,
    ],
  },
  "cave-in": {
    weight: 3,
    gap: 30,
    variants: [
      ((e: Extract<SimEvent, { type: "cave-in" }>) =>
        e.lost > 0
          ? `A fall of earth in ${e.region}. ${cap(numberWords(e.lost))} ${e.lost === 1 ? "worker" : "workers"} lost.`
          : `Part of the ceiling in ${e.region} has come down. None were caught, I think.`) as Template,
      ((e: Extract<SimEvent, { type: "cave-in" }>) =>
        e.lost > 0 ? `${cap(e.region)} has collapsed. I count ${numberWords(e.lost)} under it. The diggers are already at the rubble.` : null) as Template,
    ],
  },
  alarm: {
    weight: 2,
    gap: 20,
    variants: [
      (() => "I tapped the glass. The alarm spread from the place like ink in water, and then faded.") as Template,
      (() => "At the knock the soldiers came up out of the galleries, jaws open, looking for whoever did it.") as Template,
      (() => "Another knock. I should stop. They run from the place for a minute and then forget.") as Template,
    ],
  },
  "new-chamber": {
    weight: 2,
    gap: 120,
    variants: [
      ((e: Extract<SimEvent, { type: "new-chamber" }>) => `A new chamber in ${e.region}. That makes ${numberWords(e.count)}.`) as Template,
      ((e: Extract<SimEvent, { type: "new-chamber" }>) => `They have opened a room in ${e.region}. No one drew the plan.`) as Template,
    ],
  },
  "gap-found": {
    weight: 3,
    gap: 0,
    variants: [
      ((e: Extract<SimEvent, { type: "gap-found" }>) =>
        `${no(e.serial)} has found the fault in the frame, by the brass on the eastern side. I had thought it sealed.`) as Template,
    ],
  },
  escape: {
    weight: 2,
    gap: 90,
    variants: [
      ((e: Extract<SimEvent, { type: "escape" }>) => `${no(e.serial)} is out upon the page.`) as Template,
      ((e: Extract<SimEvent, { type: "escape" }>) => `Another has come out through the frame, ${no(e.serial)}. She walks the margin as if it were a trail.`) as Template,
      (() => "One more on the paper. They are drawn to my notes. It is the gum in the ink, I think; it is sweet.") as Template,
    ],
  },
  "letter-taken": {
    weight: 3,
    gap: 25,
    variants: [
      ((e: Extract<SimEvent, { type: "letter-taken" }>) => `${no(e.serial)} has taken the letter ${q(e.ch)} from my notes. I cannot think what she wants with it.`) as Template,
      ((e: Extract<SimEvent, { type: "letter-taken" }>) => `The letter ${q(e.ch)} is gone from the page. I watched her lift it.`) as Template,
      (() => "They are carrying off my words one letter at a time.") as Template,
      ((e: Extract<SimEvent, { type: "letter-taken" }>) => `${q(e.ch)}, taken. The word it belonged to limps on without it.`) as Template,
    ],
  },
  "letter-stored": {
    weight: 2,
    gap: 60,
    variants: [
      ((e: Extract<SimEvent, { type: "letter-stored" }>) => `The ${q(e.ch)} has been laid down in the store among the seeds.`) as Template,
      ((e: Extract<SimEvent, { type: "letter-stored" }>) => `${no(e.serial)} took the ${q(e.ch)} underground and stacked it with the food.`) as Template,
    ],
  },
  "letters-restored": {
    weight: 2,
    gap: 0,
    variants: [((e: Extract<SimEvent, { type: "letters-restored" }>) => `I have restored the notebook. ${cap(numberWords(e.count))} letters returned from the store.`) as Template],
  },
  starving: {
    weight: 3,
    gap: 600,
    variants: [(() => "The stores are empty. The foragers go farther; the queen has stopped laying.") as Template],
  },
  recovered: {
    weight: 2,
    gap: 600,
    variants: [(() => "Food in the store again. The colony eats, and the queen resumes.") as Template],
  },
  "egg-eaten": {
    weight: 2,
    gap: 900,
    variants: [(() => "The nurses have eaten some of the eggs. I record it without comment.") as Template],
  },
  dawn: {
    weight: 1,
    gap: 3600,
    variants: [
      (() => "Dawn. The first foragers are already at the entrance.") as Template,
      (() => "Light. They come up as it comes up.") as Template,
    ],
  },
  dusk: {
    weight: 1,
    gap: 3600,
    variants: [
      (() => "Dusk. I have lit the lamp. The foragers come in; the nurses do not rest.") as Template,
      (() => "Evening. The surface empties and the nursery glows under the lamp.") as Template,
    ],
  },
  "queen-laid": {
    weight: 1,
    gap: 900,
    variants: [
      (() => "The queen has laid again. The attendants took the eggs away before I could count them.") as Template,
      (() => "Eggs. She lays without seeming to notice, and they are gone at once.") as Template,
    ],
  },
};

export class Notebook {
  private lastByType = new Map<string, number>();
  private lastVariant = new Map<string, number>();
  private nextId = 1;

  /** Turn an event into a note, or null when it would be repetitive or too soon. */
  compose(e: SimEvent, c: NoteContext): Note | null {
    const spec = T[e.type];
    if (!spec) return null;
    const last = this.lastByType.get(e.type) ?? -Infinity;
    if ((c.now - last) / 1000 < spec.gap) return null;
    const n = spec.variants.length;
    const prev = this.lastVariant.get(e.type) ?? -1;
    for (let attempt = 0; attempt < n * 2; attempt++) {
      let k = Math.floor(c.random() * n);
      if (n > 1 && k === prev) k = (k + 1) % n;
      const text = (spec.variants[k] as (e: SimEvent, c: NoteContext) => string | null)(e, c);
      if (!text) continue;
      this.lastByType.set(e.type, c.now);
      this.lastVariant.set(e.type, k);
      return { id: this.nextId++, text, at: c.now, weight: spec.weight, kind: e.type };
    }
    return null;
  }
}

/** The entry for a return visit. */
export function absenceEntry(r: AbsenceReport): string {
  const parts: string[] = [`Absent ${durationPhrase(r.elapsedMs)}.`];
  if (r.flights.length) {
    const n = r.flights.reduce((s, f) => s + f.count, 0);
    parts.push(`The winged ones flew while you were gone, ${numberWords(n)} of them.`);
  }
  const newCh = r.newChambers.length;
  if (newCh > 0) {
    parts.push(newCh === 1 ? `A new chamber, in ${r.newChambers[0]}.` : `${cap(numberWords(newCh))} new chambers.`);
  } else if (r.cellsDug > 150) {
    parts.push("The galleries are longer.");
  }
  if (r.deepestRow > r.deepestBefore + 3) parts.push("They have dug deeper.");
  const falls = r.collapses.filter((c) => c.lost > 0);
  if (falls.length) {
    const worst = falls.sort((p, q2) => q2.lost - p.lost)[0];
    parts.push(`${cap(worst.region)} collapsed after rain; ${numberWords(worst.lost)} ${worst.lost === 1 ? "worker" : "workers"} lost.`);
  } else if (r.collapses.length) {
    parts.push(`A small fall of earth in ${r.collapses[0].region}, after rain.`);
  } else if (r.rainyHours > 1.5) {
    parts.push("It rained, and the mound is washed lower.");
  }
  const born = r.births;
  const died = r.deaths.age + r.deaths.starvation + r.deaths.drowned + r.deaths.abroad;
  if (born > 0 || died > 0) {
    const b = born > 0 ? `${cap(numberWords(born))} born` : "None born";
    const d = died > 0 ? `${numberWords(died)} dead` : "none dead";
    const why = r.deaths.starvation > died * 0.4 && r.deaths.starvation > 2 ? " of hunger" : died > 0 ? ", most of age" : "";
    parts.push(`${b}, ${d}${why}.`);
  }
  if (r.storesAfter < 5) parts.push("The stores are empty.");
  else if (r.storesAfter > r.storesBefore * 1.4 && r.storesAfter > 40) parts.push("The stores are fuller than I left them.");
  if (parts.length === 1) parts.push("Little has changed. They kept on without me.");
  return parts.join(" ");
}

export interface NowFacts {
  localHour: number;
  season: string;
  rain: number;
  daylight: number;
  population: number;
  abroad: number;
  onPage: number;
  foragers: number;
  nurses: number;
  diggers: number;
  resting: number;
  eggs: number;
  larvae: number;
  pupae: number;
  stores: number;
  alarm: number;
  starving: boolean;
  flightActive: boolean;
  flood: number;
  trailTo: number | null;
  lampLit: boolean;
  lettersOut: number;
}

/** The on-demand answer to "What is happening now?". */
export function nowSummary(f: NowFacts): string {
  const out: string[] = [];
  const weather = f.rain > 0.05 ? "and raining" : f.daylight > 0.5 ? "and dry" : "and dark";
  out.push(`It is ${clockPhrase(f.localHour)}, ${f.season}, ${weather}.`);
  out.push(
    `The colony numbers ${numberWords(f.population)}. ${cap(numberWords(f.abroad))} ${f.abroad === 1 ? "is" : "are"} abroad on the surface${f.trailTo !== null ? `, most on the trail to ${FOOD_PLAIN[f.trailTo]}` : ""}.`,
  );
  out.push(
    `${cap(numberWords(f.nurses))} nurses keep the brood: ${numberWords(f.eggs)} eggs, ${numberWords(f.larvae)} larvae and ${numberWords(f.pupae)} pupae. ${cap(numberWords(f.diggers))} are digging and ${numberWords(f.resting)} resting.`,
  );
  if (f.flightActive) out.push("The winged ones are leaving the nest for their flight.");
  if (f.flood > 0) out.push("There is water in the upper galleries and the nurses are moving the brood.");
  if (f.alarm > 5) out.push("There is alarm in the nest; the soldiers are up.");
  if (f.onPage > 0) out.push(`${cap(numberWords(f.onPage))} ${f.onPage === 1 ? "is" : "are"} out on the page among my notes.`);
  if (f.lettersOut > 0) out.push(`They hold ${numberWords(f.lettersOut)} of my letters.`);
  out.push(f.starving ? "The stores are empty." : `The stores hold ${numberWords(f.stores)} loads.`);
  return out.join(" ");
}

export function carryPhrase(carry: number): string {
  return CARRY_NAMES[carry] ?? "nothing";
}

export function foodName(kind: number): string {
  return FOOD_NAMES[kind] ?? "food";
}
