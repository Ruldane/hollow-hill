import { describe, expect, it } from "vitest";
import { placeFromTimeZone, sampleEnv, seasonOf, showersOn } from "@/sim/environment";
import { Notebook, absenceEntry, clockPhrase, durationPhrase, nowSummary } from "@/notes/grammar";
import type { SimEvent } from "@/sim/events";
import type { AbsenceReport } from "@/sim/catchup";

describe("real time and real place", () => {
  it("guesses the hemisphere from the time zone and flips the seasons", () => {
    const north = placeFromTimeZone("Europe/Paris", 120);
    const south = placeFromTimeZone("Australia/Sydney", 600);
    expect(north.hemisphere).toBe(1);
    expect(south.hemisphere).toBe(-1);
    const july = 190;
    expect(seasonOf(july, 1)).toBe("summer");
    expect(seasonOf(july, -1)).toBe("winter");
  });

  it("day follows the local clock: noon is light, midnight dark, the lamp lit at night", () => {
    const place = placeFromTimeZone("Europe/London", 60);
    const noon = sampleEnv(Date.UTC(2026, 5, 21, 11, 0), place, 1, "dry");
    const midnight = sampleEnv(Date.UTC(2026, 5, 21, 23, 0), place, 1, "dry");
    expect(noon.daylight).toBeGreaterThan(0.9);
    expect(midnight.daylight).toBeLessThan(0.1);
    expect(midnight.lampLit).toBe(true);
    expect(noon.activity).toBeGreaterThan(midnight.activity);
  });

  it("weather is deterministic per colony and day, and the barometer falls ahead of rain", () => {
    const place = placeFromTimeZone("Europe/London", 60);
    let rainyDay = -1;
    for (let d = 20000; d < 20100; d++) {
      const showers = showersOn(d, 270, place, 42);
      expect(showersOn(d, 270, place, 42)).toEqual(showers);
      if (showers.length && showers[0].start > 7) {
        rainyDay = d;
        const startMs = d * 86_400_000 - 60 * 60_000 + showers[0].start * 3_600_000;
        const before = sampleEnv(startMs - 5 * 3_600_000, place, 42);
        const during = sampleEnv(startMs + 0.2 * 3_600_000, place, 42);
        expect(during.pressure).toBeLessThan(before.pressure + 1);
        expect(during.rain).toBeGreaterThan(0);
        break;
      }
    }
    expect(rainyDay).toBeGreaterThan(0);
  });

  it("the nuptial flight window is a warm evening in late summer", () => {
    const place = placeFromTimeZone("Europe/London", 60);
    const evening = sampleEnv(Date.UTC(2026, 6, 20, 17, 30), place, 1, "dry");
    const morning = sampleEnv(Date.UTC(2026, 6, 20, 8, 0), place, 1, "dry");
    const winter = sampleEnv(Date.UTC(2026, 0, 20, 17, 30), place, 1, "dry");
    expect(evening.flightWeather).toBe(true);
    expect(morning.flightWeather).toBe(false);
    expect(winter.flightWeather).toBe(false);
  });
});

describe("Dr. Vance's voice", () => {
  const events: SimEvent[] = [
    { type: "food-found", serial: 1187, kind: 1, source: 3, x: 10 },
    { type: "trail", source: 3, kind: 1, foragers: 23 },
    { type: "death", serial: 1022, caste: 0, cause: 0, x: 1, y: 1, zone: "upper" },
    { type: "corpse-carried", dead: 1022, bearer: 1402 },
    { type: "cave-in", x: 1, y: 1, lost: 4, region: "the eastern gallery" },
    { type: "gap-found", serial: 2078 },
    { type: "letter-taken", serial: 2078, key: "f1:3", ch: "a" },
    { type: "flight", count: 30, females: 9, males: 21 },
    { type: "rain-begin", intensity: 0.7 },
    { type: "brood-rescue", serial: 1500, stage: 2 },
  ];

  it("writes a note for notable events, varies them, and never uses an em-dash", () => {
    const texts = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const nb = new Notebook();
      let r = round * 0.17;
      for (const e of events) {
        const note = nb.compose(e, { now: 1e9, localHour: 16.25, stores: 40, population: 900, chambers: 12, random: () => (r = (r + 0.37) % 1) });
        expect(note).not.toBeNull();
        texts.add(note!.text);
        expect(note!.text).not.toMatch(/[—–]/);
      }
    }
    expect(texts.size).toBeGreaterThan(events.length + 4);
  });

  it("rate-limits repeated events", () => {
    const nb = new Notebook();
    const ctx = { now: 1e9, localHour: 10, stores: 1, population: 1, chambers: 1, random: () => 0.5 };
    expect(nb.compose(events[0], ctx)).not.toBeNull();
    expect(nb.compose(events[0], { ...ctx, now: ctx.now + 2000 })).toBeNull();
  });

  it("phrases time the Victorian way", () => {
    expect(clockPhrase(16.25)).toBe("a quarter past four in the afternoon");
    expect(clockPhrase(12)).toBe("noon");
    expect(durationPhrase(19 * 3_600_000)).toBe("19 hours");
  });

  it("writes the return entry from the absence report", () => {
    const r: AbsenceReport = {
      elapsedMs: 19 * 3_600_000,
      modelledMs: 19 * 3_600_000,
      popBefore: 900,
      popAfter: 960,
      births: 140,
      deaths: { age: 70, starvation: 0, caveIn: 4, drowned: 0, abroad: 0 },
      broodBefore: 200,
      broodAfter: 220,
      storesBefore: 50,
      storesAfter: 40,
      foodGathered: 300,
      cellsDug: 600,
      chambersBefore: 10,
      chambersAfter: 12,
      newChambers: ["the western nursery", "the eastern gallery"],
      collapses: [{ region: "the eastern gallery", lost: 4, at: 0 }],
      rainyHours: 2,
      flights: [],
      windfalls: 1,
      deepestRow: 600,
      deepestBefore: 600,
      steps: 114,
      computeMs: 20,
    };
    const text = absenceEntry(r);
    expect(text).toBe("Absent 19 hours. Two new chambers. The eastern gallery collapsed after rain; four workers lost. Some 140 born, some 70 dead, most of age.");
    expect(text).not.toMatch(/[—–]/);
  });

  it("answers what is happening now", () => {
    const t = nowSummary({
      localHour: 14.5,
      season: "autumn",
      rain: 0,
      daylight: 1,
      population: 1200,
      abroad: 140,
      onPage: 2,
      foragers: 300,
      nurses: 300,
      diggers: 60,
      resting: 200,
      eggs: 40,
      larvae: 90,
      pupae: 80,
      stores: 60,
      alarm: 0,
      starving: false,
      flightActive: false,
      flood: 0,
      trailTo: 1,
      lampLit: false,
      lettersOut: 3,
    });
    expect(t).toContain("half past two in the afternoon");
    expect(t).toContain("the honey");
    expect(t).toContain("on the page");
  });
});
