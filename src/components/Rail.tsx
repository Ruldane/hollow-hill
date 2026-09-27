"use client";

import { useState, type MouseEvent } from "react";
import { FoodKind } from "@/sim/constants";
import { useObservatory, useUi } from "./ObservatoryProvider";

/** A small engraved clock face that stops when the clock is stopped. */
function Dial({ stopped }: { stopped: boolean }) {
  return (
    <svg className="dial" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="12.5" fill="rgba(255,244,214,0.35)" stroke="currentColor" strokeWidth="1.2" />
      {stopped ? (
        <g fill="currentColor">
          <rect x="9" y="8.5" width="3.4" height="11" rx="0.6" />
          <rect x="15.6" y="8.5" width="3.4" height="11" rx="0.6" />
        </g>
      ) : (
        <g stroke="currentColor" strokeLinecap="round">
          <line x1="14" y1="14" x2="14" y2="6.5" strokeWidth="1.6" />
          <line x1="14" y1="14" x2="19.5" y2="16.5" strokeWidth="1.6" />
        </g>
      )}
    </svg>
  );
}

export function Rail() {
  const obs = useObservatory();
  const speed = useUi((s) => s.speed);
  const tool = useUi((s) => s.tool);
  const lens = useUi((s) => s.lens);
  const chemistry = useUi((s) => s.chemistry);
  const touch = useUi((s) => s.touch);
  const offersLeft = useUi((s) => s.census?.offersLeft ?? 3);
  const population = useUi((s) => s.census?.population ?? null);
  const abroad = useUi((s) => s.census?.onPage ?? 0);
  const ready = useUi((s) => s.ready);
  const notebookOpen = useUi((s) => s.notebookOpen);
  const [tray, setTray] = useState(false);
  const [lampOn, setLampOn] = useState(false);

  const stopped = speed === 0;
  const keyboard = (e: MouseEvent) => e.detail === 0;

  const clock = (
    <button
      type="button"
      className="clock-btn"
      aria-pressed={stopped}
      onClick={() => obs?.setSpeed(stopped ? 1 : 0)}
      disabled={!ready}
      title="Stops and starts the colony and all its motion"
    >
      <Dial stopped={stopped} />
      {touch ? (stopped ? "Start" : "Stop") : stopped ? "Clock stopped" : "Stop the clock"}
      {touch ? <span className="sr-only"> the clock</span> : null}
    </button>
  );
  const hasten = (
    <button type="button" className="knob-btn" aria-pressed={speed === 4} onClick={() => obs?.setSpeed(speed === 4 ? 1 : 4)} disabled={!ready} title="Let the colony's time run four times faster">
      Hasten ×4
    </button>
  );
  const lensBtn = (
    <button type="button" className="knob-btn" aria-pressed={lens} onClick={() => obs?.toggleLens()} disabled={!ready} title="A magnifying glass: the engraving close up, and the scent trails the ants follow">
      Lens
    </button>
  );
  const scentBtn = (
    <button type="button" className="knob-btn" aria-pressed={chemistry} onClick={() => obs?.toggleChemistry()} disabled={!ready} title="Show the scent trails in gold ink (to food) and grey (home)">
      Scent
    </button>
  );
  const knockBtn = (
    <button
      type="button"
      className="knob-btn"
      aria-pressed={tool === "knock"}
      onClick={(e) => (keyboard(e) ? obs?.knockAtCentre() : obs?.setTool("knock"))}
      disabled={!ready}
      title="Tap the glass once and watch the alarm spread"
    >
      Knock
    </button>
  );
  const offerBtn = (kind: "crumb" | "honey") => (
    <button
      type="button"
      className="knob-btn"
      aria-pressed={tool === kind}
      disabled={!ready || offersLeft <= 0}
      title={kind === "honey" ? "Set a drop of honey on the surface" : "Set a crumb on the surface"}
      onClick={(e) => {
        const k = kind === "honey" ? FoodKind.Honey : FoodKind.Crumb;
        if (keyboard(e) || touch) obs?.offerAtSurface(k);
        else obs?.setTool(kind);
        setTray(false);
      }}
    >
      {kind === "honey" ? "Honey" : "Crumb"}
    </button>
  );
  const specimenBtn = (
    <button
      type="button"
      title="Choose an ant near the middle of the glass and read its card"
      className="knob-btn"
      onClick={() => {
        obs?.selectNearCentre();
        setTray(false);
      }}
      disabled={!ready}
    >
      Specimen
    </button>
  );
  const nowBtn = (
    <button
      type="button"
      className="knob-btn"
      onClick={() => {
        obs?.requestSummary();
        setTray(false);
      }}
      disabled={!ready}
    >
      What now?
    </button>
  );

  if (touch) {
    return (
      <div className="rail" role="toolbar" aria-label="Instruments">
        {tray ? (
          <div className="tray">
            {knockBtn}
            {scentBtn}
            {offerBtn("crumb")}
            {offerBtn("honey")}
            {specimenBtn}
            {nowBtn}
            {hasten}
            <span className="tray-note">
              {offersLeft} {offersLeft === 1 ? "offering" : "offerings"} left this visit
            </span>
          </div>
        ) : null}
        <div className="rail-plate">
          {clock}
          <button
            type="button"
            className="knob-btn"
            aria-pressed={lampOn}
            onClick={() => setLampOn(obs?.toggleTouchLamp() ?? false)}
            disabled={!ready}
          >
            Lamp
          </button>
          {lensBtn}
          <button type="button" className="knob-btn" aria-expanded={tray} onClick={() => setTray((t) => !t)}>
            Tools
          </button>
          <button
            type="button"
            className="knob-btn"
            aria-expanded={notebookOpen}
            onClick={() => obs?.store.set({ notebookOpen: !notebookOpen })}
          >
            Notes
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rail" role="toolbar" aria-label="Instruments">
      <div className="rail-plate">
        <div className="rail-group">
          {clock}
          {hasten}
        </div>
        <div className="rail-group">
          {lensBtn}
          {scentBtn}
          {knockBtn}
        </div>
        <div className="rail-group">
          {offerBtn("crumb")}
          {offerBtn("honey")}
          <span className="offer-count" title="Offerings you may still make this visit">
            {offersLeft} left
          </span>
        </div>
        <div className="rail-group">
          {specimenBtn}
          {nowBtn}
        </div>
        <p className="rail-status" aria-live="off">
          {population === null ? "Opening the case…" : `${population.toLocaleString("en-GB")} living${abroad ? `, ${abroad} on the page` : ""}`}
        </p>
      </div>
    </div>
  );
}
