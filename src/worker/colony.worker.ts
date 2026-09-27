/// <reference lib="webworker" />
/**
 * The colony lives here, off the main thread.
 *
 * A fixed-step loop advances the simulation in real time (or paused, or a
 * little faster). Each loop posts one frame of packed agent data in
 * transferred buffers. The colony is saved to IndexedDB every twenty seconds
 * and whenever the page is hidden; on return the absence is modelled coarsely.
 */
import { DT, Carry, ROW, Task } from "../sim/constants";
import { catchUp } from "../sim/catchup";
import { nowFacts, readSpecimen, takeCensus } from "../sim/census";
import { placeFromTimeZone, type Place } from "../sim/environment";
import { foundColony } from "../sim/founding";
import { deserialize, serialize } from "../sim/persist";
import type { Simulation } from "../sim/sim";
import { takeChanges } from "../sim/world";
import { absenceEntry } from "../notes/grammar";
import {
  ANT_F,
  ANT_U,
  BROOD_F,
  FLAG_ALARM,
  FLAG_HURRY,
  FLAG_RESTING,
  FLAG_SELECTED,
  packAntFlags,
  type FrameMsg,
  type FromWorker,
  type InitParams,
  type ToWorker,
} from "./protocol";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./store";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let params: InitParams | null = null;
let place: Place | null = null;
let basePopCap = 0;
let speed = 1;
let hidden = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let lastReal = 0;
let acc = 0;
let frameNo = 0;
let lastSave = 0;
let lastCensus = 0;
let lastInspect = 0;
let lastPerf = 0;
let tickMsSum = 0;
let tickCount = 0;
let inspectSerial: number | null = null;
let chemistry = false;
let lettersSig = "";
let waterWasSent = false;
let visitStart = 0;
let saving = false;

const LOOP_MS = 50;

const post = (msg: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const realNow = () => Date.now() + (params?.clockOffset ?? 0);

// ---------------------------------------------------------------------------
// Buffer pool: the page hands spent frame buffers back.
// ---------------------------------------------------------------------------

const pool: ArrayBuffer[] = [];
function take(bytes: number): ArrayBuffer {
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].byteLength >= bytes) return pool.splice(i, 1)[0];
  }
  return new ArrayBuffer(Math.ceil((bytes * 1.25) / 64) * 64 + 64);
}
function give(bufs: ArrayBuffer[]) {
  for (const b of bufs) if (b && b.byteLength && pool.length < 40) pool.push(b);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init(p: InitParams) {
  params = p;
  speed = p.speed;
  place = placeFromTimeZone(p.timeZone, p.offsetMinutes);
  const now = realNow();
  let resetReason: "schema" | "corrupt" | null = null;
  let absence: { report: ReturnType<typeof catchUp>; text: string } | null = null;
  let founded = false;

  if (p.fresh) await clearSnapshot();
  const snap = p.persist && !p.fresh ? await loadSnapshot() : null;
  if (snap) {
    const r = deserialize(snap, { place, weatherOverride: p.weather, popCap: p.popCap ?? undefined });
    if (r.ok) sim = r.sim;
    else {
      resetReason = r.reason;
      await clearSnapshot();
    }
  }
  if (!sim) {
    const seed = p.seed ?? (Math.random() * 0xffffffff) >>> 0;
    sim = foundColony({
      seed,
      deviceClass: p.deviceClass,
      now,
      place,
      weatherOverride: p.weather,
      popCap: p.popCap ?? undefined,
      startFraction: p.startFraction ?? undefined,
    });
    founded = true;
  } else {
    const elapsed = now - sim.envNow;
    if (elapsed > 60_000) {
      const report = catchUp(sim, elapsed);
      const text = absenceEntry(report);
      if (elapsed > 3 * 60_000) sim.absenceNotes.push({ at: now, text, elapsedMs: elapsed });
      absence = { report, text };
    } else if (elapsed > 0) {
      runSteps(Math.round(elapsed / 1000 / DT));
    }
  }
  basePopCap = sim.popCap;
  sim.clockFollowsTicks = false;
  sim.setNow(now);
  sim.refreshEnv();
  sim.offersThisVisit = 0;
  sim.visits.push({ at: now, seconds: 0 });
  visitStart = now;
  sim.events = [];
  takeChanges(sim.world);

  post({
    type: "ready",
    meta: {
      W: sim.W,
      H: sim.H,
      seed: sim.seed,
      deviceClass: sim.deviceClass,
      foundedAt: sim.foundedAt,
      entranceX: sim.world.entranceX,
      gapRow: sim.gapRow,
      popCap: sim.popCap,
    },
    soil: sim.world.soil.slice(),
    ground: sim.world.ground.slice(),
    pileType: sim.world.pileType.slice(),
    pileAmt: sim.world.pileAmt.slice(),
    letters: [...sim.letters.values()],
    absence,
    founded,
    resetReason,
    visits: sim.visits.slice(),
    absenceNotes: sim.absenceNotes.slice(),
  });
  postCensus();
  lastSave = performance.now();
  if (p.persist) void save();
  start();
}

function runSteps(n: number) {
  if (!sim) return;
  const capped = Math.min(n, 1400);
  for (let i = 0; i < capped; i++) sim.step();
}

function start() {
  stop();
  lastReal = performance.now();
  acc = 0;
  loopTimer = setTimeout(loop, LOOP_MS);
}

function stop() {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
}

function loop() {
  loopTimer = null;
  if (!sim || hidden) return;
  const now = performance.now();
  const elapsed = Math.min(250, now - lastReal);
  lastReal = now;
  sim.setNow(realNow());

  let steps = 0;
  if (speed > 0) {
    acc += (elapsed / 1000) * speed;
    const maxSteps = Math.max(2, Math.ceil(speed * 3));
    const t0 = performance.now();
    while (acc >= DT && steps < maxSteps) {
      sim.step();
      acc -= DT;
      steps++;
    }
    if (acc > DT * 4) acc = DT * 4;
    if (steps) {
      tickMsSum += performance.now() - t0;
      tickCount += steps;
    }
  }

  if (steps > 0 || frameNo === 0) postFrame(steps > 0);
  drainEvents();

  if (now - lastCensus > 1000) postCensus();
  if (inspectSerial !== null && now - lastInspect > 500) postInspect();
  if (now - lastPerf > 2000 && tickCount) {
    post({ type: "perf", msPerTick: tickSum(), population: sim.population(), popCap: sim.popCap });
    lastPerf = now;
  }
  if (params?.persist && now - lastSave > 20_000) void save();

  const spent = performance.now() - now;
  loopTimer = setTimeout(loop, Math.max(4, LOOP_MS - spent));
}

function tickSum() {
  const v = tickMsSum / Math.max(1, tickCount);
  tickMsSum = 0;
  tickCount = 0;
  return v;
}

async function save() {
  if (!sim || saving || !params?.persist) return;
  saving = true;
  lastSave = performance.now();
  const last = sim.visits[sim.visits.length - 1];
  if (last) last.seconds = Math.round((realNow() - visitStart) / 1000);
  const ok = await saveSnapshot(serialize(sim));
  saving = false;
  if (ok) post({ type: "saved", at: realNow() });
}

// ---------------------------------------------------------------------------
// Outgoing data
// ---------------------------------------------------------------------------

function drainEvents() {
  if (!sim || !sim.events.length) return;
  const events = sim.events;
  sim.events = [];
  post({ type: "events", events, envNow: sim.envNow, localHour: sim.env.localHour });
}

function postCensus() {
  if (!sim) return;
  lastCensus = performance.now();
  post({ type: "census", census: takeCensus(sim) });
}

function postInspect() {
  if (!sim || inspectSerial === null) return;
  lastInspect = performance.now();
  post({ type: "inspect", card: readSpecimen(sim, inspectSerial) });
}

function quantize(v: Float32Array, scale: number): ArrayBuffer {
  const buf = take(v.length);
  const out = new Uint8Array(buf, 0, v.length);
  for (let i = 0; i < v.length; i++) {
    const q = v[i] * scale;
    out[i] = q > 255 ? 255 : q;
  }
  return buf;
}

function postFrame(advanced: boolean) {
  if (!sim) return;
  frameNo++;
  const a = sim.ants;
  let n = 0;
  for (let s = 0; s < a.count; s++) if (a.alive[s] && a.where[s] === 0) n++;
  const fBuf = take(n * ANT_F * 4);
  const uBuf = take(n * ANT_U * 4);
  const f = new Float32Array(fBuf, 0, n * ANT_F);
  const u = new Uint32Array(uBuf, 0, n * ANT_U);
  let k = 0;
  for (let s = 0; s < a.count; s++) {
    if (!a.alive[s] || a.where[s] !== 0) continue;
    f[k * 3] = a.x[s];
    f[k * 3 + 1] = a.y[s];
    f[k * 3 + 2] = a.heading[s];
    let flags = 0;
    if (a.alarm[s] > 0) flags |= FLAG_ALARM;
    if (a.task[s] === Task.Rest && a.sub[s] === 1) flags |= FLAG_RESTING;
    if (inspectSerial !== null && a.serial[s] === inspectSerial) flags |= FLAG_SELECTED;
    if (a.carry[s] !== Carry.None && a.task[s] === Task.Forage) flags |= FLAG_HURRY;
    u[k * 3] = s;
    u[k * 3 + 1] = a.serial[s];
    u[k * 3 + 2] = packAntFlags(a.caste[s], a.carry[s], a.task[s], flags, a.gen[s]);
    k++;
  }

  const b = sim.brood;
  let bn = 0;
  for (let i = 0; i < b.count; i++) if (b.alive[i] && b.carriedBy[i] < 0) bn++;
  const bBuf = take(bn * BROOD_F * 4);
  const bf = new Float32Array(bBuf, 0, bn * BROOD_F);
  let j = 0;
  for (let i = 0; i < b.count; i++) {
    if (!b.alive[i] || b.carriedBy[i] >= 0) continue;
    bf[j * 3] = b.x[i];
    bf[j * 3 + 1] = b.y[i];
    bf[j * 3 + 2] = b.stage[i] | (b.alate[i] << 2);
    j++;
  }

  const changed = takeChanges(sim.world);
  let changes: ArrayBuffer | null = null;
  let groundChanged = false;
  if (changed.length) {
    changes = new ArrayBuffer(changed.length * 8);
    const c = new Uint32Array(changes);
    const w = sim.world;
    for (let i = 0; i < changed.length; i++) {
      const idx = changed[i];
      c[i * 2] = idx;
      c[i * 2 + 1] = w.soil[idx] | (w.pileType[idx] << 8) | (w.pileAmt[idx] << 16);
      if (idx / sim.W < ROW.ground + 2) groundChanged = true;
    }
  }

  const transfer: Transferable[] = [fBuf, uBuf, bBuf];
  if (changes) transfer.push(changes);

  const slow = frameNo % 4 === 0;
  let alarm: ArrayBuffer | null = null;
  const af = sim.fields.alarm;
  if (slow && (af.minRow <= af.maxRow || advanced === false)) {
    if (af.minRow <= af.maxRow) {
      alarm = quantize(af.v, 60);
      transfer.push(alarm);
    }
  }
  let water: ArrayBuffer | null = null;
  const hasWater = sim.raining || sim.floodCells > 0 || waterWasSent;
  if (slow && hasWater) {
    water = take(sim.world.water.length);
    new Uint8Array(water, 0, sim.world.water.length).set(sim.world.water);
    transfer.push(water);
    waterWasSent = sim.raining || sim.floodCells > 0 || anyWater(sim.world.water);
  }
  let scent: FrameMsg["scent"] = null;
  if (chemistry && frameNo % 4 === 2) {
    scent = { food: quantize(sim.fields.food.v, 90), home: quantize(sim.fields.home.v, 90) };
    transfer.push(scent.food, scent.home);
  }

  let letters: FrameMsg["letters"] = null;
  const sig = [...sim.letters.values()].map((l) => `${l.key}:${l.state}:${l.x | 0}:${l.y | 0}`).join("|");
  if (sig !== lettersSig) {
    lettersSig = sig;
    letters = [...sim.letters.values()].map((l) => ({ ...l }));
  }

  const flyers = sim.flyers;
  sim.flyers = [];

  const msg: FrameMsg = {
    type: "frame",
    tick: sim.tick,
    envNow: sim.envNow,
    speed,
    n,
    antF: fBuf,
    antU: uBuf,
    broodN: bn,
    brood: bBuf,
    changes,
    ground: groundChanged ? sim.world.ground.slice() : null,
    foods: sim.foods.map((q) => ({ id: q.id, kind: q.kind, x: q.x, y: q.y, amount: q.amount, initial: q.initial })),
    corpses: sim.corpses.filter((c) => c.carriedBy < 0).map((c) => ({ x: c.x, y: c.y, heading: c.heading, caste: c.caste })),
    pageAnts: sim.pageAnts.map((p) => ({
      serial: sim!.ants.serial[p.slot],
      x: p.x,
      y: p.y,
      heading: p.heading,
      ch: p.ch,
      carrying: p.carrying,
    })),
    flyers,
    letters,
    alarm,
    water,
    scent,
    lamp: sim.lamp.on,
    slow,
  };
  post(msg, transfer);
}

function anyWater(w: Uint8Array): boolean {
  for (let i = 0; i < w.length; i++) if (w[i]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Visibility: pause when hidden, catch up on return.
// ---------------------------------------------------------------------------

function onHidden() {
  hidden = true;
  stop();
  void save();
}

function onVisible() {
  if (!sim) return;
  hidden = false;
  const now = realNow();
  const gap = now - sim.envNow;
  if (speed > 0 && gap > 1000) {
    if (gap > 60_000) {
      const report = catchUp(sim, gap);
      sim.setNow(now);
      sim.refreshEnv();
      const text = absenceEntry(report);
      if (gap > 10 * 60_000) {
        sim.absenceNotes.push({ at: now, text, elapsedMs: gap });
        post({ type: "returned", report, text });
      }
      // The whole grid may have changed.
      post({
        type: "ready",
        meta: {
          W: sim.W,
          H: sim.H,
          seed: sim.seed,
          deviceClass: sim.deviceClass,
          foundedAt: sim.foundedAt,
          entranceX: sim.world.entranceX,
          gapRow: sim.gapRow,
          popCap: sim.popCap,
        },
        soil: sim.world.soil.slice(),
        ground: sim.world.ground.slice(),
        pileType: sim.world.pileType.slice(),
        pileAmt: sim.world.pileAmt.slice(),
        letters: [...sim.letters.values()],
        absence: null,
        founded: false,
        resetReason: null,
        visits: sim.visits.slice(),
        absenceNotes: sim.absenceNotes.slice(),
      });
      takeChanges(sim.world);
    } else {
      runSteps(Math.round(gap / 1000 / DT));
    }
  }
  sim.setNow(now);
  start();
}

// ---------------------------------------------------------------------------
// Incoming
// ---------------------------------------------------------------------------

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case "init":
        void init(m.params);
        break;
      case "buffers":
        give(m.buffers);
        break;
      case "speed":
        speed = m.speed;
        if (sim && speed > 0) sim.setNow(realNow());
        break;
      case "visibility":
        if (m.hidden) onHidden();
        else if (hidden) onVisible();
        break;
      case "lamp":
        sim?.setLamp(m.x, m.y, m.on);
        break;
      case "knock":
        sim?.knock(m.x, m.y);
        drainEvents();
        break;
      case "offer":
        if (sim && sim.offersThisVisit < 3) sim.offerFood(m.kind, m.x);
        drainEvents();
        postCensus();
        break;
      case "page":
        sim?.setPage(m.info);
        break;
      case "restore":
        sim?.restoreLetters();
        drainEvents();
        if (params?.persist) void save();
        break;
      case "inspect":
        inspectSerial = m.serial;
        postInspect();
        break;
      case "chemistry":
        chemistry = m.on;
        break;
      case "popScale":
        if (sim) sim.popCap = Math.round(basePopCap * m.factor);
        break;
      case "save":
        void save();
        break;
      case "summary":
        if (sim) post({ type: "summary", facts: nowFacts(sim, takeCensus(sim)) });
        break;
      case "reset":
        stop();
        void (async () => {
          await clearSnapshot();
          sim = null;
          if (params) await init({ ...params, fresh: true, seed: null });
        })();
        break;
      case "force":
        if (!sim) break;
        if (m.what === "flight") sim.startFlight();
        if (m.what === "collapse") sim.collapse(sim.world.entranceX + 8, ROW.ground + 30, 3);
        if (m.what === "escape") sim.gapFound = true;
        drainEvents();
        break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
