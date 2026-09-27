"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CARRY_NAMES, CASTE_NAMES, DEATH_NAMES, FOOD_NAMES, Hist, ROLE_NAMES, TASK_NAMES, Caste, Role } from "@/sim/constants";
import type { SpecimenData } from "@/sim/census";
import { durationPhrase } from "@/notes/grammar";
import { useObservatory, useUi } from "./ObservatoryProvider";
import { shortTime } from "./TodaySlip";

const ZONE_WORDS: Record<string, string> = {
  surface: "abroad on the surface",
  upper: "in the upper galleries",
  nursery: "in the deep nursery",
  royal: "in the royal chamber",
  bedrock: "at the bedrock",
  page: "out upon the page",
};

export function distanceWords(mm: number): string {
  const inches = mm / 25.4;
  if (inches < 12) return `${inches.toFixed(1)} in`;
  const feet = Math.floor(inches / 12);
  const rem = Math.round(inches - feet * 12);
  if (feet >= 5280 / 10) return `${(feet / 5280).toFixed(2)} miles`;
  return `${feet.toLocaleString("en-GB")} ft ${rem} in`;
}

function hungerWord(h: number): string {
  if (h < 0.35) return "fed";
  if (h < 0.6) return "a little empty";
  if (h < 0.9) return "hungry";
  return "starving";
}

/** End a sentence without doubling the full stop after "p.m.". */
const sentence = (t: string) => (t.endsWith(".") ? t : `${t}.`);

function deathLine(c: SpecimenData): string {
  const d = c.death;
  if (!d) return "Dead.";
  if (d.cause === 5) return sentence(`Flew from the mound at ${shortTime(d.at)} and did not return`);
  const first = sentence(`Died of ${DEATH_NAMES[d.cause]} at ${shortTime(d.at)}`);
  return `${first} ${d.bearer ? `Carried to the midden by No.\u00a0${d.bearer}.` : "Not yet carried away."}`;
}

const dayOf = (minutes: number) => Math.max(1, Math.floor(minutes / 1440) + 1);

/** A short life, written from the ant's own recorded history. */
export function biography(c: SpecimenData): string {
  const out: string[] = [];
  const pronoun = c.caste === Caste.AlateM ? "He" : "She";
  if (c.bornMinutes >= 0) out.push(`Came out of the cocoon on day ${dayOf(c.bornMinutes)}.`);
  else out.push(`Already grown when the case was sealed.`);
  const food = c.history.find((h) => h.kind === Hist.FoundFood && h.value !== 0);
  if (food) out.push(`Found the ${FOOD_NAMES[food.value]} on day ${dayOf(food.minutes)}.`);
  if (c.loads > 0) out.push(`Carried ${c.loads} ${c.loads === 1 ? "load" : "loads"} home.`);
  if (c.dug > 0) out.push(`Dug ${c.dug} ${c.dug === 1 ? "grain" : "grains"} out of the hill.`);
  if (c.fedLarvae > 0) out.push(`Fed the larvae ${c.fedLarvae} ${c.fedLarvae === 1 ? "time" : "times"}.`);
  const dead = c.history.filter((h) => h.kind === Hist.CarriedDead);
  if (dead.length) out.push(`Bore No. ${dead[dead.length - 1].value} to the midden.`);
  if (c.history.some((h) => h.kind === Hist.RescuedBrood)) out.push(`Carried brood out of the flood.`);
  if (c.history.some((h) => h.kind === Hist.SurvivedCaveIn)) out.push(`Survived a fall of earth.`);
  if (c.escaped) out.push(`Has walked out upon the page.`);
  const letters = c.history.filter((h) => h.kind === Hist.TookLetter);
  if (letters.length) out.push(`Took the letter ‘${String.fromCharCode(letters[letters.length - 1].value)}’ from my notes.`);
  const away = c.history.find((h) => h.kind === Hist.Absence);
  if (away) out.push(`While you were away ${pronoun.toLowerCase()} brought in ${away.value} more.`);
  if (c.alive) out.push(`Now ${TASK_NAMES[c.task]} ${ZONE_WORDS[c.zone] ?? ""}.`.replace(/\s+\./, "."));
  // Keep it to a card's length.
  return out.slice(0, 1).concat(out.slice(1).slice(-4)).join(" ");
}

export function SpecimenCard() {
  const obs = useObservatory();
  const selected = useUi((s) => s.selected);
  const card = useUi((s) => s.card);
  const follow = useUi((s) => s.follow);
  const still = useUi((s) => s.still);
  const [dock, setDock] = useState<{ el: HTMLElement; where: "shelf" | "notebook" } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The card rests on the shelf on wide screens, in the notebook's pinned slot
  // on desktop, and becomes a sheet at the foot of narrow screens.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1600px)");
    const desk = window.matchMedia("(min-width: 1100px)");
    const update = () => {
      const shelf = document.getElementById("specimen-dock");
      const nb = document.getElementById("notebook-dock");
      if (wide.matches && shelf) setDock({ el: shelf, where: "shelf" });
      else if (desk.matches && nb) setDock({ el: nb, where: "notebook" });
      else setDock(null);
    };
    update();
    wide.addEventListener("change", update);
    desk.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      desk.removeEventListener("change", update);
    };
  }, []);

  // Keyboard and screen-reader users land on the card when it opens.
  useEffect(() => {
    if (selected !== null) heading.current?.focus({ preventScroll: true });
  }, [selected]);

  if (selected === null) return null;
  const c = card && card.serial === selected ? card : null;
  const casteName = c ? CASTE_NAMES[c.caste] : "";
  const role = c && c.caste === Caste.Worker ? ROLE_NAMES[c.role] : null;

  const body = (
    <aside className={dock ? `specimen docked in-${dock.where}` : "specimen"} aria-labelledby="specimen-h">
      <span className="pin" aria-hidden="true" />
      <header>
        <h2 id="specimen-h" ref={heading} tabIndex={-1}>
          <small>No.</small>
          {selected}
        </h2>
        <span className="caste">{c ? `${casteName}${role && c.caste === Caste.Worker && c.role !== Role.Reserve ? `, ${role}` : ""}` : "reading…"}</span>
      </header>
      {c && !c.alive ? (
        <p className="deceased">{deathLine(c)}</p>
      ) : null}
      {c ? (
        <dl>
          {c.alive ? (
            <>
              <dt>Age</dt>
              <dd>{durationPhrase(c.ageSeconds * 1000)}</dd>
              <dt>Task</dt>
              <dd>{TASK_NAMES[c.task]}</dd>
              <dt>Carrying</dt>
              <dd>{CARRY_NAMES[c.carry]}</dd>
              <dt className="opt">Where</dt>
              <dd className="opt">{ZONE_WORDS[c.zone] ?? c.zone}</dd>
              <dt className="opt">Hunger</dt>
              <dd className="opt">{hungerWord(c.hunger)}</dd>
            </>
          ) : null}
          <dt>Walked</dt>
          <dd>{distanceWords(c.distanceMm)}</dd>
          <dt>Loads</dt>
          <dd>{c.loads}</dd>
        </dl>
      ) : null}
      {c ? <p className="bio">{biography(c)}</p> : null}
      <div className="actions">
        {c?.alive ? (
          <button type="button" className="paper-btn" aria-pressed={follow} onClick={() => obs?.setFollow(!follow)}>
            {still ? "Show me where" : follow ? "Stop following" : "Follow"}
          </button>
        ) : null}
        <button type="button" className="paper-btn" onClick={() => obs?.selectNearCentre()}>
          Another
        </button>
        <button type="button" className="paper-btn" onClick={() => obs?.select(null)}>
          Release
        </button>
      </div>
    </aside>
  );
  return dock ? createPortal(body, dock.el) : body;
}
