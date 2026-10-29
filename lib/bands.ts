import type { Band, Plan } from "./types";

/** Where a probability lands. Pure, so the results page can re-cut bands in the browser. */
export function bandOf(p: number, t: Plan["thresholds"]): Band {
  if (p >= t.yes) return "match";
  if (p <= t.no) return "reject";
  return "uncertain";
}
