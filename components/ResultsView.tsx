"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { bandOf } from "@/lib/bands";
import { warmthRank } from "@/lib/text";
import type { Band, ClientItem, Plan, RunSnapshot } from "@/lib/types";
import { BandBar, DimensionBars, PanelBars } from "./charts";
import {
  BAND_COLOR,
  BAND_GLYPH,
  BAND_LABEL,
  fmtCompact,
  fmtDate,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtUsd,
  plural,
  seriesColor,
} from "./format";
import { ItemDrawer } from "./ItemDrawer";
import { MissionBrief } from "./MissionBrief";
import { TooltipProvider, useTooltip } from "./Tooltip";
import { useRun } from "./useRun";

type Tab = Band | "error";

export function ResultsView({ initial }: { initial: RunSnapshot }) {
  return (
    <TooltipProvider>
      <Results initial={initial} />
    </TooltipProvider>
  );
}

function Results({ initial }: { initial: RunSnapshot }) {
  const [epoch, setEpoch] = useState(0);
  const { store, version } = useRun(initial.id, initial, epoch);
  const run = store.run ?? initial;
  const { plan, metrics: m } = run;
  const [tab, setTab] = useState<Tab>(() =>
    initial.metrics.bands.match ? "match" : initial.metrics.bands.uncertain ? "uncertain" : initial.metrics.bands.reject ? "reject" : "error",
  );
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(100);
  const [picked, setPicked] = useState<ClientItem | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // The match bar is a policy, not a property of the model: re-cut it here without re-running Jev.
  const [cut, setCut] = useState<Plan["thresholds"]>(initial.plan.thresholds);
  const [sort, setSort] = useState<SortKey>("match");
  const [qualifying, setQualifying] = useState(false);
  const bandFor = (i: ClientItem): Band => i.review?.verdict ?? bandOf(i.p ?? 0, cut);

  const judged = run.items.filter((i) => i.status === "judged");
  const facetFields = useMemo(() => fieldFacets(judged), [version, run]); // run mutates in place; version marks each update
  const inFacets = (i: ClientItem) => Object.entries(facets).every(([k, v]) => !v || (i.fields?.[k] ?? "") === v);
  const scoped = judged.filter(inFacets);
  const byTab = (t: Tab) => (t === "error" ? run.items.filter((i) => i.status === "error") : scoped.filter((i) => bandFor(i) === t));
  const bands: Record<Band, number> = { match: 0, uncertain: 0, reject: 0 };
  for (const i of judged) bands[bandFor(i)]++;
  const counts: Record<Tab, number> = { match: 0, uncertain: 0, reject: 0, error: m.errors };
  for (const i of scoped) counts[bandFor(i)]++;
  const recut = cut.yes !== plan.thresholds.yes || cut.no !== plan.thresholds.no;

  const choiceDims = plan.dimensions.filter((d) => d.type === "choice");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = byTab(tab);
    if (q) list = list.filter((i) => `${i.title} ${i.url ?? ""} ${i.snippet ?? ""} ${Object.values(i.fields ?? {}).join(" ")}`.toLowerCase().includes(q));
    for (const [k, v] of Object.entries(filters)) if (v) list = list.filter((i) => i.answers?.[k]?.v === v);
    const byMatch = (a: ClientItem, b: ClientItem) => (plan.panel ? (b.appeal ?? 0) - (a.appeal ?? 0) : 0) || (b.p ?? 0) - (a.p ?? 0);
    const order: Record<SortKey, (a: ClientItem, b: ClientItem) => number> = {
      match: byMatch,
      warm: (a, b) => warmthRank(b.fields?.relationship) - warmthRank(a.fields?.relationship) || byMatch(a, b),
      dms: (a, b) => Number(b.fields?.dm_messages ?? 0) - Number(a.fields?.dm_messages ?? 0) || byMatch(a, b),
      qual: (a, b) => (b.qual?.score ?? 0) - (a.qual?.score ?? 0) || byMatch(a, b),
    };
    return [...list].sort(order[sort]);
  }, [version, run, tab, query, filters, facets, cut, sort, plan.panel]); // run mutates in place; version marks each update

  const hasWarmth = judged.some((i) => i.fields?.relationship);
  const hasDms = judged.some((i) => i.fields?.dm_messages);
  const qualified = judged.filter((i) => i.qual);
  const toQualify = rows.filter((i) => !i.qual).slice(0, 100);

  const qualify = async () => {
    setQualifying(true);
    const res = await fetch(`/api/runs/${run.id}/qualify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: toQualify.map((i) => i.id) }),
    });
    if (res.ok) setEpoch((e) => e + 1);
    setQualifying(false);
  };

  const spend = m.jev.costUsd + m.claude.costUsd;
  // Fractions of a cent read better per thousand items.
  const perItem = m.judged ? m.jev.costUsd / m.judged : 0;
  const unsettled = counts.uncertain ? scoped.filter((i) => bandFor(i) === "uncertain" && !i.review) : [];
  const running = run.status === "running";

  const reviewMore = async () => {
    setReviewing(true);
    const ids = [...unsettled].sort((a, b) => (b.p ?? 0) - (a.p ?? 0)).slice(0, 50).map((i) => i.id);
    const res = await fetch(`/api/runs/${run.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, max: 50 }),
    });
    if (res.ok) setEpoch((e) => e + 1);
    setReviewing(false);
  };

  return (
    <div className="min-h-dvh pb-20">
      <header className="sticky top-0 z-30 border-b border-hairline bg-plane/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="font-mono text-[12px] tracking-[0.22em] text-ink">
            JEV<span className="text-muted">/</span>WORKSPACE
          </Link>
          <nav className="flex items-center gap-2 text-[13px] whitespace-nowrap">
            <Link href={`/runs/${run.id}`} className="btn btn-ghost hidden !py-1.5 md:inline-flex">
              Dashboard
            </Link>
            <Link href={`/?from=${run.id}`} className="btn btn-ghost hidden !py-1.5 md:inline-flex">
              Re-run plan
            </Link>
            <a
              href={`/api/runs/${run.id}/export?format=outreach&yes=${cut.yes}&no=${cut.no}`}
              className="btn btn-ghost !py-1.5"
              title={qualified.length ? "Qualified candidates scored 2 or 3, with context" : "Matches at the current cut, with context"}
            >
              Outreach sheet
            </a>
            <a href={`/api/runs/${run.id}/export?format=csv&yes=${cut.yes}&no=${cut.no}`} className="btn btn-ghost hidden !py-1.5 sm:inline-flex">
              CSV
            </a>
            <a href={`/api/runs/${run.id}/export?format=json&yes=${cut.yes}&no=${cut.no}`} className="btn btn-ghost hidden !py-1.5 sm:inline-flex">
              JSON
            </a>
            <Link href="/" className="btn btn-primary !py-1.5">
              New mission
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-4 sm:px-6">
        <section className="rise pt-10">
          <div className="eyebrow">
            Results · {fmtDate(run.createdAt)} · {run.status === "done" ? "complete" : run.status}
            {running ? " · Claude is reviewing" : ""}
          </div>
          <h1 className="mt-2 max-w-4xl font-serif text-[46px] leading-[1.02] text-ink italic sm:text-[64px]">
            {bands.match ? (
              <>
                {fmtInt(bands.match)} of {fmtInt(m.judged)} {plural(m.judged, plan.unit)} {bands.match === 1 ? "matches" : "match"}.
              </>
            ) : (
              <>No {plan.unit.plural} matched.</>
            )}
          </h1>
          <MissionBrief plan={plan} className="mt-3" />
        </section>

        <section className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Judged" value={fmtInt(m.judged)} sub={`${fmtInt(m.discovered)} found`} />
          <Stat label="Match" value={fmtInt(bands.match)} sub={m.judged ? `${fmtPct(bands.match / m.judged)} · at ≥ ${cut.yes.toFixed(2)}` : "–"} dot={BAND_COLOR.match} />
          <Stat label="Uncertain" value={fmtInt(bands.uncertain)} sub={m.reviewed ? `${fmtInt(m.reviewed)} settled by Claude` : "middle band"} dot={BAND_COLOR.uncertain} />
          <Stat label="Reject" value={fmtInt(bands.reject)} sub={m.errors ? `${fmtInt(m.errors)} errors` : "no errors"} dot={BAND_COLOR.reject} />
          <Stat label="Time" value={fmtDuration(m.elapsedMs)} sub={`peak ${m.peakPerSec.toFixed(1)}/s`} />
          <Stat label="Spend" value={fmtUsd(spend)} sub={`Jev ${fmtUsd(m.jev.costUsd)}`} />
          <Stat
            label={perItem < 0.001 ? `Per 1,000 ${plan.unit.plural}` : `Per ${plan.unit.singular}`}
            value={m.judged ? fmtUsd(perItem < 0.001 ? perItem * 1000 : perItem) : "–"}
            sub={`${fmtCompact(m.judgments)} judgments`}
          />
          <Stat
            label="LLM estimate"
            value={m.llmEquivalentUsd ? `≈ ${fmtUsd(m.llmEquivalentUsd)}` : "–"}
            sub={m.jev.costUsd ? `${Math.round(m.llmEquivalentUsd / m.jev.costUsd)}× the Jev spend` : ""}
          />
        </section>

        <section className="mt-4">
          <BandBar bands={bands} />
          <Cutoff judged={judged} cut={cut} planCut={plan.thresholds} recut={recut} onCut={setCut} />
        </section>

        <section className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hairline">
              <div className="scroll-thin flex max-w-full gap-1 overflow-x-auto">
                {(["match", "uncertain", "reject", "error"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTab(t);
                      setShown(100);
                    }}
                    className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[14px] whitespace-nowrap ${tab === t ? "border-cream text-ink" : "border-transparent text-muted hover:text-ink-2"}`}
                  >
                    <span className="h-2 w-2 rounded-sm" style={{ background: t === "error" ? BAND_COLOR.error : BAND_COLOR[t] }} />
                    {t === "error" ? "Errors" : t === "match" ? "Matches" : t === "reject" ? "Rejects" : "Uncertain"}
                    <span className="font-mono text-[12px] text-muted tabular">{fmtInt(counts[t])}</span>
                  </button>
                ))}
              </div>
              <div className="mb-2 flex items-center gap-2">
                <select className="box !w-auto !py-1.5 text-[12px]" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
                  <option value="match">Sort: best match</option>
                  {hasWarmth && <option value="warm">Sort: warmest first</option>}
                  {hasDms && <option value="dms">Sort: most DMs</option>}
                  {qualified.length > 0 && <option value="qual">Sort: qualification</option>}
                </select>
                <input className="box !py-1.5 text-[13px] sm:!w-52" placeholder="Search titles, links, text" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            {(tab === "match" || tab === "uncertain") && rows.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px] text-ink-2">
                <span>
                  {qualified.length
                    ? `${fmtInt(qualified.length)} qualified by Claude: ${qualified.filter((i) => i.qual!.score === 3).length} strong, ${qualified.filter((i) => i.qual!.score === 2).length} plausible. The outreach sheet lists the 2s and 3s.`
                    : "Next: Claude scores these 1 to 3 and writes the reason and outreach context. Uses your Claude plan, roughly a cent or two per candidate."}
                </span>
                {toQualify.length > 0 && (
                  <button className="btn btn-primary !py-1.5 text-[13px]" disabled={qualifying || running} onClick={qualify}>
                    {running ? "Claude is working…" : `Qualify the top ${toQualify.length} with Claude`}
                  </button>
                )}
              </div>
            )}

            {(choiceDims.length > 0 || facetFields.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {facetFields.map((f) => (
                  <select
                    key={`field-${f.name}`}
                    className="box !w-auto max-w-[16rem] !py-1 text-[12px]"
                    value={facets[f.name] ?? ""}
                    onChange={(e) => setFacets((x) => ({ ...x, [f.name]: e.target.value }))}
                    aria-label={`Filter by ${f.name}`}
                  >
                    <option value="">{f.name}: all</option>
                    {f.values.map(([v, n]) => (
                      <option key={v} value={v}>
                        {f.name}: {v || "(blank)"} · {fmtInt(n)}
                      </option>
                    ))}
                  </select>
                ))}
                {choiceDims.map((d) => (
                  <select
                    key={d.key}
                    className="box !w-auto !py-1 text-[12px]"
                    value={filters[d.key] ?? ""}
                    onChange={(e) => setFilters((f) => ({ ...f, [d.key]: e.target.value }))}
                    aria-label={`Filter by ${d.label}`}
                  >
                    <option value="">{d.label}: all</option>
                    {(d.options ?? []).map((o) => (
                      <option key={o.key} value={o.key}>
                        {d.label}: {o.key.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            )}

            {tab === "uncertain" && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-uncertain/30 bg-uncertain/5 px-4 py-3 text-[13px] text-ink-2">
                <span>
                  Jev was not sure about these ({cut.no.toFixed(2)} &lt; P(yes) &lt; {cut.yes.toFixed(2)}).{" "}
                  {unsettled.length ? `${fmtInt(unsettled.length)} not yet settled.` : "All settled."}
                </span>
                {unsettled.length > 0 && (
                  <button className="btn btn-primary !py-1.5 text-[13px]" disabled={reviewing || running} onClick={reviewMore}>
                    {running ? "Claude is reviewing…" : `Settle the top ${Math.min(50, unsettled.length)} with Claude`}
                  </button>
                )}
              </div>
            )}

            <ItemTable items={rows.slice(0, shown)} run={run} bandFor={bandFor} onPick={setPicked} />
            {rows.length > shown && (
              <button className="btn btn-ghost mt-4" onClick={() => setShown((s) => s + 200)}>
                Show more ({fmtInt(rows.length - shown)} left)
              </button>
            )}
            {!rows.length && <p className="py-10 text-center text-[14px] text-muted">Nothing here.</p>}
          </div>

          <aside className="space-y-8 lg:col-span-4">
            {plan.panel && (
              <Block title={`Panel · who would ${plan.panel.action}`}>
                <PanelBars plan={plan} metrics={m} limit={30} />
              </Block>
            )}
            {plan.dimensions.length > 0 && (
              <Block title={`Breakdown · ${tab === "error" ? "all judged" : BAND_LABEL[tab as Band].toLowerCase()}`}>
                <div className="space-y-6">
                  {plan.dimensions.map((d) => {
                    const set = tab === "error" ? judged : byTab(tab);
                    const c: Record<string, number> = {};
                    for (const it of set) {
                      const a = it.answers?.[d.key];
                      if (!a) continue;
                      const k = d.type === "choice" ? String(a.v) : d.type === "noul" ? ((a.v as number) >= 0.5 ? "yes" : "no") : String(Math.round(a.v as number));
                      c[k] = (c[k] ?? 0) + 1;
                    }
                    return <DimensionBars key={d.key} dim={d} counts={c} total={set.length} />;
                  })}
                </div>
              </Block>
            )}
            <Entities run={run} bandFor={bandFor} />
            <SpotCheck run={run} bandFor={bandFor} />
          </aside>
        </section>

        <CrossTab run={run} />
        <CostAndPlan run={run} />
      </main>
      <ItemDrawer item={picked} plan={plan} onClose={() => setPicked(null)} />
    </div>
  );
}

function Stat({ label, value, sub, dot }: { label: string; value: string; sub?: string; dot?: string }) {
  return (
    <div className="bg-surface p-4">
      <div className="flex items-center gap-1.5">
        {dot && <span className="h-2 w-2 rounded-sm" style={{ background: dot }} />}
        <span className="eyebrow">{label}</span>
      </div>
      <div className="mt-2 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere] text-ink xl:text-[24px]">{value}</div>
      {sub && <div className="mt-1.5 truncate text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-3">{title}</div>
      {children}
    </div>
  );
}

function ItemTable({ items, run, bandFor, onPick }: { items: ClientItem[]; run: RunSnapshot; bandFor: (i: ClientItem) => Band; onPick: (i: ClientItem) => void }) {
  const { plan } = run;
  const cols = plan.dimensions.filter((d) => d.type === "choice").slice(0, 2);
  return (
    <ol className="mt-2 divide-y divide-hairline">
      {items.map((it) => {
        const band = it.status === "judged" ? bandFor(it) : undefined;
        return (
          <li key={it.id}>
            <button onClick={() => onPick(it)} className="grid w-full grid-cols-[3.6rem_minmax(0,1fr)_auto] items-center gap-3 px-1 py-2.5 text-left hover:bg-surface">
              <span className="flex items-center gap-1.5">
                {band ? (
                  <span className="grid h-4 w-4 place-items-center rounded-[3px] text-[10px] font-bold text-black" style={{ background: BAND_COLOR[band] }}>
                    {BAND_GLYPH[band]}
                  </span>
                ) : (
                  <span className="h-4 w-4 rounded-[3px] bg-error" />
                )}
                <span className="font-mono text-[12px] text-ink tabular">{it.p != null ? it.p.toFixed(2) : "–"}</span>
              </span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  {it.qual && (
                    <span className="chip shrink-0 !py-0 font-mono !text-[10.5px]" style={{ borderColor: QUAL_COLOR[it.qual.score] }}>
                      {it.qual.score} · {QUAL_LABEL[it.qual.score]}
                    </span>
                  )}
                  <span className="truncate text-[14px] text-ink">{it.title}</span>
                </span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {it.error ??
                    (it.qual?.why ||
                      [
                        it.review ? `Claude: ${it.review.reason}` : null,
                        it.fields?.relationship,
                        it.fields?.dm_messages ? `${it.fields.dm_messages} ${it.fields.dm_messages === "1" ? "DM" : "DMs"}, last ${it.fields.dm_last}` : null,
                        it.fields?.relationship ? null : it.locator,
                      ]
                        .filter(Boolean)
                        .join(" · ") ||
                      it.url)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {cols.map((d) => {
                  const a = it.answers?.[d.key];
                  if (!a) return null;
                  const idx = (d.options ?? []).findIndex((o) => o.key === a.v);
                  return (
                    <span key={d.key} className="chip hidden !py-0 !text-[11px] md:inline-flex">
                      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: seriesColor(idx < 0 ? 99 : idx) }} />
                      {String(a.v).replace(/_/g, " ")}
                    </span>
                  );
                })}
                {it.appeal != null && <span className="font-mono text-[11px] text-ink-2 tabular">{fmtPct(it.appeal)} appeal</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function entityKey(run: RunSnapshot): { label: string; of: (i: ClientItem) => string | undefined } | null {
  const field = run.plan.entityFields[0];
  if (field) return { label: field.replace(/_/g, " "), of: (i) => i.fields?.[field]?.trim() || undefined };
  if (run.items.some((i) => i.domain)) return { label: "site", of: (i) => i.domain };
  return null;
}

function Entities({ run, bandFor }: { run: RunSnapshot; bandFor: (i: ClientItem) => Band }) {
  const { bind } = useTooltip();
  const key = entityKey(run);
  if (!key) return null;
  const groups = new Map<string, { n: number; match: number }>();
  for (const it of run.items) {
    if (it.status !== "judged") continue;
    const k = key.of(it);
    if (!k) continue;
    const g = groups.get(k) ?? { n: 0, match: 0 };
    g.n++;
    if (bandFor(it) === "match") g.match++;
    groups.set(k, g);
  }
  if (groups.size < 2) return null;
  const top = [...groups.entries()].sort((a, b) => b[1].match - a[1].match || b[1].n - a[1].n).slice(0, 12);
  const max = Math.max(...top.map(([, g]) => g.n));
  return (
    <Block title={`By ${key.label} · ${fmtInt(groups.size)} total`}>
      <div className="space-y-1.5">
        {top.map(([name, g]) => (
          <div key={name} className="grid grid-cols-[minmax(0,9rem)_1fr_4rem] items-center gap-2" tabIndex={0} {...bind({ value: `${g.match} of ${g.n} match`, label: name, color: BAND_COLOR.match })}>
            <span className="truncate text-[12px] text-ink-2">{name}</span>
            <div className="flex h-[10px] gap-[2px]" style={{ width: `${(g.n / max) * 100}%` }}>
              {g.match > 0 && <div className="h-full rounded-l-[3px]" style={{ flexGrow: g.match, background: BAND_COLOR.match }} />}
              {g.n - g.match > 0 && <div className="h-full rounded-r-[3px]" style={{ flexGrow: g.n - g.match, background: "#3a3935" }} />}
            </div>
            <span className="text-right font-mono text-[11px] text-ink-2 tabular">
              {g.match}/{g.n}
            </span>
          </div>
        ))}
      </div>
    </Block>
  );
}

/** Entity by first choice question: the "every hook, every format, by brand" view. */
function CrossTab({ run }: { run: RunSnapshot }) {
  const { bind } = useTooltip();
  const key = entityKey(run);
  const dim = run.plan.dimensions.find((d) => d.type === "choice");
  if (!key || !dim) return null;
  const options = dim.options ?? [];
  const table = new Map<string, Record<string, number>>();
  for (const it of run.items) {
    const k = key.of(it);
    const a = it.answers?.[dim.key];
    if (!k || !a) continue;
    const row = table.get(k) ?? {};
    row[String(a.v)] = (row[String(a.v)] ?? 0) + 1;
    table.set(k, row);
  }
  // One item per entity (a feed of 30 different sites) makes a sparse, meaningless grid.
  if (table.size < 2 || table.size > run.items.length / 1.5) return null;
  const rows = [...table.entries()]
    .map(([k, r]) => ({ k, r, n: Object.values(r).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 20);
  const max = Math.max(1, ...rows.flatMap((x) => Object.values(x.r)));
  const blue = (v: number) => (v ? `rgba(57,135,229,${0.15 + 0.85 * (v / max)})` : "transparent");
  return (
    <section className="mt-14">
      <div className="eyebrow mb-3">
        {dim.label} by {key.label} · top {rows.length}
      </div>
      <div className="scroll-thin overflow-x-auto rounded-2xl border border-hairline">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="sticky left-0 bg-plane px-3 py-2 font-normal">{key.label}</th>
              {options.map((o) => (
                <th key={o.key} className="px-2 py-2 text-center font-normal whitespace-nowrap">
                  {o.key.replace(/_/g, " ")}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-normal">total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ k, r, n }) => (
              <tr key={k} className="border-t border-hairline">
                <td className="sticky left-0 max-w-[220px] truncate bg-plane px-3 py-1.5 text-ink-2">{k}</td>
                {options.map((o) => (
                  <td key={o.key} className="p-[2px]">
                    <div
                      className="grid h-7 min-w-[44px] place-items-center rounded-[4px] font-mono text-[11px] tabular"
                      style={{ background: blue(r[o.key] ?? 0), color: (r[o.key] ?? 0) / max > 0.55 ? "#fff" : "#c3c2b7" }}
                      tabIndex={0}
                      {...bind({ value: `${r[o.key] ?? 0} ${plural(r[o.key] ?? 0, run.plan.unit)}`, label: `${k} · ${o.key.replace(/_/g, " ")}`, color: "#3987e5" })}
                    >
                      {r[o.key] ?? ""}
                    </div>
                  </td>
                ))}
                <td className="px-3 text-right font-mono text-ink tabular">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function sample<T extends { id: number }>(items: T[], n: number, seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rand = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Ten random labels checked by hand: the first thing to do with any new classifier. */
function SpotCheck({ run, bandFor }: { run: RunSnapshot; bandFor: (i: ClientItem) => Band }) {
  const [labels, setLabels] = useState<Record<string, boolean>>(run.spotCheck ?? {});
  const picks = useMemo(() => sample(run.items.filter((i) => i.status === "judged"), 10, run.id), [run.items, run.id]);
  if (!picks.length) return null;
  const done = picks.filter((p) => labels[p.id] !== undefined);
  const right = done.filter((p) => labels[p.id]).length;
  const mark = async (id: number, ok: boolean) => {
    setLabels((l) => ({ ...l, [id]: ok }));
    await fetch(`/api/runs/${run.id}/spotcheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: { [id]: ok } }),
    });
  };
  return (
    <Block title={`Spot-check · ${done.length}/10${done.length ? ` · ${right} right` : ""}`}>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">Check ten random verdicts by hand before trusting a new mission at scale.</p>
      <ol className="space-y-1.5">
        {picks.map((it) => {
          const band = bandFor(it);
          const v = labels[it.id];
          return (
            <li key={it.id} className="flex items-center gap-2 rounded-lg border border-hairline px-2.5 py-2">
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] text-[10px] font-bold text-black" style={{ background: BAND_COLOR[band] }}>
                {BAND_GLYPH[band]}
              </span>
              <a href={it.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate text-[12.5px] text-ink hover:underline" title={it.title}>
                {it.title}
              </a>
              <button
                aria-label="Jev was right"
                onClick={() => mark(it.id, true)}
                className={`rounded-md px-2 py-0.5 text-[12px] ${v === true ? "bg-match text-black" : "text-muted hover:text-ink"}`}
              >
                right
              </button>
              <button
                aria-label="Jev was wrong"
                onClick={() => mark(it.id, false)}
                className={`rounded-md px-2 py-0.5 text-[12px] ${v === false ? "bg-error text-white" : "text-muted hover:text-ink"}`}
              >
                wrong
              </button>
            </li>
          );
        })}
      </ol>
    </Block>
  );
}

function CostAndPlan({ run }: { run: RunSnapshot }) {
  const { plan, metrics: m } = run;
  const [open, setOpen] = useState(false);
  const rows: [string, string][] = [
    ["Jev model", `${m.jev.model ?? run.jev.model} via ${run.jev.name}`],
    ["Jev calls", `${fmtInt(m.jev.calls)} (${plan.limits.itemsPerCall} ${plural(plan.limits.itemsPerCall, plan.unit)} per call)`],
    ["Input tokens", fmtInt(m.jev.inputTokens)],
    ["Jev price", `$${run.jev.usdPerMillionInput} per million input tokens, output free`],
    ["Jev spend", `${fmtUsd(m.jev.costUsd)} · ${m.judged ? fmtUsd((m.jev.costUsd / m.judged) * 1000) : "–"} per 1,000 ${plan.unit.plural}`],
    ["Latency", `p50 ${m.jev.p50} ms · p95 ${m.jev.p95} ms${m.jev.throttled ? ` · throttled ${m.jev.throttled}×` : ""}`],
    ["Planner", `${plan.planner.provider}${plan.planner.model ? ` · ${plan.planner.model}` : ""} · ${fmtDuration(plan.planner.ms)} · ${fmtUsd(plan.planner.costUsd)}`],
    ["Claude", `${m.claude.calls} ${m.claude.calls === 1 ? "call" : "calls"} (planning and review) · ${fmtUsd(m.claude.costUsd)}`],
    ["LLM estimate", `${fmtUsd(m.llmEquivalentUsd)}: the same questions sent to Claude Sonnet 5 at list price. An estimate, not a measurement.`],
  ];
  return (
    <section className="mt-14 grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div>
        <div className="eyebrow mb-3">Cost and speed</div>
        <dl className="divide-y divide-hairline rounded-2xl border border-hairline">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5 text-[13px]">
              <dt className="text-muted">{k}</dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">What Jev was asked</div>
          <button className="text-[12px] text-muted hover:text-ink" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show all"}
          </button>
        </div>
        <div className="space-y-3 rounded-2xl border border-hairline p-4 text-[13px]">
          <div>
            <span className="eyebrow">Gate · yes ≥ {plan.thresholds.yes} · no ≤ {plan.thresholds.no}</span>
            <p className="mt-1 text-ink">{plan.gate.instructions}</p>
          </div>
          {(open ? plan.dimensions : plan.dimensions.slice(0, 2)).map((d) => (
            <div key={d.key}>
              <span className="eyebrow">
                {d.label} · {d.type}
              </span>
              <p className="mt-1 text-ink-2">{d.instructions}</p>
              {open && d.options && <p className="mt-1 text-[12px] text-muted">{d.options.map((o) => o.key).join(" · ")}</p>}
              {open && d.levels && <p className="mt-1 text-[12px] text-muted">{d.levels.join(" → ")}</p>}
            </div>
          ))}
          {plan.panel && (
            <div>
              <span className="eyebrow">
                Panel · {plan.panel.personas.length} people · would {plan.panel.action}
              </span>
              {open && <p className="mt-1 text-[12px] text-muted">{plan.panel.personas.map((p) => p.label).join(" · ")}</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// Names, links, bios and message stats identify an item; filtering on them is a search, not a facet.
const NOT_FACETS = /^(name|link|details|url|title|full.?name|display.?name|biography|bio|website|external.?url|profile.?url|username|handle|dm_.*)$/i;

/** Fields worth filtering on: a few repeated values across the judged items, like "relationship" or "I Follow". */
function fieldFacets(items: ClientItem[]): { name: string; values: [string, number][] }[] {
  const seen = new Map<string, Map<string, number>>();
  for (const it of items) {
    for (const [k, raw] of Object.entries(it.fields ?? {})) {
      if (NOT_FACETS.test(k)) continue;
      const v = raw.trim();
      let m = seen.get(k);
      if (!m) seen.set(k, (m = new Map()));
      if (m.size <= 12 || m.has(v)) m.set(v, (m.get(v) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, m]) => {
      const filled = [...m.entries()].filter(([v]) => v).reduce((a, [, n]) => a + n, 0);
      return m.size >= 2 && m.size <= 12 && m.size <= Math.max(3, filled * 0.6);
    })
    .map(([name, m]) => ({ name, values: [...m.entries()].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => Number(b.name === "relationship") - Number(a.name === "relationship"))
    .slice(0, 6);
}

const LADDER = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

/** The match bar, adjustable after the run, with how many items each bar would keep. */
function Cutoff({
  judged,
  cut,
  planCut,
  recut,
  onCut,
}: {
  judged: ClientItem[];
  cut: Plan["thresholds"];
  planCut: Plan["thresholds"];
  recut: boolean;
  onCut: (c: Plan["thresholds"]) => void;
}) {
  const keep = (yes: number) => judged.filter((i) => (i.review ? i.review.verdict === "match" : (i.p ?? 0) >= yes)).length;
  const set = (yes: number) => onCut({ yes, no: Math.min(planCut.no, Math.round((yes - 0.05) * 100) / 100) });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-2">
      <label className="flex items-center gap-2">
        Match at P(yes) ≥
        <input
          type="range"
          min={0.3}
          max={0.95}
          step={0.05}
          value={cut.yes}
          onChange={(e) => set(Number(e.target.value))}
          className="w-36 accent-[#efe6d2]"
          aria-label="Match cutoff"
        />
        <span className="w-10 font-mono text-ink tabular">{cut.yes.toFixed(2)}</span>
      </label>
      <span className="flex flex-wrap items-center gap-1.5">
        {LADDER.map((y) => (
          <button
            key={y}
            onClick={() => set(y)}
            className={`chip !py-0.5 font-mono !text-[11px] ${Math.abs(cut.yes - y) < 0.001 ? "!border-cream !text-ink" : "hover:!text-ink"}`}
            title={`Keep items at P(yes) ≥ ${y.toFixed(2)}`}
          >
            {y.toFixed(1)} → {fmtInt(keep(y))}
          </button>
        ))}
      </span>
      {recut && (
        <button className="font-mono text-[11px] text-muted underline decoration-axis underline-offset-4 hover:text-ink" onClick={() => onCut(planCut)}>
          back to the plan&apos;s {planCut.yes.toFixed(2)}
        </button>
      )}
    </div>
  );
}

type SortKey = "match" | "warm" | "dms" | "qual";

const QUAL_LABEL: Record<1 | 2 | 3, string> = { 3: "strong", 2: "plausible", 1: "weak" };
const QUAL_COLOR: Record<1 | 2 | 3, string> = { 3: "#0ca30c", 2: "#fab219", 1: "#686761" };
