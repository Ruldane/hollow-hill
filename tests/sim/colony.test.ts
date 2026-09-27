import { describe, expect, it } from "vitest";
import { Carry, FoodKind, Mat, Pile, ROW, SCHEMA_VERSION } from "@/sim/constants";
import { catchUp } from "@/sim/catchup";
import { createFields, deposit, fieldTotal, updateField } from "@/sim/fields";
import { deserialize, serialize } from "@/sim/persist";
import { FieldBuilder, FAR, createEmptyWorld, entranceCells, generateSoil, refreshAllWalk } from "@/sim/world";
import { absenceEntry } from "@/notes/grammar";
import { LONDON, NOON, collect, colony, run } from "./helpers";

describe("determinism", () => {
  it("the same seed gives the same colony, step for step", () => {
    const a = colony(11);
    const b = colony(11);
    run(a, 30);
    run(b, 30);
    expect(a.population()).toBe(b.population());
    expect(Array.from(a.ants.x.slice(0, a.ants.count))).toEqual(Array.from(b.ants.x.slice(0, b.ants.count)));
    expect(Array.from(a.world.soil)).toEqual(Array.from(b.world.soil));
  });

  it("different seeds diverge", () => {
    const a = colony(1);
    const b = colony(2);
    expect(Array.from(a.world.soil)).not.toEqual(Array.from(b.world.soil));
  });
});

describe("foraging", () => {
  it("scouts find offered honey and a trail forms", () => {
    const sim = colony(7);
    const honey = sim.offerFood(FoodKind.Honey, sim.world.entranceX + 20);
    const events = collect(sim, 240);
    const found = events.find((e) => e.type === "food-found" && e.source === honey.id);
    expect(found).toBeTruthy();
    // Loads were carried off and marked with food scent between source and nest.
    expect(honey.amount).toBeLessThan(honey.initial);
    let scent = 0;
    const W = sim.W;
    for (let x = Math.min(honey.x, sim.world.entranceX) | 0; x <= Math.max(honey.x, sim.world.entranceX); x++) {
      for (let y = ROW.ground - ROW.band; y < ROW.ground; y++) scent += sim.fields.food.v[y * W + x];
    }
    expect(scent).toBeGreaterThan(1);
    expect(sim.foodGathered).toBeGreaterThan(0);
  });

  it("food is carried to the stores underground", () => {
    const sim = colony(9);
    const before = sim.storeLoads();
    sim.offerFood(FoodKind.Honey, sim.world.entranceX - 16);
    run(sim, 300);
    // Stores rise despite everyone eating, or at least loads were delivered.
    expect(sim.foodGathered).toBeGreaterThan(5);
    expect(sim.storeLoads() + 0.001).toBeGreaterThan(before * 0.5);
  });
});

describe("pheromones", () => {
  it("evaporate and diffuse", () => {
    const world = createEmptyWorld(40, 40);
    world.walk.fill(1);
    const f = createFields(40 * 40);
    deposit(f.alarm, world, 20, 20, 8);
    updateField(f.alarm, world, f.scratch, 0.2);
    expect(f.alarm.v[20 * 40 + 21]).toBeGreaterThan(0);
    const start = fieldTotal(f.alarm);
    for (let k = 0; k < 300; k++) updateField(f.alarm, world, f.scratch, 0.2);
    expect(fieldTotal(f.alarm)).toBeLessThan(start * 0.01);
  });

  it("a knock on the glass raises alarm that then decays", () => {
    const sim = colony(5);
    const y = ROW.ground + 30;
    sim.knock(sim.world.entranceX, y);
    run(sim, 1);
    const peak = sim.alarmLevel();
    expect(peak).toBeGreaterThan(5);
    run(sim, 60);
    expect(sim.alarmLevel()).toBeLessThan(peak * 0.2);
  });
});

describe("excavation", () => {
  it("every dug cell is connected to the entrance", () => {
    const sim = colony(3);
    run(sim, 120);
    const b = new FieldBuilder(sim.W * sim.H);
    const d = new Uint16Array(sim.W * sim.H);
    b.build(sim.world, entranceCells(sim.world), d);
    let open = 0;
    let unreachable = 0;
    for (let y = ROW.ground + 2; y < sim.H; y++) {
      for (let x = 0; x < sim.W; x++) {
        const i = y * sim.W + x;
        if (sim.world.soil[i] !== Mat.Open || y < sim.world.ground[x]) continue;
        open++;
        if (d[i] === FAR) unreachable++;
      }
    }
    expect(open).toBeGreaterThan(1000);
    // Allow a handful of cells cut off by a cave-in or rubble, no more.
    expect(unreachable / open).toBeLessThan(0.01);
  });

  it("diggers extend the nest and the mound grows", () => {
    const sim = colony(4, { startFraction: 0.5 });
    const before = sim.world.volume;
    const mound = Array.from(sim.world.ground).reduce((s, g) => s + (ROW.ground - g), 0);
    run(sim, 600);
    expect(sim.world.volume).toBeGreaterThan(before);
    const after = Array.from(sim.world.ground).reduce((s, g) => s + (ROW.ground - g), 0);
    expect(after).toBeGreaterThanOrEqual(mound);
  });

  it("soil generation is layered and bounded by bedrock", () => {
    const w = createEmptyWorld(60);
    generateSoil(w, 1);
    refreshAllWalk(w);
    expect(w.soil[(ROW.ground + 5) * 60 + 30]).not.toBe(Mat.Open);
    expect(w.soil[(w.H - 2) * 60 + 30]).toBe(Mat.Bedrock);
  });
});

describe("the dead", () => {
  it("are carried to a midden", () => {
    const sim = colony(8);
    // Kill a handful of workers in the upper galleries.
    let killed = 0;
    for (let s = 0; s < sim.ants.count && killed < 6; s++) {
      if (sim.ants.alive[s] && sim.ants.caste[s] === 0 && sim.ants.y[s] > ROW.ground + 10 && sim.ants.y[s] < ROW.stone1) {
        sim.kill(s, 0);
        killed++;
      }
    }
    expect(sim.corpses.length).toBe(killed);
    const events = collect(sim, 400);
    expect(events.some((e) => e.type === "corpse-carried")).toBe(true);
    let husks = 0;
    for (let i = 0; i < sim.world.pileType.length; i++) if (sim.world.pileType[i] === Pile.Husk) husks += sim.world.pileAmt[i];
    expect(husks).toBeGreaterThan(0);
  });
});

describe("population and food", () => {
  it("a fed colony outgrows a starved one", () => {
    const fed = colony(21, { popCap: 400 });
    const starved = colony(21, { popCap: 400 });
    fed.feedPool = 50_000;
    // Take everything from the starved colony and let nothing fall on its surface.
    starved.world.pileAmt.fill(0);
    starved.world.pileType.fill(0);
    starved.world.pileVersion++;
    starved.foods = [];
    starved.feedPool = 0;
    starved.foodPass = () => {};
    const r1 = catchUp(fed, 20 * 3_600_000);
    const r2 = catchUp(starved, 20 * 3_600_000);
    expect(r1.popAfter).toBeGreaterThan(r2.popAfter);
    expect(r2.deaths.starvation).toBeGreaterThan(r1.deaths.starvation);
    expect(r1.births).toBeGreaterThanOrEqual(r2.births);
  });
});

describe("absence", () => {
  it("catch-up is bounded in cost and plausible", () => {
    const sim = colony(12, { popCap: 800, deviceClass: "large" });
    const pop = sim.population();
    const r = catchUp(sim, 19 * 3_600_000);
    expect(r.computeMs).toBeLessThan(4000);
    expect(r.popAfter).toBeGreaterThan(0);
    expect(r.popAfter).toBeLessThanOrEqual(sim.popCap * 1.3);
    expect(r.births).toBeGreaterThanOrEqual(0);
    expect(r.popAfter).toBeGreaterThan(pop * 0.3);
    expect(r.popAfter).toBeLessThan(pop * 3);
    expect(absenceEntry(r)).toMatch(/^Absent /);
    // A month away still costs a bounded number of coarse steps.
    const long = catchUp(sim, 90 * 86_400_000);
    expect(long.modelledMs).toBeLessThanOrEqual(30 * 86_400_000);
    expect(long.steps).toBeLessThan(2400);
  });

  it("the colony keeps working while away: galleries lengthen", () => {
    const sim = colony(13, { startFraction: 0.5 });
    const before = sim.world.volume;
    const r = catchUp(sim, 12 * 3_600_000);
    expect(r.cellsDug).toBeGreaterThan(0);
    expect(sim.world.volume).toBeGreaterThan(before);
  });
});

describe("persistence", () => {
  it("snapshots round-trip through the schema", () => {
    const sim = colony(14);
    run(sim, 20);
    sim.offerFood(FoodKind.Crumb, 20);
    const snap = structuredClone(serialize(sim));
    expect(snap.schema).toBe(SCHEMA_VERSION);
    const back = deserialize(snap, { place: LONDON });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const s2 = back.sim;
    expect(s2.population()).toBe(sim.population());
    expect(Array.from(s2.world.soil)).toEqual(Array.from(sim.world.soil));
    expect(Array.from(s2.world.ground)).toEqual(Array.from(sim.world.ground));
    expect(s2.foods.length).toBe(sim.foods.length);
    expect(s2.ants.serial.slice(0, 50)).toEqual(sim.ants.serial.slice(0, 50));
    expect(s2.foundedAt).toBe(sim.foundedAt);
    // And the restored colony keeps living.
    run(s2, 10);
    expect(s2.population()).toBeGreaterThan(0);
  });

  it("an old schema is refused so the colony can be refounded", () => {
    const snap = serialize(colony(15));
    const r = deserialize({ ...snap, schema: SCHEMA_VERSION - 1 }, { place: LONDON });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema");
    expect(deserialize(null, { place: LONDON }).ok).toBe(false);
  });
});

describe("the page", () => {
  it("scouts find the fault in the frame, borrow letters and store them underground", () => {
    const sim = colony(7, { deviceClass: "large", popCap: 1200 });
    const letters = Array.from({ length: 40 }, (_, k) => ({ key: `f1:${k}`, ch: "e", x: 1300 + (k % 8) * 9, y: 300 + Math.floor(k / 8) * 30, w: 8, h: 16 }));
    sim.setPage({ letters, gapX: 1000, gapY: 380, width: 1440, height: 4000, cellPx: 4.7, maxAnts: 10, maxStolen: 30 });
    const events = collect(sim, 420);
    expect(events.some((e) => e.type === "gap-found")).toBe(true);
    expect(events.some((e) => e.type === "letter-taken")).toBe(true);
    expect(events.some((e) => e.type === "letter-stored")).toBe(true);
    expect(sim.lettersOut()).toBeLessThanOrEqual(30);
    const restored = sim.restoreLetters();
    expect(restored).toBeGreaterThan(0);
    expect(sim.letters.size).toBe(0);
    for (let s = 0; s < sim.ants.count; s++) if (sim.ants.alive[s]) expect(sim.ants.carry[s]).not.toBe(Carry.Letter);
  });
});

describe("clock", () => {
  it("colony time runs with the steps in headless mode", () => {
    const sim = colony(16);
    run(sim, 10);
    expect(sim.envNow).toBe(NOON + 10_000);
  });
});
