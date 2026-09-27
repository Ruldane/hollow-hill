/**
 * Messages between the page and the colony worker.
 *
 * Per-frame data travels as transferred ArrayBuffers (no copying, no
 * SharedArrayBuffer, so no cross-origin isolation is needed); the page
 * returns spent buffers so the worker can reuse them.
 */
import type { DeviceClass } from "../sim/constants";
import type { WeatherOverride } from "../sim/environment";
import type { SimEvent } from "../sim/events";
import type { Census, SpecimenData } from "../sim/census";
import type { AbsenceReport } from "../sim/catchup";
import type { NowFacts } from "../notes/grammar";
import type { AbsenceNote, PageInfo, Visit } from "../sim/sim";
import type { LetterItem } from "../sim/colony";

export interface InitParams {
  deviceClass: DeviceClass;
  timeZone: string;
  offsetMinutes: number;
  /** Added to Date.now() for the environment clock (testing and demonstration). */
  clockOffset: number;
  seed: number | null;
  fresh: boolean;
  weather: WeatherOverride;
  popCap: number | null;
  speed: number;
  persist: boolean;
  startFraction: number | null;
}

export type ToWorker =
  | { type: "init"; params: InitParams }
  | { type: "speed"; speed: number }
  | { type: "visibility"; hidden: boolean }
  | { type: "lamp"; x: number; y: number; on: boolean }
  | { type: "knock"; x: number; y: number }
  | { type: "offer"; kind: number; x: number }
  | { type: "page"; info: PageInfo | null }
  | { type: "restore" }
  | { type: "inspect"; serial: number | null }
  | { type: "buffers"; buffers: ArrayBuffer[] }
  | { type: "chemistry"; on: boolean }
  | { type: "popScale"; factor: number }
  | { type: "save" }
  | { type: "summary" }
  | { type: "reset" }
  | { type: "force"; what: "flight" | "collapse" | "escape" };

export interface WorldMeta {
  W: number;
  H: number;
  seed: number;
  deviceClass: DeviceClass;
  foundedAt: number;
  entranceX: number;
  gapRow: number;
  popCap: number;
}

export interface FoodView {
  id: number;
  kind: number;
  x: number;
  y: number;
  amount: number;
  initial: number;
}

export interface CorpseView {
  x: number;
  y: number;
  heading: number;
  caste: number;
}

export interface PageAntView {
  serial: number;
  x: number;
  y: number;
  heading: number;
  ch: string;
  carrying: string | null;
}

export interface FlyerView {
  serial: number;
  female: boolean;
  x: number;
  y: number;
}

/** Floats per ant: x, y, heading. */
export const ANT_F = 3;
/** Uint32 per ant: slot, serial, packed flags. */
export const ANT_U = 3;
/** Floats per brood item: x, y, stage | alate << 2. */
export const BROOD_F = 3;

export function packAntFlags(caste: number, carry: number, task: number, flags: number, gen: number): number {
  return (caste & 7) | ((carry & 15) << 3) | ((task & 15) << 7) | ((flags & 31) << 11) | ((gen & 255) << 16);
}

export function unpackAntFlags(v: number) {
  return {
    caste: v & 7,
    carry: (v >>> 3) & 15,
    task: (v >>> 7) & 15,
    flags: (v >>> 11) & 31,
    gen: (v >>> 16) & 255,
  };
}

export const FLAG_ALARM = 1;
export const FLAG_RESTING = 2;
export const FLAG_SELECTED = 4;
export const FLAG_HURRY = 8;

export interface FrameMsg {
  type: "frame";
  tick: number;
  envNow: number;
  speed: number;
  n: number;
  antF: ArrayBuffer;
  antU: ArrayBuffer;
  broodN: number;
  brood: ArrayBuffer;
  /** Pairs: [cellIndex, soil | pileType << 8 | pileAmt << 16]. */
  changes: ArrayBuffer | null;
  ground: Int16Array | null;
  foods: FoodView[];
  corpses: CorpseView[];
  pageAnts: PageAntView[];
  flyers: FlyerView[];
  letters: LetterItem[] | null;
  alarm: ArrayBuffer | null;
  water: ArrayBuffer | null;
  scent: { food: ArrayBuffer; home: ArrayBuffer } | null;
  lamp: boolean;
  /** Slow-rate fields (alarm, water) were considered this frame. */
  slow: boolean;
}

export type FromWorker =
  | {
      type: "ready";
      meta: WorldMeta;
      soil: Uint8Array;
      ground: Int16Array;
      pileType: Uint8Array;
      pileAmt: Uint8Array;
      letters: LetterItem[];
      absence: { report: AbsenceReport; text: string } | null;
      founded: boolean;
      resetReason: "schema" | "corrupt" | null;
      visits: Visit[];
      absenceNotes: AbsenceNote[];
    }
  | FrameMsg
  | { type: "census"; census: Census }
  | { type: "events"; events: SimEvent[]; envNow: number; localHour: number }
  | { type: "inspect"; card: SpecimenData | null }
  | { type: "summary"; facts: NowFacts }
  | { type: "saved"; at: number }
  | { type: "perf"; msPerTick: number; population: number; popCap: number }
  | { type: "returned"; report: AbsenceReport; text: string }
  | { type: "error"; message: string };
