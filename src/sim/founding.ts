/**
 * Founding a colony for a first visit. The nest is not drawn: the founding
 * queen's shaft is a digging walk, and the galleries and chambers are dug by
 * the same rules the live diggers use, run coarsely until the nest has room
 * for the starting population.
 */
import { Caste, FoodKind, LIFE, Mat, POP_CAPS, Pile, ROW, Role, Stage, Task, WORLD_WIDTHS } from "./constants";
import { spawnAnt, spawnBrood } from "./colony";
import { coarseExcavate, digEllipse, digFoundingShaft } from "./excavation";
import { Rng } from "./rng";
import { Simulation, type SimOptions } from "./sim";
import { FieldBuilder, FAR, addPile, createEmptyWorld, generateSoil, isFloor, isWalkable, refreshAllWalk } from "./world";

export interface FoundingOptions extends SimOptions {
  /** Fraction of the population cap to start with. */
  startFraction?: number;
}

export function foundColony(opts: FoundingOptions): Simulation {
  const W = WORLD_WIDTHS[opts.deviceClass];
  const world = createEmptyWorld(W);
  generateSoil(world, opts.seed);
  refreshAllWalk(world);

  const sim = new Simulation(opts, world);
  const rng = new Rng(opts.seed ^ 0xf0d1);
  const cap = opts.popCap ?? POP_CAPS[opts.deviceClass];
  const startPop = Math.round(cap * (opts.startFraction ?? 0.36));

  // The founding queen dug down alone to her claustral chamber.
  const bottom = ROW.stone2End + 40 + rng.int(0, 30);
  const end = digFoundingShaft(world, rng, bottom);
  const royal = { x: Math.max(12, Math.min(W - 12, end.x)), y: end.y + 3 };
  digEllipse(world, royal.x, royal.y, 13, 4.8, rng);
  refreshAllWalk(world);

  // The workers have dug the rest by the rules they still follow.
  const builder = new FieldBuilder(W * world.H);
  const target = startPop * 4.5 + 600;
  coarseExcavate(world, Math.max(0, target - world.volume), { upper: 0.5, nursery: 0.36, royal: 0.14 }, rng, builder);
  refreshAllWalk(world);
  world.changes = [];
  world.changeSet.fill(0);

  sim.rebuildAllFields();
  sim.computeBroodTargets();
  sim.chamberPass(false);
  sim.rebuildAllFields();

  // The queen.
  const qCell = nearestFloor(sim, royal.x, royal.y + 2);
  const q = spawnAnt(sim.ants, {
    caste: Caste.Queen,
    x: (qCell % W) + 0.5,
    y: ((qCell / W) | 0) + 0.5,
    birth: -LIFE.queenLifespan * 0.02,
    minutes: 0,
    rng,
    serial: 1,
  });
  sim.queen = q;
  sim.ants.lifespan[q] = LIFE.queenLifespan;
  sim.ants.heading[q] = 0;

  // The store: the first roomy chamber below the entrance.
  sim.storeSeed = chooseStore(sim);
  if (sim.storeSeed >= 0) {
    const loads = Math.round(startPop * 0.06) + 30;
    let placed = 0;
    const sx = sim.storeSeed % W;
    const sy = (sim.storeSeed / W) | 0;
    for (let r = 0; r < 6 && placed < loads; r++) {
      for (let dx = -r; dx <= r && placed < loads; dx++) {
        for (let dy = -2; dy <= 2 && placed < loads; dy++) {
          if (!isFloor(world, sx + dx, sy + dy)) continue;
          placed += addPile(world, (sy + dy) * W + sx + dx, Pile.Food, Math.min(8, loads - placed));
        }
      }
    }
  }
  sim.rebuildAllFields();

  // Brood in the nursery.
  const targets = sim.broodTargets.length ? sim.broodTargets : [qCell];
  const broodN = Math.round(startPop * 0.2);
  for (let k = 0; k < broodN; k++) {
    const c = targets[rng.int(0, Math.min(targets.length, 40))];
    const stage = rng.pick([Stage.Egg, Stage.Larva, Stage.Larva, Stage.Pupa, Stage.Pupa]);
    const age = rng.next() * (stage === Stage.Egg ? LIFE.egg : stage === Stage.Larva ? LIFE.larva : LIFE.pupa) * 0.9;
    const b = spawnBrood(sim.brood, (c % W) + 0.2 + rng.next() * 0.6, ((c / W) | 0) + 0.6 + rng.next() * 0.3, stage, age, false);
    if (b >= 0 && stage === Stage.Larva) sim.brood.fed[b] = Math.min(LIFE.larvaFeeds, Math.floor((age / LIFE.larva) * LIFE.larvaFeeds));
  }

  // Workers of all ages.
  const open: number[] = [];
  for (let i = 0; i < world.walk.length; i++) {
    const y = (i / W) | 0;
    if (world.walk[i] && y >= world.ground[i % W] + 1 && sim.dUp[i] !== FAR) open.push(i);
  }
  for (let k = 0; k < startPop; k++) {
    const caste = k % 15 === 0 ? Caste.Soldier : Caste.Worker;
    const c = open[rng.int(0, open.length)];
    const age = rng.next() * LIFE.workerLifespan * 0.62;
    spawnAnt(sim.ants, {
      caste,
      x: (c % W) + 0.2 + rng.next() * 0.6,
      y: ((c / W) | 0) + 0.2 + rng.next() * 0.6,
      birth: -age,
      minutes: -age / 60,
      rng,
    });
  }

  // In the warm months the colony already carries winged sexuals.
  if (sim.env.warmth > 0.1) {
    const n = 10 + rng.int(0, 14);
    for (let k = 0; k < n; k++) {
      const c = targets[rng.int(0, targets.length)];
      spawnAnt(sim.ants, {
        caste: rng.chance(0.4) ? Caste.AlateF : Caste.AlateM,
        x: (c % W) + 0.5,
        y: ((c / W) | 0) + 0.5,
        birth: -rng.range(1, 5) * 86400,
        minutes: 0,
        rng,
      });
    }
  }

  sim.allocateRoles();
  // Nurses start among the brood.
  const a = sim.ants;
  for (let s = 0; s < a.count; s++) {
    if (!a.alive[s] || a.caste[s] !== Caste.Worker) continue;
    if (a.role[s] === Role.Nurse) {
      const c = targets[rng.int(0, targets.length)];
      a.x[s] = (c % W) + 0.5;
      a.y[s] = ((c / W) | 0) + 0.3;
      a.task[s] = Task.Nurse;
    }
  }

  // Food abroad on the surface: a crust, a scatter of seeds, and a dead beetle.
  sim.addFood(FoodKind.Crust, W * 0.18, false);
  sim.addFood(FoodKind.Beetle, W * 0.64, false);
  for (let k = 0; k < 10; k++) sim.addFood(FoodKind.Seed, rng.range(3, W - 4), false);

  sim.rebuildAllFields();
  sim.events = [];
  return sim;
}

function nearestFloor(sim: Simulation, x: number, y: number): number {
  const w = sim.world;
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = Math.round(x + dx);
        const ny = Math.round(y + dy);
        if (isFloor(w, nx, ny)) return ny * sim.W + nx;
      }
    }
  }
  return Math.round(y) * sim.W + Math.round(x);
}

function chooseStore(sim: Simulation): number {
  const w = sim.world;
  const W = sim.W;
  let best = -1;
  let bestScore = -Infinity;
  for (let y = ROW.ground + 14; y < ROW.stone1 - 6; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (!isFloor(w, x, y)) continue;
      const i = y * W + x;
      if (sim.dUp[i] === FAR) continue;
      let open = 0;
      for (let dy = -3; dy <= 0; dy++) for (let dx = -3; dx <= 3; dx++) if (isWalkable(w, x + dx, y + dy)) open++;
      const score = open - sim.dUp[i] * 0.12 - Math.abs(y - (ROW.ground + 40)) * 0.1;
      if (score > bestScore && w.soil[i + W] !== Mat.Open) {
        bestScore = score;
        best = i;
      }
    }
  }
  return best;
}
