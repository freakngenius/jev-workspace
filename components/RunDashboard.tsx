"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ClientItem, RunSnapshot } from "@/lib/types";
import { AnimatedNumber } from "./AnimatedNumber";
import { DimensionBars, Histogram, PanelBars, Sparkline } from "./charts";
import { BAND_COLOR, BAND_GLYPH, BAND_LABEL, fmtCompact, fmtDuration, fmtInt, fmtUsd, plural, seriesColor } from "./format";
import { ItemDrawer } from "./ItemDrawer";
import { MissionBrief } from "./MissionBrief";
import { TileField } from "./TileField";
import { TooltipProvider } from "./Tooltip";
import { useRun } from "./useRun";

export function RunDashboard({ id, initial }: { id: string; initial: RunSnapshot | null }) {
  return (
    <TooltipProvider>
      <Dashboard id={id} initial={initial} />
    </TooltipProvider>
  );
}

function Dashboard({ id, initial }: { id: string; initial: RunSnapshot | null }) {
  const { store, version } = useRun(id, initial);
  const [picked, setPicked] = useState<ClientItem | null>(null);
  const run = store.run;
  // Auto-open results only when the run finished while this page watched it.
  const watchedLive = useRef<boolean | null>(null);
  if (watchedLive.current === null && run) watchedLive.current = run.status === "running";

  if (!run) {
    return (
      <div className="grid min-h-dvh place-items-center text-muted">
        {store.error ?? <span className="eyebrow">Connecting to the run…</span>}
      </div>
    );
  }
  const { plan, metrics: m } = run;
  const running = run.status === "running";
  const ceiling = (run.jev.requestsPerMinute / 60) * plan.limits.itemsPerCall;
  const spend = m.jev.costUsd + m.claude.costUsd;

  return (
    <div className="min-h-dvh pb-16">
      <TopBar run={run} />
      <main className="mx-auto max-w-[1480px] px-4 sm:px-6">
        {store.done && <Complete run={run} auto={watchedLive.current === true} hold={picked !== null} />}

        <section className="rise pt-6">
          <div className="eyebrow">Mission</div>
          <h1 className="mt-1 font-serif text-[40px] leading-[1.02] text-ink italic sm:text-[52px]">{plan.title}</h1>
          <MissionBrief plan={plan} className="mt-2" />
        </section>

        <Pipeline run={run} />

        <section className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="card rise p-5 lg:col-span-4" style={{ animationDelay: "60ms" }}>
            <div className="eyebrow">Judged</div>
            <div className="mt-2 flex items-baseline gap-3">
              <AnimatedNumber value={m.judged} format={fmtInt} className="font-mono text-[64px] leading-none font-medium tracking-tight text-ink tabular" />
              <span className="text-[15px] text-ink-2">
                of {fmtInt(m.discovered)} {plural(m.discovered, plan.unit)}
              </span>
            </div>
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-hairline">
              <div className="h-full rounded-full bg-cream transition-[width] duration-300" style={{ width: `${m.discovered ? (m.judged / m.discovered) * 100 : 0}%` }} />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {(["match", "uncertain", "reject"] as const).map((b) => (
                <div key={b}>
                  <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
                    <span className="grid h-3.5 w-3.5 place-items-center rounded-[3px] text-[9px] font-bold text-black" style={{ background: BAND_COLOR[b] }}>
                      {BAND_GLYPH[b]}
                    </span>
                    {BAND_LABEL[b]}
                  </div>
                  <AnimatedNumber value={m.bands[b]} format={fmtInt} className="font-mono text-[22px] text-ink tabular" />
                </div>
              ))}
            </div>
            {(m.errors > 0 || m.reviewed > 0) && (
              <div className="mt-3 flex gap-4 text-[12px] text-muted">
                {m.reviewed > 0 && <span>{fmtInt(m.reviewed)} settled by Claude</span>}
                {m.errors > 0 && <span className="text-[#e88a8a]">{fmtInt(m.errors)} errors</span>}
              </div>
            )}
          </div>

          <div className="card rise min-w-0 p-5 lg:col-span-4 xl:col-span-3" style={{ animationDelay: "120ms" }}>
            <div className="eyebrow">Spend, live</div>
            <AnimatedNumber value={spend} format={fmtUsd} className="mt-2 block font-mono text-[40px] leading-none font-medium text-ink tabular xl:text-[44px]" />
            <div className="mt-4 space-y-1.5 text-[13px]">
              <Row label="Jev" value={fmtUsd(m.jev.costUsd)} hint={`${fmtCompact(m.jev.inputTokens)} tokens · ${fmtInt(m.jev.calls)} calls`} />
              <Row label="Claude" value={fmtUsd(m.claude.costUsd)} hint={`${m.claude.calls} ${m.claude.calls === 1 ? "call" : "calls"}`} />
              <Row label={`Per ${plan.unit.singular}`} value={m.judged ? fmtUsd(m.jev.costUsd / m.judged) : "–"} />
              <Row
                label="Same on an LLM"
                value={m.llmEquivalentUsd ? `≈ ${fmtUsd(m.llmEquivalentUsd)}` : "–"}
                hint={m.jev.costUsd && m.llmEquivalentUsd ? `${Math.round(m.llmEquivalentUsd / m.jev.costUsd)}× Jev` : undefined}
                title="Estimate: the same questions sent to Claude Sonnet 5 at list price ($2 in / $10 out per million tokens)."
              />
            </div>
            {running && m.projectedCostUsd > spend && (
              <div className="mt-3 border-t border-hairline pt-2 text-[12px] text-muted">Projected at finish {fmtUsd(m.projectedCostUsd)}</div>
            )}
          </div>

          <div className="card rise min-w-0 p-5 lg:col-span-4 xl:col-span-3" style={{ animationDelay: "180ms" }}>
            <div className="eyebrow">Throughput</div>
            <div className="mt-2 flex items-baseline gap-2">
              <AnimatedNumber value={m.perSec} format={(n) => n.toFixed(1)} className="font-mono text-[44px] leading-none font-medium text-ink tabular" />
              <span className="text-[14px] text-ink-2">{plan.unit.plural}/s</span>
            </div>
            <div className="mt-3">
              <Sparkline rate={m.rate} ceiling={ceiling} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
              <span>peak {m.peakPerSec.toFixed(1)}/s</span>
              <span>p50 {m.jev.p50}ms</span>
              <span>p95 {m.jev.p95}ms</span>
              <span>limit {ceiling.toFixed(0)}/s</span>
              {m.jev.throttled > 0 && <span className="text-uncertain">throttled {m.jev.throttled}×</span>}
            </div>
          </div>

          <div className="card rise p-5 lg:col-span-12 xl:col-span-2" style={{ animationDelay: "240ms" }}>
            <div className="eyebrow">Counted</div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-1">
              {m.entities.map((e) => (
                <Counter key={e.label} value={e.count} label={e.label.replace(/_/g, " ")} />
              ))}
              {m.people > 0 && <Counter value={m.people} label="people on the panel" />}
              <Counter value={m.judgments} label="judgments" />
              <Counter value={m.jev.calls} label="Jev calls" />
            </div>
          </div>
        </section>

        <section className="card rise mt-3 p-5" style={{ animationDelay: "300ms" }}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="eyebrow">
              Every {plan.unit.singular} · {fmtInt(m.discovered)} found · click one to inspect
            </div>
            <Legend run={run} />
          </div>
          <TileField store={store} version={version} onPick={setPicked} />
        </section>

        <section className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="card p-5 lg:col-span-5">
            <div className="eyebrow mb-3">Live judgments</div>
            <Feed items={store.recent} run={run} onPick={setPicked} />
          </div>
          <div className="card p-5 lg:col-span-3">
            <div className="eyebrow mb-3">P(yes) distribution</div>
            <Histogram bins={m.histogram} thresholds={plan.thresholds} />
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              At or above {plan.thresholds.yes.toFixed(2)} is a match, at or below {plan.thresholds.no.toFixed(2)} a reject. The middle band
              {plan.review.enabled ? " goes to Claude." : " stays uncertain."}
            </p>
          </div>
          <div className="card p-5 lg:col-span-4">
            <div className="eyebrow mb-3">{plan.panel ? `Panel · would ${plan.panel.action}` : "Breakdown"}</div>
            <div className="space-y-5">
              {plan.panel && <PanelBars plan={plan} metrics={m} limit={8} />}
              {plan.dimensions.map((d) => (
                <DimensionBars key={d.key} dim={d} counts={m.dimensions[d.key] ?? {}} total={m.judged} />
              ))}
              {!plan.panel && !plan.dimensions.length && (
                <p className="text-[13px] text-muted">This mission asks one question. Add breakdown questions in the plan to see them here.</p>
              )}
            </div>
          </div>
        </section>

        <LogStrip run={run} />
      </main>
      <ItemDrawer item={picked} plan={plan} onClose={() => setPicked(null)} />
    </div>
  );
}

function Row({ label, value, hint, title }: { label: string; value: string; hint?: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="min-w-0 text-right">
        <span className="font-mono text-ink tabular">{value}</span>
        {hint && <span className="ml-2 font-mono text-[11px] text-muted">{hint}</span>}
      </span>
    </div>
  );
}

function Counter({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <AnimatedNumber value={value} format={fmtCompact} className="block font-mono text-[24px] leading-none text-ink tabular" />
      <div className="mt-0.5 text-[12px] text-muted">{label}</div>
    </div>
  );
}

function TopBar({ run }: { run: RunSnapshot }) {
  const [stopping, setStopping] = useState(false);
  const running = run.status === "running";
  const label =
    run.status === "running"
      ? run.phase === "reviewing"
        ? "Claude reviewing"
        : "Live"
      : run.status === "done"
        ? "Complete"
        : run.status === "stopped"
          ? "Stopped"
          : "Error";
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-plane/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 font-mono text-[11px] tracking-[0.18em] text-ink sm:text-[12px] sm:tracking-[0.22em]">
          JEV<span className="text-muted">/</span>
          <span className="hidden sm:inline">WORKSPACE</span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-5">
          <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] whitespace-nowrap text-ink uppercase">
            {running ? <span className="live-dot" /> : <span className="h-2 w-2 rounded-full" style={{ background: run.status === "done" ? "#0ca30c" : run.status === "stopped" ? "#fab219" : "#d03b3b" }} />}
            {label}
          </span>
          <Clock run={run} />
          <span className="hidden font-mono text-[11px] text-muted md:inline">
            {run.jev.name === "custom" ? "custom endpoint" : run.jev.name} · {run.metrics.jev.model ?? run.jev.model}
          </span>
          {running ? (
            <button
              className="btn btn-ghost !py-1.5 text-[13px]"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                await fetch(`/api/runs/${run.id}/stop`, { method: "POST" });
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <Link href={`/runs/${run.id}/results`} className="btn btn-primary !py-1.5 text-[13px] whitespace-nowrap">
              Results →
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function Clock({ run }: { run: RunSnapshot }) {
  const ref = useRef<HTMLSpanElement>(null);
  const running = run.status === "running";
  const started = Date.parse(run.createdAt);
  const final = run.metrics.elapsedMs;
  useEffect(() => {
    if (!running) {
      if (ref.current) ref.current.textContent = fmtDuration(final);
      return;
    }
    const t = setInterval(() => {
      if (ref.current) ref.current.textContent = fmtDuration(Date.now() - started);
    }, 100);
    return () => clearInterval(t);
  }, [running, started, final]);
  // The server and the browser read the clock at different moments, so the first text differs by design.
  return (
    <span ref={ref} className="font-mono text-[13px] text-ink tabular" suppressHydrationWarning>
      {fmtDuration(running ? Date.now() - started : final)}
    </span>
  );
}

function Pipeline({ run }: { run: RunSnapshot }) {
  const m = run.metrics;
  const running = run.status === "running";
  const doneSources = run.sources.filter((s) => s.state === "done" || s.state === "error").length;
  const stages = [
    { label: "Sources", value: `${doneSources}/${run.sources.length}`, active: running && doneSources < run.sources.length },
    { label: "Found", value: fmtInt(m.discovered), active: running && doneSources < run.sources.length },
    { label: "Read", value: fmtInt(m.fetched), active: running && m.fetched < m.discovered },
    { label: "Judged by Jev", value: fmtInt(m.judged), active: running && m.jev.inFlight > 0 },
    ...(run.plan.review.enabled ? [{ label: "Settled by Claude", value: fmtInt(m.reviewed), active: run.phase === "reviewing" }] : []),
  ];
  return (
    <section className="rise mt-6">
      <div className="flex flex-wrap items-center gap-y-3">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center">
            {i > 0 && <div className={`flow mx-3 h-px w-8 sm:w-14 ${s.active || stages[i - 1].active ? "active" : ""}`} />}
            <div>
              <div className="eyebrow">{s.label}</div>
              <div className="font-mono text-[20px] text-ink tabular">{s.value}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {run.sources.map((s) => (
          <span key={s.id} className="chip" title={s.error ?? s.label}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${s.state === "active" ? "animate-pulse" : ""}`}
              style={{ background: s.state === "error" ? "#d03b3b" : s.state === "done" ? "#8b8983" : s.state === "active" ? "#efe6d2" : "#3a3935" }}
            />
            <span className="max-w-[260px] truncate">{s.label.replace(/^https?:\/\//, "")}</span>
            <span className="font-mono text-[11px] text-muted">
              {s.kind} · {fmtInt(s.found)}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

function Legend({ run }: { run: RunSnapshot }) {
  const m = run.metrics;
  const pending = Math.max(0, m.discovered - m.judged - m.errors - (m.skipped ?? 0));
  const entries: [string, string, number | null][] = [
    ["Match", BAND_COLOR.match, m.bands.match],
    ["Uncertain", BAND_COLOR.uncertain, m.bands.uncertain],
    ["Reject", BAND_COLOR.reject, m.bands.reject],
    ["Waiting", BAND_COLOR.ready, pending],
    ["Error", BAND_COLOR.error, m.errors],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {entries.map(([label, color, n]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: color }} />
          {label}
          {n != null && <span className="font-mono text-muted tabular">{fmtInt(n)}</span>}
        </span>
      ))}
      {run.plan.review.enabled && (
        <span className="flex items-center gap-1.5">
          <span className="grid h-2.5 w-2.5 place-items-center rounded-[2px] bg-[#686761]">
            <span className="h-1 w-1 bg-cream" />
          </span>
          settled by Claude
        </span>
      )}
    </div>
  );
}

function Feed({ items, run, onPick }: { items: ClientItem[]; run: RunSnapshot; onPick: (i: ClientItem) => void }) {
  const firstChoice = run.plan.dimensions.find((d) => d.type === "choice");
  if (!items.length) {
    return <p className="text-[13px] text-muted">{run.status === "running" ? "Waiting for the first answers…" : "Nothing judged."}</p>;
  }
  return (
    <ol className="space-y-0.5">
      {items.slice(0, 14).map((it) => {
        const band = it.finalBand ?? it.band ?? "uncertain";
        const choice = firstChoice ? it.answers?.[firstChoice.key] : undefined;
        const optIdx = firstChoice && choice ? (firstChoice.options ?? []).findIndex((o) => o.key === choice.v) : -1;
        return (
          <li key={it.id} className="feed-row">
            <button
              onClick={() => onPick(it)}
              className="grid w-full grid-cols-[1.25rem_3.2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised"
            >
              <span className="grid h-4 w-4 place-items-center rounded-[3px] text-[10px] font-bold text-black" style={{ background: BAND_COLOR[band] }}>
                {BAND_GLYPH[band]}
              </span>
              <span className="font-mono text-[12px] text-ink tabular">{it.p?.toFixed(2)}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-ink">{it.title}</span>
                <span className="block truncate font-mono text-[10.5px] text-muted">{[it.domain, it.locator].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="flex items-center gap-2">
                {choice && (
                  <span className="chip !py-0 !text-[11px]">
                    <span className="h-1.5 w-1.5 rounded-sm" style={{ background: seriesColor(optIdx < 0 ? 99 : optIdx) }} />
                    {String(choice.v).replace(/_/g, " ")}
                  </span>
                )}
                <span className="font-mono text-[10.5px] text-muted tabular">{it.ms}ms</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function LogStrip({ run }: { run: RunSnapshot }) {
  const [open, setOpen] = useState(false);
  const lines = open ? run.logs.slice(-60) : run.logs.slice(-4);
  return (
    <section className="mt-3 rounded-xl border border-hairline p-4">
      <div className="flex items-center justify-between">
        <div className="eyebrow">Log</div>
        <button className="text-[12px] text-muted hover:text-ink" onClick={() => setOpen((o) => !o)}>
          {open ? "Less" : "More"}
        </button>
      </div>
      <ol className="scroll-thin mt-2 max-h-72 space-y-1 overflow-y-auto font-mono text-[11.5px]">
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`} className={l.level === "error" ? "text-[#e88a8a]" : l.level === "warn" ? "text-uncertain" : "text-ink-2"}>
            <span className="text-muted" suppressHydrationWarning>
              {new Date(l.at).toLocaleTimeString("en-US", { hour12: false })}
            </span>{" "}
            {l.msg}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Complete({ run, auto, hold }: { run: RunSnapshot; auto: boolean; hold: boolean }) {
  const router = useRouter();
  const [left, setLeft] = useState(auto && run.status === "done" ? 6 : null);
  // Inspecting an item means the user wants to stay; never pull the page out from under them.
  useEffect(() => {
    if (hold) setLeft(null);
  }, [hold]);
  useEffect(() => {
    if (left == null) return;
    if (left <= 0) {
      router.push(`/runs/${run.id}/results`);
      return;
    }
    const t = setTimeout(() => setLeft((l) => (l == null ? l : l - 1)), 1000);
    return () => clearTimeout(t);
  }, [left, router, run.id]);
  const m = run.metrics;
  return (
    <div className="rise mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-cream/30 bg-[#16150f] px-5 py-4">
      <div>
        <div className="eyebrow !text-cream/70">{run.status === "done" ? "Mission complete" : run.status === "stopped" ? "Mission stopped" : "Mission ended with an error"}</div>
        <div className="mt-1 text-[16px] text-ink">
          <span className="font-semibold">{fmtInt(m.bands.match)}</span> {plural(m.bands.match, run.plan.unit)} match out of {fmtInt(m.judged)} judged ·{" "}
          {fmtUsd(m.jev.costUsd + m.claude.costUsd)} · {fmtDuration(m.elapsedMs)}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {left != null && (
          <button className="text-[13px] text-muted hover:text-ink" onClick={() => setLeft(null)}>
            Opening results in {left}s · stay here
          </button>
        )}
        <Link href={`/runs/${run.id}/results`} className="btn btn-primary">
          Open results →
        </Link>
      </div>
    </div>
  );
}
