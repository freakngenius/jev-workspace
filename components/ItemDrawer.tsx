"use client";

import { useEffect } from "react";
import type { ClientItem, Plan } from "@/lib/types";
import { BAND_COLOR, BAND_LABEL, fmtPct, seriesColor } from "./format";

/** Everything Jev said about one item, and the text it saw (first few hundred characters). */
export function ItemDrawer({ item, plan, onClose }: { item: ClientItem | null; plan: Plan; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!item) return null;
  const band = item.finalBand ?? item.band;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        className="rise scroll-thin h-full w-full max-w-[520px] overflow-y-auto border-l border-hairline bg-[#121211] p-6"
        onClick={(e) => e.stopPropagation()}
        aria-label="Item detail"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="eyebrow">
            {plan.unit.singular} #{item.id + 1}
            {item.locator ? ` · ${item.locator}` : ""}
          </div>
          <button className="text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <h3 className="mt-2 text-[20px] leading-snug font-semibold text-ink">{item.title}</h3>
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer noopener" className="mt-1 block truncate font-mono text-[12px] text-ink-2 underline decoration-axis underline-offset-4 hover:text-ink">
            {item.url}
          </a>
        )}

        {item.status === "judged" && band && (
          <div className="mt-5 rounded-xl border border-hairline bg-surface p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAND_COLOR[band] }} />
                {BAND_LABEL[band]}
              </span>
              <span className="font-mono text-[13px] tabular text-ink">P(yes) {item.p!.toFixed(3)}</span>
            </div>
            <div className="relative mt-3 h-2 rounded-full bg-hairline">
              <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${item.p! * 100}%`, background: BAND_COLOR[band] }} />
              {[plan.thresholds.no, plan.thresholds.yes].map((t) => (
                <div key={t} className="absolute -top-1 h-4 w-px bg-cream/60" style={{ left: `${t * 100}%` }} />
              ))}
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">{plan.gate.instructions}</p>
            {item.review && (
              <div className="mt-3 border-t border-hairline pt-3 text-[13px] text-ink-2">
                <span className="font-semibold text-ink">Claude: {item.review.verdict}.</span> {item.review.reason}
              </div>
            )}
          </div>
        )}

        {item.qual && (
          <div className="mt-5 rounded-xl border border-hairline bg-surface p-4 text-[13px] leading-relaxed">
            <div className="eyebrow mb-2">
              Qualified by Claude · {item.qual.score} of 3 · {item.qual.score === 3 ? "strong" : item.qual.score === 2 ? "plausible" : "weak"}
            </div>
            <p className="text-ink">{item.qual.why}</p>
            <p className="mt-2 text-ink-2">
              <span className="text-muted">For outreach: </span>
              {item.qual.context}
            </p>
          </div>
        )}

        {item.error && <div className="mt-5 rounded-xl border border-error/40 bg-error/10 p-3 text-[13px] text-ink-2">{item.error}</div>}

        {plan.dimensions.length > 0 && item.answers && (
          <div className="mt-5 space-y-3">
            {plan.dimensions.map((d) => {
              const a = item.answers?.[d.key];
              if (!a) return null;
              let value: string;
              let color = "#3987e5";
              if (d.type === "choice") {
                const idx = (d.options ?? []).findIndex((o) => o.key === a.v);
                value = String(a.v).replace(/_/g, " ");
                color = seriesColor(idx < 0 ? 99 : idx);
              } else if (d.type === "noul") {
                value = `${fmtPct(a.v as number)} yes`;
              } else {
                const levels = d.levels ?? [];
                value = levels[Math.round(a.v as number)] ?? String(a.v);
              }
              return (
                <div key={d.key} className="grid grid-cols-[8rem_1fr] gap-3 text-[13px]">
                  <span className="text-muted">{d.label}</span>
                  <span className="flex items-start gap-2 text-ink">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
                    {value}
                    {a.c != null && <span className="font-mono text-[11px] text-muted">({a.c.toFixed(2)})</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {plan.panel && item.panel && (
          <div className="mt-6">
            <div className="eyebrow mb-2">
              Panel · would {plan.panel.action} · {item.appeal != null ? fmtPct(item.appeal) : "–"}
            </div>
            <div className="space-y-1">
              {plan.panel.personas.map((p) => {
                const v = item.panel?.[p.key];
                if (v == null) return null;
                return (
                  <div key={p.key} className="grid grid-cols-[10rem_1fr_2.5rem] items-center gap-2 text-[12px]">
                    <span className="truncate text-ink-2">{p.label}</span>
                    <div className="h-1.5 rounded-full bg-hairline">
                      <div className="h-full rounded-full bg-s1" style={{ width: `${v * 100}%` }} />
                    </div>
                    <span className="text-right font-mono text-muted tabular">{v.toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {item.fields && (
          <div className="mt-6">
            <div className="eyebrow mb-2">Fields</div>
            <dl className="space-y-1 text-[12px]">
              {Object.entries(item.fields)
                .filter(([, v]) => v)
                .slice(0, 30)
                .map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[8rem_1fr] gap-3">
                    <dt className="truncate text-muted">{k}</dt>
                    <dd className="break-words text-ink-2">{v.length > 300 ? `${v.slice(0, 300)}…` : v}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )}

        {item.snippet && !item.fields && (
          <div className="mt-6">
            <div className="eyebrow mb-2">What Jev read (start)</div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{item.snippet}…</p>
          </div>
        )}
        <div className="mt-6 font-mono text-[11px] text-muted">
          {item.chars.toLocaleString()} chars{item.ms != null ? ` · Jev ${item.ms} ms` : ""}
        </div>
      </aside>
    </div>
  );
}
