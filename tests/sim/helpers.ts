import { foundColony } from "@/sim/founding";
import { placeFromTimeZone } from "@/sim/environment";
import type { Simulation } from "@/sim/sim";

/** Noon on a late-September weekday in London: daylight, mild, dry by default. */
export const NOON = Date.UTC(2026, 8, 23, 11, 0);
export const LONDON = placeFromTimeZone("Europe/London", 60);

export function colony(seed = 7, opts: Partial<Parameters<typeof foundColony>[0]> = {}): Simulation {
  return foundColony({
    seed,
    deviceClass: "small",
    now: NOON,
    place: LONDON,
    weatherOverride: "dry",
    popCap: 500,
    ...opts,
  });
}

export function run(sim: Simulation, seconds: number) {
  const steps = Math.round(seconds * 20);
  for (let i = 0; i < steps; i++) sim.step();
}

export function collect(sim: Simulation, seconds: number) {
  const events: Simulation["events"] = [];
  const steps = Math.round(seconds * 20);
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (sim.events.length) {
      events.push(...sim.events);
      sim.events = [];
    }
  }
  return events;
}
