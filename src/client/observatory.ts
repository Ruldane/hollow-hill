/**
 * The Observatory: everything between the colony worker and the page that is
 * not React. It owns the animation loop, the camera (derived from scroll,
 * read once per frame, never from scroll listeners), pointer input on the
 * glass, the letters on the page, the notebook grammar, adaptive quality and
 * the test hooks.
 */
import { FoodKind, ROW } from "../sim/constants";
import { OFFERS_PER_VISIT } from "../sim/census";
import { Notebook, absenceEntry, nowSummary, type Note } from "../notes/grammar";
import { ColonyClient } from "./colony-client";
import { LetterManager } from "./letters";
import { Store, initialUi, type Tool, type UiState } from "./store";
import { Renderer, TIERS } from "../render/renderer";
import { PageLayer } from "../render/page-layer";
import { FrameMonitor, initialDeviceClass } from "../render/perf";
import type { InitParams } from "../worker/protocol";

export interface UrlOptions {
  seed: number | null;
  clockOffset: number;
  weather: "rain" | "dry" | null;
  fresh: boolean;
  popCap: number | null;
  persist: boolean;
  still: boolean | null;
  debug: boolean;
  speed: number;
  start: number | null;
}

export function readUrlOptions(): UrlOptions {
  const q = new URLSearchParams(window.location.search);
  let clockOffset = 0;
  const clock = q.get("clock");
  if (clock) {
    const rel = /^([+-]?\d+(?:\.\d+)?)(h|d|m)$/.exec(clock);
    if (rel) {
      const n = parseFloat(rel[1]);
      clockOffset = n * (rel[2] === "d" ? 86_400_000 : rel[2] === "h" ? 3_600_000 : 60_000);
    } else {
      const t = Date.parse(clock);
      if (!Number.isNaN(t)) clockOffset = t - Date.now();
    }
  }
  const weather = q.get("weather");
  return {
    seed: q.has("seed") ? Number(q.get("seed")) >>> 0 : null,
    clockOffset,
    weather: weather === "rain" || weather === "dry" ? weather : null,
    fresh: q.has("fresh"),
    popCap: q.has("pop") ? Math.max(20, Number(q.get("pop"))) : null,
    persist: q.get("persist") !== "0",
    still: q.has("still") ? q.get("still") !== "0" : null,
    debug: q.has("debug"),
    speed: q.has("speed") ? Number(q.get("speed")) : 1,
    start: q.has("start") ? Number(q.get("start")) : null,
  };
}

interface Layout {
  cell: number;
  glassH: number;
  glassTop: number;
  glassLeft: number;
  glassW: number;
  viewW: number;
  viewH: number;
  W: number;
  H: number;
}

export class Observatory {
  readonly store = new Store<UiState>(initialUi);
  readonly client = new ColonyClient();
  readonly letters = new LetterManager();
  private notebook = new Notebook();
  renderer: Renderer | null = null;
  page: PageLayer | null = null;
  private monitor: FrameMonitor | null = null;
  private stage: HTMLCanvasElement | null = null;
  private glass: HTMLElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private lensCanvas: HTMLCanvasElement | null = null;
  private lensEl: HTMLElement | null = null;
  private layout: Layout = { cell: 4.5, glassH: 3000, glassTop: 0, glassLeft: 0, glassW: 800, viewW: 1280, viewH: 800, W: 180, H: 720 };
  private raf = 0;
  private started = false;
  private disposed = false;
  private pointer = { x: 0, y: 0, inside: false, kind: "mouse" as string };
  /** Touch instruments: world positions of the lamp and the lens. */
  private touchLamp: { x: number; y: number } | null = null;
  private touchLens: { x: number; y: number } | null = null;
  private lastLampSend = 0;
  private lastLampState = "";
  private lastScrollY = -1;
  private lastDrawAt = 0;
  private needsDraw = true;
  private lastPerf = 0;
  private lastAnnounce = 0;
  private programmaticScroll = 0;
  private pageInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];
  private opts: UrlOptions | null = null;
  private knockShake = 0;
  bookFont = "Georgia, serif";
  labelFont = "Georgia, serif";

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    const opts = readUrlOptions();
    this.opts = opts;
    const width = window.innerWidth;
    const guess = initialDeviceClass(width);
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const touch = window.matchMedia("(pointer: coarse)").matches;
    let narrate = false;
    let stillPref: boolean | null = null;
    try {
      narrate = window.localStorage.getItem("hh:narrate") === "1";
      const sp = window.localStorage.getItem("hh:still");
      stillPref = sp === null ? null : sp === "1";
    } catch {
      /* storage unavailable */
    }
    const still = opts.still ?? stillPref ?? mq.matches;
    this.store.set({ systemReduced: mq.matches, still, touch, narrate, debug: opts.debug, speed: opts.speed });
    document.documentElement.dataset.still = still ? "1" : "0";
    const onMq = () => {
      this.store.set({ systemReduced: mq.matches });
      if (opts.still === null && stillPref === null) this.setStill(mq.matches, false);
    };
    mq.addEventListener("change", onMq);
    this.cleanups.push(() => mq.removeEventListener("change", onMq));

    this.monitor = new FrameMonitor(guess.tier, TIERS.length - 1);
    this.monitor.onTier = (tier) => {
      this.renderer?.setTier(tier);
      this.client.popScale(tier >= TIERS.length - 1 ? 0.7 : 1);
      this.needsDraw = true;
    };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
    const params: InitParams = {
      deviceClass: guess.device,
      timeZone: tz,
      offsetMinutes: -new Date(Date.now() + opts.clockOffset).getTimezoneOffset(),
      clockOffset: opts.clockOffset,
      seed: opts.seed,
      fresh: opts.fresh,
      weather: opts.weather,
      popCap: opts.popCap,
      speed: opts.speed,
      persist: opts.persist,
      startFraction: opts.start,
    };
    this.wireClient();
    this.client.start(params);

    const onVis = () => {
      const hidden = document.visibilityState === "hidden";
      this.client.visibility(hidden);
      if (!hidden) this.needsDraw = true;
    };
    document.addEventListener("visibilitychange", onVis);
    const onPageHide = () => this.client.save();
    window.addEventListener("pagehide", onPageHide);
    const onResize = () => this.measure();
    window.addEventListener("resize", onResize);
    // Any deliberate scrolling by the visitor ends camera tracking.
    const cancelFollow = () => {
      if (performance.now() - this.programmaticScroll > 120 && this.store.get().follow) this.store.set({ follow: false });
    };
    window.addEventListener("wheel", cancelFollow, { passive: true });
    window.addEventListener("touchmove", cancelFollow, { passive: true });
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) cancelFollow();
      if (e.key === "Escape") {
        const st = this.store.get();
        if (st.summary) this.store.set({ summary: null });
        else if (st.notebookOpen) this.store.set({ notebookOpen: false });
        else if (st.returnNote) this.store.set({ returnNote: null });
        else if (st.tool !== "observe") this.setTool("observe");
        else if (st.selected !== null) this.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    this.cleanups.push(() => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", cancelFollow);
      window.removeEventListener("touchmove", cancelFollow);
      window.removeEventListener("keydown", onKey);
    });

    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.readFonts();
        this.measure();
      });
    }

    this.installTestHooks();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.pageInfoTimer) clearTimeout(this.pageInfoTimer);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.client.save();
    this.client.dispose();
    const w = window as unknown as { __hollow?: unknown };
    if (w.__hollow && (w.__hollow as { owner?: unknown }).owner === this) delete w.__hollow;
  }

  private readFonts() {
    const probe = document.querySelector<HTMLElement>("[data-font-book]");
    if (probe) {
      const fam = getComputedStyle(probe).fontFamily;
      if (fam) this.bookFont = fam;
    }
    const label = document.querySelector<HTMLElement>("[data-font-label]");
    if (label) this.labelFont = getComputedStyle(label).fontFamily || this.labelFont;
    if (this.renderer) {
      this.renderer.bookFont = this.bookFont;
      this.renderer.labelFont = this.labelFont;
    }
    if (this.page) this.page.bookFont = this.bookFont;
  }

  private wireClient() {
    const c = this.client;
    c.onReady.on((info) => {
      const W = info.meta.W;
      document.documentElement.style.setProperty("--world-w", String(W));
      this.layout.W = W;
      this.layout.H = info.meta.H;
      if (this.stage && !this.renderer) this.makeRenderer();
      this.renderer?.worldReady();
      const patch: Partial<UiState> = {
        ready: true,
        meta: info.meta,
        founded: info.founded,
        resetReason: info.resetReason,
        visits: info.visits,
        absenceNotes: info.absenceNotes,
      };
      if (info.absence && info.absence.report.elapsedMs > 3 * 60_000) {
        patch.returnNote = { text: info.absence.text, report: info.absence.report };
        this.say(info.absence.text, true);
      }
      this.store.set(patch);
      this.measure();
      this.needsDraw = true;
    });
    c.onCensus.on((census) => {
      this.store.set({ census });
      if (this.renderer) {
        const e = census.env;
        this.renderer.light = {
          daylight: e.daylight,
          sunAltitude: e.sunAltitude,
          localHour: e.localHour,
          moonPhase: e.moonPhase,
          rain: e.rain,
          lampLit: e.lampLit,
          season: e.season,
          warmth: e.warmth,
        };
      }
      document.documentElement.dataset.lamp = census.env.lampLit ? "lit" : "out";
      document.documentElement.style.setProperty("--daylight", census.env.daylight.toFixed(3));
    });
    c.onEvents.on(({ events, envNow, localHour }) => {
      const census = this.store.get().census;
      const fresh: Note[] = [];
      for (const e of events) {
        if (e.type === "letter-taken") this.letters.hide(e.key);
        if (e.type === "letters-restored") this.letters.showAll();
        const note = this.notebook.compose(e, {
          now: envNow,
          localHour,
          stores: census?.stores ?? 0,
          population: census?.population ?? 0,
          chambers: census?.chambers ?? 0,
          random: Math.random,
        });
        if (note) fresh.push(note);
      }
      if (events.some((e) => e.type === "letter-taken" || e.type === "letters-restored")) this.schedulePageInfo(300);
      if (fresh.length) {
        this.store.set((s) => ({ notes: [...fresh.reverse(), ...s.notes].slice(0, 80) }));
        const loud = fresh.find((n) => n.weight >= 3) ?? fresh.find((n) => n.weight >= 2);
        if (loud) this.say(loud.text, false);
      }
    });
    c.onInspect.on((card) => this.store.set({ card }));
    c.onSummary.on((facts) => {
      const text = nowSummary(facts);
      this.store.set({ summary: text });
      this.say(text, true);
    });
    c.onFlyers.on((flyers) => {
      if (!this.page) return;
      const L = this.layout;
      const top = this.glassTopNow();
      this.page.launch(
        flyers,
        (f) => ({ x: L.glassLeft + f.x * L.cell - window.scrollX, y: top + f.y * L.cell }),
        performance.now(),
      );
    });
    c.onReturned.on(({ report, text }) => {
      this.store.set((s) => ({
        returnNote: { text, report },
        absenceNotes: [...s.absenceNotes, { at: Date.now(), text, elapsedMs: report.elapsedMs }],
      }));
      this.say(text, true);
    });
    c.onLetters.on((letters) => {
      this.letters.sync(letters.map((l) => l.key));
      const words: Record<string, { word: string; index: number }> = {};
      for (const l of letters) {
        const w = this.letters.wordFor(l.key);
        if (w) words[l.key] = w;
      }
      this.store.set({ letters, letterWords: words });
    });
    c.onSaved.on((at) => this.store.set({ savedAt: at }));
    c.onError.on((message) => this.store.set({ error: message }));
  }

  /** Polite, rate-limited narration for screen readers (only when asked for). */
  private say(text: string, force: boolean) {
    const s = this.store.get();
    const now = performance.now();
    if (!force && (!s.narrate || now - this.lastAnnounce < 45_000)) return;
    this.lastAnnounce = now;
    this.store.set({ announce: text });
  }

  // ------------------------------------------------------------------------
  // DOM attachment
  // ------------------------------------------------------------------------

  attachStage(canvas: HTMLCanvasElement | null, glass: HTMLElement | null) {
    this.stage = canvas;
    this.glass = glass;
    if (!canvas || !glass) return;
    if (this.client.world && !this.renderer) this.makeRenderer();
    const onMove = (e: PointerEvent) => this.onPointerMove(e);
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      this.pointer.inside = false;
      this.needsDraw = true;
      this.sendLamp(true);
    };
    const onClick = (e: MouseEvent) => this.onGlassClick(e);
    glass.addEventListener("pointermove", onMove);
    glass.addEventListener("pointerdown", onMove);
    glass.addEventListener("pointerleave", onLeave);
    glass.addEventListener("click", onClick);
    const ro = new ResizeObserver(() => this.measure());
    ro.observe(glass);
    this.cleanups.push(() => {
      glass.removeEventListener("pointermove", onMove);
      glass.removeEventListener("pointerdown", onMove);
      glass.removeEventListener("pointerleave", onLeave);
      glass.removeEventListener("click", onClick);
      ro.disconnect();
    });
    this.measure();
  }

  attachOverlay(canvas: HTMLCanvasElement | null) {
    this.overlay = canvas;
    if (canvas) {
      this.page = new PageLayer(canvas, this.client);
      this.page.bookFont = this.bookFont;
      this.page.reducedMotion = this.store.get().still;
      this.measure();
    }
  }

  attachLens(el: HTMLElement | null, canvas: HTMLCanvasElement | null) {
    this.lensEl = el;
    this.lensCanvas = canvas;
  }

  private makeRenderer() {
    if (!this.stage || !this.client.world) return;
    this.renderer = new Renderer(this.stage, this.client, this.client.world.meta.seed);
    this.renderer.bookFont = this.bookFont;
    this.renderer.labelFont = this.labelFont;
    this.renderer.reducedMotion = this.store.get().still;
    this.renderer.tierIndex = this.monitor?.tier ?? 0;
    this.renderer.worldReady();
    this.measure();
  }

  // ------------------------------------------------------------------------
  // Layout and camera
  // ------------------------------------------------------------------------

  private glassTopNow(): number {
    // Viewport y of the top of the glass (world row 0).
    return this.layout.glassTop - window.scrollY;
  }

  measure() {
    if (!this.glass) return;
    const r = this.glass.getBoundingClientRect();
    const L = this.layout;
    L.glassTop = r.top + window.scrollY;
    L.glassLeft = r.left + window.scrollX;
    L.glassW = r.width;
    L.glassH = r.height;
    L.viewW = window.innerWidth;
    L.viewH = window.innerHeight;
    L.cell = r.width / L.W;
    const dpr = window.devicePixelRatio || 1;
    if (this.stage) {
      this.stage.style.width = `${r.width}px`;
      this.stage.style.height = `${L.viewH}px`;
    }
    this.renderer?.applyViewport(r.width, L.viewH, L.cell, dpr);
    if (this.page) {
      this.page.resize(L.viewW, L.viewH, dpr);
      this.page.cellPx = L.cell;
    }
    this.needsDraw = true;
    this.schedulePageInfo(250);
  }

  private camRow(): number {
    const L = this.layout;
    const rows = L.viewH / L.cell;
    const raw = (window.scrollY - L.glassTop) / L.cell;
    return Math.max(0, Math.min(L.glassH / L.cell - rows, raw));
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.stage) return null;
    const r = this.stage.getBoundingClientRect();
    const L = this.layout;
    const x = (clientX - r.left) / L.cell;
    const y = this.camRow() + (clientY - r.top) / L.cell;
    if (x < 0 || x > L.W || y < 0 || y > L.H) return null;
    return { x, y };
  }

  /** Where the gap in the frame is, in document coordinates, and the letters. */
  private schedulePageInfo(delay: number) {
    if (this.pageInfoTimer) clearTimeout(this.pageInfoTimer);
    this.pageInfoTimer = setTimeout(() => this.sendPageInfo(), delay);
  }

  private sendPageInfo() {
    if (!this.glass || !this.client.world) return;
    const L = this.layout;
    const meta = this.client.world.meta;
    const letters = this.letters.scan();
    const doc = document.documentElement;
    const small = L.viewW < 700;
    this.client.setPage({
      letters,
      gapX: L.glassLeft + L.glassW + (small ? 5 : 12),
      gapY: L.glassTop + meta.gapRow * L.cell,
      width: doc.scrollWidth,
      height: doc.scrollHeight,
      cellPx: L.cell,
      maxAnts: small ? 3 : L.viewW < 1100 ? 4 : 6,
      maxStolen: small ? 10 : 24,
    });
  }

  // ------------------------------------------------------------------------
  // Input on the glass
  // ------------------------------------------------------------------------

  private onPointerMove(e: PointerEvent) {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.kind = e.pointerType;
    if (e.pointerType === "touch") return;
    this.pointer.inside = true;
    this.needsDraw = true;
    this.sendLamp(false);
  }

  private sendLamp(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastLampSend < 90) return;
    this.lastLampSend = now;
    let on = false;
    let x = 0;
    let y = 0;
    if (this.touchLamp) {
      on = true;
      x = this.touchLamp.x;
      y = this.touchLamp.y;
    } else if (this.pointer.inside && this.pointer.kind !== "touch") {
      const w = this.toWorld(this.pointer.x, this.pointer.y);
      if (w) {
        on = true;
        x = w.x;
        y = w.y;
      }
    }
    if (this.renderer) this.renderer.lamp = { x, y, on };
    const key = on ? `${x.toFixed(1)}:${y.toFixed(1)}` : "off";
    if (key !== this.lastLampState) {
      this.lastLampState = key;
      this.client.lamp(x, y, on);
    }
  }

  private onGlassClick(e: MouseEvent) {
    const w = this.toWorld(e.clientX, e.clientY);
    if (!w) return;
    const tool = this.store.get().tool;
    if (tool === "knock") {
      this.knockAt(w.x, w.y);
      this.store.set({ tool: "observe" });
      return;
    }
    if (tool === "crumb" || tool === "honey") {
      this.offer(tool === "honey" ? FoodKind.Honey : FoodKind.Crumb, w.x);
      this.setTool("observe");
      return;
    }
    const radius = Math.max(3.2, 14 / this.layout.cell);
    const serial = this.renderer?.pick(w.x, w.y, radius) ?? null;
    if (serial !== null) this.select(serial);
  }

  // ------------------------------------------------------------------------
  // Commands (used by the brass controls)
  // ------------------------------------------------------------------------

  setSpeed(speed: number) {
    this.client.setSpeed(speed);
    this.store.set({ speed });
    this.needsDraw = true;
  }

  setTool(tool: Tool) {
    this.store.set({ tool: this.store.get().tool === tool ? "observe" : tool });
  }

  knockAt(x: number, y: number) {
    this.client.knock(x, y);
    this.knockShake = performance.now();
    if (!this.store.get().still && this.glass) {
      this.glass.classList.remove("knocked");
      void this.glass.offsetWidth;
      this.glass.classList.add("knocked");
    }
  }

  /** Keyboard: knock at the middle of the glass currently in view. */
  knockAtCentre() {
    const L = this.layout;
    const rows = L.viewH / L.cell;
    this.knockAt(L.W / 2, this.camRow() + rows * 0.45);
    this.store.set({ message: "You knocked on the glass." });
  }

  offer(kind: number, x: number) {
    const census = this.store.get().census;
    if (census && census.offersLeft <= 0) {
      this.store.set({ message: `No more offerings this visit. You may leave ${OFFERS_PER_VISIT} each time you come.` });
      return;
    }
    this.client.offer(kind, Math.max(2, Math.min(this.layout.W - 3, x)));
    this.store.set({ message: kind === FoodKind.Honey ? "A drop of honey, set on the surface." : "A crumb, set on the surface." });
  }

  offerAtSurface(kind: number) {
    const x = this.layout.W * (0.15 + Math.random() * 0.7);
    this.offer(kind, x);
  }

  select(serial: number | null) {
    if (serial === null) {
      this.store.set({ selected: null, card: null, follow: false });
      this.client.inspect(null);
    } else {
      this.store.set({ selected: serial });
      this.client.inspect(serial);
      // On narrow screens the card is a sheet at the foot: lift the ant above it.
      if (this.layout.viewW < 1100) {
        const y = this.docYOf(serial);
        if (y !== null) {
          this.programmaticScroll = performance.now();
          window.scrollTo({ top: Math.max(0, y - this.layout.viewH * 0.26), behavior: this.store.get().still ? "instant" : "smooth" });
        }
      }
    }
    if (this.renderer) this.renderer.selected = serial;
    this.needsDraw = true;
  }

  /** Choose a specimen near the middle of the view. */
  selectNearCentre() {
    const r = this.renderer;
    if (!r || !r.positions.n) return;
    const L = this.layout;
    const rows = L.viewH / L.cell;
    const cy = this.camRow() + rows * 0.5;
    const all = r.positions.list();
    const visible = all.filter((p) => Math.abs(p.y - cy) < rows * 0.45);
    const pool = visible.length ? visible : all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.select(pick.serial);
  }

  setFollow(on: boolean) {
    if (this.store.get().still && on) {
      this.jumpToSelected();
      return;
    }
    this.store.set({ follow: on });
  }

  jumpToSelected() {
    const s = this.store.get().selected;
    if (s === null) return;
    const y = this.docYOf(s);
    if (y === null) return;
    this.programmaticScroll = performance.now();
    window.scrollTo({ top: Math.max(0, y - this.layout.viewH * 0.45), behavior: "instant" as ScrollBehavior });
  }

  private docYOf(serial: number): number | null {
    const p = this.renderer?.positionOf(serial);
    if (p) return this.layout.glassTop + p.y * this.layout.cell;
    const onPage = this.client.pageAnts.find((a) => a.serial === serial);
    return onPage ? onPage.y : null;
  }

  toggleLens() {
    const on = !this.store.get().lens;
    this.store.set({ lens: on });
    if (on && this.store.get().touch) {
      const L = this.layout;
      this.touchLens = { x: L.W / 2, y: this.camRow() + (L.viewH / L.cell) * 0.4 };
    }
    if (!on) this.touchLens = null;
    this.client.chemistry(on || this.store.get().chemistry);
    this.needsDraw = true;
  }

  toggleChemistry() {
    const on = !this.store.get().chemistry;
    this.store.set({ chemistry: on });
    if (this.renderer) this.renderer.chemistry = on;
    this.client.chemistry(on || this.store.get().lens);
    this.needsDraw = true;
  }

  /** Touch: place or remove the observation lamp. */
  toggleTouchLamp() {
    if (this.touchLamp) this.touchLamp = null;
    else {
      const L = this.layout;
      this.touchLamp = { x: L.W / 2, y: this.camRow() + (L.viewH / L.cell) * 0.5 };
    }
    this.sendLamp(true);
    this.needsDraw = true;
    return this.touchLamp !== null;
  }

  /** Touch: drag an instrument by its handle (client coordinates). */
  dragInstrument(which: "lamp" | "lens", clientX: number, clientY: number) {
    const w = this.toWorld(clientX, clientY);
    if (!w) return;
    if (which === "lamp") {
      this.touchLamp = w;
      this.sendLamp(false);
    } else this.touchLens = w;
    this.needsDraw = true;
  }

  instrumentPosition(which: "lamp" | "lens"): { x: number; y: number } | null {
    const p = which === "lamp" ? this.touchLamp : this.touchLens;
    if (!p || !this.stage) return null;
    const r = this.stage.getBoundingClientRect();
    return { x: r.left + p.x * this.layout.cell, y: r.top + (p.y - this.camRow()) * this.layout.cell };
  }

  restoreLetters() {
    this.client.restore();
    this.letters.showAll();
    this.store.set({ message: "The notebook is restored." });
  }

  requestSummary() {
    this.client.summary();
  }

  setStill(still: boolean, remember = true) {
    this.store.set({ still });
    if (this.renderer) this.renderer.reducedMotion = still;
    if (this.page) this.page.reducedMotion = still;
    if (still) this.store.set({ follow: false });
    document.documentElement.dataset.still = still ? "1" : "0";
    if (remember) {
      try {
        window.localStorage.setItem("hh:still", still ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
    this.needsDraw = true;
  }

  setNarrate(on: boolean) {
    this.store.set({ narrate: on });
    try {
      window.localStorage.setItem("hh:narrate", on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  resetColony() {
    this.select(null);
    this.letters.showAll();
    this.store.set({ notes: [], returnNote: null, ready: false });
    this.client.reset();
  }

  // ------------------------------------------------------------------------
  // The loop
  // ------------------------------------------------------------------------

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const r = this.renderer;
    if (!r || !this.client.world || document.visibilityState === "hidden") {
      this.monitor?.tick(now, false);
      return;
    }
    const s = this.store.get();
    const sy = window.scrollY;
    const scrolled = sy !== this.lastScrollY;
    this.lastScrollY = sy;
    if (scrolled && this.pointer.inside) this.sendLamp(false);

    const paused = s.speed === 0;
    let draw = true;
    const fpsCap = TIERS[r.tierIndex].fpsCap;
    if (s.still) draw = scrolled || this.needsDraw || now - this.lastDrawAt > 3200 || (r.positions.n === 0 && this.client.cur !== null);
    else if (paused) draw = scrolled || this.needsDraw;
    if (draw && fpsCap < 60 && now - this.lastDrawAt < 1000 / fpsCap - 2) draw = false;

    // Camera tracking of a chosen specimen.
    if (s.follow && s.selected !== null && !s.still) {
      const y = this.docYOf(s.selected);
      if (y !== null) {
        const target = Math.max(0, y - this.layout.viewH * 0.45);
        const d = target - sy;
        if (Math.abs(d) > 2) {
          this.programmaticScroll = now;
          window.scrollTo({ top: sy + d * 0.07, behavior: "instant" as ScrollBehavior });
        }
      }
    }

    if (draw) {
      r.draw(this.camRow(), now);
      this.lastDrawAt = now;
      this.needsDraw = false;
    }

    // The lens.
    if (s.lens && this.lensEl && this.lensCanvas) {
      let pos: { x: number; y: number } | null = null;
      let clientPos: { x: number; y: number } | null = null;
      if (this.touchLens) {
        pos = this.touchLens;
        clientPos = this.instrumentPosition("lens");
      } else if (this.pointer.inside) {
        pos = this.toWorld(this.pointer.x, this.pointer.y);
        clientPos = { x: this.pointer.x, y: this.pointer.y };
      }
      if (pos && clientPos && this.stage) {
        const size = this.lensEl.offsetWidth;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (this.lensCanvas.width !== Math.round(size * dpr)) {
          this.lensCanvas.width = Math.round(size * dpr);
          this.lensCanvas.height = Math.round(size * dpr);
        }
        this.lensEl.style.transform = `translate(${clientPos.x - size / 2}px, ${clientPos.y - size / 2}px)`;
        this.lensEl.dataset.visible = "1";
        if (draw || !s.still) r.drawLens(this.lensCanvas, pos.x, pos.y, 3.4, now);
      } else this.lensEl.dataset.visible = "0";
    } else if (this.lensEl) this.lensEl.dataset.visible = "0";

    // The page overlay: escaped ants and the flight.
    if (this.page) {
      const alpha = this.client.cur ? Math.max(0, Math.min(1, (now - this.client.cur.arrived) / this.client.frameInterval)) : 1;
      if (this.page.busy || draw) this.page.draw(window.scrollX, sy, now, alpha);
    }

    this.monitor?.tick(now, draw && !s.still && !paused);
    if (now - this.lastPerf > 1000) {
      this.lastPerf = now;
      const m = this.monitor!;
      this.store.set({
        perf: {
          fps: Math.round(m.fps),
          p90: Math.round(m.p90 * 10) / 10,
          tier: r.tierIndex,
          drawn: r.drawn,
          agents: r.positions.n,
          msPerTick: Math.round(this.client.msPerTick * 100) / 100,
          drawMs: Math.round(r.lastDrawMs * 10) / 10,
        },
      });
    }
  };

  // ------------------------------------------------------------------------
  // Test and inspection hooks (read-only views plus the same commands as the UI)
  // ------------------------------------------------------------------------

  layoutView() {
    return { ...this.layout, camRow: this.camRow() };
  }

  stageRect() {
    return this.stage?.getBoundingClientRect() ?? null;
  }

  private installTestHooks() {
    const self = { store: this.store, client: this.client, letters: this.letters, obs: this };
    (window as unknown as { __hollow: unknown }).__hollow = {
      owner: this,
      ready: () => self.store.get().ready,
      census: () => self.store.get().census,
      tick: () => self.client.cur?.tick ?? -1,
      frames: () => self.client.framesReceived,
      positions: (n = 50) => self.obs.renderer?.positions.list(n) ?? [],
      layout: () => ({ ...self.obs.layoutView(), camRow: self.obs.layoutView().camRow }),
      worldToClient: (x: number, y: number) => {
        const r = self.obs.stageRect();
        if (!r) return null;
        return { x: r.left + x * self.obs.layoutView().cell, y: r.top + (y - self.obs.layoutView().camRow) * self.obs.layoutView().cell };
      },
      pageAnts: () => self.client.pageAnts.map((p) => ({ ...p })),
      letters: () => self.client.letters.map((l) => ({ ...l })),
      takenOnPage: () => self.letters.count,
      foods: () => self.client.foods.map((f) => ({ ...f })),
      card: () => self.store.get().card,
      selected: () => self.store.get().selected,
      notes: () => self.store.get().notes.map((n) => n.text),
      perf: () => self.store.get().perf,
      select: (serial: number) => self.obs.select(serial),
      knock: (x: number, y: number) => self.obs.knockAt(x, y),
      offer: (kind: number, x: number) => self.obs.offer(kind, x),
      force: (what: "flight" | "collapse" | "escape") => self.client.force(what),
      save: () => self.client.save(),
      savedAt: () => self.store.get().savedAt,
      rows: () => ROW,
      absence: () => self.store.get().returnNote,
      entry: absenceEntry,
      skip: (layer: string, on = true) => {
        const r = self.obs.renderer;
        if (!r) return;
        if (on) r.skip.add(layer);
        else r.skip.delete(layer);
      },
      tier: (t: number) => self.obs.renderer?.setTier(t),
    };
  }
}
