"use client";

import { useLayoutEffect, useRef } from "react";
import type { Dimension, Persona, Plan, SourceKind } from "@/lib/types";
import { fmtDuration, fmtInt, fmtUsd, seriesColor } from "./format";
import { MissionBrief } from "./MissionBrief";

export interface JevStatus {
  ready: boolean;
  reason: string | null;
  name: string;
  model: string;
  usdPerMillionInput: number;
  requestsPerMinute: number;
}

const KINDS: SourceKind[] = ["site", "page", "sitemap", "feed", "table", "pdf", "text"];

/** Uploaded HTML reads three ways: one item per list entry, each file whole, or each file cut into sections at its headings. */
const HTML_KINDS = [
  ["table", "list: one item per entry"],
  ["page", "page: one item per file"],
  ["text", "text: split at headings"],
] as const;

function keyOf(s: string, fallback: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || fallback
  );
}

function freshKey(taken: string[], base: string): string {
  let k = base;
  let i = 2;
  while (taken.includes(k)) k = `${base.slice(0, 21)}_${i++}`;
  return k;
}

/** Rough count of items each source will yield, from what the sniff saw. */
function expectedItems(plan: Plan): number {
  let n = 0;
  for (const s of plan.sources) {
    const num = Number(s.note?.match(/([\d,]+)\+?\s+(rows|entries|URLs|pages)/)?.[1]?.replace(/,/g, ""));
    const files = s.uploadIds?.length ?? (s.uploadId ? 1 : 0);
    if (files && s.kind === "table" && s.count) n += s.count;
    else if (files && (s.kind === "page" || s.kind === "site")) n += files;
    else if (files && s.kind === "text") n += files * 8;
    else if (s.kind === "site" || (s.kind === "page" && s.crawl)) n += plan.limits.maxPagesPerSite;
    else if (s.kind === "page") n += 1;
    else if (s.kind === "sitemap") n += Math.min(plan.limits.maxPagesPerSite, num || plan.limits.maxPagesPerSite);
    else if (s.kind === "text") n += 8;
    else n += num || 50;
  }
  return Math.min(plan.limits.maxItems, n);
}

const AVG_CHARS: Record<SourceKind, number> = { site: 4000, page: 4000, sitemap: 4000, feed: 900, table: 500, pdf: 2600, text: 1500 };

export function estimate(plan: Plan, jev: JevStatus) {
  const items = expectedItems(plan);
  const qChars =
    plan.gate.instructions.length +
    plan.dimensions.reduce((a, d) => a + d.instructions.length + (d.options ?? []).reduce((b, o) => b + o.description.length + o.key.length, 0) + (d.levels ?? []).join(" ").length, 0) +
    (plan.panel?.personas ?? []).reduce((a, p) => a + p.description.length + p.label.length + 80, 0);
  const avgItem =
    plan.sources.reduce((a, s) => a + Math.min(plan.limits.maxCharsPerItem, AVG_CHARS[s.kind]), 0) / Math.max(1, plan.sources.length);
  const tokensPerItem = (avgItem + qChars + 200) / 4;
  const usd = (items * tokensPerItem * jev.usdPerMillionInput) / 1_000_000;
  const judgeRate = Math.min((jev.requestsPerMinute / 60) * plan.limits.itemsPerCall, plan.limits.concurrency * 3 * plan.limits.itemsPerCall);
  const crawled = plan.sources.some((s) => s.kind === "site" || s.kind === "sitemap" || s.crawl);
  const rate = crawled ? Math.min(judgeRate, 10) : judgeRate;
  const questions = 1 + plan.dimensions.length + (plan.panel?.personas.length ?? 0);
  return { items, usd, seconds: items / Math.max(0.5, rate), judgments: items * questions };
}

export function PlanEditor({
  plan,
  onChange,
  jev,
  onBack,
  onLaunch,
  launching,
  error,
}: {
  plan: Plan;
  onChange: (p: Plan) => void;
  jev: JevStatus;
  onBack: () => void;
  onLaunch: () => void;
  launching: boolean;
  error: string | null;
}) {
  const set = (patch: Partial<Plan>) => onChange({ ...plan, ...patch });
  const setDim = (i: number, patch: Partial<Dimension>) => set({ dimensions: plan.dimensions.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const setPersona = (i: number, patch: Partial<Persona>) =>
    plan.panel && set({ panel: { ...plan.panel, personas: plan.panel.personas.map((p, j) => (j === i ? { ...p, ...patch } : p)) } });
  const columns = [...new Set(plan.sources.flatMap((s) => s.columns ?? []))];
  const est = estimate(plan, jev);
  const addDim = (type: Dimension["type"]) => {
    const key = freshKey(plan.dimensions.map((d) => d.key), `q${plan.dimensions.length + 1}`);
    const d: Dimension =
      type === "choice"
        ? { key, label: "New question", type, instructions: "", options: [{ key: "option_a", description: "" }, { key: "option_b", description: "" }] }
        : type === "score"
          ? { key, label: "New rating", type, instructions: "", levels: ["Low", "Medium", "High"] }
          : { key, label: "New check", type, instructions: "" };
    set({ dimensions: [...plan.dimensions, d] });
  };

  return (
    <div className="rise mx-auto max-w-[980px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="eyebrow">Mission brief · review before launch</div>
        <span className="chip font-mono !text-[11px]">
          drafted by {plan.planner.provider === "claude-cli" ? "Claude (CLI)" : plan.planner.provider === "anthropic" ? "Claude (API)" : plan.planner.provider}
          {plan.planner.model ? ` · ${plan.planner.model}` : ""}
          {plan.planner.ms ? ` · ${fmtDuration(plan.planner.ms)}` : ""}
          {plan.planner.costUsd ? ` · ${fmtUsd(plan.planner.costUsd)}` : ""}
        </span>
      </div>
      <input
        className="field mt-3 !border-transparent font-serif text-[40px] leading-tight italic focus:!border-cream sm:text-[52px]"
        value={plan.title}
        onChange={(e) => set({ title: e.target.value })}
        aria-label="Mission title"
      />
      <MissionBrief plan={plan} className="mt-1" />

      {plan.notes.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl border border-uncertain/30 bg-uncertain/5 px-4 py-3 text-[13px] text-ink-2">
          {plan.notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}

      <Section title="Sources" hint="Code gathers the items. Jev only judges them.">
        <div className="space-y-2">
          {plan.sources.map((s, i) => (
            <div key={s.id} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto_auto]">
              <select
                className="box !py-1 font-mono text-[12px]"
                value={s.kind}
                onChange={(e) => {
                  const kind = e.target.value as SourceKind;
                  set({ sources: plan.sources.map((x, j) => (j === i ? { ...x, kind, crawl: kind === "site" } : x)) });
                }}
                aria-label="Source type"
              >
                {(s.fileType === "html" ? HTML_KINDS : KINDS.map((k) => [k, k] as const)).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink" title={s.label}>
                  {s.title || s.label}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {s.url ?? s.label}
                  {s.note ? ` · ${s.note}` : ""}
                </div>
              </div>
              {(s.kind === "site" || s.kind === "page") && !s.uploadId && !s.uploadIds && (
                <label className="flex items-center gap-2 text-[12px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={s.crawl}
                    onChange={(e) =>
                      set({ sources: plan.sources.map((x, j) => (j === i ? { ...x, crawl: e.target.checked, kind: e.target.checked ? "site" : "page" } : x)) })
                    }
                  />
                  crawl site
                </label>
              )}
              {s.kind === "feed" && (
                <label className="flex items-center gap-2 text-[12px] text-ink-2" title="Fetch each entry's link and judge the page, not just the feed text">
                  <input
                    type="checkbox"
                    checked={s.crawl}
                    onChange={(e) => set({ sources: plan.sources.map((x, j) => (j === i ? { ...x, crawl: e.target.checked } : x)) })}
                  />
                  read linked pages
                </label>
              )}
              <button className="text-[12px] text-muted hover:text-ink" onClick={() => set({ sources: plan.sources.filter((_, j) => j !== i) })}>
                remove
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Each item is a" hint="Used in counters and labels.">
        <div className="flex flex-wrap items-center gap-3 text-[14px] text-ink-2">
          <input className="box !w-40" value={plan.unit.singular} onChange={(e) => set({ unit: { ...plan.unit, singular: e.target.value } })} aria-label="Unit, singular" />
          <span>plural</span>
          <input className="box !w-40" value={plan.unit.plural} onChange={(e) => set({ unit: { ...plan.unit, plural: e.target.value } })} aria-label="Unit, plural" />
        </div>
      </Section>

      <Section title="The gate" hint="One yes/no question. Yes means the item belongs in the results.">
        <Grow className="box min-h-[84px] text-[15px] leading-relaxed" value={plan.gate.instructions} onChange={(e) => set({ gate: { instructions: e.target.value } })} />
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px] text-ink-2">
          <label className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm bg-match" /> match at P(yes) ≥
            <input
              type="number"
              step={0.05}
              min={0.5}
              max={1}
              className="box !w-20 !py-1 font-mono"
              value={plan.thresholds.yes}
              onChange={(e) => set({ thresholds: { ...plan.thresholds, yes: Number(e.target.value) } })}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm bg-reject" /> reject at ≤
            <input
              type="number"
              step={0.05}
              min={0}
              max={0.5}
              className="box !w-20 !py-1 font-mono"
              value={plan.thresholds.no}
              onChange={(e) => set({ thresholds: { ...plan.thresholds, no: Number(e.target.value) } })}
            />
          </label>
          <span className="text-muted">between them: uncertain</span>
        </div>
      </Section>

      <Section title="Breakdown questions" hint="Asked in the same call as the gate. Extra questions add almost no latency.">
        <div className="space-y-3">
          {plan.dimensions.map((d, i) => (
            <div key={d.key} className="rounded-xl border border-hairline bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <input className="box !w-56 !py-1 text-[13px] font-semibold" value={d.label} onChange={(e) => setDim(i, { label: e.target.value })} aria-label="Question label" />
                <span className="chip font-mono !text-[11px]">{d.type === "noul" ? "yes/no" : d.type === "choice" ? "pick one" : "score"}</span>
                <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => set({ dimensions: plan.dimensions.filter((_, j) => j !== i) })}>
                  remove
                </button>
              </div>
              <Grow
                className="box mt-2 min-h-[60px] text-[14px]"
                placeholder="The question, with concrete criteria"
                value={d.instructions}
                onChange={(e) => setDim(i, { instructions: e.target.value })}
              />
              {d.type === "choice" && (
                <div className="mt-2 space-y-1.5">
                  {(d.options ?? []).map((o, j) => (
                    <div key={j} className="grid grid-cols-[0.75rem_10rem_minmax(0,1fr)_auto] items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: seriesColor(j) }} />
                      <input
                        className="box !py-1 font-mono text-[12px]"
                        value={o.key}
                        onChange={(e) => setDim(i, { options: (d.options ?? []).map((x, k) => (k === j ? { ...x, key: keyOf(e.target.value, `option_${j + 1}`) } : x)) })}
                        aria-label="Option key"
                      />
                      <input
                        className="box !py-1 text-[12px]"
                        placeholder="What this option means"
                        value={o.description}
                        onChange={(e) => setDim(i, { options: (d.options ?? []).map((x, k) => (k === j ? { ...x, description: e.target.value } : x)) })}
                      />
                      <button className="text-[12px] text-muted hover:text-ink" onClick={() => setDim(i, { options: (d.options ?? []).filter((_, k) => k !== j) })} aria-label="Remove option">
                        ✕
                      </button>
                    </div>
                  ))}
                  {(d.options ?? []).length < 8 && (
                    <button
                      className="text-[12px] text-muted hover:text-ink"
                      onClick={() => setDim(i, { options: [...(d.options ?? []), { key: freshKey((d.options ?? []).map((o) => o.key), "option"), description: "" }] })}
                    >
                      + option
                    </button>
                  )}
                </div>
              )}
              {d.type === "score" && (
                <div className="mt-2 space-y-1.5">
                  {(d.levels ?? []).map((l, j) => (
                    <div key={j} className="flex items-center gap-2">
                      <span className="w-6 font-mono text-[11px] text-muted">{j + 1}</span>
                      <input
                        className="box !py-1 text-[12px]"
                        value={l}
                        onChange={(e) => setDim(i, { levels: (d.levels ?? []).map((x, k) => (k === j ? e.target.value : x)) })}
                      />
                      <button className="text-[12px] text-muted hover:text-ink" onClick={() => setDim(i, { levels: (d.levels ?? []).filter((_, k) => k !== j) })} aria-label="Remove level">
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="text-[12px] text-muted hover:text-ink" onClick={() => setDim(i, { levels: [...(d.levels ?? []), ""] })}>
                    + level (lowest first)
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost !py-1.5 text-[13px]" onClick={() => addDim("choice")}>
              + pick one
            </button>
            <button className="btn btn-ghost !py-1.5 text-[13px]" onClick={() => addDim("noul")}>
              + yes/no check
            </button>
            <button className="btn btn-ghost !py-1.5 text-[13px]" onClick={() => addDim("score")}>
              + score
            </button>
          </div>
        </div>
      </Section>

      <Section title="Audience panel" hint="Simulated people. Each one answers the same yes/no about every item.">
        {plan.panel ? (
          <div className="rounded-xl border border-hairline bg-surface p-3">
            <label className="flex flex-wrap items-center gap-2 text-[14px] text-ink-2">
              Would this person
              <input
                className="box !w-72 !py-1"
                value={plan.panel.action}
                onChange={(e) => set({ panel: { ...plan.panel!, action: e.target.value } })}
                aria-label="Panel action"
              />
              ?
            </label>
            <div className="mt-3 space-y-1.5">
              {plan.panel.personas.map((p, i) => (
                <div key={i} className="grid grid-cols-[11rem_minmax(0,1fr)_auto] items-center gap-2">
                  <input className="box !py-1 text-[12px] font-semibold" value={p.label} onChange={(e) => setPersona(i, { label: e.target.value })} aria-label="Persona name" />
                  <input className="box !py-1 text-[12px]" value={p.description} onChange={(e) => setPersona(i, { description: e.target.value })} aria-label="Persona description" />
                  <button
                    className="text-[12px] text-muted hover:text-ink"
                    onClick={() => set({ panel: { ...plan.panel!, personas: plan.panel!.personas.filter((_, j) => j !== i) } })}
                    aria-label="Remove persona"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-4">
              {plan.panel.personas.length < 40 && (
                <button
                  className="text-[12px] text-muted hover:text-ink"
                  onClick={() =>
                    set({
                      panel: {
                        ...plan.panel!,
                        personas: [...plan.panel!.personas, { key: freshKey(plan.panel!.personas.map((p) => p.key), `person_${plan.panel!.personas.length + 1}`), label: "New person", description: "" }],
                      },
                    })
                  }
                >
                  + person
                </button>
              )}
              <button className="text-[12px] text-muted hover:text-ink" onClick={() => set({ panel: null })}>
                remove panel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn btn-ghost !py-1.5 text-[13px]"
            onClick={() =>
              set({
                panel: {
                  action: "act on this",
                  personas: [
                    { key: "person_1", label: "Person one", description: "" },
                    { key: "person_2", label: "Person two", description: "" },
                  ],
                },
              })
            }
          >
            + add a panel
          </button>
        )}
      </Section>

      {columns.length > 0 && (
        <Section title="Count distinct" hint="Table columns that name an account, brand, company or person.">
          <div className="flex flex-wrap gap-2">
            {columns.map((c) => {
              const on = plan.entityFields.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => set({ entityFields: on ? plan.entityFields.filter((f) => f !== c) : [...plan.entityFields, c].slice(0, 5) })}
                  className={`chip ${on ? "!border-cream !text-ink" : ""}`}
                >
                  {on ? "✓ " : ""}
                  {c}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Limits" hint={`Jev allows ${fmtInt(jev.requestsPerMinute)} requests a minute per key.`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Num label="Max items" value={plan.limits.maxItems} min={1} max={20000} onChange={(v) => set({ limits: { ...plan.limits, maxItems: v } })} />
          <Num label="Pages per site" value={plan.limits.maxPagesPerSite} min={1} max={5000} onChange={(v) => set({ limits: { ...plan.limits, maxPagesPerSite: v } })} />
          <Num label="Crawl depth" value={plan.limits.crawlDepth} min={0} max={5} onChange={(v) => set({ limits: { ...plan.limits, crawlDepth: v } })} />
          <Num label="Parallel calls" value={plan.limits.concurrency} min={1} max={64} onChange={(v) => set({ limits: { ...plan.limits, concurrency: v } })} />
          <Num
            label="Items per call"
            hint="above 1 packs items into one call: faster, slightly riskier"
            value={plan.limits.itemsPerCall}
            min={1}
            max={8}
            onChange={(v) => set({ limits: { ...plan.limits, itemsPerCall: v } })}
          />
          <Num label="Chars per item" value={plan.limits.maxCharsPerItem} min={200} max={60000} onChange={(v) => set({ limits: { ...plan.limits, maxCharsPerItem: v } })} />
        </div>
        <label className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={plan.review.enabled} onChange={(e) => set({ review: { ...plan.review, enabled: e.target.checked } })} />
          Send the uncertain band to Claude, up to
          <input
            type="number"
            className="box !w-20 !py-1 font-mono"
            min={0}
            max={500}
            value={plan.review.max}
            onChange={(e) => set({ review: { ...plan.review, max: Math.max(0, Math.round(Number(e.target.value))) } })}
          />
          items
        </label>
      </Section>

      <div className="sticky bottom-4 z-20 mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-hairline bg-[#121211]/95 px-5 py-4 shadow-2xl backdrop-blur">
        <div className="font-mono text-[12px] text-ink-2">
          ≈ {fmtInt(est.items)} items · {fmtInt(est.judgments)} judgments · {fmtUsd(est.usd)} Jev · ~{fmtDuration(est.seconds * 1000)}
          <span className="ml-2 text-muted">estimate</span>
          {!jev.ready && <div className="mt-1 text-[#e88a8a]">{jev.reason}</div>}
          {error && <div className="mt-1 text-[#e88a8a]">{error}</div>}
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-primary" disabled={!jev.ready || launching || !plan.sources.length} onClick={onLaunch}>
            {launching ? "Launching…" : "Launch mission ▸"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {hint && <span className="text-[12px] text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Num({ label, value, min, max, hint, onChange }: { label: string; value: number; min: number; max: number; hint?: string; onChange: (v: number) => void }) {
  return (
    <label className="block" title={hint}>
      <span className="eyebrow">{label}</span>
      <input
        type="number"
        className="box mt-1 !py-1.5 font-mono text-[13px]"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))}
      />
    </label>
  );
}

/** A textarea that grows with its text, so a long question is never hidden behind a scrollbar. */
function Grow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={2} {...props} style={{ resize: "none", overflow: "hidden", ...props.style }} />;
}
