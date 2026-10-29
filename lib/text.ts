/** Small text helpers shared by server code and browser components. No imports, so either side can use them. */

/** The first sentence of a mission, or its opening words when that sentence runs long. */
export function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  if (m) return m[1];
  return t.length > 200 ? `${t.slice(0, 200).replace(/\s+\S*$/, "")}…` : t;
}

const RELATIONSHIP_ORDER = ["DMs + mutual follow", "DMs only", "DMs", "mutual follow", "follows you", "you follow", "unknown"];

/** A warmth rank for sorting accounts: higher is warmer. */
export function warmthRank(relationship: string | undefined): number {
  const i = RELATIONSHIP_ORDER.indexOf(relationship ?? "unknown");
  return i < 0 ? 0 : RELATIONSHIP_ORDER.length - i;
}
