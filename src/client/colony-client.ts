/**
 * The page's side of the worker bridge.
 *
 * Owns the worker, mirrors the soil grid from deltas, keeps the last two
 * frames for interpolation, returns spent buffers to the worker's pool, and
 * fans out census, events and specimen readings to subscribers. Nothing here
 * touches React state per frame.
 */
import type { Census, SpecimenData } from "../sim/census";
import type { SimEvent } from "../sim/events";
import type { LetterItem } from "../sim/colony";
import type { NowFacts } from "../notes/grammar";
import type { AbsenceReport } from "../sim/catchup";
import type { AbsenceNote, PageInfo, Visit } from "../sim/sim";
import type {
  CorpseView,
  FlyerView,
  FoodView,
  FrameMsg,
  FromWorker,
  InitParams,
  PageAntView,
  ToWorker,
  WorldMeta,
} from "../worker/protocol";

export interface Frame {
  tick: number;
  envNow: number;
  arrived: number;
  n: number;
  f: Float32Array;
  u: Uint32Array;
  broodN: number;
  brood: Float32Array;
  buffers: ArrayBuffer[];
}

export interface WorldMirror {
  meta: WorldMeta;
  soil: Uint8Array;
  ground: Int16Array;
  pileType: Uint8Array;
  pileAmt: Uint8Array;
  /** Cells changed since the renderer last looked. */
  dirty: number[];
  version: number;
  groundVersion: number;
}

type Listener<T> = (v: T) => void;

class Channel<T> {
  private ls = new Set<Listener<T>>();
  on(l: Listener<T>) {
    this.ls.add(l);
    return () => void this.ls.delete(l);
  }
  emit(v: T) {
    for (const l of this.ls) l(v);
  }
}

export interface ReadyInfo {
  meta: WorldMeta;
  founded: boolean;
  resetReason: "schema" | "corrupt" | null;
  absence: { report: AbsenceReport; text: string } | null;
  visits: Visit[];
  absenceNotes: AbsenceNote[];
}

export class ColonyClient {
  private worker: Worker | null = null;
  world: WorldMirror | null = null;
  prev: Frame | null = null;
  cur: Frame | null = null;
  frameInterval = 50;
  foods: FoodView[] = [];
  corpses: CorpseView[] = [];
  pageAnts: PageAntView[] = [];
  prevPageAnts: PageAntView[] = [];
  letters: LetterItem[] = [];
  alarm: Uint8Array | null = null;
  alarmVersion = 0;
  water: Uint8Array | null = null;
  waterVersion = 0;
  scent: { food: Uint8Array; home: Uint8Array } | null = null;
  scentVersion = 0;
  census: Census | null = null;
  speed = 1;
  msPerTick = 0;
  popCap = 0;
  lastFrameAt = 0;
  framesReceived = 0;
  private spare: ArrayBuffer[] = [];

  readonly onReady = new Channel<ReadyInfo>();
  readonly onEvents = new Channel<{ events: SimEvent[]; envNow: number; localHour: number }>();
  readonly onCensus = new Channel<Census>();
  readonly onInspect = new Channel<SpecimenData | null>();
  readonly onSummary = new Channel<NowFacts>();
  readonly onFlyers = new Channel<FlyerView[]>();
  readonly onReturned = new Channel<{ report: AbsenceReport; text: string }>();
  readonly onLetters = new Channel<LetterItem[]>();
  readonly onSaved = new Channel<number>();
  readonly onError = new Channel<string>();

  start(params: InitParams): void {
    this.worker = new Worker(new URL("../worker/colony.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.receive(ev.data);
    this.worker.onerror = (ev) => this.onError.emit(ev.message || "worker error");
    this.speed = params.speed;
    this.send({ type: "init", params });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  // Commands ---------------------------------------------------------------

  setSpeed(speed: number) {
    this.speed = speed;
    this.send({ type: "speed", speed });
  }
  knock(x: number, y: number) {
    this.send({ type: "knock", x, y });
  }
  offer(kind: number, x: number) {
    this.send({ type: "offer", kind, x });
  }
  lamp(x: number, y: number, on: boolean) {
    this.send({ type: "lamp", x, y, on });
  }
  setPage(info: PageInfo | null) {
    this.send({ type: "page", info });
  }
  restore() {
    this.send({ type: "restore" });
  }
  inspect(serial: number | null) {
    this.send({ type: "inspect", serial });
  }
  chemistry(on: boolean) {
    this.send({ type: "chemistry", on });
  }
  popScale(factor: number) {
    this.send({ type: "popScale", factor });
  }
  summary() {
    this.send({ type: "summary" });
  }
  visibility(hidden: boolean) {
    this.send({ type: "visibility", hidden });
  }
  save() {
    this.send({ type: "save" });
  }
  reset() {
    this.send({ type: "reset" });
  }
  force(what: "flight" | "collapse" | "escape") {
    this.send({ type: "force", what });
  }

  // Incoming ---------------------------------------------------------------

  private receive(m: FromWorker): void {
    switch (m.type) {
      case "ready": {
        this.world = {
          meta: m.meta,
          soil: m.soil,
          ground: m.ground,
          pileType: m.pileType,
          pileAmt: m.pileAmt,
          dirty: [],
          version: (this.world?.version ?? 0) + 1,
          groundVersion: (this.world?.groundVersion ?? 0) + 1,
        };
        this.letters = m.letters;
        this.popCap = m.meta.popCap;
        this.onLetters.emit(this.letters);
        this.onReady.emit({
          meta: m.meta,
          founded: m.founded,
          resetReason: m.resetReason,
          absence: m.absence,
          visits: m.visits,
          absenceNotes: m.absenceNotes,
        });
        break;
      }
      case "frame":
        this.takeFrame(m);
        break;
      case "census":
        this.census = m.census;
        this.onCensus.emit(m.census);
        break;
      case "events":
        this.onEvents.emit({ events: m.events, envNow: m.envNow, localHour: m.localHour });
        break;
      case "inspect":
        this.onInspect.emit(m.card);
        break;
      case "summary":
        this.onSummary.emit(m.facts);
        break;
      case "perf":
        this.msPerTick = m.msPerTick;
        this.popCap = m.popCap;
        break;
      case "returned":
        this.onReturned.emit({ report: m.report, text: m.text });
        break;
      case "saved":
        this.onSaved.emit(m.at);
        break;
      case "error":
        this.onError.emit(m.message);
        break;
    }
  }

  private takeFrame(m: FrameMsg): void {
    const now = performance.now();
    const w = this.world;
    if (w && m.changes) {
      const c = new Uint32Array(m.changes);
      for (let i = 0; i < c.length; i += 2) {
        const idx = c[i];
        const v = c[i + 1];
        w.soil[idx] = v & 255;
        w.pileType[idx] = (v >>> 8) & 255;
        w.pileAmt[idx] = (v >>> 16) & 255;
        w.dirty.push(idx);
      }
      w.version++;
    }
    if (w && m.ground) {
      w.ground = m.ground;
      w.groundVersion++;
    }
    if (m.alarm) {
      if (this.alarm) this.spare.push(this.alarm.buffer as ArrayBuffer);
      this.alarm = new Uint8Array(m.alarm, 0, w ? w.meta.W * w.meta.H : m.alarm.byteLength);
      this.alarmVersion++;
    } else if (this.alarm && m.slow) {
      // No alarm left in the soil.
      this.spare.push(this.alarm.buffer as ArrayBuffer);
      this.alarm = null;
      this.alarmVersion++;
    }
    if (m.water) {
      if (this.water) this.spare.push(this.water.buffer as ArrayBuffer);
      this.water = new Uint8Array(m.water, 0, w ? w.meta.W * w.meta.H : m.water.byteLength);
      this.waterVersion++;
    }
    if (m.scent) {
      if (this.scent) this.spare.push(this.scent.food.buffer as ArrayBuffer, this.scent.home.buffer as ArrayBuffer);
      const n = w ? w.meta.W * w.meta.H : m.scent.food.byteLength;
      this.scent = { food: new Uint8Array(m.scent.food, 0, n), home: new Uint8Array(m.scent.home, 0, n) };
      this.scentVersion++;
    }
    this.foods = m.foods;
    this.corpses = m.corpses;
    this.prevPageAnts = this.pageAnts;
    this.pageAnts = m.pageAnts;
    if (m.flyers.length) this.onFlyers.emit(m.flyers);
    if (m.letters) {
      this.letters = m.letters;
      this.onLetters.emit(m.letters);
    }

    const frame: Frame = {
      tick: m.tick,
      envNow: m.envNow,
      arrived: now,
      n: m.n,
      f: new Float32Array(m.antF, 0, m.n * 3),
      u: new Uint32Array(m.antU, 0, m.n * 3),
      broodN: m.broodN,
      brood: new Float32Array(m.brood, 0, m.broodN * 3),
      buffers: [m.antF, m.antU, m.brood],
    };
    if (this.cur && this.cur.tick !== frame.tick) {
      if (this.prev) this.spare.push(...this.prev.buffers);
      this.prev = this.cur;
      const gap = now - this.lastFrameAt;
      if (gap > 0 && gap < 400) this.frameInterval = this.frameInterval * 0.85 + gap * 0.15;
    } else if (this.cur) {
      this.spare.push(...this.cur.buffers);
    }
    this.cur = frame;
    this.lastFrameAt = now;
    this.framesReceived++;
    if (this.spare.length >= 6) {
      const give = this.spare;
      this.spare = [];
      this.send({ type: "buffers", buffers: give }, give);
    }
  }
}
