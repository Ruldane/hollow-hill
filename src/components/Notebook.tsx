import { FRAGMENTS, PLATES } from "@/content/notebook";
import { Stealable } from "./Stealable";
import { TodaySlip } from "./TodaySlip";

const ZONE_ROWS: Record<string, [number, number]> = {
  surface: [0, 98],
  upper: [98, 284],
  nursery: [284, 490],
  royal: [490, 720],
};

/**
 * The notebook column beside the glass (wide screens). Each plate is a
 * section whose minimum height matches its depth in the glass, so passages
 * sit beside what they describe and simply flow on if they run long.
 */
export function NotebookColumn() {
  return (
    <div className="notebook" id="notebook">
      {PLATES.map((p) => {
        const [from, to] = ZONE_ROWS[p.id];
        const frags = FRAGMENTS.filter((f) => f.row >= from && f.row < to);
        return (
          <section key={p.id} className="nb-zone" style={{ ["--rows" as string]: to - from }} aria-labelledby={`plate-${p.id}`}>
            {p.id === "surface" ? (
              <h2 id={`plate-${p.id}`} className="sr-only">
                Plate {p.numeral}. {p.title}
              </h2>
            ) : (
              <h2 id={`plate-${p.id}`} className="plate-head">
                <span className="num">{p.numeral}.</span>
                {p.title}
                <span className="cap">{p.caption}</span>
              </h2>
            )}
            <div className="nb-entries">
              {frags.map((f) => (
                <div key={f.id} className="fragment">
                  <span className="date">{f.date}</span>
                  <Stealable id={f.id} text={f.text} className="hand" />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <div className="today-track">
        <div id="notebook-dock" />
        <TodaySlip />
      </div>
    </div>
  );
}

/** On a narrow glass the sky holds only the first lines of the first entry. */
const SKY_SLIP = "The hill is sealed behind glass this morning and set upon the north bench. By noon they had found the crust.";

/** Narrow screens: two slips glued to the glass, in the sky and on the bedrock. */
export function GlassSlips() {
  const sky = FRAGMENTS[0];
  const deep = FRAGMENTS[FRAGMENTS.length - 1];
  return (
    <>
      <div className="slip" style={{ ["--row" as string]: 4 }}>
        <span className="date">{sky.date}</span>
        <Stealable id={`${sky.id}-slip`} text={SKY_SLIP} className="hand" />
      </div>
      <div className="slip" style={{ ["--row" as string]: 652 }}>
        <span className="date">{deep.date}</span>
        <Stealable id={`${deep.id}-slip`} text={deep.text} className="hand" />
      </div>
    </>
  );
}

export function GlassDescription() {
  return (
    <p>
      A tall glass case of earth in cross-section. At the top, grass and a mound of excavated soil at the entrance; below, the upper
      galleries with the food stores and the midden; deeper, a warm nursery of eggs, larvae and pupae by the lamp; at the bottom, the
      queen in her chamber. The ants move continuously. Use the controls at the foot of the page, or ask what is happening now.
    </p>
  );
}
