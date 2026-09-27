"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { INSTRUCTIONS } from "@/content/notebook";
import { useObservatory, useUi } from "./ObservatoryProvider";

export function shortTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const pm = h >= 12;
  h = h % 12 || 12;
  return `${h}.${String(m).padStart(2, "0")} ${pm ? "p.m." : "a.m."}`;
}

export function longDate(ms: number): string {
  const d = new Date(ms);
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  const month = d.toLocaleDateString("en-GB", { month: "long" });
  return `${weekday}, ${day}${suffix} ${month}`;
}

/** The pinned slip of today's live notes. The page scrolls beneath it. */
export function TodaySlip() {
  const obs = useObservatory();
  const notes = useUi((s) => s.notes);
  const envNow = useUi((s) => s.census?.envNow ?? null);
  const lettersOut = useUi((s) => s.letters.length);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1600px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const latest = notes.slice(0, wide ? 2 : 1);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  // On wide screens the slip rests on the shelf instead of over the notebook.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1600px)");
    const update = () => setDock(mq.matches ? document.getElementById("today-dock") : null);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const body = (
    <section className={dock ? "today docked" : "today"} aria-labelledby="today-h">
      <h2 id="today-h">
        <span>Observations</span>
        <span style={{ letterSpacing: 0, textTransform: "none", fontStyle: "italic" }}>{envNow ? longDate(envNow) : ""}</span>
      </h2>
      {latest.length ? (
        <ol>
          {latest.map((n, i) => (
            <li key={n.id} className={i === 0 ? "fresh" : undefined}>
              <time dateTime={new Date(n.at).toISOString()}>{shortTime(n.at)}</time>
              {n.text}
            </li>
          ))}
        </ol>
      ) : (
        <div className="instructions">
          {INSTRUCTIONS.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      )}
      <p style={{ margin: "10px 0 0", display: "flex", gap: 14, flexWrap: "wrap", fontSize: "0.86rem" }}>
        <a className="text-link" href="#today-log">
          All of today&rsquo;s notes
        </a>
        {lettersOut > 0 ? (
          <button type="button" className="text-link" onClick={() => obs?.restoreLetters()}>
            Restore the notebook ({lettersOut} {lettersOut === 1 ? "letter" : "letters"} taken)
          </button>
        ) : null}
      </p>
    </section>
  );
  return dock ? createPortal(body, dock) : body;
}