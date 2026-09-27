"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useObservatory, useUi } from "./ObservatoryProvider";
import { Shelf } from "./Shelf";

const INCH_ROWS = 12.7;
const GROUND = 84;

/** Etched depth marks: one tick to the inch, a numeral every six. */
function Gauge() {
  const marks: { row: number; label: string }[] = [];
  for (let inch = 6; inch * INCH_ROWS + GROUND < 712; inch += 6) {
    const feet = Math.floor(inch / 12);
    const rem = inch % 12;
    marks.push({ row: GROUND + inch * INCH_ROWS, label: feet ? `${feet} ft${rem ? ` ${rem}` : ""}` : `${inch} in` });
  }
  return (
    <>
      <div className="gauge" />
      <span className="gauge-mark" style={{ top: `calc(var(--cell) * ${GROUND})` }}>
        <small>ground</small>
      </span>
      {marks.map((m) => (
        <span key={m.row} className="gauge-mark" style={{ top: `calc(var(--cell) * ${m.row})` }}>
          {m.label}
        </span>
      ))}
    </>
  );
}

function Corner({ style, flip }: { style: React.CSSProperties; flip: string }) {
  return (
    <svg className="brass-corner" style={{ ...style, transform: flip }} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="brassG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e6cc90" />
          <stop offset="0.5" stopColor="#b48d4a" />
          <stop offset="1" stopColor="#7c5c2c" />
        </linearGradient>
      </defs>
      <path d="M0 0 H40 C30 4 22 10 16 16 C10 22 4 30 0 40 Z" fill="url(#brassG)" stroke="#4d3818" strokeWidth="0.8" />
      <path d="M3 3 H31 C24 7 18 12 13 17 C8 22 5 27 3 32 Z" fill="none" stroke="rgba(255,238,196,0.55)" strokeWidth="0.6" />
      <circle cx="9" cy="9" r="2.6" fill="#caa865" stroke="#4d3818" strokeWidth="0.6" />
      <path d="M7.4 10.4 L10.6 7.6" stroke="#4d3818" strokeWidth="0.7" />
    </svg>
  );
}

/** The fault in the frame: a chipped notch by the eastern brass. */
function Fault() {
  return (
    <svg className="fault" style={{ top: `calc(var(--cell) * ${GROUND - 3} - 11px)` }} viewBox="0 0 16 22" aria-hidden="true">
      <path d="M0 4 L5 6 L3 10 L7 12 L4 17 L0 19 Z" fill="#050302" />
      <path d="M5 6 L11 3 M7 12 L15 13 M4 17 L10 21" stroke="rgba(255,240,210,0.35)" strokeWidth="0.5" fill="none" />
    </svg>
  );
}

function LabLamp() {
  return (
    <div className="lab-lamp" aria-hidden="true">
      <div className="glow" />
      <svg viewBox="0 0 48 120" width="48" height="120">
        <defs>
          <linearGradient id="lampBrass" x1="0" x2="1">
            <stop offset="0" stopColor="#7c5c2c" />
            <stop offset="0.45" stopColor="#e2c88c" />
            <stop offset="1" stopColor="#8a6a34" />
          </linearGradient>
          <radialGradient id="flameG" cx="0.5" cy="0.65" r="0.6">
            <stop offset="0" stopColor="#fff4c8" />
            <stop offset="0.5" stopColor="#ffb44c" />
            <stop offset="1" stopColor="rgba(255,120,40,0)" />
          </radialGradient>
        </defs>
        <path d="M17 18 C12 34 12 48 18 56 H30 C36 48 36 34 31 18 Z" fill="rgba(230,220,200,0.12)" stroke="rgba(255,240,210,0.4)" strokeWidth="0.8" />
        <g className="flame">
          <ellipse cx="24" cy="44" rx="12" ry="16" fill="url(#flameG)" />
          <path d="M24 34 C21 40 21 46 24 50 C27 46 27 40 24 34 Z" fill="#fff0c0" />
        </g>
        <rect x="16" y="55" width="16" height="6" rx="1" fill="url(#lampBrass)" stroke="#3d2c12" strokeWidth="0.6" />
        <path d="M10 62 H38 C40 72 36 82 24 84 C12 82 8 72 10 62 Z" fill="url(#lampBrass)" stroke="#3d2c12" strokeWidth="0.7" />
        <rect x="21" y="84" width="6" height="18" fill="url(#lampBrass)" stroke="#3d2c12" strokeWidth="0.6" />
        <path d="M8 104 H40 L44 112 H4 Z" fill="url(#lampBrass)" stroke="#3d2c12" strokeWidth="0.7" />
      </svg>
    </div>
  );
}

export function Formicarium({ notebook, slips, description }: { notebook: ReactNode; slips: ReactNode; description: ReactNode }) {
  const obs = useObservatory();
  const canvas = useRef<HTMLCanvasElement>(null);
  const glass = useRef<HTMLDivElement>(null);
  const tool = useUi((s) => s.tool);

  useEffect(() => {
    if (!obs) return;
    obs.attachStage(canvas.current, glass.current);
  }, [obs]);

  return (
    <section className="hill" aria-labelledby="hill-title">
      <h2 id="hill-title" className="sr-only">
        The formicarium, from the surface down to the royal chamber
      </h2>
      <div className="stile stile-left" aria-hidden="true">
        <Gauge />
        <Corner style={{ left: 0, top: 0 }} flip="none" />
        <Corner style={{ left: 0, bottom: 0 }} flip="scaleY(-1)" />
      </div>
      <div className="glass" ref={glass} data-tool={tool}>
        <div className="stage-wrap">
          <canvas ref={canvas} className="stage" aria-hidden="true" />
          <div className="sheen" />
        </div>
        {slips}
        <div className="sr-only">{description}</div>
      </div>
      <div className="stile stile-right" aria-hidden="true">
        <Fault />
        <Corner style={{ right: 0, top: 0 }} flip="scaleX(-1)" />
        <Corner style={{ right: 0, bottom: 0 }} flip="scale(-1, -1)" />
      </div>
      <div className="gutter" aria-hidden="true">
        <LabLamp />
      </div>
      {notebook}
      <Shelf />
    </section>
  );
}
