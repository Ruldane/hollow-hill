/**
 * While you were away.
 *
 * Advances the colony by real elapsed time without running every frame: a
 * coarse model with ten-minute steps (two-hour steps beyond a fortnight) that
 * reuses the live rules for brood, the queen, food falling, digging and
 * collapse, and treats foraging, feeding and death in aggregate. Its cost is
 * bounded by a fixed number of steps and a cap on cells dug.
 */
import { Carry, Caste, DeathCause, FEEDS_PER_LOAD, Hist, LIFE, Pile, ROW, Role, Stage, Task } from "./constants";
import { killBrood, logHistory } from "./colony";
import { coarseExcavate } from "./excavation";
import { clearField } from "./fields";
import type { Simulation } from "./sim";
import { FieldBuilder, addPile, isFloor, isWalkable } from "./world";

export interface AbsenceReport {
  elapsedMs: number;
  modelledMs: number;
  popBefore: number;
  popAfter: number;
  births: number;
  deaths: { age: number; starvation: number; caveIn: number; drowned: number; abroad: number };
  broodBefore: number;
  broodAfter: number;
  storesBefore: number;
  storesAfter: number;
  foodGathered: number;
  cellsDug: number;
  chambersBefore: number;
  chambersAfter: number;
  newChambers: string[];
  collapses: { region: string; lost: number; at: number }[];
  rainyHours: number;
  flights: { count: number; at: number }[];
  windfalls: number;
  deepestRow: number;
  deepestBefore: number;
  steps: number;
  computeMs: number;
}

const FORTNIGHT = 14 * 86_400_000;
const MAX_MODELLED = 30 * 86_400_000;
const MAX_DUG = 16_000;

export function catchUp(sim: Simulation, elapsedMs: number): AbsenceReport {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const a = sim.ants;
  const modelled = Math.max(0, Math.min(elapsedMs, MAX_MODELLED));
  const builder = new FieldBuilder(sim.W * sim.H);

  const before = sim.chamberPass(false);
  const report: AbsenceReport = {
    elapsedMs,
    modelledMs: modelled,
    popBefore: sim.population(),
    popAfter: 0,
    births: 0,
    deaths: { age: 0, starvation: 0, caveIn: 0, drowned: 0, abroad: 0 },
    broodBefore: sim.broodCount(),
    broodAfter: 0,
    storesBefore: Math.round(sim.storeLoads()),
    storesAfter: 0,
    foodGathered: 0,
    cellsDug: 0,
    chambersBefore: before.length,
    chambersAfter: 0,
    newChambers: [],
    collapses: [],
    rainyHours: 0,
    flights: [],
    windfalls: 0,
    deepestRow: 0,
    deepestBefore: deepestOpen(sim),
    steps: 0,
    computeMs: 0,
  };

  const deathsBefore = sim.deathsByCause.slice();
  const birthsBefore = sim.births;
  const gatheredPerAnt = new Map<number, number>();
  sim.events = [];

  let t = 0;
  while (t < modelled) {
    const stepMs = Math.min(t < FORTNIGHT ? 600_000 : 7_200_000, modelled - t);
    const dt = stepMs / 1000;
    t += stepMs;
    report.steps++;
    sim.envNow += stepMs;
    sim.colonyTime += dt;
    sim.refreshEnv();
    const env = sim.env;
    if (env.rain > 0.05) report.rainyHours += stepMs / 3_600_000;

    // Age: those whose span has run out.
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s] || a.caste[s] === Caste.Queen) continue;
      if (sim.colonyTime - a.birth[s] > a.lifespan[s]) sim.kill(s, DeathCause.Age);
    }

    // Food falls and is found; foragers bring it in.
    const windfallBefore = sim.nextWindfall;
    sim.foodPass(dt);
    if (sim.nextWindfall !== windfallBefore && windfallBefore !== 0) report.windfalls++;
    const pop = sim.population();
    let foragers = 0;
    for (let s = 0; s < a.count; s++) if (a.alive[s] && a.role[s] === Role.Forager) foragers++;
    const capacity = foragers * env.activity * (dt / 200);
    let gathered = 0;
    for (const q of sim.foods) {
      if (gathered >= capacity) break;
      const take = Math.min(q.amount, capacity - gathered);
      q.amount -= take;
      gathered += take;
    }
    sim.foods = sim.foods.filter((q) => q.amount >= 1);
    const whole = Math.floor(gathered);
    stash(sim, whole);
    report.foodGathered += whole;
    sim.foodGathered += whole;
    if (whole > 0 && foragers > 0) {
      // Credit the foragers with their share.
      for (let s = 0; s < a.count; s++) {
        if (a.alive[s] && a.role[s] === Role.Forager && sim.rng.chance(Math.min(1, whole / foragers))) {
          a.loads[s]++;
          a.dist[s] += 180;
          gatheredPerAnt.set(s, (gatheredPerAnt.get(s) ?? 0) + 1);
        }
      }
    }

    // Feed the larvae, then the adults.
    const b = sim.brood;
    for (let k = 0; k < b.count; k++) {
      if (!b.alive[k] || b.stage[k] !== Stage.Larva) continue;
      const due = Math.min(LIFE.larvaFeeds, Math.ceil(((b.age[k] + dt) / LIFE.larva) * LIFE.larvaFeeds));
      while (b.fed[k] < due && sim.eatOne()) b.fed[k]++;
      if (b.fed[k] >= due) b.hungry[k] = 0;
    }
    let starvedNow = 0;
    for (let s = 0; s < a.count; s++) {
      if (!a.alive[s]) continue;
      a.hunger[s] = Math.min(1, a.hunger[s] + dt / LIFE.hungerPeriod);
      if (a.hunger[s] > 0.55) {
        if (sim.eatOne()) {
          a.hunger[s] = 0;
          a.starve[s] = 0;
        } else if (a.hunger[s] >= 1) {
          a.starve[s] += dt;
          if (a.starve[s] > LIFE.starveGrace && a.caste[s] !== Caste.Queen) {
            sim.kill(s, DeathCause.Starvation);
            starvedNow++;
          }
        }
      }
    }
    if (sim.queen >= 0 && sim.eatOne()) a.hunger[sim.queen] = 0;
    void starvedNow;

    // Brood develops; the queen lays.
    const popBeforeBrood = sim.population();
    sim.broodPass(dt);
    sim.queenPass(dt);
    report.births += Math.max(0, sim.population() - popBeforeBrood);

    // Digging to make room.
    if (report.cellsDug < MAX_DUG) {
      const target = pop * 5.2 + 700;
      const deficit = target - sim.world.volume;
      if (deficit > 0) {
        let diggers = 0;
        for (let s = 0; s < a.count; s++) if (a.alive[s] && a.role[s] === Role.Digger) diggers++;
        const cells = Math.min(deficit, Math.max(4, diggers) * (dt / 60) * 0.35, MAX_DUG - report.cellsDug);
        if (cells >= 1) {
          const nurseryShort = report.broodBefore * 3 + 200 > 0 && sim.broodCount() > 120;
          report.cellsDug += coarseExcavate(
            sim.world,
            Math.floor(cells),
            { upper: 0.5, nursery: nurseryShort ? 0.55 : 0.3, royal: 0.12 },
            sim.rng,
            builder,
          );
        }
      }
    }

    // Rain soaks the upper galleries; wet ceilings fall.
    if (env.rain > 0.25) {
      soak(sim, env.rain, dt);
      const p = env.rain * (dt / 3600) * 0.45;
      if (sim.rng.next() < p) {
        const spot = randomUpperTunnel(sim);
        if (spot) {
          const lost = sim.collapse(spot.x, spot.y, 2.2 + sim.rng.next() * 1.8);
          report.collapses.push({ region: sim.regionName(spot.x, spot.y), lost, at: sim.envNow });
        }
      }
    }

    // A warm evening in the season: the winged ones go.
    if (env.flightWeather && sim.lastFlightDay !== env.dayNumber) {
      let alates = 0;
      for (let s = 0; s < a.count; s++) if (a.alive[s] && a.caste[s] >= Caste.AlateF) alates++;
      if (alates >= 6 && sim.rng.chance(0.3)) {
        for (let s = 0; s < a.count; s++) {
          if (a.alive[s] && a.caste[s] >= Caste.AlateF) {
            a.alive[s] = 0;
            a.free.push(s);
            sim.flownTotal++;
          }
        }
        sim.lastFlightDay = env.dayNumber;
        sim.flightsTotal++;
        report.flights.push({ count: alates, at: sim.envNow });
      }
    }

    if (report.steps % 36 === 0) sim.allocateRoles();
  }

  // The dead were carried out long ago.
  for (let k = 0; k < sim.corpses.length; k++) {
    const spot = sim.middenSeed >= 0 ? sim.middenSeed : -1;
    if (spot >= 0) addPile(sim.world, spot, Pile.Husk, 1);
  }
  sim.corpses = [];
  for (let s = 0; s < a.count; s++) {
    if (!a.alive[s]) continue;
    if (a.carry[s] === Carry.Corpse) a.carry[s] = Carry.None;
    const g = gatheredPerAnt.get(s);
    if (g) logHistory(a, s, sim.minutes, Hist.Absence, g);
    // Everyone settles somewhere real and decides afresh.
    if (!isWalkable(sim.world, a.x[s] | 0, a.y[s] | 0)) relocate(sim, s);
    if (a.task[s] !== Task.Queen) {
      a.task[s] = Task.Idle;
      a.sub[s] = 0;
      a.timer[s] = sim.rng.next() * 4;
      if (a.carry[s] >= Carry.Egg && a.carry[s] <= Carry.Pupa) {
        const k = a.carryRef[s];
        if (k >= 0 && sim.brood.alive[k]) {
          sim.brood.carriedBy[k] = -1;
          sim.brood.x[k] = a.x[s];
          sim.brood.y[k] = a.y[s];
        }
        a.carry[s] = Carry.None;
        a.carryRef[s] = -1;
      } else if (a.carry[s] !== Carry.Letter) {
        a.carry[s] = Carry.None;
      }
    }
    a.alarm[s] = 0;
  }
  // Brood left somewhere impossible is lost.
  const b = sim.brood;
  for (let k = 0; k < b.count; k++) {
    if (b.alive[k] && !isWalkable(sim.world, b.x[k] | 0, b.y[k] | 0)) killBrood(b, k);
  }
  clearField(sim.fields.food);
  clearField(sim.fields.home);
  clearField(sim.fields.alarm);
  if (sim.env.rain < 0.05) sim.world.water.fill(0);
  sim.flightActive = false;
  sim.pageAnts = [];

  sim.rebuildAllFields();
  sim.computeBroodTargets();
  sim.allocateRoles();
  const after = sim.chamberPass(false);
  report.chambersAfter = after.length;
  for (const c of after) {
    const known = before.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < 7);
    if (!known) report.newChambers.push(sim.regionName(c.x, c.y));
  }
  sim.rebuildAllFields();

  report.popAfter = sim.population();
  report.broodAfter = sim.broodCount();
  report.storesAfter = Math.round(sim.storeLoads());
  report.deaths.age = sim.deathsByCause[DeathCause.Age] - deathsBefore[DeathCause.Age];
  report.deaths.starvation = sim.deathsByCause[DeathCause.Starvation] - deathsBefore[DeathCause.Starvation];
  report.deaths.caveIn = sim.deathsByCause[DeathCause.CaveIn] - deathsBefore[DeathCause.CaveIn];
  report.deaths.drowned = sim.deathsByCause[DeathCause.Drowned] - deathsBefore[DeathCause.Drowned];
  report.deaths.abroad = sim.deathsByCause[DeathCause.Surface] - deathsBefore[DeathCause.Surface];
  report.births = sim.births - birthsBefore;
  report.deepestRow = deepestOpen(sim);
  sim.events = [];
  report.computeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return report;
}

function stash(sim: Simulation, loads: number): void {
  if (loads <= 0) return;
  const w = sim.world;
  const W = sim.W;
  sim.refreshStoreCells();
  let left = loads;
  for (const i of sim.storeCells) {
    if (left <= 0) break;
    left -= addPile(w, i, Pile.Food, Math.min(left, Math.max(0, 14 - w.pileAmt[i])));
  }
  if (left <= 0) return;
  const seed = sim.storeCells[0] ?? sim.storeSeed;
  if (seed < 0) {
    sim.feedPool += left * FEEDS_PER_LOAD;
    return;
  }
  const sx = seed % W;
  const sy = (seed / W) | 0;
  for (let r = 1; r < 10 && left > 0; r++) {
    for (let dy = -r; dy <= r && left > 0; dy++) {
      for (let dx = -r; dx <= r && left > 0; dx++) {
        if (!isFloor(w, sx + dx, sy + dy)) continue;
        const i = (sy + dy) * W + sx + dx;
        if (w.pileType[i] !== Pile.None && w.pileType[i] !== Pile.Food) continue;
        left -= addPile(w, i, Pile.Food, Math.min(left, 14 - w.pileAmt[i]));
      }
    }
  }
  if (left > 0) sim.feedPool += left * FEEDS_PER_LOAD;
}

function soak(sim: Simulation, rain: number, dt: number): void {
  const w = sim.world;
  const n = Math.round(rain * sim.W * (dt / 60) * 0.6);
  for (let k = 0; k < n; k++) {
    const x = sim.rng.int(1, sim.W - 1);
    const y = w.ground[x] + sim.rng.int(0, 70);
    const i = y * sim.W + x;
    if (w.soil[i] !== 0) w.moisture[i] = Math.min(255, w.moisture[i] + 40);
  }
}

function randomUpperTunnel(sim: Simulation): { x: number; y: number } | null {
  const w = sim.world;
  for (let tries = 0; tries < 400; tries++) {
    const x = sim.rng.int(3, sim.W - 3);
    const y = sim.rng.int(ROW.ground + 6, ROW.stone1 - 4);
    const i = y * sim.W + x;
    if (w.walk[i] && y > w.ground[x] + 3 && w.soil[i - sim.W] !== 0) return { x, y };
  }
  return null;
}

function relocate(sim: Simulation, s: number): void {
  const a = sim.ants;
  const w = sim.world;
  for (let tries = 0; tries < 400; tries++) {
    const x = sim.rng.int(2, sim.W - 2);
    const y = sim.rng.int(ROW.ground + 4, ROW.bedrock);
    if (isWalkable(w, x, y)) {
      a.x[s] = x + 0.5;
      a.y[s] = y + 0.5;
      return;
    }
  }
}

function deepestOpen(sim: Simulation): number {
  const w = sim.world;
  for (let y = sim.H - 1; y > ROW.ground; y--) {
    for (let x = 0; x < sim.W; x++) if (w.walk[y * sim.W + x]) return y;
  }
  return ROW.ground;
}
