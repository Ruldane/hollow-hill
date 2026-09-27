import { ObservatoryProvider } from "@/components/ObservatoryProvider";
import { Formicarium } from "@/components/Formicarium";
import { GlassDescription, GlassSlips, NotebookColumn } from "@/components/Notebook";
import { Instruments } from "@/components/Instruments";
import { Rail } from "@/components/Rail";
import { SpecimenCard } from "@/components/SpecimenCard";
import { Overlays } from "@/components/Overlays";
import { Absences, CensusTable, Colophon, LettersHeld, ObserverSettings, TodayLog, Visits } from "@/components/Ledger";

export default function Home() {
  return (
    <ObservatoryProvider>
      <a className="skip" href="#notebook">
        Skip to the notebook
      </a>
      <a className="skip" href="#ledger">
        Skip to the census
      </a>
      <div className="cabinet">
        <main className="case">
          <header className="rail-top">
            <div className="frame-top">
              <div className="plaque">
                <h1>The Hollow Hill</h1>
                <p>A Living Formicarium, after the Notebooks of Dr.&nbsp;Aurelie Vance, 1893</p>
              </div>
            </div>
            <div aria-hidden="true" />
            <Instruments />
          </header>
          <Formicarium notebook={<NotebookColumn />} slips={<GlassSlips />} description={<GlassDescription />} />
          <div className="frame-bottom" aria-hidden="true" />

          <section className="ledger" id="ledger" aria-labelledby="ledger-h">
            <h2 id="ledger-h">
              <span className="num">V.</span>Below the Hill
            </h2>
            <p className="lede">The ledger kept under the case: the census, your visits, what happened while you were away, and the letters the ants have taken.</p>
            <div className="ledger-spread">
              <div>
                <h3>The census</h3>
                <CensusTable />
                <h3>Letters taken from the notebook</h3>
                <LettersHeld />
              </div>
              <div>
                <h3>Your visits</h3>
                <Visits />
                <h3>While you were away</h3>
                <Absences />
                <h3 id="today-log">Today&rsquo;s notes</h3>
                <TodayLog />
                <h3>For the observer</h3>
                <ObserverSettings />
              </div>
            </div>
            <Colophon />
          </section>
        </main>
      </div>
      <span data-font-book style={{ fontFamily: "var(--font-hand)", position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden="true" />
      <span data-font-label style={{ fontFamily: "var(--font-book)", position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden="true" />
      <Overlays />
      <Rail />
      <SpecimenCard />
    </ObservatoryProvider>
  );
}
