/**
 * The formicarium's colours: umber and ochre strata, black japanning,
 * aged brass, bone labels, and one saturated specimen accent (vermilion).
 */
export const INK = "#1d140d";
export const INK_SOFT = "#3a2a1c";
export const BONE = "#ebe0c6";
export const BONE_DIM = "#cbb994";
export const VERMILION = "#c43a20";
export const BRASS = "#b8924f";
export const HONEY = "#c8902a";
export const WATER = "#46606a";
export const CAVITY = "#c9ad7c";
export const CAVITY_DEEP = "#8a6a45";

/** Per-material base tint and engraving ink, indexed by Mat. */
export const MATERIAL: readonly { base: string; ink: string; light: string; kind: "stipple" | "hatch" | "cross" | "grain" | "strata" | "none" }[] = [
  { base: "#00000000", ink: INK, light: "#ffffff", kind: "none" }, // Open
  { base: "#4a3423", ink: "#23170e", light: "#6b4d33", kind: "stipple" }, // Topsoil
  { base: "#a98251", ink: "#5c4128", light: "#c8a36d", kind: "strata" }, // Sand
  { base: "#76685a", ink: "#2f271f", light: "#9a8b78", kind: "grain" }, // Gravel
  { base: "#8b5635", ink: "#46261a", light: "#a8704a", kind: "hatch" }, // Clay
  { base: "#5c3826", ink: "#2a170e", light: "#7a4d34", kind: "cross" }, // DeepClay
  { base: "#8e8577", ink: "#2c2621", light: "#bfb5a3", kind: "stipple" }, // Stone
  { base: "#2e241c", ink: "#130d09", light: "#4a3b2e", kind: "strata" }, // Bedrock
  { base: "#a57f4f", ink: "#5a3f25", light: "#c49a63", kind: "grain" }, // Mound
  { base: "#7d5d3f", ink: "#3a2818", light: "#9c7a55", kind: "grain" }, // Rubble
  { base: "#4a3423", ink: "#23170e", light: "#6b4d33", kind: "stipple" }, // Root (drawn over topsoil)
  { base: "#00000000", ink: INK, light: "#ffffff", kind: "none" }, // Stem (drawn by the surface layer)
];

export function mix(a: string, b: string, t: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export function parse(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r},${g},${b},${a})`;
}
