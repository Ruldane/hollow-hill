/**
 * The formicarium renderer (Canvas 2D, main thread, budgeted).
 *
 * Layers, back to front: sky and weather; the back wall of the glass case
 * seen through hollows; engraved soil tiles; water; alarm scent; floor
 * piles, brood, food and the dead; grass; ants; light (depth, the time of
 * day, the laboratory lamp, the observer's lamp); the selected specimen.
 *
 * Agents are interpolated between the last two worker frames. The camera is
 * a world row derived from scroll; nothing here touches React state.
 */
import { Carry, Caste, Mat, Pile, ROW } from "../sim/constants";
import { hash01 } from "../sim/rng";
import type { ColonyClient, Frame } from "../client/colony-client";
import { FLAG_ALARM, FLAG_SELECTED } from "../worker/protocol";
import { BODY_CELLS, antSprite, broodSprite, clearSpriteCache, drawCarried, type Sprite } from "./sprites";
import { SoilTiles } from "./soil-tiles";
import { BONE, CAVITY, HONEY, INK, VERMILION, rgba } from "./palette";

export interface Light {
  daylight: number;
  sunAltitude: number;
  localHour: number;
  moonPhase: number;
  rain: number;
  lampLit: boolean;
  season: string;
  warmth: number;
}

export interface Tier {
  dprCap: number;
  detail: boolean;
  grass: number;
  fpsCap: number;
}

export const TIERS: Tier[] = [
  { dprCap: 2, detail: true, grass: 1, fpsCap: 60 },
  { dprCap: 1.5, detail: true, grass: 0.8, fpsCap: 60 },
  { dprCap: 1.25, detail: false, grass: 0.55, fpsCap: 60 },
  { dprCap: 1, detail: false, grass: 0.4, fpsCap: 30 },
];

export interface Viewport {
  cssW: number;
  cssH: number;
  cell: number;
  dpr: number;
}

/** Interpolated positions of the last draw, in typed arrays (no per-frame objects). */
export class Positions {
  n = 0;
  x = new Float32Array(1024);
  y = new Float32Array(1024);
  h = new Float32Array(1024);
  serial = new Uint32Array(1024);
  packed = new Uint32Array(1024);
  slot = new Int32Array(1024);

  reset(capacity: number) {
    this.n = 0;
    if (capacity <= this.x.length) return;
    const size = Math.max(capacity, this.x.length * 2);
    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.h = new Float32Array(size);
    this.serial = new Uint32Array(size);
    this.packed = new Uint32Array(size);
    this.slot = new Int32Array(size);
  }

  push(x: number, y: number, h: number, serial: number, packed: number, slot: number) {
    const k = this.n++;
    this.x[k] = x;
    this.y[k] = y;
    this.h[k] = h;
    this.serial[k] = serial;
    this.packed[k] = packed;
    this.slot[k] = slot;
  }

  indexOf(serial: number): number {
    for (let k = 0; k < this.n; k++) if (this.serial[k] === serial) return k;
    return -1;
  }

  list(limit = Infinity): { serial: number; x: number; y: number }[] {
    const out: { serial: number; x: number; y: number }[] = [];
    for (let k = 0; k < Math.min(this.n, limit); k++) out.push({ serial: this.serial[k], x: this.x[k], y: this.y[k] });
    return out;
  }
}

const TAU = Math.PI * 2;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private client: ColonyClient;
  private tiles: SoilTiles;
  private lensTiles: SoilTiles;
  vp: Viewport = { cssW: 1, cssH: 1, cell: 4, dpr: 1 };
  tierIndex = 0;
  bookFont = "Georgia, serif";
  /** The book face, for engraved labels drawn on the glass. */
  labelFont = "Georgia, serif";
  reducedMotion = false;
  light: Light = {
    daylight: 1,
    sunAltitude: 30,
    localHour: 12,
    moonPhase: 0.5,
    rain: 0,
    lampLit: false,
    season: "summer",
    warmth: 0.5,
  };
  lamp: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false };
  selected: number | null = null;
  chemistry = false;
  /** Layers to skip, for measuring what each costs (test hooks only). */
  skip = new Set<string>();

  /** Interpolated agent positions from the last draw, for picking and tracking. */
  positions = new Positions();
  private spriteScale = -1;
  private spriteDetail = true;
  private spriteTable: Sprite[][] = [];
  private odometer = new Float32Array(4096);
  private lastX = new Float32Array(4096);
  private lastY = new Float32Array(4096);
  private lastGen = new Uint8Array(4096);
  private prevIndex = new Int32Array(4096).fill(-1);
  private seenTick = -1;
  private prevTick = -1;
  private frozen: { cur: Frame; prev: Frame | null } | null = null;
  private frozenAt = 0;

  private worldVersionSeen = -1;
  private waterCanvas: HTMLCanvasElement | null = null;
  private waterVersionSeen = -1;
  private alarmCanvas: HTMLCanvasElement | null = null;
  private alarmVersionSeen = -1;
  private scentCanvas: HTMLCanvasElement | null = null;
  private scentVersionSeen = -1;
  private cavityPattern: CanvasPattern | null = null;
  private skyCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  lastDrawMs = 0;
  tilesRendered = 0;
  drawn = 0;

  constructor(canvas: HTMLCanvasElement, client: ColonyClient, seed: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.client = client;
    this.tiles = new SoilTiles(seed, 320);
    this.lensTiles = new SoilTiles(seed, 48);
  }

  get tier(): Tier {
    return TIERS[this.tierIndex];
  }

  setTier(i: number) {
    const next = Math.max(0, Math.min(TIERS.length - 1, i));
    if (next === this.tierIndex) return;
    this.tierIndex = next;
    this.applyViewport(this.vp.cssW, this.vp.cssH, this.vp.cell, window.devicePixelRatio || 1);
  }

  /** Called on resize. */
  applyViewport(cssW: number, cssH: number, cell: number, rawDpr: number) {
    const dpr = Math.min(rawDpr, this.tier.dprCap);
    const changedScale = Math.abs(cell * dpr - this.vp.cell * this.vp.dpr) > 0.001;
    this.vp = { cssW, cssH, cell, dpr };
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const world = this.client.world;
    if (world) {
      this.tiles.setScale(cell * dpr, dpr);
      if (changedScale) {
        clearSpriteCache();
        this.spriteScale = -1;
      }
    }
    this.cavityPattern = null;
    this.skyCache = null;
  }

  worldReady() {
    const world = this.client.world;
    if (!world) return;
    const client = this.client;
    const src = {
      get W() {
        return client.world!.meta.W;
      },
      get H() {
        return client.world!.meta.H;
      },
      get soil() {
        return client.world!.soil;
      },
      get ground() {
        return client.world!.ground;
      },
    };
    this.tiles.setSource(src);
    this.lensTiles.setSource(src);
    this.tiles.setScale(this.vp.cell * this.vp.dpr, this.vp.dpr);
    this.worldVersionSeen = world.version;
    world.dirty = [];
  }

  // -------------------------------------------------------------------------
  // Frames and interpolation
  // -------------------------------------------------------------------------

  private ensureSlots(n: number) {
    if (n <= this.odometer.length) return;
    const size = Math.max(n, this.odometer.length * 2);
    const grow = <T extends Float32Array | Uint8Array | Int32Array>(a: T, fill = 0): T => {
      const b = new (a.constructor as { new (n: number): T })(size);
      b.set(a);
      if (fill) b.fill(fill as never, a.length);
      return b;
    };
    this.odometer = grow(this.odometer);
    this.lastX = grow(this.lastX);
    this.lastY = grow(this.lastY);
    this.lastGen = grow(this.lastGen);
    this.prevIndex = grow(this.prevIndex, -1);
  }

  private currentFrames(now: number): { cur: Frame | null; prev: Frame | null; alpha: number } {
    const c = this.client;
    if (this.reducedMotion) {
      // Still observations: a new plate every few seconds, no in-between motion.
      if (c.cur && (!this.frozen || now - this.frozenAt > 3200)) {
        this.frozen = { cur: c.cur, prev: null };
        this.frozenAt = now;
      }
      return { cur: this.frozen?.cur ?? null, prev: null, alpha: 1 };
    }
    this.frozen = null;
    const cur = c.cur;
    const prev = c.prev;
    if (!cur) return { cur: null, prev: null, alpha: 1 };
    const alpha = prev ? Math.max(0, Math.min(1, (now - cur.arrived) / Math.max(16, c.frameInterval))) : 1;
    return { cur, prev, alpha };
  }

  private indexPrev(prev: Frame | null, cur: Frame) {
    if (cur.tick === this.seenTick) return;
    this.seenTick = cur.tick;
    let maxSlot = 0;
    for (let k = 0; k < cur.n; k++) maxSlot = Math.max(maxSlot, cur.u[k * 3]);
    if (prev) for (let k = 0; k < prev.n; k++) maxSlot = Math.max(maxSlot, prev.u[k * 3]);
    this.ensureSlots(maxSlot + 1);
    if (prev && prev.tick !== this.prevTick) {
      this.prevTick = prev.tick;
      this.prevIndex.fill(-1);
      for (let k = 0; k < prev.n; k++) this.prevIndex[prev.u[k * 3]] = k;
    }
    // Advance each ant's odometer for its gait.
    for (let k = 0; k < cur.n; k++) {
      const slot = cur.u[k * 3];
      const gen = (cur.u[k * 3 + 2] >>> 16) & 255;
      const x = cur.f[k * 3];
      const y = cur.f[k * 3 + 1];
      if (this.lastGen[slot] === gen) {
        const d = Math.hypot(x - this.lastX[slot], y - this.lastY[slot]);
        if (d < 3) this.odometer[slot] += d;
      }
      this.lastGen[slot] = gen;
      this.lastX[slot] = x;
      this.lastY[slot] = y;
    }
  }

  // -------------------------------------------------------------------------
  // Draw
  // -------------------------------------------------------------------------

  draw(camRow: number, now: number) {
    const t0 = performance.now();
    const client = this.client;
    const world = client.world;
    const ctx = this.ctx;
    const { dpr, cell } = this.vp;
    const s = cell * dpr;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const rows = ch / s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!world) {
      ctx.fillStyle = "#1a130d";
      ctx.fillRect(0, 0, cw, ch);
      return;
    }
    if (world.version !== this.worldVersionSeen) {
      this.worldVersionSeen = world.version;
      if (world.dirty.length) {
        this.tiles.invalidateCells(world.dirty);
        this.lensTiles.invalidateCells(world.dirty);
        world.dirty = [];
      }
    }

    const W = world.meta.W;
    const groundRow = ROW.ground;
    const yOf = (row: number) => (row - camRow) * s;

    // 1. Sky and the back wall of the case.
    const skyBottom = yOf(groundRow);
    if (skyBottom > 0) this.drawSky(ctx, camRow, s, cw, Math.min(ch, skyBottom + 2), now);
    if (skyBottom < ch) {
      if (!this.cavityPattern) this.cavityPattern = this.makeCavityPattern(ctx, dpr);
      ctx.fillStyle = this.cavityPattern ?? CAVITY;
      const top = Math.max(0, skyBottom);
      ctx.fillRect(0, top, cw, ch - top);
    }

    this.drawGroundPlane(ctx, camRow, s, cw);

    // 2. Soil.
    if (!this.skip.has("tiles")) this.tilesRendered = this.tiles.draw(ctx, camRow, rows + 1, this.tilesRendered === 0 && this.seenTick < 0 ? 400 : 4);

    this.drawFinds(ctx, world, camRow, s);

    // Below the world the glass shows only bedrock.
    const worldBottom = yOf(world.meta.H);
    if (worldBottom < ch) {
      ctx.fillStyle = "#231a14";
      ctx.fillRect(0, Math.max(0, worldBottom - 1), cw, ch - Math.max(0, worldBottom - 1));
    }

    // 3. Water in the galleries.
    this.drawWater(ctx, camRow, s, cw, ch);

    // 4. Alarm scent (always visible as a vermilion wash) and, if asked, the trails.
    this.drawAlarm(ctx, camRow, s, cw, ch);
    if (this.chemistry) this.drawScent(ctx, camRow, s, cw, ch, 1);

    // 5. Floor piles, stored letters, brood, food, the dead.
    this.drawPiles(ctx, world, camRow, rows, s);
    this.drawLetters(ctx, camRow, rows, s);
    const frames = this.currentFrames(now);
    if (frames.cur) this.drawBrood(ctx, frames.cur, camRow, rows, s);
    this.drawFoods(ctx, camRow, s, now);
    this.drawCorpses(ctx, camRow, rows, s);

    // 6. Grass and the ground line.
    if (skyBottom > -40 * s && !this.skip.has("grass")) this.drawGrass(ctx, world, camRow, s, now);

    // 7. Ants.
    this.drawn = 0;
    if (frames.cur) {
      this.indexPrev(frames.prev, frames.cur);
      if (!this.skip.has("ants")) this.drawAnts(ctx, frames.cur, frames.prev, frames.alpha, camRow, rows, s, now);
    }

    // 8. Light.
    if (!this.skip.has("light")) this.drawLight(ctx, world, camRow, s, cw, ch, W);

    // 9. The selected specimen.
    this.drawSelection(ctx, camRow, s, now);

    this.lastDrawMs = performance.now() - t0;
  }


  private planeCache: { key: string; canvas: HTMLCanvasElement } | null = null;

  /** The top face of the soil, seen a little from above as it recedes to the back of the case. */
  private drawGroundPlane(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number) {
    const band = ROW.band;
    const top = (ROW.ground - band - camRow) * s;
    const bottom = (ROW.ground + 1 - camRow) * s;
    if (bottom < 0 || top > this.canvas.height) return;
    const night = 1 - this.light.daylight;
    const key = `${cw}|${s.toFixed(3)}|${Math.round(night * 20)}`;
    if (!this.planeCache || this.planeCache.key !== key) {
      const h = Math.ceil((band + 1) * s);
      const c = this.planeCache?.canvas ?? document.createElement("canvas");
      c.width = cw;
      c.height = h;
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, cw, h);
      const plane = g.createLinearGradient(0, 0, 0, h);
      plane.addColorStop(0, `rgba(${Math.round(170 - night * 90)}, ${Math.round(154 - night * 84)}, ${Math.round(122 - night * 60)}, 0.6)`);
      plane.addColorStop(1, `rgb(${Math.round(126 - night * 70)}, ${Math.round(102 - night * 60)}, ${Math.round(70 - night * 40)})`);
      g.fillStyle = plane;
      g.fillRect(0, 0, cw, h);
      const W = this.client.world!.meta.W;
      g.fillStyle = "rgba(60, 42, 24, 0.5)";
      g.beginPath();
      for (let k = 0; k < W * 3; k++) {
        const x = hash01(k, 61) * W;
        const f = hash01(k, 62);
        const y = (band - band * f * f) * s;
        const r = (0.12 + (1 - f) * 0.22) * s;
        g.moveTo(x * s + r * 1.4, y);
        g.ellipse(x * s, y, r * 1.4, r * 0.7, 0, 0, TAU);
      }
      g.fill();
      g.strokeStyle = "rgba(70, 50, 30, 0.2)";
      g.lineWidth = Math.max(0.6 * this.vp.dpr, s * 0.06);
      g.beginPath();
      for (let k = 1; k < 4; k++) {
        const y = (band - band * (k / 4) ** 1.6) * s;
        for (let x = 0; x < W; x += 3) {
          if (hash01(x, k, 63) < 0.35) continue;
          g.moveTo(x * s, y);
          g.lineTo((x + 2 + hash01(x, k, 64) * 3) * s, y);
        }
      }
      g.stroke();
      this.planeCache = { key, canvas: c };
    }
    ctx.drawImage(this.planeCache.canvas, 0, Math.round(top));
  }

  /**
   * Things the hill has kept: a clay pipe, a lost button, a fossil shell and an
   * ammonite with its specimen label. Each is drawn only while the earth around
   * it is undug; the ants may yet dig one out.
   */
  private drawFinds(ctx: CanvasRenderingContext2D, world: NonNullable<ColonyClient["world"]>, camRow: number, s: number) {
    const W = world.meta.W;
    const H = world.meta.H;
    const rows = this.canvas.height / s;
    const finds = [
      { kind: "pipe", x: W * 0.2, y: ROW.ground + 22, r: 4 },
      { kind: "button", x: W * 0.8, y: ROW.stone1 - 60, r: 2 },
      { kind: "shell", x: W * 0.3, y: ROW.stone2End + 80, r: 3.5 },
      { kind: "ammonite", x: W * 0.64, y: ROW.bedrock + 40, r: 8 },
    ];
    const dpr = this.vp.dpr;
    for (const f of finds) {
      if (f.y + f.r < camRow - 2 || f.y - f.r > camRow + rows + 2) continue;
      let intact = true;
      for (let yy = Math.floor(f.y - f.r); yy <= Math.ceil(f.y + f.r) && intact; yy++) {
        for (let xx = Math.floor(f.x - f.r * 1.4); xx <= Math.ceil(f.x + f.r * 1.4); xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (world.soil[yy * W + xx] === Mat.Open) {
            intact = false;
            break;
          }
        }
      }
      if (!intact) continue;
      const cx = f.x * s;
      const cy = (f.y - camRow) * s;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineWidth = Math.max(0.8 * dpr, s * 0.1);
      ctx.strokeStyle = rgba(INK, 0.8);
      if (f.kind === "ammonite") {
        const r = f.r * s;
        ctx.fillStyle = "rgba(150, 132, 110, 0.55)";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
        // The coil, and its ribs.
        ctx.beginPath();
        for (let t = 0; t < 6.2 * Math.PI; t += 0.08) {
          const rr = r * Math.exp(-t / (2.2 * Math.PI)) * 0.98;
          const px = Math.cos(t) * rr;
          const py = Math.sin(t) * rr;
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.lineWidth = Math.max(0.5 * dpr, s * 0.05);
        ctx.strokeStyle = rgba(INK, 0.45);
        ctx.beginPath();
        for (let t = 0; t < 4 * Math.PI; t += 0.28) {
          const r1 = r * Math.exp(-t / (2.2 * Math.PI));
          const r2 = r * Math.exp(-(t + 2 * Math.PI) / (2.2 * Math.PI));
          ctx.moveTo(Math.cos(t) * r1 * 0.97, Math.sin(t) * r1 * 0.97);
          ctx.lineTo(Math.cos(t) * r2, Math.sin(t) * r2);
        }
        ctx.stroke();
        // Its specimen label, pinned beside it.
        const lx = r * 1.4;
        const ly = -r * 0.4;
        ctx.rotate(-0.05);
        ctx.fillStyle = "rgba(232, 222, 196, 0.92)";
        const fontPx = Math.max(10 * dpr, s * 2.2);
        ctx.font = `italic ${Math.round(fontPx)}px ${this.labelFont}`;
        const text = "Ammonite, from the bedrock";
        const tw = ctx.measureText(text).width;
        ctx.fillRect(lx, ly - fontPx, tw + fontPx, fontPx * 1.7);
        ctx.strokeStyle = VERMILION;
        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeRect(lx + 2 * dpr, ly - fontPx + 2 * dpr, tw + fontPx - 4 * dpr, fontPx * 1.7 - 4 * dpr);
        ctx.fillStyle = INK;
        ctx.textBaseline = "middle";
        ctx.fillText(text, lx + fontPx * 0.5, ly - fontPx + fontPx * 0.88);
      } else if (f.kind === "pipe") {
        // A broken clay pipe: bowl and a length of stem.
        ctx.fillStyle = "rgba(226, 214, 192, 0.9)";
        ctx.beginPath();
        ctx.moveTo(-f.r * s, -0.2 * s);
        ctx.lineTo(f.r * 0.7 * s, -0.5 * s);
        ctx.lineTo(f.r * 0.72 * s, 0.1 * s);
        ctx.lineTo(-f.r * s, 0.3 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(f.r * 0.6 * s, -0.5 * s);
        ctx.quadraticCurveTo(f.r * 0.7 * s, -2.4 * s, f.r * 1.1 * s, -2.6 * s);
        ctx.lineTo(f.r * 1.5 * s, -2.4 * s);
        ctx.quadraticCurveTo(f.r * 1.4 * s, -0.4 * s, f.r * 0.72 * s, 0.1 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (f.kind === "button") {
        const r = f.r * s;
        const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
        g.addColorStop(0, "#e8cf93");
        g.addColorStop(1, "#7b5a2a");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = rgba(INK, 0.8);
        for (const [dx, dy] of [
          [-0.3, -0.3],
          [0.3, -0.3],
          [-0.3, 0.3],
          [0.3, 0.3],
        ]) {
          ctx.beginPath();
          ctx.arc(dx * r, dy * r, r * 0.12, 0, TAU);
          ctx.fill();
        }
      } else {
        // A fossil cockle: a ribbed fan.
        const r = f.r * s;
        ctx.fillStyle = "rgba(200, 184, 150, 0.6)";
        ctx.beginPath();
        ctx.moveTo(0, r * 0.7);
        ctx.arc(0, r * 0.7, r * 1.4, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = rgba(INK, 0.5);
        ctx.beginPath();
        for (let k = 1; k < 9; k++) {
          const a = -Math.PI * (0.85 - k * 0.0875);
          ctx.moveTo(0, r * 0.7);
          ctx.lineTo(Math.cos(a) * r * 1.4, r * 0.7 + Math.sin(a) * r * 1.4);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private makeCavityPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
    const size = Math.round(90 * dpr);
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    g.fillStyle = CAVITY;
    g.fillRect(0, 0, size, size);
    // The back of the case: a plaster wash with fine vertical strokes.
    g.strokeStyle = "rgba(96, 70, 40, 0.13)";
    g.lineWidth = 0.6 * dpr;
    for (let x = 0; x < size; x += 2.6 * dpr) {
      g.beginPath();
      const y0 = hash01(3, x) * size;
      g.moveTo(x, y0);
      g.lineTo(x + 0.6 * dpr, y0 + size * 0.7);
      g.stroke();
    }
    for (let k = 0; k < 220; k++) {
      g.fillStyle = `rgba(90, 64, 36, ${0.08 + hash01(k, 9) * 0.12})`;
      g.beginPath();
      g.arc(hash01(k, 1) * size, hash01(k, 2) * size, (0.3 + hash01(k, 3) * 0.6) * dpr, 0, TAU);
      g.fill();
    }
    return ctx.createPattern(c, "repeat");
  }

  // ---- sky ----------------------------------------------------------------

  private skyColours(): [string, string, number] {
    const L = this.light;
    const alt = L.sunAltitude;
    const rainy = Math.min(1, L.rain * 1.4);
    let top: [number, number, number];
    let bottom: [number, number, number];
    let stars = 0;
    if (alt < -9) {
      top = [16, 19, 29];
      bottom = [33, 36, 48];
      stars = 1;
    } else if (alt < 7) {
      const t = (alt + 9) / 16;
      const dusk = L.localHour > 12;
      top = lerp3([22, 25, 38], dusk ? [120, 92, 88] : [150, 128, 118], t);
      bottom = lerp3([40, 40, 52], dusk ? [226, 160, 104] : [232, 190, 140], t);
      stars = Math.max(0, 1 - t * 1.6);
    } else {
      const t = Math.min(1, (alt - 7) / 25);
      top = lerp3([196, 190, 176], [188, 196, 196], t);
      bottom = lerp3([236, 214, 172], [230, 224, 206], t);
    }
    if (rainy > 0) {
      top = lerp3(top, [120, 122, 120], rainy * 0.6);
      bottom = lerp3(bottom, [160, 158, 150], rainy * 0.6);
    }
    return [`rgb(${top.join(",")})`, `rgb(${bottom.join(",")})`, stars];
  }

  private drawSky(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number, bottom: number, now: number) {
    const L = this.light;
    const [top, low, stars] = this.skyColours();
    const key = `${top}|${low}|${stars.toFixed(2)}|${L.rain > 0.35 ? 1 : 0}|${cw}|${s.toFixed(3)}|${Math.round(L.moonPhase * 40)}|${Math.round(L.localHour * 12)}`;
    const skyH = Math.ceil(ROW.ground * s);
    if (!this.skyCache || this.skyCache.key !== key) {
      const c = this.skyCache?.canvas ?? document.createElement("canvas");
      c.width = cw;
      c.height = skyH;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 0, skyH);
      grad.addColorStop(0, top);
      grad.addColorStop(1, low);
      g.fillStyle = grad;
      g.fillRect(0, 0, cw, skyH);
      // Engraved sky: ruled horizontal lines, closer together toward the zenith.
      const dpr = this.vp.dpr;
      g.lineWidth = 0.7 * dpr;
      for (let y = 1; y < skyH * 0.75; ) {
        const f = y / (skyH * 0.75);
        g.strokeStyle = stars > 0.5 ? `rgba(200, 200, 220, ${0.05 * (1 - f)})` : `rgba(70, 60, 50, ${0.11 * (1 - f)})`;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(cw, y);
        g.stroke();
        y += (2.2 + f * 6) * dpr;
      }
      if (stars > 0) {
        for (let k = 0; k < 140; k++) {
          const x = hash01(k, 71) * cw;
          const y = hash01(k, 72) * skyH * 0.72;
          const r = (0.4 + hash01(k, 73) * 0.9) * dpr;
          g.fillStyle = `rgba(236, 230, 210, ${stars * (0.35 + hash01(k, 74) * 0.55)})`;
          g.beginPath();
          g.arc(x, y, r, 0, TAU);
          g.fill();
        }
      }
      this.drawSunMoon(g, cw, skyH, s);
      this.skyCache = { key, canvas: c };
    }
    const y0 = (0 - camRow) * s;
    ctx.drawImage(this.skyCache.canvas, 0, Math.round(y0));
    // Rain and cloud move, so they are drawn every frame.
    if (L.rain > 0.02) this.drawRain(ctx, camRow, s, cw, bottom, now);
  }

  private drawSunMoon(g: CanvasRenderingContext2D, cw: number, skyH: number, s: number) {
    const L = this.light;
    const dpr = this.vp.dpr;
    // East on the left, west on the right, as if looking south through the glass.
    const dayT = Math.max(0, Math.min(1, (L.localHour - 5) / 15));
    if (L.sunAltitude > -4 && L.rain < 0.35) {
      const x = cw * (0.1 + dayT * 0.8);
      const y = skyH * (0.78 - Math.max(0, L.sunAltitude) / 70) ;
      const r = 5.5 * s;
      g.save();
      g.strokeStyle = "rgba(120, 78, 30, 0.55)";
      g.lineWidth = 0.7 * dpr;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * TAU;
        const r1 = r * 1.25;
        const r2 = r * (k % 2 ? 1.75 : 2.2);
        g.beginPath();
        g.moveTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
        g.lineTo(x + Math.cos(a) * r2, y + Math.sin(a) * r2);
        g.stroke();
      }
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(252, 236, 190, 0.95)");
      grad.addColorStop(1, "rgba(236, 196, 120, 0.9)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(110, 70, 30, 0.8)";
      g.lineWidth = 1 * dpr;
      g.stroke();
      g.restore();
    }
    if (L.sunAltitude < 4) {
      // The moon, in its real phase.
      const nightT = ((L.localHour + 24 - 18) % 24) / 12;
      const x = cw * (0.15 + Math.min(1, nightT) * 0.7);
      const y = skyH * 0.26;
      const r = 4.2 * s;
      const phase = L.moonPhase;
      g.save();
      g.fillStyle = "rgba(120, 124, 140, 0.16)";
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      g.fillStyle = "rgba(236, 228, 204, 0.95)";
      const k = Math.cos(phase * TAU);
      const waxing = phase < 0.5;
      g.beginPath();
      g.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !waxing);
      g.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) !== waxing);
      g.fill();
      g.strokeStyle = "rgba(200, 196, 180, 0.22)";
      g.lineWidth = 0.7 * dpr;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.stroke();
      g.restore();
    }
  }

  private drawRain(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number, bottom: number, now: number) {
    const L = this.light;
    const dpr = this.vp.dpr;
    const n = Math.round(90 * L.rain * (cw / (800 * dpr)));
    const fall = this.reducedMotion ? 0 : now * 0.9 * dpr;
    ctx.save();
    // Clouds: hatched masses drifting across the top of the sky.
    const drift = this.reducedMotion ? 0 : now * 0.004 * dpr;
    for (let k = 0; k < 6; k++) {
      const cx = ((hash01(k, 91) * cw * 1.4 + drift * (0.6 + hash01(k, 92))) % (cw * 1.4)) - cw * 0.2;
      const cy = (-camRow + 6 + hash01(k, 93) * 14) * s;
      const rw = (18 + hash01(k, 94) * 26) * s;
      const rh = rw * 0.28;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rw);
      grad.addColorStop(0, `rgba(78, 78, 80, ${0.35 * L.rain})`);
      grad.addColorStop(1, "rgba(78,78,80,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(52, 58, 64, ${0.25 + L.rain * 0.3})`;
    ctx.lineWidth = 0.8 * dpr;
    ctx.beginPath();
    const h = bottom;
    for (let k = 0; k < n; k++) {
      const x = hash01(k, 51) * cw;
      const len = (6 + hash01(k, 52) * 10) * dpr;
      const y = (hash01(k, 53) * h + fall * (0.8 + hash01(k, 54) * 0.4)) % Math.max(1, h);
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.25, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- water, scent -------------------------------------------------------

  private fieldCanvas(existing: HTMLCanvasElement | null, W: number, H: number) {
    const c = existing ?? document.createElement("canvas");
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    return c;
  }

  private drawWater(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number, ch: number) {
    const c = this.client;
    const world = c.world!;
    if (!c.water) return;
    const W = world.meta.W;
    const H = world.meta.H;
    if (this.waterVersionSeen !== c.waterVersion) {
      this.waterVersionSeen = c.waterVersion;
      this.waterCanvas = this.fieldCanvas(this.waterCanvas, W, H);
      const g = this.waterCanvas.getContext("2d")!;
      const img = g.createImageData(W, H);
      const d = img.data;
      const water = c.water;
      let any = false;
      for (let i = 0; i < water.length; i++) {
        const v = water[i];
        if (!v) continue;
        any = true;
        d[i * 4] = 64;
        d[i * 4 + 1] = 88;
        d[i * 4 + 2] = 98;
        d[i * 4 + 3] = Math.min(220, 70 + v * 0.7);
      }
      g.putImageData(img, 0, 0);
      if (!any) this.waterCanvas = null;
    }
    if (!this.waterCanvas) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.waterCanvas, 0, Math.max(0, Math.floor(camRow)), W, Math.min(H, ch / s + 2), 0, (Math.floor(camRow) - camRow) * s, cw, Math.min(H, ch / s + 2) * s);
    ctx.restore();
  }

  private drawAlarm(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number, ch: number) {
    const c = this.client;
    const world = c.world!;
    if (!c.alarm) return;
    const W = world.meta.W;
    const H = world.meta.H;
    if (this.alarmVersionSeen !== c.alarmVersion) {
      this.alarmVersionSeen = c.alarmVersion;
      this.alarmCanvas = this.fieldCanvas(this.alarmCanvas, W, H);
      const g = this.alarmCanvas.getContext("2d")!;
      const img = g.createImageData(W, H);
      const d = img.data;
      const a = c.alarm;
      for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v < 3) continue;
        d[i * 4] = 196;
        d[i * 4 + 1] = 58;
        d[i * 4 + 2] = 32;
        d[i * 4 + 3] = Math.min(170, v * 1.1);
      }
      g.putImageData(img, 0, 0);
    }
    if (!this.alarmCanvas) return;
    const rows = Math.min(H, ch / s + 2);
    const r0 = Math.max(0, Math.floor(camRow));
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.alarmCanvas, 0, r0, W, rows, 0, (r0 - camRow) * s, cw, rows * s);
    ctx.restore();
  }

  private drawScent(ctx: CanvasRenderingContext2D, camRow: number, s: number, cw: number, ch: number, strength: number) {
    const c = this.client;
    const world = c.world!;
    if (!c.scent) return;
    const W = world.meta.W;
    const H = world.meta.H;
    if (this.scentVersionSeen !== c.scentVersion) {
      this.scentVersionSeen = c.scentVersion;
      this.scentCanvas = this.fieldCanvas(this.scentCanvas, W, H);
      const g = this.scentCanvas.getContext("2d")!;
      const img = g.createImageData(W, H);
      const d = img.data;
      const f = c.scent.food;
      const h = c.scent.home;
      for (let i = 0; i < f.length; i++) {
        const fv = f[i];
        const hv = h[i];
        if (fv < 2 && hv < 2) continue;
        // Food trail in gold ink, the home trail in a cold grey-blue.
        const tf = Math.min(1, fv / 120);
        const th = Math.min(1, hv / 160);
        const sum = tf + th + 1e-6;
        d[i * 4] = (214 * tf + 70 * th) / sum;
        d[i * 4 + 1] = (160 * tf + 96 * th) / sum;
        d[i * 4 + 2] = (40 * tf + 120 * th) / sum;
        d[i * 4 + 3] = Math.min(240, (tf * 2.2 + th * 1.2) * 255);
      }
      g.putImageData(img, 0, 0);
    }
    if (!this.scentCanvas) return;
    const rows = Math.min(H, ch / s + 2);
    const r0 = Math.max(0, Math.floor(camRow));
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.scentCanvas, 0, r0, W, rows, 0, (r0 - camRow) * s, cw, rows * s);
    ctx.restore();
  }

  // ---- items --------------------------------------------------------------

  private pileCache = new Map<string, CanvasImageSource>();
  private pileScale = -1;

  private pileSprite(type: number, amount: number, variant: number, s: number): CanvasImageSource {
    if (this.pileScale !== s) {
      this.pileCache.clear();
      this.pileScale = s;
    }
    const key = `${type}:${amount}:${variant}`;
    const hit = this.pileCache.get(key);
    if (hit) return hit;
    const size = Math.ceil(s * 2.4);
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const dpr = this.vp.dpr;
    g.lineWidth = Math.max(0.6 * dpr, s * 0.06);
    const n = Math.min(type === Pile.Food ? 9 : 7, amount);
    for (let k = 0; k < n; k++) {
      const jx = hash01(variant, k, 1);
      const jy = hash01(variant, k, 2);
      const px = (0.1 + jx * 0.8 + 0.7) * s;
      const py = (2.2 - 0.18 - (k / 3) * 0.3 - jy * 0.12) * s;
      if (type === Pile.Food) {
        g.fillStyle = k % 3 === 0 ? "#cbb07a" : "#dcc592";
        g.strokeStyle = rgba(INK, 0.7);
        g.beginPath();
        g.ellipse(px, py, s * 0.3, s * 0.17, jx * 3, 0, TAU);
        g.fill();
        g.stroke();
      } else {
        g.fillStyle = k % 2 ? "#6a5a4a" : "#4d4036";
        g.beginPath();
        g.ellipse(px, py, s * 0.28, s * 0.12, jx * 3, 0, TAU);
        g.fill();
      }
    }
    this.pileCache.set(key, c);
    return c;
  }

  private drawPiles(ctx: CanvasRenderingContext2D, world: NonNullable<ColonyClient["world"]>, camRow: number, rows: number, s: number) {
    const W = world.meta.W;
    const r0 = Math.max(0, Math.floor(camRow) - 1);
    const r1 = Math.min(world.meta.H - 1, Math.ceil(camRow + rows) + 1);
    const pt = world.pileType;
    const pa = world.pileAmt;
    for (let y = r0; y <= r1; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const type = pt[i];
        if (!type) continue;
        const amt = Math.min(type === Pile.Food ? 9 : 7, pa[i]);
        const img = this.pileSprite(type, amt, i & 3, s);
        ctx.drawImage(img, (x - 0.7) * s, (y - 1.2 - camRow) * s);
      }
    }
  }

  private drawLetters(ctx: CanvasRenderingContext2D, camRow: number, rows: number, s: number) {
    const letters = this.client.letters;
    if (!letters.length) return;
    const stacks = new Map<string, number>();
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `${Math.round(s * 2.4)}px ${this.bookFont}`;
    for (const l of letters) {
      if (l.state !== 2) continue;
      if (l.y < camRow - 4 || l.y > camRow + rows + 4) continue;
      const key = `${Math.round(l.x / 2)}:${Math.round(l.y)}`;
      const k = stacks.get(key) ?? 0;
      stacks.set(key, k + 1);
      const px = (l.x + ((k % 3) - 1) * 0.9) * s;
      const py = (l.y + 0.55 - Math.floor(k / 3) * 1.9 - camRow) * s;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((hash01(l.key.length, k, l.ch.charCodeAt(0)) - 0.5) * 0.5);
      ctx.fillStyle = "rgba(236, 224, 198, 0.9)";
      ctx.fillRect(-s * 0.9, -s * 2, s * 1.8, s * 2.35);
      ctx.fillStyle = INK;
      ctx.fillText(l.ch, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawBrood(ctx: CanvasRenderingContext2D, frame: Frame, camRow: number, rows: number, s: number) {
    const b = frame.brood;
    for (let k = 0; k < frame.broodN; k++) {
      const x = b[k * 3];
      const y = b[k * 3 + 1];
      if (y < camRow - 2 || y > camRow + rows + 2) continue;
      const meta = b[k * 3 + 2];
      const stage = meta & 3;
      const alate = (meta & 4) !== 0;
      const spr = broodSprite(stage, alate, s);
      ctx.drawImage(spr.canvas as CanvasImageSource, x * s - spr.cx, (y - camRow) * s - spr.cy);
    }
  }

  private drawFoods(ctx: CanvasRenderingContext2D, camRow: number, s: number, now: number) {
    const dpr = this.vp.dpr;
    for (const f of this.client.foods) {
      const px = f.x * s;
      const py = (f.y - camRow) * s;
      if (py < -40 * s || py > this.canvas.height + 40 * s) continue;
      const frac = Math.max(0.15, Math.sqrt(f.amount / Math.max(1, f.initial)));
      ctx.save();
      ctx.translate(px, py);
      ctx.lineWidth = Math.max(0.7 * dpr, s * 0.08);
      ctx.strokeStyle = rgba(INK, 0.85);
      switch (f.kind) {
        case 0: // seed
          ctx.fillStyle = "#d4bb86";
          ctx.beginPath();
          ctx.ellipse(0, 0, s * 0.42, s * 0.24, 0.3, 0, TAU);
          ctx.fill();
          ctx.stroke();
          break;
        case 1: {
          // honey: an amber bead that shrinks as it is carried off
          const r = s * 3.2 * frac;
          const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
          grad.addColorStop(0, "rgba(250, 214, 140, 0.95)");
          grad.addColorStop(0.5, HONEY);
          grad.addColorStop(1, "rgba(150, 90, 20, 0.95)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.ellipse(0, -r * 0.35, r, r * 0.62, 0, Math.PI, 0);
          ctx.lineTo(r, 0);
          ctx.quadraticCurveTo(0, r * 0.12, -r, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(255, 248, 225, 0.85)";
          ctx.beginPath();
          ctx.ellipse(-r * 0.35, -r * 0.55, r * 0.18, r * 0.09, -0.4, 0, TAU);
          ctx.fill();
          break;
        }
        case 2: {
          // a dead beetle on its back, legs to the sky
          const r = s * 3.6 * (0.55 + 0.45 * frac);
          ctx.fillStyle = "#2c2119";
          ctx.beginPath();
          ctx.ellipse(0, -r * 0.45, r, r * 0.5, 0, 0, TAU);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = "rgba(170, 140, 100, 0.55)";
          ctx.lineWidth = Math.max(0.6 * dpr, s * 0.05);
          for (let k = -3; k <= 3; k++) {
            ctx.beginPath();
            ctx.moveTo(k * r * 0.22, -r * 0.85);
            ctx.lineTo(k * r * 0.24, -r * 0.1);
            ctx.stroke();
          }
          ctx.strokeStyle = rgba(INK, 0.9);
          ctx.lineWidth = Math.max(0.8 * dpr, s * 0.1);
          for (let k = 0; k < 3; k++) {
            for (const side of [-1, 1]) {
              const bx = (k - 1) * r * 0.45;
              ctx.beginPath();
              ctx.moveTo(bx, -r * 0.8);
              ctx.lineTo(bx + side * r * 0.25, -r * 1.35);
              ctx.lineTo(bx + side * r * 0.45, -r * 1.2);
              ctx.stroke();
            }
          }
          break;
        }
        case 3:
        case 4: {
          // a crust or crumb
          const r = s * (f.kind === 3 ? 4.2 : 2.2) * (0.5 + 0.5 * frac);
          ctx.fillStyle = f.kind === 3 ? "#c79b5e" : "#e2c995";
          ctx.beginPath();
          ctx.moveTo(-r, 0);
          ctx.quadraticCurveTo(-r * 0.9, -r * 0.7, -r * 0.2, -r * 0.62);
          ctx.quadraticCurveTo(r * 0.5, -r * 0.8, r, -r * 0.2);
          ctx.lineTo(r * 0.9, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(90, 60, 30, 0.45)";
          for (let k = 0; k < 14; k++) {
            ctx.beginPath();
            ctx.arc((hash01(f.id, k) - 0.5) * r * 1.5, -hash01(f.id, k, 3) * r * 0.5, s * 0.12, 0, TAU);
            ctx.fill();
          }
          break;
        }
      }
      ctx.restore();
    }
    void now;
  }

  private drawCorpses(ctx: CanvasRenderingContext2D, camRow: number, rows: number, s: number) {
    for (const c of this.client.corpses) {
      if (c.y < camRow - 3 || c.y > camRow + rows + 3) continue;
      const spr = antSprite(c.caste, BODY_CELLS[c.caste] * s, 0, true);
      ctx.setTransform(Math.cos(c.heading), Math.sin(c.heading), -Math.sin(c.heading), Math.cos(c.heading), c.x * s, (c.y - camRow) * s);
      ctx.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- surface ------------------------------------------------------------

  private drawGrass(ctx: CanvasRenderingContext2D, world: NonNullable<ColonyClient["world"]>, camRow: number, s: number, now: number) {
    const W = world.meta.W;
    const soil = world.soil;
    const ground = world.ground;
    const L = this.light;
    const dpr = this.vp.dpr;
    const t = this.reducedMotion ? 0 : now / 1000;
    const wind = 0.5 + L.rain * 1.2;
    const dry = L.season === "winter" || L.season === "autumn";
    const blade = dry ? "#7c6a44" : "#6f6c3e";
    const bladeLight = dry ? "#a58d5c" : "#8f8a52";
    ctx.save();
    ctx.lineCap = "round";

    // Ground line: an engraved edge with small tufts and grains.
    ctx.strokeStyle = rgba(INK, 0.85);
    ctx.lineWidth = Math.max(1 * dpr, s * 0.14);
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      const gx = Math.min(W - 1, x);
      const y = (ground[gx] - camRow) * s + (hash01(x, 5) - 0.5) * s * 0.3;
      if (x === 0) ctx.moveTo(0, y);
      else ctx.lineTo(x * s, y);
    }
    ctx.stroke();

    // Background grass (decorative), batched by tone: a few strokes, not hundreds.
    const density = this.tier.grass;
    const backN = Math.round(W * 0.9 * density);
    ctx.lineWidth = Math.max(0.6 * dpr, s * 0.07);
    const tones = [0.28, 0.36, 0.44];
    for (let tone = 0; tone < tones.length; tone++) {
      ctx.strokeStyle = `rgba(92, 88, 52, ${tones[tone]})`;
      ctx.beginPath();
      for (let k = tone; k < backN; k += tones.length) {
        const x = hash01(k, 11) * W;
        const gy = ground[Math.min(W - 1, x | 0)];
        const h = (5 + hash01(k, 12) * 26) * (dry ? 0.8 : 1);
        const sway = Math.sin(t * (0.6 + hash01(k, 13)) + k) * 0.9 * wind;
        const bx = x * s;
        const by = (gy - ROW.band * hash01(k, 16) ** 1.4 - camRow) * s;
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + sway * s * 0.5, by - h * s * 0.55, bx + (sway + (hash01(k, 15) - 0.5) * 4) * s, by - h * s);
      }
      ctx.stroke();
    }

    // Stems: the real obstacles in the litter band, rising into tall blades.
    for (let x = 0; x < W; x++) {
      const g = ground[x];
      if (g < 1 || soil[(g - 1) * W + x] !== Mat.Stem) continue;
      let top = g - 1;
      while (top > 0 && soil[(top - 1) * W + x] === Mat.Stem) top--;
      const stemCells = g - top;
      const h = stemCells * 3 + 14 + hash01(x, 21) * 22;
      const sway = Math.sin(t * (0.5 + hash01(x, 22) * 0.6) + x * 0.7) * 1.4 * wind;
      const bx = (x + 0.5) * s;
      const by = (g - camRow) * s;
      const tipX = bx + (sway + (hash01(x, 23) - 0.5) * 6) * s;
      const tipY = by - h * s;
      const wBase = s * 0.55;
      ctx.fillStyle = blade;
      ctx.strokeStyle = rgba(INK, 0.75);
      ctx.lineWidth = Math.max(0.6 * dpr, s * 0.06);
      ctx.beginPath();
      ctx.moveTo(bx - wBase, by);
      ctx.quadraticCurveTo(bx - wBase * 0.3 + sway * s * 0.3, by - h * s * 0.5, tipX, tipY);
      ctx.quadraticCurveTo(bx + wBase * 0.3 + sway * s * 0.3, by - h * s * 0.5, bx + wBase, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = bladeLight;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + sway * s * 0.3, by - h * s * 0.5, tipX, tipY);
      ctx.stroke();
      // Seed heads in summer and autumn.
      if ((L.season === "summer" || L.season === "autumn") && hash01(x, 24) < 0.55) {
        ctx.fillStyle = "#3b2c1c";
        for (let k = 0; k < 7; k++) {
          const f = k / 7;
          const sx = tipX + (bx - tipX) * f * 0.25 + (k % 2 ? 1 : -1) * s * 0.45;
          const sy = tipY + (by - tipY) * f * 0.25;
          ctx.beginPath();
          ctx.ellipse(sx, sy, s * 0.26, s * 0.55, (k % 2 ? 0.5 : -0.5) + sway * 0.05, 0, TAU);
          ctx.fill();
        }
      }
    }

    // Litter: a few fixed twigs and leaf fragments on the ground.
    ctx.strokeStyle = "rgba(60, 42, 26, 0.7)";
    ctx.lineWidth = Math.max(0.7 * dpr, s * 0.1);
    for (let k = 0; k < W / 9; k++) {
      const x = hash01(k, 31) * W;
      const g = ground[Math.min(W - 1, x | 0)];
      const len = (1.5 + hash01(k, 32) * 3) * s;
      const a = (hash01(k, 33) - 0.5) * 0.6;
      const bx = x * s;
      const by = (g - camRow - 0.2) * s;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(a) * len, by + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- ants ---------------------------------------------------------------

  private drawAnts(ctx: CanvasRenderingContext2D, cur: Frame, prev: Frame | null, alpha: number, camRow: number, rows: number, s: number, now: number) {
    const detail = this.tier.detail;
    const letters = this.client.letters;
    const positions = this.positions;
    positions.reset(cur.n);
    const wobble = this.reducedMotion ? 0 : now;
    // One sprite per caste and gait frame at this scale, looked up without strings.
    if (this.spriteScale !== s || this.spriteDetail !== detail) {
      this.spriteScale = s;
      this.spriteDetail = detail;
      this.spriteTable = BODY_CELLS.map((cells, caste) => {
        const L = cells * s;
        return [0, 1, 2, 3].map((g) => antSprite(caste, detail ? L : Math.min(L, 10), detail ? g : 0));
      });
    }
    const table = this.spriteTable;
    const odo = this.odometer;
    const prevIndex = this.prevIndex;
    const top = camRow - 4;
    const bottom = camRow + rows + 4;
    const speck = new Path2D();
    const carried = new Path2D();
    for (let k = 0; k < cur.n; k++) {
      const k3 = k * 3;
      let x = cur.f[k3];
      let y = cur.f[k3 + 1];
      let h = cur.f[k3 + 2];
      const slot = cur.u[k3];
      const serial = cur.u[k3 + 1];
      const packed = cur.u[k3 + 2];
      if (prev && alpha < 1) {
        const pk = slot < prevIndex.length ? prevIndex[slot] : -1;
        if (pk >= 0 && prev.u[pk * 3 + 1] === serial) {
          const px = prev.f[pk * 3];
          const py = prev.f[pk * 3 + 1];
          if (Math.abs(px - x) < 3 && Math.abs(py - y) < 3) {
            const ph = prev.f[pk * 3 + 2];
            x = px + (x - px) * alpha;
            y = py + (y - py) * alpha;
            let dh = h - ph;
            if (dh > Math.PI) dh -= TAU;
            else if (dh < -Math.PI) dh += TAU;
            h = ph + dh * alpha;
          }
        }
      }
      positions.push(x, y, h, serial, packed, slot);
      if (y < top || y > bottom) continue;
      const caste = packed & 7;
      const carry = (packed >>> 3) & 15;
      const flags = (packed >>> 11) & 31;
      if (!detail && caste <= 1) {
        // At a distance, and on slow machines: ink specks, all in one stroke.
        const half = (caste === 1 ? 1.35 : 1.1) * s;
        const cx = Math.cos(h) * half;
        const cy = Math.sin(h) * half;
        const X = x * s;
        const Y = (y - camRow) * s;
        speck.moveTo(X - cx, Y - cy);
        speck.lineTo(X + cx * 0.55, Y + cy * 0.55);
        speck.moveTo(X + cx * 0.72, Y + cy * 0.72);
        speck.lineTo(X + cx * 0.95, Y + cy * 0.95);
        if (carry !== Carry.None) {
          carried.moveTo(X + cx * 1.35 + s * 0.3, Y + cy * 1.35);
          carried.arc(X + cx * 1.35, Y + cy * 1.35, s * 0.3, 0, TAU);
        }
        this.drawn++;
        continue;
      }
      const gait = detail ? Math.floor((odo[slot] ?? 0) * 3.2) & 3 : 0;
      const spr = table[caste][gait];
      if (caste === 2) {
        const L = (BODY_CELLS[2] ?? 5) * s;
        ctx.setTransform(Math.cos(h), Math.sin(h), -Math.sin(h), Math.cos(h), x * s, (y - camRow) * s);
        ctx.fillStyle = "rgba(240, 214, 160, 0.22)";
        ctx.beginPath();
        ctx.ellipse(-L * 0.1, 0, L * 0.72, L * 0.34, 0, 0, TAU);
        ctx.fill();
      }
      // Alarmed ants tremble.
      const hh = flags & FLAG_ALARM && wobble ? h + Math.sin(wobble * 0.05 + slot) * 0.12 : h;
      const c = Math.cos(hh);
      const sn = Math.sin(hh);
      ctx.setTransform(c, sn, -sn, c, x * s, (y - camRow) * s);
      ctx.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
      if (carry !== Carry.None) {
        let ch = "";
        if (carry === Carry.Letter) ch = letters.find((l) => l.bearer === serial && l.state === 1)?.ch ?? "e";
        drawCarried(ctx, carry, (BODY_CELLS[caste] ?? 2.3) * s, this.bookFont, ch);
      }
      this.drawn++;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!detail) {
      ctx.lineCap = "round";
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, s * 0.5);
      ctx.stroke(speck);
      ctx.fillStyle = "#d9c393";
      ctx.fill(carried);
    }
  }

  // ---- light --------------------------------------------------------------

  private drawLight(ctx: CanvasRenderingContext2D, world: NonNullable<ColonyClient["world"]>, camRow: number, s: number, cw: number, ch: number, W: number) {
    const L = this.light;
    const night = 1 - L.daylight;
    const yOf = (row: number) => (row - camRow) * s;
    ctx.save();

    // Depth: the earth darkens as you go down.
    const g = ctx.createLinearGradient(0, yOf(ROW.ground - 2), 0, yOf(ROW.bedrock + 40));
    g.addColorStop(0, "rgba(14, 8, 4, 0)");
    g.addColorStop(0.18, `rgba(14, 8, 4, ${0.1 + night * 0.1})`);
    g.addColorStop(0.42, `rgba(14, 8, 4, ${0.26 + night * 0.1})`);
    g.addColorStop(0.62, "rgba(10, 6, 3, 0.42)");
    g.addColorStop(0.86, "rgba(8, 5, 3, 0.52)");
    g.addColorStop(1, "rgba(6, 4, 2, 0.62)");
    ctx.fillStyle = g;
    const top = Math.max(0, yOf(ROW.ground - 2));
    ctx.fillRect(0, top, cw, ch - top);

    // Night on the surface and in the upper earth.
    if (night > 0.02) {
      const ng = ctx.createLinearGradient(0, yOf(0), 0, yOf(ROW.stone1));
      ng.addColorStop(0, `rgba(10, 12, 22, ${night * 0.25})`);
      ng.addColorStop(0.55, `rgba(10, 12, 22, ${night * 0.5})`);
      ng.addColorStop(1, `rgba(10, 8, 6, ${night * 0.25})`);
      ctx.fillStyle = ng;
      ctx.fillRect(0, 0, cw, Math.max(0, Math.min(ch, yOf(ROW.stone1))));
    }

    // Lamplight and daylight tint.
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = L.lampLit ? "rgb(236, 196, 142)" : "rgb(250, 242, 228)";
    ctx.fillRect(0, Math.max(0, yOf(ROW.ground)), cw, ch);
    ctx.globalCompositeOperation = "source-over";

    // The laboratory lamp beside the nursery glass warms it amber.
    const nurseryRow = (ROW.stone1End + ROW.stone2) / 2;
    const ly = yOf(nurseryRow);
    if (ly > -600 * this.vp.dpr && ly < ch + 600 * this.vp.dpr) {
      const r = Math.max(cw * 0.9, 110 * s);
      const lg = ctx.createRadialGradient(cw * 1.02, ly, 0, cw * 1.02, ly, r);
      const k = L.lampLit ? 0.34 : 0.14;
      lg.addColorStop(0, `rgba(255, 176, 84, ${k})`);
      lg.addColorStop(0.45, `rgba(240, 150, 70, ${k * 0.45})`);
      lg.addColorStop(1, "rgba(240,150,70,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = lg;
      ctx.fillRect(0, ly - r, cw, r * 2);
      ctx.globalCompositeOperation = "source-over";
    }

    // The royal chamber: hushed, near black, one dim pool around her.
    const qk = this.positions.indexOf(this.queenSerial);
    const queen = qk >= 0 ? { x: this.positions.x[qk], y: this.positions.y[qk] } : null;
    const ry0 = yOf(ROW.stone2End);
    if (ry0 < ch) {
      ctx.fillStyle = "rgba(6, 3, 2, 0.16)";
      ctx.fillRect(0, Math.max(0, ry0), cw, ch - Math.max(0, ry0));
      if (queen) {
        const qx = queen.x * s;
        const qy = yOf(queen.y);
        const r = 34 * s;
        const qg = ctx.createRadialGradient(qx, qy, 0, qx, qy, r);
        qg.addColorStop(0, "rgba(255, 190, 120, 0.3)");
        qg.addColorStop(1, "rgba(255, 190, 120, 0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = qg;
        ctx.fillRect(qx - r, qy - r, r * 2, r * 2);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // The observer's lamp.
    if (this.lamp.on) {
      const lx = this.lamp.x * s;
      const lyy = yOf(this.lamp.y);
      const r = 18 * s;
      const og = ctx.createRadialGradient(lx, lyy, 0, lx, lyy, r);
      og.addColorStop(0, "rgba(255, 226, 170, 0.34)");
      og.addColorStop(0.5, "rgba(255, 200, 130, 0.12)");
      og.addColorStop(1, "rgba(255, 200, 130, 0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = og;
      ctx.fillRect(lx - r, lyy - r, r * 2, r * 2);
      ctx.globalCompositeOperation = "source-over";
    }

    // The frame's shadow falls on the glass edges.
    const edge = Math.min(cw * 0.06, 26 * this.vp.dpr);
    const lgE = ctx.createLinearGradient(0, 0, edge, 0);
    lgE.addColorStop(0, "rgba(8, 5, 3, 0.55)");
    lgE.addColorStop(1, "rgba(8, 5, 3, 0)");
    ctx.fillStyle = lgE;
    ctx.fillRect(0, 0, edge, ch);
    const rgE = ctx.createLinearGradient(cw, 0, cw - edge, 0);
    rgE.addColorStop(0, "rgba(8, 5, 3, 0.55)");
    rgE.addColorStop(1, "rgba(8, 5, 3, 0)");
    ctx.fillStyle = rgE;
    ctx.fillRect(cw - edge, 0, edge, ch);
    ctx.restore();
    void world;
    void W;
  }

  private queenSerial = 1;
  private isQueen(serial: number) {
    return serial === this.queenSerial;
  }

  private drawSelection(ctx: CanvasRenderingContext2D, camRow: number, s: number, now: number) {
    if (this.selected === null) return;
    const sk = this.positions.indexOf(this.selected);
    if (sk < 0) return;
    const p = { x: this.positions.x[sk], y: this.positions.y[sk], serial: this.selected };
    const x = p.x * s;
    const y = (p.y - camRow) * s;
    const dpr = this.vp.dpr;
    const pulse = this.reducedMotion ? 0 : Math.sin(now / 420) * 0.12;
    ctx.save();
    ctx.strokeStyle = VERMILION;
    ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, s * (2.6 + pulse), 0, TAU);
    ctx.stroke();
    // A specimen pin line and tag.
    const tx = x + s * 5;
    const ty = y - s * 5;
    ctx.beginPath();
    ctx.moveTo(x + s * 1.9, y - s * 1.9);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    const label = `No. ${p.serial}`;
    ctx.font = `${Math.round(11 * dpr)}px ${this.bookFont}`;
    const w = ctx.measureText(label).width + 10 * dpr;
    const hgt = 16 * dpr;
    ctx.fillStyle = BONE;
    ctx.fillRect(tx, ty - hgt, w, hgt);
    ctx.strokeRect(tx, ty - hgt, w, hgt);
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.fillText(label, tx + 5 * dpr, ty - hgt / 2 + 0.5 * dpr);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Picking, tracking and the lens
  // -------------------------------------------------------------------------

  pick(wx: number, wy: number, radius: number): number | null {
    const P = this.positions;
    let best = -1;
    let bestD = radius * radius;
    for (let k = 0; k < P.n; k++) {
      const d = (P.x[k] - wx) ** 2 + (P.y[k] - wy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best >= 0 ? P.serial[best] : null;
  }

  positionOf(serial: number): { x: number; y: number } | null {
    const k = this.positions.indexOf(serial);
    return k >= 0 ? { x: this.positions.x[k], y: this.positions.y[k] } : null;
  }

  /** Render a magnified disc of the world at (wx, wy) into the lens canvas. */
  drawLens(lens: HTMLCanvasElement, wx: number, wy: number, mag: number, now: number) {
    const world = this.client.world;
    if (!world) return;
    const g = lens.getContext("2d")!;
    const dpr = this.vp.dpr;
    const size = lens.width;
    const s = this.vp.cell * mag * dpr;
    this.lensTiles.setScale(s, dpr * 1.2);
    const halfCells = size / 2 / s;
    const camRow = wy - halfCells;
    const col0 = wx - halfCells;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, TAU);
    g.clip();
    g.fillStyle = wy < ROW.ground + 2 ? "#d9d2bd" : CAVITY;
    g.fillRect(0, 0, size, size);
    g.translate(-col0 * s, 0);
    this.lensTiles.draw(g as unknown as CanvasRenderingContext2D, camRow, halfCells * 2 + 1, 6, col0 - 1, col0 + halfCells * 2 + 1);
    // Chemistry: under the lens the trails show as coloured ink.
    const saveCh = this.chemistry;
    const vpSave = this.vp;
    this.vp = { ...vpSave, cell: vpSave.cell * mag };
    this.drawScent(g as unknown as CanvasRenderingContext2D, camRow, s, world.meta.W * s, size, 1);
    this.drawAlarm(g as unknown as CanvasRenderingContext2D, camRow, s, world.meta.W * s, size);
    this.drawPiles(g as unknown as CanvasRenderingContext2D, world, camRow, halfCells * 2 + 1, s);
    this.drawLetters(g as unknown as CanvasRenderingContext2D, camRow, halfCells * 2 + 1, s);
    const frames = this.currentFrames(now);
    if (frames.cur) this.drawBrood(g as unknown as CanvasRenderingContext2D, frames.cur, camRow, halfCells * 2 + 1, s);
    this.drawFoods(g as unknown as CanvasRenderingContext2D, camRow, s, now);
    this.drawCorpses(g as unknown as CanvasRenderingContext2D, camRow, halfCells * 2 + 1, s);
    // Ants at lens scale, with legs.
    const P = this.positions;
    for (let k = 0; k < P.n; k++) {
      const px = P.x[k];
      const py = P.y[k];
      if (Math.abs(px - wx) > halfCells + 3 || Math.abs(py - wy) > halfCells + 3) continue;
      const packed = P.packed[k];
      const caste = packed & 7;
      const carry = (packed >>> 3) & 15;
      const flags = (packed >>> 11) & 31;
      const L = (BODY_CELLS[caste] ?? 2.3) * s;
      const gait = Math.floor((this.odometer[P.slot[k]] ?? 0) * 3.2) & 3;
      const spr = antSprite(caste, L, gait);
      const c = Math.cos(P.h[k]);
      const sn = Math.sin(P.h[k]);
      g.setTransform(c, sn, -sn, c, (px - col0) * s, (py - camRow) * s);
      g.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
      if (carry !== Carry.None) {
        const serial = P.serial[k];
        const ch = carry === Carry.Letter ? this.client.letters.find((l) => l.bearer === serial && l.state === 1)?.ch ?? "e" : "";
        drawCarried(g, carry, L, this.bookFont, ch);
      }
      if (flags & FLAG_SELECTED) {
        g.strokeStyle = VERMILION;
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        g.arc(0, 0, L * 0.9, 0, TAU);
        g.stroke();
      }
    }
    this.vp = vpSave;
    this.chemistry = saveCh;
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Lens vignette.
    const vg = g.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size / 2);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(20, 12, 6, 0.55)");
    g.fillStyle = vg;
    g.fillRect(0, 0, size, size);
    g.restore();
    void Caste;
  }
}

function lerp3(a: number[], b: number[], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
