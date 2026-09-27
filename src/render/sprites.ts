/**
 * Engraved insects. Each ant is drawn once per (caste, size, gait frame) into
 * a small cached canvas and stamped with a rotation. At a distance the ants
 * are three ink specks; close up (and under the lens) they have segments,
 * elbowed antennae and six legs moving in a tripod gait.
 */
import { Caste } from "../sim/constants";
import { INK, rgba } from "./palette";

export const BODY_CELLS = [2.3, 2.9, 5.2, 3.1, 2.7];

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Sprite {
  /** An immutable bitmap where supported, so the GPU keeps it as a texture. */
  canvas: HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
  /** Pixel offset of the body centre inside the sprite canvas. */
  cx: number;
  cy: number;
}

function freeze(c: Canvas): HTMLCanvasElement | OffscreenCanvas | ImageBitmap {
  if (typeof OffscreenCanvas !== "undefined" && c instanceof OffscreenCanvas) return c.transferToImageBitmap();
  return c;
}

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const cache = new Map<string, Sprite>();

export function clearSpriteCache() {
  for (const s of cache.values()) if (typeof ImageBitmap !== "undefined" && s.canvas instanceof ImageBitmap) s.canvas.close();
  cache.clear();
}

/** Legs: [attachX, baseAngle] per side; three pairs. */
const LEGS: [number, number][] = [
  [0.1, 0.95],
  [0.05, 1.62],
  [-0.01, 2.3],
];

export function antSprite(caste: number, lengthPx: number, frame: number, dead = false): Sprite {
  const L = Math.max(4, Math.round(lengthPx));
  const detail = L >= 11;
  const key = `${caste}:${L}:${detail ? frame & 3 : 0}:${dead ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pad = 2;
  const w = Math.ceil(L * 1.5) + pad * 2;
  const h = Math.ceil(L * 1.05) + pad * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d") as Ctx2D;
  const cx = Math.round(L * 0.78) + pad;
  const cy = Math.round(h / 2);
  ctx.translate(cx, cy);
  ctx.scale(L, L);
  drawAnt(ctx, caste, detail ? frame & 3 : 0, detail, L, dead);
  const s = { canvas: freeze(canvas), cx, cy };
  cache.set(key, s);
  return s;
}

function ellipse(ctx: Ctx2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

function drawAnt(ctx: Ctx2D, caste: number, frame: number, detail: boolean, L: number, dead: boolean) {
  const queen = caste === Caste.Queen;
  const soldier = caste === Caste.Soldier;
  const alate = caste === Caste.AlateF || caste === Caste.AlateM;
  const male = caste === Caste.AlateM;
  const body = dead ? "#4a3b30" : INK;
  const px = 1 / L;

  // Gaster, petiole, mesosoma, head.
  const gx = queen ? -0.4 : caste === Caste.AlateF ? -0.34 : -0.29;
  const grx = queen ? 0.37 : caste === Caste.AlateF ? 0.27 : male ? 0.17 : 0.22;
  const gry = queen ? 0.2 : caste === Caste.AlateF ? 0.16 : male ? 0.1 : 0.15;
  const hx = soldier ? 0.3 : 0.27;
  const hrx = soldier ? 0.155 : male ? 0.075 : 0.1;
  const hry = soldier ? 0.135 : male ? 0.07 : 0.09;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (detail) {
    // Legs: tripod gait. Set A = front-left, middle-right, hind-left.
    ctx.strokeStyle = body;
    ctx.lineWidth = Math.max(0.9 * px, queen ? 0.03 : 0.036);
    const swing = [0.26, -0.16, 0.05, -0.26][frame];
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < 3; k++) {
        const [ax, base] = LEGS[k];
        const setA = (k === 1 ? side === 1 : side === -1) ? 1 : -1;
        let ang = base + swing * setA;
        if (dead) ang = base * 0.6 + 0.9;
        const reach = queen ? 0.9 : 1;
        const kx = ax + Math.cos(ang) * 0.17 * reach;
        const ky = side * Math.sin(ang) * 0.19 * reach;
        const fx = kx + Math.cos(ang + (k === 0 ? -0.35 : 0.35)) * 0.19 * reach;
        let fy = ky + side * Math.sin(ang + (k === 0 ? -0.35 : 0.35)) * 0.14 * reach;
        if (dead) fy = ky * 0.4;
        ctx.beginPath();
        ctx.moveTo(ax, side * 0.02);
        ctx.lineTo(kx, ky);
        ctx.lineTo(fx, fy);
        ctx.stroke();
      }
    }
    // Antennae: scape then funiculus, elbowed.
    ctx.lineWidth = Math.max(0.75 * px, 0.026);
    const wave = [0.04, -0.03, 0.02, -0.04][frame];
    for (let side = -1; side <= 1; side += 2) {
      ctx.beginPath();
      ctx.moveTo(hx + 0.05, side * 0.04);
      const ex = hx + 0.12;
      const ey = side * (0.19 + wave * side);
      ctx.lineTo(ex, ey);
      ctx.quadraticCurveTo(ex + 0.1, ey - side * 0.02, hx + 0.3, side * (0.12 + wave));
      ctx.stroke();
    }
  }

  // Wings behind the body, translucent with veins.
  if (alate && detail && !dead) {
    for (let side = -1; side <= 1; side += 2) {
      ctx.save();
      ctx.fillStyle = "rgba(226, 214, 186, 0.42)";
      ctx.strokeStyle = "rgba(40, 28, 18, 0.55)";
      ctx.lineWidth = Math.max(0.5 * px, 0.012);
      ellipse(ctx, -0.3, side * 0.1, 0.42, 0.11, side * 0.14);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.05, side * 0.04);
      ctx.lineTo(-0.55, side * 0.16);
      ctx.moveTo(-0.1, side * 0.07);
      ctx.lineTo(-0.35, side * 0.02);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.fillStyle = body;
  ellipse(ctx, gx, 0, grx, gry);
  ctx.fill();
  ellipse(ctx, -0.075, 0, 0.045, 0.04);
  ctx.fill();
  ellipse(ctx, 0.07, 0, queen ? 0.16 : 0.135, queen ? 0.09 : 0.066);
  ctx.fill();
  ellipse(ctx, hx, 0, hrx, hry);
  ctx.fill();

  if (detail) {
    // Mandibles.
    ctx.strokeStyle = body;
    ctx.lineWidth = Math.max(0.8 * px, 0.03);
    for (let side = -1; side <= 1; side += 2) {
      ctx.beginPath();
      ctx.moveTo(hx + hrx * 0.8, side * hry * 0.45);
      ctx.quadraticCurveTo(hx + hrx + 0.06, side * hry * 0.5, hx + hrx + 0.05, side * 0.01);
      ctx.stroke();
    }
    // Engraved highlights: segment bands across the gaster, a glint on the thorax and head.
    ctx.strokeStyle = dead ? "rgba(160, 140, 120, 0.5)" : "rgba(150, 118, 84, 0.62)";
    ctx.lineWidth = Math.max(0.6 * px, 0.018);
    const bands = queen ? 5 : 3;
    for (let k = 1; k <= bands; k++) {
      const t = k / (bands + 1);
      const bx = gx + grx * (0.75 - t * 1.4);
      const span = Math.sqrt(Math.max(0, 1 - ((bx - gx) / grx) ** 2)) * gry * 0.82;
      ctx.beginPath();
      ctx.moveTo(bx + 0.02, -span);
      ctx.quadraticCurveTo(bx - 0.04, 0, bx + 0.02, span);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0.0, -0.035);
    ctx.lineTo(0.12, -0.03);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx + 0.01, -hry * 0.35, hrx * 0.45, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
    if (queen) {
      // The queen's gaster is banded pale between the plates.
      ctx.strokeStyle = "rgba(196, 160, 112, 0.35)";
      ctx.lineWidth = 0.02;
      for (let k = 1; k <= 4; k++) {
        const bx = gx + grx * (0.6 - k * 0.3);
        ctx.beginPath();
        ctx.ellipse(bx, 0, 0.03, gry * 0.9, 0, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Brood
// ---------------------------------------------------------------------------

export function broodSprite(stage: number, alate: boolean, cellPx: number): Sprite {
  const scale = alate ? 3 : 2.2;
  const key = `brood:${stage}:${alate ? 1 : 0}:${Math.round(cellPx * 4)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = Math.ceil(cellPx * 2.2 * scale) + 4;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d") as Ctx2D;
  const c = size / 2;
  ctx.translate(c, c);
  ctx.scale(cellPx * scale, cellPx * scale);
  const line = 1 / (cellPx * scale);
  ctx.lineWidth = Math.max(line * 0.7, 0.06);
  ctx.strokeStyle = "rgba(60, 40, 22, 0.75)";
  if (stage === 0) {
    ctx.fillStyle = "#f2ead6";
    ellipse(ctx, 0, 0, 0.3, 0.2, 0.3);
    ctx.fill();
    ctx.stroke();
  } else if (stage === 1) {
    ctx.fillStyle = "#efe4c8";
    ctx.beginPath();
    ctx.arc(0, 0.05, 0.5, Math.PI * 0.85, Math.PI * 2.25);
    ctx.arc(0.12, 0.05, 0.22, Math.PI * 2.25, Math.PI * 0.85, true);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = Math.max(line * 0.5, 0.04);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI * (1.0 + k * 0.3);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 0.26 + 0.06, Math.sin(a) * 0.26 + 0.05);
      ctx.lineTo(Math.cos(a) * 0.48, Math.sin(a) * 0.48 + 0.05);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = "#d9c49a";
    ellipse(ctx, 0, 0, 0.62, 0.3, -0.2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(70, 48, 26, 0.8)";
    ellipse(ctx, -0.5, 0.1, 0.09, 0.08);
    ctx.fill();
    ctx.strokeStyle = "rgba(90, 64, 36, 0.35)";
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(k * 0.2, -0.24);
      ctx.quadraticCurveTo(k * 0.2 - 0.05, 0, k * 0.2, 0.24);
      ctx.stroke();
    }
  }
  const s = { canvas: freeze(canvas), cx: c, cy: c };
  cache.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// Carried items, drawn in the ant's local frame just ahead of the mandibles.
// ---------------------------------------------------------------------------

export function drawCarried(ctx: Ctx2D, carry: number, L: number, bookFont: string, ch: string) {
  const x = L * 0.52;
  ctx.save();
  switch (carry) {
    case 1: // grain
      ctx.fillStyle = "#8a6a44";
      ctx.strokeStyle = rgba(INK, 0.6);
      ctx.lineWidth = Math.max(0.6, L * 0.02);
      ctx.beginPath();
      ctx.arc(x, 0, L * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 2: // seed
      ctx.fillStyle = "#d8c08a";
      ctx.strokeStyle = rgba(INK, 0.7);
      ctx.lineWidth = Math.max(0.6, L * 0.02);
      ctx.beginPath();
      ctx.ellipse(x + L * 0.04, 0, L * 0.14, L * 0.075, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 3: // honey
      ctx.fillStyle = "rgba(214, 150, 40, 0.92)";
      ctx.beginPath();
      ctx.arc(x, 0, L * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 236, 190, 0.8)";
      ctx.beginPath();
      ctx.arc(x - L * 0.03, -L * 0.03, L * 0.03, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 4: // meat
      ctx.fillStyle = "#5a2a1c";
      ctx.beginPath();
      ctx.ellipse(x, 0, L * 0.12, L * 0.08, 0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 5: // crumb
      ctx.fillStyle = "#e0c896";
      ctx.strokeStyle = rgba(INK, 0.5);
      ctx.lineWidth = Math.max(0.5, L * 0.015);
      ctx.beginPath();
      ctx.moveTo(x - L * 0.08, -L * 0.06);
      ctx.lineTo(x + L * 0.1, -L * 0.08);
      ctx.lineTo(x + L * 0.12, L * 0.06);
      ctx.lineTo(x - L * 0.06, L * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 6:
    case 7:
    case 8: {
      const b = broodSprite(carry - 6, false, L / 2.3);
      const s = (L / 2.3) * 0.9;
      ctx.drawImage(b.canvas, x + L * 0.08 - (b.cx * s) / (L / 2.3), -(b.cy * s) / (L / 2.3), (b.canvas.width * s) / (L / 2.3), (b.canvas.height * s) / (L / 2.3));
      break;
    }
    case 9: {
      const d = antSprite(Caste.Worker, L * 0.9, 0, true);
      ctx.translate(x + L * 0.3, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(d.canvas, -d.cx, -d.cy);
      break;
    }
    case 10: {
      ctx.translate(x + L * 0.18, 0);
      ctx.rotate(Math.PI / 2);
      ctx.font = `${Math.round(L * 0.95)}px ${bookFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = INK;
      ctx.fillText(ch || "e", 0, 0);
      break;
    }
  }
  ctx.restore();
}
