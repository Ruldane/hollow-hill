/**
 * The page overlay: a fixed, pointer-transparent canvas above the notebook
 * where escaped foragers walk (in document coordinates) carrying letters,
 * and where the winged ones cross the whole viewport once on the evening
 * of the nuptial flight.
 */
import { Caste } from "../sim/constants";
import type { ColonyClient } from "../client/colony-client";
import type { FlyerView } from "../worker/protocol";
import { antSprite, BODY_CELLS } from "./sprites";
import { INK } from "./palette";

interface Flight {
  serial: number;
  female: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  born: number;
  life: number;
}

export class PageLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private client: ColonyClient;
  private flights: Flight[] = [];
  cellPx = 4;
  dpr = 1;
  bookFont = "Georgia, serif";
  reducedMotion = false;
  private stillPositions: { x: number; y: number; h: number; ch: string; carrying: boolean }[] = [];
  private stillAt = 0;
  private odo = new Map<number, number>();

  constructor(canvas: HTMLCanvasElement, client: ColonyClient) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.client = client;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = Math.min(2, dpr);
    const W = Math.round(w * this.dpr);
    const H = Math.round(h * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  /** Launch the flyers from where they left the world (viewport coords given). */
  launch(flyers: FlyerView[], origin: (f: FlyerView) => { x: number; y: number }, now: number) {
    const vh = this.canvas.height / this.dpr;
    const vw = this.canvas.width / this.dpr;
    for (const f of flyers) {
      const o = origin(f);
      const x = Math.max(8, Math.min(vw - 8, o.x));
      const y = o.y > vh || o.y < 0 ? vh + 10 : o.y;
      this.flights.push({
        serial: f.serial,
        female: f.female,
        x,
        y,
        vx: (Math.random() - 0.3) * 30,
        vy: -(45 + Math.random() * 40),
        phase: Math.random() * 6,
        born: now + Math.random() * 1500,
        life: 9000,
      });
    }
  }

  get busy(): boolean {
    return this.flights.length > 0 || this.client.pageAnts.length > 0;
  }

  draw(scrollX: number, scrollY: number, now: number, alpha: number) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Escaped ants.
    const cur = this.client.pageAnts;
    const prev = new Map(this.client.prevPageAnts.map((p) => [p.serial, p]));
    let list = cur.map((p) => {
      const q = prev.get(p.serial);
      let x = p.x;
      let y = p.y;
      let h = p.heading;
      if (q && !this.reducedMotion) {
        x = q.x + (p.x - q.x) * alpha;
        y = q.y + (p.y - q.y) * alpha;
        let dh = p.heading - q.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        h = q.heading + dh * alpha;
        const moved = Math.hypot(p.x - q.x, p.y - q.y);
        this.odo.set(p.serial, (this.odo.get(p.serial) ?? 0) + moved * 0.02);
      }
      return { serial: p.serial, x, y, h, ch: p.ch, carrying: !!p.carrying };
    });
    if (this.reducedMotion) {
      // Still observations, refreshed every few seconds.
      if (now - this.stillAt > 3200) {
        this.stillPositions = list.map((p) => ({ x: p.x, y: p.y, h: p.h, ch: p.ch, carrying: p.carrying }));
        this.stillAt = now;
      }
      list = this.stillPositions.map((p, i) => ({ serial: i, ...p }));
    }
    const L = BODY_CELLS[Caste.Worker] * this.cellPx * dpr;
    for (const p of list) {
      const X = (p.x - scrollX) * dpr;
      const Y = (p.y - scrollY) * dpr;
      if (X < -40 || Y < -40 || X > this.canvas.width + 40 || Y > this.canvas.height + 40) continue;
      const gait = this.reducedMotion ? 0 : Math.floor(this.odo.get(p.serial) ?? 0) & 3;
      const spr = antSprite(Caste.Worker, L, gait);
      const c = Math.cos(p.h);
      const s = Math.sin(p.h);
      // A faint shadow: they are on the paper, not in it.
      ctx.setTransform(c, s, -s, c, X + 1.2 * dpr, Y + 1.6 * dpr);
      ctx.globalAlpha = 0.18;
      ctx.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
      ctx.globalAlpha = 1;
      ctx.setTransform(c, s, -s, c, X, Y);
      ctx.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
      if (p.carrying && p.ch) {
        ctx.translate(L * 0.7, 0);
        ctx.rotate(Math.PI / 2);
        ctx.font = `${Math.round(L * 1.35)}px ${this.bookFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = INK;
        ctx.fillText(p.ch, 0, 0);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // The flight.
    if (this.flights.length) {
      const keep: Flight[] = [];
      for (const f of this.flights) {
        const t = now - f.born;
        if (t < 0) {
          keep.push(f);
          continue;
        }
        if (t > f.life) continue;
        const sec = t / 1000;
        let x = f.x + f.vx * sec + Math.sin(sec * 2.2 + f.phase) * 18;
        let y = f.y + f.vy * sec - sec * sec * 6;
        if (this.reducedMotion) {
          // One still: scattered in the air, fading.
          x = f.x + f.vx * 2;
          y = f.y + f.vy * 2.4;
        }
        if (y < -40) continue;
        const fade = this.reducedMotion ? Math.max(0, 1 - t / 6000) : Math.min(1, t / 300) * (1 - Math.max(0, (t - f.life + 1200) / 1200));
        const caste = f.female ? Caste.AlateF : Caste.AlateM;
        const Lf = BODY_CELLS[caste] * this.cellPx * dpr * 1.6;
        const spr = antSprite(caste, Lf, 0);
        const heading = -Math.PI / 2 + Math.sin(sec * 1.7 + f.phase) * 0.35;
        ctx.globalAlpha = fade;
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
        ctx.drawImage(spr.canvas as CanvasImageSource, -spr.cx, -spr.cy);
        // Beating wings: a blur of two strokes.
        if (!this.reducedMotion) {
          const beat = Math.sin(now / 28 + f.phase) * 0.5 + 0.5;
          ctx.strokeStyle = `rgba(226, 214, 186, ${0.55 * fade})`;
          ctx.lineWidth = Lf * 0.16;
          for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(-Lf * 0.05, 0);
            ctx.lineTo(-Lf * 0.45, side * Lf * (0.25 + beat * 0.45));
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        keep.push(f);
      }
      this.flights = keep;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
