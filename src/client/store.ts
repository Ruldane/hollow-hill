/**
 * A small external store for UI state that changes at human pace (tool
 * selection, the census once a second, notes). Per-frame values never go here.
 */
import { useSyncExternalStore } from "react";
import type { Census, SpecimenData } from "../sim/census";
import type { LetterItem } from "../sim/colony";
import type { AbsenceReport } from "../sim/catchup";
import type { AbsenceNote, Visit } from "../sim/sim";
import type { WorldMeta } from "../worker/protocol";
import type { Note } from "../notes/grammar";

export type Tool = "observe" | "knock" | "crumb" | "honey";

export interface UiState {
  ready: boolean;
  error: string | null;
  speed: number;
  tool: Tool;
  lens: boolean;
  chemistry: boolean;
  follow: boolean;
  selected: number | null;
  card: SpecimenData | null;
  census: Census | null;
  notes: Note[];
  returnNote: { text: string; report: AbsenceReport } | null;
  absenceNotes: AbsenceNote[];
  visits: Visit[];
  letters: LetterItem[];
  letterWords: Record<string, { word: string; index: number }>;
  still: boolean;
  systemReduced: boolean;
  narrate: boolean;
  announce: string;
  summary: string | null;
  perf: { fps: number; p90: number; tier: number; drawn: number; agents: number; msPerTick: number; drawMs: number };
  notebookOpen: boolean;
  founded: boolean;
  resetReason: "schema" | "corrupt" | null;
  meta: WorldMeta | null;
  touch: boolean;
  debug: boolean;
  savedAt: number | null;
  message: string | null;
}

export const initialUi: UiState = {
  ready: false,
  error: null,
  speed: 1,
  tool: "observe",
  lens: false,
  chemistry: false,
  follow: false,
  selected: null,
  card: null,
  census: null,
  notes: [],
  returnNote: null,
  absenceNotes: [],
  visits: [],
  letters: [],
  letterWords: {},
  still: false,
  systemReduced: false,
  narrate: false,
  announce: "",
  summary: null,
  perf: { fps: 0, p90: 0, tier: 0, drawn: 0, agents: 0, msPerTick: 0, drawMs: 0 },
  notebookOpen: false,
  founded: false,
  resetReason: null,
  meta: null,
  touch: false,
  debug: false,
  savedAt: null,
  message: null,
};

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<() => void>();
  constructor(initial: T) {
    this.state = initial;
  }
  get = () => this.state;
  set(patch: Partial<T> | ((s: T) => Partial<T>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const k in p) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
}

export function useStoreValue<T extends object, R>(store: Store<T>, select: (s: T) => R): R {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}
