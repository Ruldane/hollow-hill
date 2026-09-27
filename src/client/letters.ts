/**
 * The letters on the page that the ants may carry off.
 *
 * Each stealable passage renders its full text once for assistive technology
 * (visually hidden) and once as per-glyph spans marked aria-hidden. Only the
 * visual glyphs are ever hidden. Rules keep every sentence legible: never the
 * first or last letter of a word, one letter per word, words of four letters
 * or more, never neighbouring words, and at most one word in twelve.
 */
import type { PageLetter } from "../sim/sim";

export class LetterManager {
  private taken = new Set<string>();
  reduced = false;

  private span(key: string): HTMLElement | null {
    const [block, i] = key.split(":");
    return document.querySelector<HTMLElement>(`[data-stealable="${CSS.escape(block)}"] [data-i="${CSS.escape(i)}"]`);
  }

  /** Measure the glyphs the ants may take, in document coordinates. */
  scan(): PageLetter[] {
    const out: PageLetter[] = [];
    const sx = window.scrollX;
    const sy = window.scrollY;
    const blocks = document.querySelectorAll<HTMLElement>("[data-stealable]");
    for (const block of blocks) {
      const id = block.dataset.stealable!;
      if (block.getClientRects().length === 0) continue;
      const words = [...block.querySelectorAll<HTMLElement>(".w")];
      // Which words have already lost a letter?
      const robbed = words.map((w) => [...w.querySelectorAll<HTMLElement>("[data-i]")].some((c) => this.taken.has(`${id}:${c.dataset.i}`)));
      const robbedCount = robbed.filter(Boolean).length;
      // At most one word in twelve, so every sentence stays readable.
      if (robbedCount >= Math.max(1, Math.floor(words.length / 12))) continue;
      words.forEach((word, wi) => {
        if (robbed[wi] || robbed[wi - 1] || robbed[wi + 1]) return;
        const chars = word.querySelectorAll<HTMLElement>("[data-i]");
        if (chars.length < 4) return;
        // Never the first or the last letter: the word keeps its shape.
        for (let k = 1; k < chars.length - 1; k++) {
          const c = chars[k];
          const ch = c.textContent ?? "";
          if (!/[A-Za-z]/.test(ch)) continue;
          const r = c.getBoundingClientRect();
          if (!r.width) continue;
          out.push({ key: `${id}:${c.dataset.i}`, ch, word: wi, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
        }
      });
    }
    return out;
  }

  hide(key: string) {
    if (this.taken.has(key)) return;
    this.taken.add(key);
    const el = this.span(key);
    if (el) el.classList.add("taken");
  }

  show(key: string) {
    this.taken.delete(key);
    const el = this.span(key);
    if (el) el.classList.remove("taken");
  }

  /** Make the page match the colony's record of borrowed letters. */
  sync(keys: Iterable<string>) {
    const want = new Set(keys);
    for (const k of [...this.taken]) if (!want.has(k)) this.show(k);
    for (const k of want) this.hide(k);
  }

  showAll() {
    for (const k of [...this.taken]) this.show(k);
  }

  /** The word a borrowed letter came from, with a gap where it was. */
  wordFor(key: string): { word: string; index: number } | null {
    const el = this.span(key);
    const word = el?.closest(".w");
    if (!el || !word) return null;
    const chars = [...word.querySelectorAll<HTMLElement>("[data-i]")];
    return { word: chars.map((c) => c.textContent).join(""), index: chars.indexOf(el) };
  }

  get count() {
    return this.taken.size;
  }
}
