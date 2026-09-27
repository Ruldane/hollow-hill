"use client";

import { useState } from "react";
import { DeathCause } from "@/sim/constants";
import { COLOPHON } from "@/content/notebook";
import { durationPhrase } from "@/notes/grammar";
import { useObservatory, useUi } from "./ObservatoryProvider";
import { longDate, shortTime } from "./TodaySlip";

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

export function CensusTable() {
  const c = useUi((s) => s.census);
  if (!c) {
    return (
      <p className="hand" style={{ fontSize: "1.4rem" }}>
        The census is being taken.
      </p>
    );
  }
  const brood = c.eggs + c.larvae + c.pupae;
  const remarkStores = c.starving ? "empty" : c.stores < c.population * 0.03 ? "running low" : c.stores > c.population * 0.12 ? "plenty" : "";
  const rows: { group?: string; label?: string; n?: number | string; remark?: string }[] = [
    { group: "The living" },
    { label: "Queen", n: c.queenAlive ? 1 : 0, remark: c.queenAlive ? "" : "lost" },
    { label: "Workers", n: c.workers },
    { label: "Soldiers", n: c.soldiers },
    { label: "Winged females", n: c.alatesF, remark: c.flightActive ? "flying" : c.env.flightWeather && c.alatesF + c.alatesM > 5 ? "restless" : "" },
    { label: "Winged males", n: c.alatesM },
    { group: "At work" },
    { label: "Nurses", n: c.roles[0] },
    { label: "Diggers", n: c.roles[1] },
    { label: "Foragers", n: c.roles[2], remark: c.abroad > 0 ? `${fmt(c.abroad)} abroad` : "all in" },
    { label: "In reserve", n: c.roles[3] },
    { label: "On the page", n: c.onPage, remark: c.onPage ? "among my notes" : "" },
    { group: "Brood" },
    { label: "Eggs", n: c.eggs },
    { label: "Larvae", n: c.larvae },
    { label: "Pupae", n: c.pupae, remark: brood === 0 ? "none" : "" },
    { group: "Stores and works" },
    { label: "Stores, in loads", n: c.stores, remark: remarkStores },
    { label: "Food abroad", n: Math.round(c.surfaceFood) },
    { label: "Chambers", n: c.chambers },
    { label: "Galleries, in feet", n: c.tunnelFeet.toFixed(1) },
    { label: "Deepest, in inches", n: c.deepestInches.toFixed(1) },
    { label: "Husks in the midden", n: c.midden },
    { group: "Since the case was sealed" },
    { label: "Born", n: c.births },
    { label: "Dead of age", n: c.deathsByCause[DeathCause.Age] },
    { label: "Dead of hunger", n: c.deathsByCause[DeathCause.Starvation] },
    { label: "Lost to cave-ins", n: c.deathsByCause[DeathCause.CaveIn] },
    { label: "Drowned", n: c.deathsByCause[DeathCause.Drowned] },
    { label: "Nuptial flights", n: c.flights, remark: c.flown ? `${fmt(c.flown)} flew` : "" },
    { label: "Letters borrowed", n: c.lettersTakenTotal, remark: c.lettersOut ? `${c.lettersOut} still held` : "" },
  ];
  return (
    <table className="census">
      <caption>
        Taken at {shortTime(c.envNow)}, {longDate(c.envNow)}, on day {c.colonyDay} of the colony. It changes as you read.
      </caption>
      <thead>
        <tr>
          <th scope="col">Entry</th>
          <th scope="col" style={{ textAlign: "right", paddingRight: 18 }}>
            Count
          </th>
          <th scope="col">Remarks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) =>
          r.group ? (
            <tr key={i} className="group">
              <th scope="colgroup" colSpan={3}>
                {r.group}
              </th>
            </tr>
          ) : (
            <tr key={i}>
              <th scope="row">{r.label}</th>
              <td className="n">{typeof r.n === "number" ? fmt(r.n) : r.n}</td>
              <td className="remark">{r.remark}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

export function LettersHeld() {
  const obs = useObservatory();
  const letters = useUi((s) => s.letters);
  const words = useUi((s) => s.letterWords);
  if (!letters.length) {
    return <p>None at present. The ants have not yet found their way out of the case, or have returned everything.</p>;
  }
  return (
    <>
      <p>
        {letters.length === 1 ? "One letter is" : `${letters.length} letters are`} held by the colony. Those already underground lie in the
        store among the seeds. The words themselves are intact for anyone reading aloud.
      </p>
      <ul className="letters-held">
        {letters.map((l) => {
          const w = words[l.key];
          return (
            <li key={l.key}>
              {w ? (
                <>
                  {w.word.slice(0, w.index)}
                  <span className="gap" aria-hidden="true">
                    &nbsp;
                  </span>
                  {w.word.slice(w.index + 1)}
                  <span className="sr-only">
                    {" "}
                    (the {l.ch} of {w.word})
                  </span>
                </>
              ) : (
                <span>{l.ch}</span>
              )}
              <span className="held">{l.state === 2 ? "in the store" : "being carried"}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="paper-btn seal" onClick={() => obs?.restoreLetters()}>
        Restore the notebook
      </button>
    </>
  );
}

export function Visits() {
  const visits = useUi((s) => s.visits);
  const founded = useUi((s) => s.meta?.foundedAt ?? null);
  if (!visits.length) return <p>&nbsp;</p>;
  const recent = visits.slice(-8).reverse();
  return (
    <>
      {founded ? <p>The case was sealed on {longDate(founded)}, at {shortTime(founded)}</p> : null}
      <ol className="visit-list">
        {recent.map((v, i) => (
          <li key={v.at}>
            <span>
              {longDate(v.at)}, {shortTime(v.at)}
            </span>
            <span style={{ fontStyle: "italic" }}>{i === 0 ? "now" : v.seconds > 30 ? durationPhrase(v.seconds * 1000) : "a glance"}</span>
          </li>
        ))}
      </ol>
      {visits.length > 8 ? <p style={{ fontSize: "0.86rem", fontStyle: "italic" }}>and {visits.length - 8} visits before these.</p> : null}
    </>
  );
}

export function Absences() {
  const notes = useUi((s) => s.absenceNotes);
  if (!notes.length) return <p>Nothing yet. Close the page and come back; the colony will not wait for you.</p>;
  return (
    <ol className="absences">
      {notes
        .slice(-6)
        .reverse()
        .map((n) => (
          <li key={n.at}>
            <time dateTime={new Date(n.at).toISOString()}>
              {longDate(n.at)}, {shortTime(n.at)}
            </time>
            {n.text}
          </li>
        ))}
    </ol>
  );
}

export function TodayLog() {
  const notes = useUi((s) => s.notes);
  if (!notes.length) return <p>Nothing written yet.</p>;
  return (
    <ol className="absences">
      {notes.slice(0, 40).map((n) => (
        <li key={n.id}>
          <time dateTime={new Date(n.at).toISOString()}>{shortTime(n.at)}</time>
          {n.text}
        </li>
      ))}
    </ol>
  );
}

export function ObserverSettings() {
  const obs = useObservatory();
  const still = useUi((s) => s.still);
  const narrate = useUi((s) => s.narrate);
  const system = useUi((s) => s.systemReduced);
  return (
    <div>
      <label className="switch-row">
        <input type="checkbox" checked={still} onChange={(e) => obs?.setStill(e.target.checked)} />
        <span>
          Still plates: show the colony as a sequence of still observations, a few seconds apart.
          {system ? " Your system asks for reduced motion, so this is on by default." : ""}
        </span>
      </label>
      <label className="switch-row">
        <input type="checkbox" checked={narrate} onChange={(e) => obs?.setNarrate(e.target.checked)} />
        <span>Narrate notable events aloud to screen readers, no more than once in forty-five seconds.</span>
      </label>
      <button type="button" className="paper-btn" onClick={() => obs?.requestSummary()}>
        What is happening now?
      </button>
    </div>
  );
}

export function Colophon() {
  const obs = useObservatory();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="colophon">
      <p>{COLOPHON}</p>
      <p>
        Set in Bodoni Moda, Old Standard TT and Pinyon Script. The colony is a simulation of several thousand individuals, each with a
        number, an age, needs and a history; it runs beside the page, not in it.
      </p>
      {confirm ? (
        <p style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span>This colony and its records will be lost. Found another?</span>
          <button
            type="button"
            className="paper-btn seal"
            onClick={() => {
              setConfirm(false);
              obs?.resetColony();
            }}
          >
            Yes, seal a new case
          </button>
          <button type="button" className="paper-btn" onClick={() => setConfirm(false)}>
            Keep this one
          </button>
        </p>
      ) : (
        <button type="button" className="paper-btn" onClick={() => setConfirm(true)}>
          Found a new colony
        </button>
      )}
    </div>
  );
}
