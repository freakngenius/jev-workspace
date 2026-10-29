"use client";

import type { Dimension, Metrics, Plan } from "@/lib/types";
import { BAND_COLOR, fmtInt, fmtPct, ordinalBlue, seriesColor } from "./format";
import { useTooltip } from "./Tooltip";

/** Distribution of P(yes) in twenty bins, with the two thresholds that cut it into bands. */
export function Histogram({ bins, thresholds, height = 120 }: { bins: number[]; thresholds: Plan["thresholds"]; height?: number }) {
  const { bind } = useTooltip();
  const max = Math.max(1, ...bins);
  const W = 400;
  const H = height;
  const bw = W / bins.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label="Histogram of P(yes)">
      <line x1={0} x2={W} y1={H} y2={H} stroke="#3a3935" strokeWidth={1} />
      {bins.map((count, i) => {
        const lo = i / bins.length;
        const hi = (i + 1) / bins.length;
        const band = lo >= thresholds.yes - 1e-9 ? "match" : hi <= thresholds.no + 1e-9 ? "reject" : "uncertain";
        const h = count ? Math.max(2, (count / max) * (H - 6)) : 0;
        return (
          <g key={i} tabIndex={0} {...bind({ value: `${fmtInt(count)} items`, label: `P(yes) ${lo.toFixed(2)}–${hi.toFixed(2)}`, color: BAND_COLOR[band] })}>
            <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
            {h > 0 && <rect x={i * bw + 1} y={H - h} width={bw - 2} height={h} rx={2} fill={BAND_COLOR[band]} />}
          </g>
        );
      })}
      {[thresholds.no, thresholds.yes].map((t) => (
        <g key={t}>
          <line x1={t * W} x2={t * W} y1={0} y2={H} stroke="#efe6d2" strokeOpacity={0.5} strokeWidth={1} />
          <text x={t * W} y={H + 13} textAnchor="middle" className="fill-muted font-mono" fontSize={10}>
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      <text x={0} y={H + 13} className="fill-muted font-mono" fontSize={10}>
        0
      </text>
      <text x={W} y={H + 13} textAnchor="end" className="fill-muted font-mono" fontSize={10}>
        1
      </text>
    </svg>
  );
}

/** Items judged per second over the last minute, against the request-rate ceiling. */
export function Sparkline({ rate, ceiling, height = 56 }: { rate: number[]; ceiling: number; height?: number }) {
  const W = 300;
  const H = height;
  const data = rate.length > 1 ? rate : [0, ...rate, 0].slice(-2);
  const max = Math.max(ceiling * 1.1, 1, ...data);
  const x = (i: number) => (i / Math.max(1, data.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 4) - 2;
  const line = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;
  const cy = y(ceiling);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Throughput over the last minute">
      <line x1={0} x2={W} y1={cy} y2={cy} stroke="#3a3935" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={area} fill="#efe6d2" fillOpacity={0.08} />
      <path d={line} fill="none" stroke="#efe6d2" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal bars for one extra question: option counts for choice, yes share for noul, level counts for score. */
export function DimensionBars({ dim, counts, total }: { dim: Dimension; counts: Record<string, number>; total: number }) {
  const { bind } = useTooltip();
  if (dim.type === "noul") {
    const yes = counts.yes ?? 0;
    const n = yes + (counts.no ?? 0);
    const share = n ? yes / n : 0;
    return (
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] text-ink-2">{dim.label}</span>
          <span className="font-mono text-[12px] text-ink tabular">{fmtPct(share)} yes</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[#1d2a3d]" {...bind({ value: `${fmtInt(yes)} of ${fmtInt(n)} yes`, label: dim.instructions, color: "#3987e5" })}>
          <div className="h-full rounded-full bg-s1 transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
    );
  }
  const rows =
    dim.type === "choice"
      ? (dim.options ?? []).map((o, i) => ({ key: o.key, label: o.key.replace(/_/g, " "), detail: o.description, color: seriesColor(i) }))
      : (dim.levels ?? []).map((l, i, all) => ({ key: String(i), label: l.length > 42 ? `${l.slice(0, 40)}…` : l, detail: l, color: ordinalBlue(i, all.length) }));
  const known = new Set(rows.map((r) => r.key));
  const other = Object.entries(counts).filter(([k]) => !known.has(k)).reduce((a, [, v]) => a + v, 0);
  const max = Math.max(1, ...rows.map((r) => counts[r.key] ?? 0), other);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] text-ink-2">{dim.label}</span>
        <span className="eyebrow">{dim.type}</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const c = counts[r.key] ?? 0;
          return (
            <div key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-2" tabIndex={0} {...bind({ value: `${fmtInt(c)} (${total ? fmtPct(c / total) : "0%"})`, label: r.label, detail: r.detail, color: r.color })}>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-2">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} />
                <span className="truncate">{r.label}</span>
              </span>
              <div className="h-[10px]">
                <div className="h-full rounded-r-[4px] transition-[width] duration-500" style={{ width: `${(c / max) * 100}%`, background: r.color, minWidth: c ? 2 : 0 }} />
              </div>
              <span className="text-right font-mono text-[11px] text-ink-2 tabular">{fmtInt(c)}</span>
            </div>
          );
        })}
        {other > 0 && (
          <div className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-2">
            <span className="text-[12px] text-muted">other</span>
            <div className="h-[10px]">
              <div className="h-full rounded-r-[4px] bg-[#6b6a64]" style={{ width: `${(other / max) * 100}%` }} />
            </div>
            <span className="text-right font-mono text-[11px] text-ink-2 tabular">{fmtInt(other)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Share of judged items each persona would act on. One series, so one hue. */
export function PanelBars({ plan, metrics, limit = 12 }: { plan: Plan; metrics: Metrics; limit?: number }) {
  const { bind } = useTooltip();
  if (!plan.panel) return null;
  const judged = Math.max(1, metrics.judged);
  const rows = plan.panel.personas
    .map((p) => ({ ...p, yes: metrics.panelYes[p.key] ?? 0 }))
    .sort((a, b) => b.yes - a.yes)
    .slice(0, limit);
  return (
    <div className="space-y-1.5">
      {rows.map((p) => (
        <div key={p.key} className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-2" tabIndex={0} {...bind({ value: `${fmtPct(p.yes / judged)} would ${plan.panel!.action}`, label: p.label, detail: p.description, color: "#3987e5" })}>
          <span className="truncate text-[12px] text-ink-2">{p.label}</span>
          <div className="h-[10px] rounded-r-[4px] bg-[#1b2433]">
            <div className="h-full rounded-r-[4px] bg-s1 transition-[width] duration-500" style={{ width: `${(p.yes / judged) * 100}%` }} />
          </div>
          <span className="text-right font-mono text-[11px] text-ink-2 tabular">{fmtPct(p.yes / judged)}</span>
        </div>
      ))}
      {plan.panel.personas.length > limit && <div className="pt-1 text-[11px] text-muted">+{plan.panel.personas.length - limit} more personas</div>}
    </div>
  );
}

/** 100% stacked bar of the three bands, 2px surface gaps between segments. */
export function BandBar({ bands, height = 14 }: { bands: Metrics["bands"]; height?: number }) {
  const { bind } = useTooltip();
  const total = bands.match + bands.uncertain + bands.reject;
  if (!total) return <div className="w-full rounded bg-hairline" style={{ height }} />;
  return (
    <div className="flex w-full gap-[2px]" style={{ height }}>
      {(["match", "uncertain", "reject"] as const).map((b) =>
        bands[b] ? (
          <div
            key={b}
            className="h-full first:rounded-l-[4px] last:rounded-r-[4px] transition-[flex-grow] duration-500"
            style={{ flexGrow: bands[b], flexBasis: 0, background: BAND_COLOR[b] }}
            {...bind({ value: `${fmtInt(bands[b])} (${fmtPct(bands[b] / total)})`, label: b, color: BAND_COLOR[b] })}
          />
        ) : null,
      )}
    </div>
  );
}
