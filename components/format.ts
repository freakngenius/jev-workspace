import type { Band } from "@/lib/types";

export const BAND_COLOR: Record<Band | "error" | "queued" | "fetching" | "ready" | "judging" | "skipped", string> = {
  match: "#0ca30c",
  uncertain: "#fab219",
  reject: "#686761",
  error: "#d03b3b",
  queued: "#2a2a27",
  fetching: "#34332f",
  ready: "#4a4843",
  judging: "#efe6d2",
  skipped: "#201f1d",
};

export const BAND_LABEL: Record<Band, string> = { match: "Match", uncertain: "Uncertain", reject: "Reject" };

export const BAND_GLYPH: Record<Band, string> = { match: "✓", uncertain: "?", reject: "✕" };

/** Categorical slots in the validated order. Options past eight fold into gray "other". */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER = "#6b6a64";

export function seriesColor(i: number): string {
  return i < SERIES.length ? SERIES[i] : OTHER;
}

/** Ordinal steps of the blue ramp for score levels, darkest step still clear of the dark surface. */
export function ordinalBlue(i: number, n: number): string {
  const steps = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
  if (n <= 1) return steps[4];
  return steps[Math.round((i / (n - 1)) * (steps.length - 1))];
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number): string {
  if (n < 10_000) return fmtInt(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtUsd(n: number): string {
  if (!n) return "$0.00";
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${fmtInt(n)}`;
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtPct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function plural(n: number, unit: { singular: string; plural: string }): string {
  return n === 1 ? unit.singular : unit.plural;
}
