"use client";

import { useEffect, useRef, useState } from "react";
import { FRAGMENTS } from "@/content/notebook";
import { useObservatory, useUi } from "./ObservatoryProvider";
import { shortTime } from "./TodaySlip";

function PageCanvas() {
  const obs = useObservatory();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    obs?.attachOverlay(ref.current);
  }, [obs]);
  return <canvas ref={ref} className="page-overlay" aria-hidden="true" />;
}

function Lens() {
  const obs = useObservatory();
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    obs?.attachLens(el.current, canvas.current);
  }, [obs]);
  return (
    <div ref={el} className="lens" data-visible="0" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}

/** Touch: brass handles for the lamp and the lens, dragged without fighting the scroll. */
function TouchKnobs() {
  const obs = useObservatory();
  const touch = useUi((s) => s.touch);
  const lens = useUi((s) => s.lens);
  const lampRef = useRef<HTMLButtonElement>(null);
  const lensRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!obs || !touch) return;
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      for (const [which, ref] of [
        ["lamp", lampRef],
        ["lens", lensRef],
      ] as const) {
        const el = ref.current;
        if (!el) continue;
        const p = obs.instrumentPosition(which);
        el.style.display = p ? "block" : "none";
        if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [obs, touch]);
  if (!touch) return null;
  const drag = (which: "lamp" | "lens") => (e: React.PointerEvent<HTMLButtonElement>) => {
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => obs?.dragInstrument(which, ev.clientX, ev.clientY - (which === "lens" ? 70 : 0));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <>
      <button ref={lampRef} type="button" className="touch-knob" style={{ display: "none" }} aria-label="Observation lamp: drag to move" onPointerDown={drag("lamp")}>
        lamp
      </button>
      {lens ? (
        <button ref={lensRef} type="button" className="touch-knob lens-knob" style={{ display: "none" }} aria-label="Lens: drag to move" onPointerDown={drag("lens")}>
          lens
        </button>
      ) : null}
    </>
  );
}

function ReturnNote() {
  const obs = useObservatory();
  const note = useUi((s) => s.returnNote);
  const ref = useRef<HTMLButtonElement>(null);
  if (!note) return null;
  return (
    <section className="return-note" aria-labelledby="return-h" role="dialog" aria-modal="false">
      <h2 id="return-h">While you were away</h2>
      <p>{note.text}</p>
      <button ref={ref} type="button" className="paper-btn" onClick={() => obs?.store.set({ returnNote: null })}>
        Return to the glass
      </button>
    </section>
  );
}

function Summary() {
  const obs = useObservatory();
  const summary = useUi((s) => s.summary);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (summary) closeRef.current?.focus();
  }, [summary]);
  if (!summary) return null;
  return (
    <section className="summary" role="dialog" aria-modal="false" aria-labelledby="summary-h">
      <h2 id="summary-h">What is happening now</h2>
      <p>{summary}</p>
      <button ref={closeRef} type="button" className="paper-btn" onClick={() => obs?.store.set({ summary: null })}>
        Close
      </button>
    </section>
  );
}

function Toast() {
  const obs = useObservatory();
  const message = useUi((s) => s.message);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => obs?.store.set({ message: null }), 3200);
    return () => clearTimeout(t);
  }, [message, obs]);
  return message ? (
    <p className="toast" role="status">
      {message}
    </p>
  ) : null;
}

/** Polite narration for screen readers, rate-limited by the observatory. */
function LiveRegion() {
  const announce = useUi((s) => s.announce);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announce}
    </div>
  );
}

function Drawer() {
  const obs = useObservatory();
  const open = useUi((s) => s.notebookOpen);
  const notes = useUi((s) => s.notes);
  const lettersOut = useUi((s) => s.letters.length);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <section className="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-h">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 id="drawer-h">Dr. Vance&rsquo;s notes</h2>
        <button ref={closeRef} type="button" className="paper-btn" onClick={() => obs?.store.set({ notebookOpen: false })}>
          Close
        </button>
      </div>
      <h3>Today</h3>
      {notes.length ? (
        <ol>
          {notes.slice(0, 12).map((n) => (
            <li key={n.id}>
              <span style={{ fontFamily: "var(--font-book)", fontSize: "0.72rem", fontStyle: "italic", marginRight: 6 }}>{shortTime(n.at)}</span>
              {n.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="hand">Nothing yet. Watch for a while.</p>
      )}
      {lettersOut > 0 ? (
        <button type="button" className="paper-btn" onClick={() => obs?.restoreLetters()}>
          Restore the notebook ({lettersOut} taken)
        </button>
      ) : null}
      <h3>1893</h3>
      <ol>
        {FRAGMENTS.map((f) => (
          <li key={f.id}>
            <span style={{ display: "block", fontSize: "1.05rem", color: "var(--color-vermilion-ink)" }}>{f.date}</span>
            {f.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Narrow screens: the newest notable note appears above the rail for a while. */
function Ticker() {
  const notes = useUi((s) => s.notes);
  const open = useUi((s) => s.notebookOpen);
  const note = notes.find((n) => n.weight >= 2) ?? null;
  const [hiddenId, setHiddenId] = useState<number | null>(null);
  const [glassInView, setGlassInView] = useState(true);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setHiddenId(note.id), 9000);
    return () => clearTimeout(t);
  }, [note]);
  // Only while the glass is in view: never over the ledger below.
  useEffect(() => {
    const hill = document.querySelector(".hill");
    if (!hill) return;
    const io = new IntersectionObserver(([e]) => setGlassInView(e.intersectionRatio > 0.25), { threshold: [0, 0.25, 0.5] });
    io.observe(hill);
    return () => io.disconnect();
  }, []);
  if (!note || open || hiddenId === note.id || !glassInView) return null;
  return (
    <p className="ticker" aria-hidden="true">
      <time>{shortTime(note.at)}</time>
      {note.text}
    </p>
  );
}

function PerfPanel() {
  const debug = useUi((s) => s.debug);
  const perf = useUi((s) => s.perf);
  const pop = useUi((s) => s.census?.population ?? 0);
  if (!debug) return null;
  return (
    <div className="perf" aria-hidden="true">
      {`fps ${perf.fps}  p90 ${perf.p90}ms  tier ${perf.tier}\nants ${pop}  drawn ${perf.drawn}  draw ${perf.drawMs}ms\nsim ${perf.msPerTick}ms/tick`}
    </div>
  );
}

function ErrorNote() {
  const error = useUi((s) => s.error);
  const [shown, setShown] = useState(true);
  if (!error || !shown) return null;
  return (
    <div className="return-note" role="alert">
      <h2>The case would not open</h2>
      <p style={{ fontFamily: "var(--font-book)", fontSize: "1rem" }}>Something went wrong in the colony: {error}</p>
      <button type="button" className="paper-btn" onClick={() => setShown(false)}>
        Dismiss
      </button>
    </div>
  );
}

export function Overlays() {
  return (
    <>
      <PageCanvas />
      <Lens />
      <TouchKnobs />
      <ReturnNote />
      <Summary />
      <Toast />
      <LiveRegion />
      <Drawer />
      <Ticker />
      <PerfPanel />
      <ErrorNote />
    </>
  );
}
