"use client";

import { useId } from "react";
import { useUi } from "./ObservatoryProvider";

const r2 = (n: number) => Math.round(n * 100) / 100;

const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

/** The pocket watch keeps the visitor's own time; the aperture shows the real moon. */
function Watch({ hour, moon }: { hour: number | null; moon: number }) {
  const id = useId();
  const h = hour ?? 10.15;
  const hourAngle = ((h % 12) / 12) * 360;
  const minuteAngle = ((h % 1) * 60 / 60) * 360;
  // The moon aperture: a disc sliding behind a window, lit side by phase.
  const lit = Math.cos(moon * Math.PI * 2);
  return (
    <svg viewBox="0 0 120 132" width="104" height="114" role="img" aria-label={hour === null ? "A pocket watch" : `A pocket watch showing ${Math.floor(h % 12) || 12}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`}>
      <defs>
        <radialGradient id={`${id}b`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#f2dca2" />
          <stop offset="0.55" stopColor="#b8924f" />
          <stop offset="1" stopColor="#5e4520" />
        </radialGradient>
        <radialGradient id={`${id}d`} cx="0.45" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#f4ecd6" />
          <stop offset="1" stopColor="#d8caa6" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="10" r="7" fill="none" stroke={`url(#${id}b)`} strokeWidth="3" />
      <rect x="55" y="14" width="10" height="9" rx="2" fill={`url(#${id}b)`} stroke="#3d2c12" strokeWidth="0.6" />
      <circle cx="60" cy="74" r="54" fill={`url(#${id}b)`} stroke="#3d2c12" strokeWidth="1" />
      <circle cx="60" cy="74" r="46" fill={`url(#${id}d)`} stroke="#6b5026" strokeWidth="1" />
      <circle cx="60" cy="74" r="43" fill="none" stroke="rgba(40,26,10,0.5)" strokeWidth="0.5" />
      {Array.from({ length: 60 }, (_, k) => {
        const a = (k / 60) * Math.PI * 2;
        const r1 = k % 5 === 0 ? 39.5 : 41.5;
        return (
          <line key={k} x1={r2(60 + Math.sin(a) * r1)} y1={r2(74 - Math.cos(a) * r1)} x2={r2(60 + Math.sin(a) * 43)} y2={r2(74 - Math.cos(a) * 43)} stroke="#2a1d10" strokeWidth={k % 5 === 0 ? 0.9 : 0.4} />
        );
      })}
      {ROMAN.map((r, k) => {
        const a = (k / 12) * Math.PI * 2;
        return (
          <text key={r} x={r2(60 + Math.sin(a) * 33)} y={r2(74 - Math.cos(a) * 33 + 2.6)} fontSize="7.2" textAnchor="middle" fill="#2a1d10" fontFamily="var(--font-plate)">
            {r}
          </text>
        );
      })}
      {/* Moon aperture */}
      <path d="M46 90 A14 14 0 0 1 74 90 Z" fill="#1c2233" stroke="#6b5026" strokeWidth="0.6" />
      <clipPath id={`${id}m`}>
        <path d="M46 90 A14 14 0 0 1 74 90 Z" />
      </clipPath>
      <g clipPath={`url(#${id}m)`}>
        <circle cx="60" cy="86" r="5" fill="#2c3040" />
        <ellipse cx="60" cy="86" rx={Math.abs(lit) * 5} ry="5" fill="#ece2c4" />
        <path d={moon < 0.5 ? "M60 81 A5 5 0 0 1 60 91 Z" : "M60 81 A5 5 0 0 0 60 91 Z"} fill={lit < 0 ? "#ece2c4" : "#2c3040"} />
      </g>
      <g stroke="#1d130a" strokeLinecap="round">
        <line x1="60" y1="74" x2={r2(60 + Math.sin((hourAngle * Math.PI) / 180) * 22)} y2={r2(74 - Math.cos((hourAngle * Math.PI) / 180) * 22)} strokeWidth="2.4" />
        <line x1="60" y1="74" x2={r2(60 + Math.sin((minuteAngle * Math.PI) / 180) * 34)} y2={r2(74 - Math.cos((minuteAngle * Math.PI) / 180) * 34)} strokeWidth="1.4" />
      </g>
      <circle cx="60" cy="74" r="2.2" fill="#1d130a" />
    </svg>
  );
}

/** The barometer reads the colony's weather: it falls ahead of rain. */
function Barometer({ pressure }: { pressure: number | null }) {
  const id = useId();
  const p = pressure ?? 1013;
  const t = Math.max(0, Math.min(1, (p - 985) / 50));
  const angle = -120 + t * 240;
  const labels = ["Stormy", "Rain", "Change", "Fair", "Very dry"];
  const word = p < 998 ? "rain" : p < 1010 ? "change" : "fair";
  return (
    <svg viewBox="0 0 120 120" width="104" height="104" role="img" aria-label={`A barometer reading ${word}`}>
      <defs>
        <radialGradient id={`${id}b`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#f2dca2" />
          <stop offset="0.55" stopColor="#b8924f" />
          <stop offset="1" stopColor="#5e4520" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="56" fill={`url(#${id}b)`} stroke="#3d2c12" strokeWidth="1" />
      <circle cx="60" cy="60" r="48" fill="#ede3ca" stroke="#6b5026" strokeWidth="1" />
      {Array.from({ length: 41 }, (_, k) => {
        const a = ((-120 + k * 6) * Math.PI) / 180;
        const r1 = k % 5 === 0 ? 38 : 41;
        return <line key={k} x1={r2(60 + Math.sin(a) * r1)} y1={r2(60 - Math.cos(a) * r1)} x2={r2(60 + Math.sin(a) * 44)} y2={r2(60 - Math.cos(a) * 44)} stroke="#2a1d10" strokeWidth={k % 5 === 0 ? 0.8 : 0.35} />;
      })}
      {labels.map((l, k) => {
        const a = ((-100 + k * 50) * Math.PI) / 180;
        return (
          <text key={l} x={r2(60 + Math.sin(a) * 29)} y={r2(60 - Math.cos(a) * 29 + 2)} fontSize="6" fontStyle="italic" textAnchor="middle" fill="#2a1d10" fontFamily="var(--font-book)">
            {l}
          </text>
        );
      })}
      <g transform={`rotate(${angle} 60 60)`}>
        <line x1="60" y1="70" x2="60" y2="20" stroke="#1d130a" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M60 16 L57.5 24 L62.5 24 Z" fill="#1d130a" />
      </g>
      <circle cx="60" cy="60" r="3" fill={`url(#${id}b)`} stroke="#1d130a" strokeWidth="0.6" />
    </svg>
  );
}

export function Instruments() {
  const env = useUi((s) => s.census?.env ?? null);
  const day = useUi((s) => s.census?.colonyDay ?? null);
  return (
    <div className="instruments" aria-label="The observer's instruments">
      <figure style={{ margin: 0, textAlign: "center" }}>
        <Watch hour={env ? env.localHour : null} moon={env?.moonPhase ?? 0.3} />
        <figcaption style={{ fontSize: "0.78rem", fontStyle: "italic", color: "rgb(212 180 120 / 0.9)" }}>
          {env ? `Your time. ${env.season[0].toUpperCase()}${env.season.slice(1)}.` : "Your time."}
        </figcaption>
      </figure>
      <figure style={{ margin: 0, textAlign: "center" }}>
        <Barometer pressure={env ? env.pressure : null} />
        <figcaption style={{ fontSize: "0.78rem", fontStyle: "italic", color: "rgb(212 180 120 / 0.9)" }}>
          {day ? `Day ${day} of the colony.` : " "}
        </figcaption>
      </figure>
    </div>
  );
}
