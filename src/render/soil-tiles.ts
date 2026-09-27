/**
 * The soil, engraved. The grid is cut into 16x16-cell tiles; each tile is
 * drawn once into a cached canvas and redrawn only when ants dig or the
 * mound grows there. Materials are hand-tinted washes with stipple and
 * hatching; the edges of every tunnel are traced by marching squares with a
 * little deterministic tremor, like a burin line.
 */
import { Mat, ROW } from "../sim/constants";
import { Rng, hash01 } from "../sim/rng";
import { INK, MATERIAL, rgba } from "./palette";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const TILE = 16;

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export interface SoilSource {
  W: number;
  H: number;
  soil: Uint8Array;
  ground: Int16Array;
}

/** Engraved texture for one material, drawn in device pixels. */
function materialPattern(m: number, unit: number, seed: number): Canvas {
  const size = Math.round(120 * unit) & ~1;
  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d") as Ctx2D;
  const spec = MATERIAL[m];
  const rng = new Rng(seed * 31 + m);
  ctx.fillStyle = spec.base;
  ctx.fillRect(0, 0, size, size);
  // A soft wash variation, as if tinted by hand.
  for (let k = 0; k < 14; k++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(size * 0.1, size * 0.35);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const light = rng.chance(0.5);
    g.addColorStop(0, light ? rgba(spec.light, 0.18) : rgba(spec.ink, 0.12));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }
  }
  const dot = (x: number, y: number, r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const u = unit;
  const stipple = (n: number, alpha: number, rMin: number, rMax: number) => {
    for (let k = 0; k < n; k++) {
      dot(rng.range(0, size), rng.range(0, size), rng.range(rMin, rMax) * u, rgba(spec.ink, alpha * rng.range(0.5, 1)));
    }
  };
  const lightStipple = (n: number, alpha: number) => {
    for (let k = 0; k < n; k++) dot(rng.range(0, size), rng.range(0, size), rng.range(0.3, 0.7) * u, rgba(spec.light, alpha));
  };
  const hline = (y: number, alpha: number, width: number, wobble: number) => {
    ctx.strokeStyle = rgba(spec.ink, alpha);
    ctx.lineWidth = width * u;
    ctx.beginPath();
    let started = false;
    for (let x = -4; x <= size + 4; x += 6 * u) {
      const yy = y + Math.sin(x * 0.05 + y) * wobble * u + rng.range(-0.3, 0.3) * u;
      if (!started) {
        ctx.moveTo(x, yy);
        started = true;
      } else if (rng.chance(0.04)) {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 3 * u, yy);
      } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  };
  const d = size * size;
  switch (spec.kind) {
    case "stipple":
      stipple(d / (26 * u * u), 0.55, 0.35, 0.9);
      lightStipple(d / (120 * u * u), 0.25);
      break;
    case "strata":
      for (let y = 2 * u; y < size; y += rng.range(3.5, 7) * u) hline(y, m === Mat.Bedrock ? 0.55 : 0.28, rng.range(0.4, 0.9), 1.2);
      stipple(d / (70 * u * u), 0.4, 0.3, 0.7);
      lightStipple(d / (160 * u * u), 0.3);
      break;
    case "hatch":
      for (let y = 1.5 * u; y < size; y += 2.8 * u) hline(y, 0.26, 0.55, 0.5);
      stipple(d / (180 * u * u), 0.35, 0.3, 0.6);
      break;
    case "cross":
      ctx.strokeStyle = rgba(spec.ink, 0.3);
      ctx.lineWidth = 0.55 * u;
      for (let k = -size; k < size * 2; k += 3.2 * u) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k + size, size);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(spec.ink, 0.16);
      for (let k = -size; k < size * 2; k += 4.6 * u) {
        ctx.beginPath();
        ctx.moveTo(k, size);
        ctx.lineTo(k + size, 0);
        ctx.stroke();
      }
      stipple(d / (200 * u * u), 0.35, 0.3, 0.6);
      break;
    case "grain":
      for (let k = 0; k < d / (60 * u * u); k++) {
        const x = rng.range(0, size);
        const y = rng.range(0, size);
        const r = rng.range(0.6, 1.8) * u;
        ctx.strokeStyle = rgba(spec.ink, 0.5);
        ctx.lineWidth = 0.45 * u;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.2, r, rng.range(0, 3), 0, Math.PI * 2);
        ctx.stroke();
        if (rng.chance(0.4)) dot(x - r * 0.3, y - r * 0.3, r * 0.35, rgba(spec.light, 0.4));
      }
      stipple(d / (50 * u * u), 0.4, 0.3, 0.7);
      break;
  }
  return c;
}

interface CachedTile {
  canvas: Canvas | ImageBitmap;
  version: number;
}

export class SoilTiles {
  private tiles = new Map<number, CachedTile>();
  private stamp = new Map<number, number>();
  private patterns: (CanvasPattern | null)[] = [];
  private patternCanvases: (Canvas | null)[] = [];
  private tilesW = 0;
  private tilesH = 0;
  private globalVersion = 1;
  private scale = 0;
  private src: SoilSource | null = null;
  private seed: number;
  private maxTiles: number;
  private scratch: Canvas | null = null;

  constructor(seed: number, maxTiles = 260) {
    this.seed = seed;
    this.maxTiles = maxTiles;
  }

  setSource(src: SoilSource) {
    this.src = src;
    this.tilesW = Math.ceil(src.W / TILE);
    this.tilesH = Math.ceil(src.H / TILE);
    this.invalidateAll();
  }

  /** Device pixels per cell. Changing it redraws everything. */
  setScale(scale: number, unit: number) {
    if (Math.abs(scale - this.scale) < 0.001 && this.patterns.length) return;
    this.scale = scale;
    this.patternCanvases = MATERIAL.map((_, m) => (m === Mat.Open || m === Mat.Stem ? null : materialPattern(m, unit, this.seed)));
    this.patterns = [];
    this.invalidateAll();
  }

  invalidateAll() {
    this.globalVersion++;
    for (const t of this.tiles.values()) if (typeof ImageBitmap !== "undefined" && t.canvas instanceof ImageBitmap) t.canvas.close();
    this.tiles.clear();
    this.stamp.clear();
  }

  invalidateCells(cells: number[]) {
    if (!this.src) return;
    const W = this.src.W;
    for (const i of cells) {
      const x = i % W;
      const y = (i / W) | 0;
      // Marching squares reads neighbours, so touch adjacent tiles at edges.
      const tx0 = Math.floor((x - 1) / TILE);
      const tx1 = Math.floor((x + 1) / TILE);
      const ty0 = Math.floor((y - 1) / TILE);
      const ty1 = Math.floor((y + 1) / TILE);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tx < 0 || ty < 0 || tx >= this.tilesW || ty >= this.tilesH) continue;
          const key = ty * this.tilesW + tx;
          this.stamp.set(key, (this.stamp.get(key) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * Draw tiles covering world rows [row0, row0 + rows) into ctx, where one cell
   * is `scale` device pixels and the canvas y=0 corresponds to row0.
   * At most `budget` tiles are (re)rendered this call; others use stale art.
   */
  draw(ctx: CanvasRenderingContext2D, row0: number, rows: number, budget: number, colFrom = 0, colTo = Infinity): number {
    if (!this.src) return 0;
    const s = this.scale;
    const ty0 = Math.max(0, Math.floor(row0 / TILE));
    const ty1 = Math.min(this.tilesH - 1, Math.floor((row0 + rows) / TILE));
    const tx0 = Math.max(0, Math.floor(colFrom / TILE));
    const tx1 = Math.min(this.tilesW - 1, Math.floor(Math.min(colTo, this.src.W) / TILE));
    let rendered = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      // The sky rows hold no soil worth tiling.
      if ((ty + 1) * TILE < ROW.ground - 20) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = ty * this.tilesW + tx;
        const want = (this.stamp.get(key) ?? 0) + this.globalVersion * 100000;
        let t = this.tiles.get(key);
        if (!t || t.version !== want) {
          if (rendered < budget || !t) {
            t = this.renderTile(tx, ty, want, t);
            rendered++;
          }
        }
        if (t) {
          // Refresh LRU order.
          this.tiles.delete(key);
          this.tiles.set(key, t);
          ctx.drawImage(t.canvas as CanvasImageSource, Math.round(tx * TILE * s), Math.round((ty * TILE - row0) * s));
        }
      }
    }
    while (this.tiles.size > this.maxTiles) {
      const first = this.tiles.keys().next().value as number;
      const t = this.tiles.get(first);
      if (t && typeof ImageBitmap !== "undefined" && t.canvas instanceof ImageBitmap) t.canvas.close();
      this.tiles.delete(first);
    }
    return rendered;
  }

  private pattern(ctx: Ctx2D, m: number): CanvasPattern | null {
    const c = this.patternCanvases[m];
    if (!c) return null;
    return ctx.createPattern(c as CanvasImageSource, "repeat");
  }

  private renderTile(tx: number, ty: number, version: number, reuse?: CachedTile): CachedTile {
    const src = this.src!;
    const s = this.scale;
    const px = Math.ceil(TILE * s);
    // Render into a shared scratch canvas, then freeze it into a bitmap the GPU can keep.
    if (!this.scratch || this.scratch.width !== px || this.scratch.height !== px) this.scratch = makeCanvas(px, px);
    const canvas = this.scratch;
    if (reuse && typeof ImageBitmap !== "undefined" && reuse.canvas instanceof ImageBitmap) reuse.canvas.close();
    const ctx = canvas.getContext("2d") as Ctx2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, px, px);
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    const W = src.W;
    const H = src.H;
    const soil = src.soil;
    const seed = this.seed;
    const mat = (x: number, y: number) => {
      if (x < 0) x = 0;
      if (x >= W) x = W - 1;
      if (y < 0) return Mat.Open;
      if (y >= H) return Mat.Bedrock;
      return soil[y * W + x];
    };
    const open = (x: number, y: number) => {
      const m = mat(x, y);
      return m === Mat.Open || m === Mat.Stem;
    };
    const plain = (m: number) => m !== Mat.Open && m !== Mat.Stem && m !== Mat.Stone && m !== Mat.Root;
    const stratum = (y: number) =>
      y < ROW.ground + 34
        ? Mat.Topsoil
        : y < ROW.stone1
          ? Mat.Sand
          : y < ROW.stone1End
            ? Mat.Gravel
            : y < ROW.stone2
              ? Mat.Clay
              : y < ROW.stone2End
                ? Mat.Gravel
                : y < ROW.bedrock
                  ? Mat.DeepClay
                  : Mat.Bedrock;
    /** The earth a cell is made of, for tinting; dug and stony cells borrow their surroundings. */
    const base = (x: number, y: number): number => {
      const m = mat(x, y);
      if (m === Mat.Root) return Mat.Topsoil;
      if (plain(m)) return m;
      for (let d = 1; d < 5; d++) {
        const b = mat(x, y + d);
        if (plain(b)) return b;
        const u = mat(x, y - d);
        if (plain(u)) return u;
      }
      return stratum(y);
    };
    // World cell (x, y) maps to tile pixels ((x - x0) * s, (y - y0) * s).
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);

    const fillWith = (m: number, path: Path2D) => {
      const pat = this.pattern(ctx, m);
      if (pat) {
        pat.setTransform(new DOMMatrix().scale(1 / s, 1 / s));
        ctx.fillStyle = pat;
      } else ctx.fillStyle = MATERIAL[m].base;
      ctx.fill(path);
    };

    // 1. The earth, one path per material.
    const gx0 = x0 - 1;
    const gy0 = y0 - 1;
    const G = TILE + 3;
    const baseGrid = new Uint8Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) baseGrid[j * G + i] = base(gx0 + i, gy0 + j);
    const bAt = (x: number, y: number) => baseGrid[(y - gy0) * G + (x - gx0)];
    const byMat = new Map<number, Path2D>();
    const pathFor = (map: Map<number, Path2D>, m: number) => {
      let p = map.get(m);
      if (!p) {
        p = new Path2D();
        map.set(m, p);
      }
      return p;
    };
    for (let j = 0; j < G; j++) {
      let run = 0;
      for (let i = 1; i <= G; i++) {
        if (i === G || baseGrid[j * G + i] !== baseGrid[j * G + run]) {
          pathFor(byMat, baseGrid[j * G + run]).rect(gx0 + run, gy0 + j, i - run, 1);
          run = i;
        }
      }
    }
    for (const [m, p] of byMat) fillWith(m, p);

    // 2. Where one earth meets another, interlocking scallops instead of steps.
    const scallops = new Map<number, Path2D>();
    for (let y = y0; y <= y0 + TILE; y++) {
      for (let x = x0; x <= x0 + TILE; x++) {
        const here = bAt(x, y);
        const up = bAt(x, y - 1);
        if (here !== up && hash01(seed, x, y, 11) < 0.8) {
          const h = hash01(seed, x, y, 7);
          const m = h < 0.5 ? up : here;
          const cx = x + 0.5 + (hash01(seed, x, y, 12) - 0.5) * 0.6;
          const cy = y + (h < 0.5 ? 0.1 : -0.1);
          const rx = 0.5 + hash01(seed, x, y, 13) * 0.6;
          const ry = 0.2 + hash01(seed, x, y, 8) * 0.6;
          const p = pathFor(scallops, m);
          p.moveTo(cx + rx, cy);
          p.ellipse(cx, cy, rx, ry, (hash01(seed, x, y, 14) - 0.5) * 0.6, 0, Math.PI * 2);
        }
        const left = bAt(x - 1, y);
        if (here !== left) {
          const h = hash01(seed, x, y, 9);
          const m = h < 0.5 ? left : here;
          const rx = 0.3 + hash01(seed, x, y, 10) * 0.4;
          const p = pathFor(scallops, m);
          p.moveTo(x + rx, y + 0.5);
          p.ellipse(x, y + 0.5, rx, 0.7, 0, 0, Math.PI * 2);
        }
      }
    }
    for (const [m, p] of scallops) fillWith(m, p);

    // 3. Stones: pale, outlined, shaded on their lower sides (marching squares).
    const stonePath = new Path2D();
    const stoneContour = new Path2D();
    const jitter = (ex: number, ey: number) => (hash01(seed, ex, ey) - 0.5) * 0.3;
    const mid = (ax: number, ay: number, bx: number, by: number): [number, number] => {
      const mx = (ax + bx) / 2 + 0.5;
      const my = (ay + by) / 2 + 0.5;
      const j = jitter(ax + bx, ay + by);
      return ax === bx ? [mx + j, my] : [mx, my + j];
    };
    const isStone = (x: number, y: number) => mat(x, y) === Mat.Stone;
    let anyStone = false;
    let anyRoot = false;
    for (let j = y0 - 1; j < y0 + TILE; j++) {
      for (let i = x0 - 1; i < x0 + TILE; i++) {
        if (mat(i, j) === Mat.Root) anyRoot = true;
        const tl = isStone(i, j);
        const tr = isStone(i + 1, j);
        const br = isStone(i + 1, j + 1);
        const bl = isStone(i, j + 1);
        const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (code === 0) continue;
        anyStone = true;
        if (code === 15) {
          stonePath.rect(i + 0.5, j + 0.5, 1, 1);
          continue;
        }
        const TL: [number, number] = [i + 0.5, j + 0.5];
        const TR: [number, number] = [i + 1.5, j + 0.5];
        const BR: [number, number] = [i + 1.5, j + 1.5];
        const BL: [number, number] = [i + 0.5, j + 1.5];
        const T = mid(i, j, i + 1, j);
        const R = mid(i + 1, j, i + 1, j + 1);
        const B = mid(i, j + 1, i + 1, j + 1);
        const L = mid(i, j, i, j + 1);
        const pts: [number, number][] = [];
        if (tl) pts.push(TL);
        if (tl !== tr) pts.push(T);
        if (tr) pts.push(TR);
        if (tr !== br) pts.push(R);
        if (br) pts.push(BR);
        if (br !== bl) pts.push(B);
        if (bl) pts.push(BL);
        if (bl !== tl) pts.push(L);
        stonePath.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) stonePath.lineTo(pts[k][0], pts[k][1]);
        stonePath.closePath();
        const seg = (a: [number, number], b: [number, number]) => {
          stoneContour.moveTo(a[0], a[1]);
          stoneContour.lineTo(b[0], b[1]);
        };
        switch (code) {
          case 1:
          case 14:
            seg(L, B);
            break;
          case 2:
          case 13:
            seg(B, R);
            break;
          case 3:
          case 12:
            seg(L, R);
            break;
          case 4:
          case 11:
            seg(T, R);
            break;
          case 5:
            seg(L, T);
            seg(B, R);
            break;
          case 6:
          case 9:
            seg(T, B);
            break;
          case 7:
          case 8:
            seg(L, T);
            break;
          case 10:
            seg(T, R);
            seg(L, B);
            break;
        }
      }
    }
    if (anyStone) {
      ctx.save();
      ctx.clip(stonePath);
      const pat = this.pattern(ctx, Mat.Stone);
      if (pat) {
        pat.setTransform(new DOMMatrix().scale(1 / s, 1 / s));
        ctx.fillStyle = pat;
      }
      ctx.fillRect(x0 - 1, y0 - 1, TILE + 2, TILE + 2);
      ctx.strokeStyle = rgba(INK, 0.32);
      ctx.lineWidth = 0.9 / s;
      for (let k = -TILE; k < TILE * 2; k += 0.5) {
        ctx.beginPath();
        ctx.moveTo(x0 + k, y0 + TILE + 1);
        ctx.lineTo(x0 + k + 1.4, y0 + TILE - 0.4);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = rgba(INK, 0.78);
      ctx.lineWidth = 1.05 / s;
      ctx.stroke(stoneContour);
    }

    // 4. Roots: fine dark fibres through the topsoil.
    if (anyRoot) {
      ctx.strokeStyle = "rgba(24, 15, 8, 0.6)";
      ctx.lineWidth = Math.max(0.8 / s, 0.18);
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let y = y0 - 1; y <= y0 + TILE; y++) {
        for (let x = x0 - 1; x <= x0 + TILE; x++) {
          if (mat(x, y) !== Mat.Root) continue;
          for (const [dx, dy] of [
            [0, 1],
            [1, 1],
            [-1, 1],
            [1, 0],
          ]) {
            if (mat(x + dx, y + dy) === Mat.Root) {
              const w1 = (hash01(seed, x, y, 3) - 0.5) * 0.5;
              ctx.moveTo(x + 0.5 + w1, y + 0.5);
              ctx.quadraticCurveTo(x + 0.5 + dx * 0.5 - w1, y + 0.5 + dy * 0.5, x + dx + 0.5, y + dy + 0.5);
            }
          }
        }
      }
      ctx.stroke();
    }

    // 5. Hollows: smoothed marching squares over a lightly blurred "open" field,
    //    so galleries have rounded, continuous walls; the hole is punched out and
    //    its edge engraved in ink.
    const F = TILE + 6;
    const fx0 = x0 - 3;
    const fy0 = y0 - 3;
    const raw = new Float32Array(F * F);
    let anyOpen = false;
    for (let j = 0; j < F; j++) {
      for (let i = 0; i < F; i++) {
        const y = fy0 + j;
        if (y < H && open(fx0 + i, y)) {
          raw[j * F + i] = 1;
          anyOpen = true;
        }
      }
    }
    if (anyOpen) {
      const f = new Float32Array(F * F);
      for (let j = 1; j < F - 1; j++) {
        for (let i = 1; i < F - 1; i++) {
          const k = j * F + i;
          f[k] = raw[k] * 0.52 + (raw[k - 1] + raw[k + 1] + raw[k - F] + raw[k + F]) * 0.1 + (raw[k - F - 1] + raw[k - F + 1] + raw[k + F - 1] + raw[k + F + 1]) * 0.02;
        }
      }
      const at = (x: number, y: number) => f[(y - fy0) * F + (x - fx0)];
      const hole = new Path2D();
      const edge = new Path2D();
      const iso = 0.5;
      for (let j = y0 - 1; j < y0 + TILE + 1; j++) {
        for (let i = x0 - 1; i < x0 + TILE + 1; i++) {
          const a = at(i, j);
          const b = at(i + 1, j);
          const c = at(i + 1, j + 1);
          const d = at(i, j + 1);
          const tl = a > iso;
          const tr = b > iso;
          const br = c > iso;
          const bl = d > iso;
          const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
          if (code === 0) continue;
          const cx = i + 0.5;
          const cy = j + 0.5;
          if (code === 15) {
            hole.rect(cx - 0.01, cy - 0.01, 1.02, 1.02);
            continue;
          }
          const lerp = (p: number, q: number) => (iso - p) / (q - p);
          const T: [number, number] = [cx + lerp(a, b), cy];
          const R: [number, number] = [cx + 1, cy + lerp(b, c)];
          const B: [number, number] = [cx + lerp(d, c), cy + 1];
          const L: [number, number] = [cx, cy + lerp(a, d)];
          const pts: [number, number][] = [];
          if (tl) pts.push([cx, cy]);
          if (tl !== tr) pts.push(T);
          if (tr) pts.push([cx + 1, cy]);
          if (tr !== br) pts.push(R);
          if (br) pts.push([cx + 1, cy + 1]);
          if (br !== bl) pts.push(B);
          if (bl) pts.push([cx, cy + 1]);
          if (bl !== tl) pts.push(L);
          hole.moveTo(pts[0][0], pts[0][1]);
          for (let k = 1; k < pts.length; k++) hole.lineTo(pts[k][0], pts[k][1]);
          hole.closePath();
          const seg = (p: [number, number], q: [number, number]) => {
            edge.moveTo(p[0], p[1]);
            edge.lineTo(q[0], q[1]);
          };
          switch (code) {
            case 1:
            case 14:
              seg(L, B);
              break;
            case 2:
            case 13:
              seg(B, R);
              break;
            case 3:
            case 12:
              seg(L, R);
              break;
            case 4:
            case 11:
              seg(T, R);
              break;
            case 5:
              seg(L, T);
              seg(B, R);
              break;
            case 6:
            case 9:
              seg(T, B);
              break;
            case 7:
            case 8:
              seg(L, T);
              break;
            case 10:
              seg(T, R);
              seg(L, B);
              break;
          }
        }
      }
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      ctx.fill(hole);
      ctx.globalCompositeOperation = "source-over";

      // Ceiling shadow: short hatch strokes under overhanging earth, inside the hollow.
      ctx.save();
      ctx.clip(hole);
      ctx.strokeStyle = rgba("#2b1d12", 0.42);
      ctx.lineWidth = 0.9 / s;
      ctx.beginPath();
      for (let y = y0; y < y0 + TILE; y++) {
        for (let x = x0; x < x0 + TILE; x++) {
          if (!open(x, y) || y < src.ground[Math.min(W - 1, Math.max(0, x))]) continue;
          if (open(x, y - 1)) continue;
          for (let k = 0; k < 3; k++) {
            const hx = x + (k + 0.25) / 3;
            ctx.moveTo(hx, y);
            ctx.lineTo(hx + 0.16, y + 0.55 + hash01(seed, x * 7 + k, y) * 0.3);
          }
        }
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = rgba(INK, 0.92);
      ctx.lineWidth = Math.max(1.1 / s, 0.2);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(edge);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
      return { canvas: canvas.transferToImageBitmap(), version };
    }
    // Without OffscreenCanvas each tile keeps its own canvas.
    this.scratch = null;
    return { canvas, version };
  }
}
