# The Hollow Hill

*A Living Formicarium, after the Notebooks of Dr. Aurelie Vance, 1893.*

A glass-fronted cross-section of earth in which an ant colony lives, digs, forages, fights, mourns and grows. It is a simulation, not an animation: several thousand individuals, each with a number, a caste, an age, needs and a history, running in a Web Worker beside the page. The colony keeps the visitor's real clock and goes on living when the page is closed.

Dr. Vance, her notebooks and the Hollow Hill are fiction. The colony borrows the habits of real ants, but nothing here is offered as natural history.

## Run

```bash
npm install
npm run dev          # http://localhost:3000
npm run check        # lint, type-check, unit tests, production build, browser tests
```

Individual steps: `npm run lint`, `npm run typecheck`, `npm test` (headless simulation tests, Vitest), `npm run build`, `npm run test:e2e` (Playwright against `next start` on port 3230; build first).

### Observer's parameters

For testing and demonstration the page reads a few URL parameters. None are needed in normal use.

| Parameter | Effect |
|---|---|
| `?fresh` | Seal a new colony (clears the saved one). |
| `?seed=7` | Found the colony from a fixed seed (deterministic). |
| `?clock=2026-06-21T19:30` or `?clock=+19h` | Move the visitor's clock (day, night, seasons, absence). |
| `?weather=rain` / `?weather=dry` | Force the weather. |
| `?speed=4` | Start hastened. |
| `?still` | Start in still plates (reduced-motion presentation). |
| `?debug` | Frame-rate, tier and agent-count readout. |
| `?persist=0` | Do not save. |

## What "alive" means here

- **Autonomy and emergence.** Foragers leave by one door, search, smell food, lay a food trail on the way home, and recruit; trails become roads without being drawn. Diggers walk out along the nest to its dead ends and dig forward, sloping gently, turning at stones, sometimes opening a low chamber. Tunnel architecture, the midden, the store and the brood piles all arise from local rules.
- **Needs and consequences.** Ants grow hungry and tired, eat from the store or from a nestmate's crop, rest in clusters, age and die. The dead are carried to a midden, which is founded where the first body is laid. A starving colony sends more foragers, the queen stops laying and the nurses eat eggs.
- **Memory.** The colony is saved to IndexedDB (versioned schema; an old schema is refused and a new colony founded). On return, a coarse model advances it by the real time away (ten-minute steps, two-hour steps beyond a fortnight, capped at thirty days) using the live rules for brood, the queen, food falling, digging and cave-ins, then writes the notebook entry: "Absent 19 hours. Two new chambers. The eastern gallery collapsed after rain; four workers lost."
- **Real time and place.** Sun, moon phase, season and hemisphere come from the visitor's clock and time zone. Foragers work by day; nurses by lamplight. The laboratory lamp beside the nursery is lit at night.
- **Reaction.** The pointer is an observation lamp: some ants seek its warmth, most shy from its light. A knock on the glass sends alarm pheromone through the soil; it spreads visibly in vermilion and fades.
- **Individuality.** Click any ant for its specimen card, read from the ant's own slot: caste, age, task, what it carries, distance walked, loads, and a biography built from its recorded history.

## The surprises

1. **The letters.** A restless scout finds the fault in the frame by the eastern brass, drawn by the sugar of gum arabic in Dr. Vance's ink, and walks out onto the page. Ants carry single letters off the notebook's handwriting and stack them in the store among the seeds, where you can see them under the glass. The text read by assistive technology is never touched: each passage is rendered once for screen readers and once as visual glyphs, and only glyphs are hidden. At most one word in twelve loses a letter, never neighbouring words, never a first or last letter. "Restore the notebook" returns everything.
2. **Rain.** Deterministic per colony and calendar day, likelier in spring and autumn. Water runs in at the entrance and pools in the galleries; wet ceilings fall; nurses carry the brood down out of the wet; the barometer falls ahead of each shower.
3. **The nuptial flight.** On a warm, dry evening in season, winged queens and males raised by a well-fed colony climb the grass and leave, crossing the whole viewport once.

## Architecture

| Concern | Where |
|---|---|
| Simulation core (pure, headless, seeded) | `src/sim/` (`sim.ts` the step and behaviour; `world.ts` soil, piles and distance fields; `fields.ts` pheromones; `excavation.ts` digging rules; `environment.ts` clock, sun, moon, seasons, weather; `founding.ts`; `catchup.ts` absence model; `persist.ts` snapshots; `census.ts`) |
| Worker and protocol | `src/worker/` (fixed-step loop, packed frames in transferred buffers with a return pool, IndexedDB, hidden-tab pause and catch-up) |
| Page bridge | `src/client/colony-client.ts` (soil mirror, frame interpolation, channels) and `src/client/observatory.ts` (animation loop, camera from scroll read per frame, input, layout, letters, notes, adaptive quality, test hooks) |
| Renderer | `src/render/` (`renderer.ts` layers: sky, soil face, soil tiles, water, alarm, scent, piles, letters, brood, food, the dead, grass, ants, light, selection, lens; `soil-tiles.ts` engraved tile cache; `sprites.ts` engraved insects; `page-layer.ts` escaped ants and the flight; `perf.ts`) |
| Notebook grammar | `src/notes/grammar.ts` (Dr. Vance's voice, rate-limited, varied; absence entry; "what is happening now") |
| Editorial UI | `src/components/` (formicarium frame, notebook, instruments, rail, specimen card, ledger, overlays) |

No per-frame values live in React state and nothing listens to scroll events; the camera reads `scrollY` inside the animation loop. No SharedArrayBuffer is used, so no cross-origin isolation is required.

## Accessibility

- A prominent **Stop the clock** control stops the simulation and all motion (WCAG 2.2.2).
- **Still plates** (on by default under `prefers-reduced-motion`, and a setting for anyone): the colony keeps living, but the glass shows a new still observation every few seconds, camera tracking becomes a single jump, borrowed letters fade instead of being carried, and the flight is a single fading still.
- Screen readers: a text description of the glass, a polite rate-limited narration (opt-in), an on-demand "What is happening now?" summary drawn from the colony's state, and the census as a real `<table>`.
- Every control is a button reachable by keyboard; knocking and offering from the keyboard act on the glass in view.

## Performance

The simulation runs in a worker at 20 steps per second. Rendering is budgeted and adapts from sustained frame intervals (two-second windows, 90th percentile): device pixel ratio, sprite detail, grass density and a 30 fps cap step down in turn, and only at the last tier is the population cap lowered. Distant or slow-machine ants are drawn as ink specks in a single stroke.

Measured on the production build (Chrome, RTX 4070 laptop, 1440×900):

| Scenario | Median frame | p90 | Agents |
|---|---|---|---|
| Founding colony | 16.6 ms | 16.8 ms | ~1,170 |
| Full desktop colony | 16.7 ms | 25 ms | ~3,060 |
| Full desktop colony, CPU throttled 4× | 25 ms | 25 ms | ~3,060 (tier 2) |

Simulation cost is about 1.8 ms per step for ~1,170 ants and 4.6 ms per step for ~3,060, off the main thread. Phones found a narrower glass (100 cells wide) with a 900-ant cap.

## Dependencies

Only what the stack requires: Next.js 16.3.6 (App Router), React 19.2.8 as pinned by that release, Tailwind CSS 4, TypeScript. Development only: Vitest (headless simulation tests in Node) and Playwright (behavioural browser tests). Typefaces are self-hosted through `next/font`: Bodoni Moda, Old Standard TT, Pinyon Script.
