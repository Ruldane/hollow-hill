"use client";

import { Instruments } from "./Instruments";
import { useUi } from "./ObservatoryProvider";

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

function weatherWord(rain: number, pressure: number): string {
  if (rain > 0.05) return "Raining";
  if (pressure < 1003) return "Unsettled";
  if (pressure < 1012) return "Changeable";
  return "Fair";
}

/** A glance at the colony, for the shelf beside the notebook. */
function Tally() {
  const c = useUi((s) => s.census);
  if (!c) return null;
  const brood = c.eggs + c.larvae + c.pupae;
  const fahrenheit = Math.round(c.env.surfaceTemp * 1.8 + 32);
  return (
    <section className="tally" aria-labelledby="tally-h">
      <h2 id="tally-h">The colony at a glance</h2>
      <dl>
        <dt>Living</dt>
        <dd>{fmt(c.population)}</dd>
        <dt>Abroad on the surface</dt>
        <dd>{fmt(c.abroad)}</dd>
        {c.onPage > 0 ? (
          <>
            <dt>Out upon the page</dt>
            <dd>{fmt(c.onPage)}</dd>
          </>
        ) : null}
        <dt>Brood</dt>
        <dd>{fmt(brood)}</dd>
        <dt>Stores, in loads</dt>
        <dd>{fmt(c.stores)}</dd>
        <dt>Chambers</dt>
        <dd>{fmt(c.chambers)}</dd>
        {c.lettersOut > 0 ? (
          <>
            <dt>Letters held</dt>
            <dd>{fmt(c.lettersOut)}</dd>
          </>
        ) : null}
        <dt>Weather</dt>
        <dd>
          {weatherWord(c.env.rain, c.env.pressure)}, {fahrenheit}°F
        </dd>
      </dl>
      <a className="text-link" href="#ledger" style={{ fontSize: "0.86rem" }}>
        The full census, below the hill
      </a>
    </section>
  );
}

/** Wide screens only: the observer's shelf beside the notebook. */
export function Shelf() {
  return (
    <aside className="shelf" aria-label="The observer's shelf">
      <div className="shelf-inner">
        <Instruments />
        <div id="today-dock" />
        <Tally />
        <div id="specimen-dock" />
      </div>
    </aside>
  );
}
