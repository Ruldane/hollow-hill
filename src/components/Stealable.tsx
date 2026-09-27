import { Fragment, type ElementType } from "react";

/**
 * Text the ants may borrow letters from. The words are read once, whole, by
 * assistive technology; the visible copy is made of per-glyph spans hidden
 * from it, and only those glyphs are ever carried off.
 */
export function Stealable({ id, text, as: Tag = "p", className }: { id: string; text: string; as?: ElementType; className?: string }) {
  const words = text.split(" ");
  let i = 0;
  return (
    <Tag className={className} data-stealable={id}>
      <span className="sr-only sr-only-select">{text}</span>
      <span aria-hidden="true" className="glyphs">
        {words.map((w, wi) => (
          <Fragment key={wi}>
            <span className="w">
              {Array.from(w).map((c) => {
                const k = i++;
                return (
                  <span key={k} data-i={k}>
                    {c}
                  </span>
                );
              })}
            </span>
            {wi < words.length - 1 ? " " : null}
          </Fragment>
        ))}
      </span>
    </Tag>
  );
}
