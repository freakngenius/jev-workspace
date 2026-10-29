"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Plan, PlannerProvider, RunMeta, RunSnapshot } from "@/lib/types";
import { BAND_COLOR, fmtDate, fmtDuration, fmtInt, fmtUsd, plural } from "./format";
import { filesFromDrop, filesFromInput, selectFiles, type PickedFile } from "./folderUpload";
import { PlanEditor, type JevStatus } from "./PlanEditor";

export interface WorkspaceStatus {
  jev: JevStatus;
  planners: PlannerProvider[];
  claude: { route: string | null; model: string };
}

interface Upload {
  id: string;
  name: string;
  path?: string;
  size: number;
}

const EXAMPLES: { label: string; mission: string; links: string[]; hint?: string }[] = [
  {
    label: "HN · agent stories",
    mission: "Which of these Hacker News front-page stories are about AI agents or tools for building agents? Say what kind of story each one is.",
    links: ["https://news.ycombinator.com/rss"],
  },
  {
    label: "arXiv · new benchmarks",
    mission: "Screen today's arXiv computation-and-language papers. Which ones introduce a new benchmark or dataset? Rate how practical each one is for people shipping products.",
    links: ["https://rss.arxiv.org/rss/cs.CL"],
  },
  {
    label: "Ad teardown",
    mission:
      "Tear down every ad: hook type, format, offer, call to action and awareness stage. Flag landing-page mismatch. Which ones would a busy founder actually click?",
    links: [],
    hint: "Drop an ads export (CSV or JSON from the Meta Ad Library, Apify, or similar).",
  },
  {
    label: "Leads · ICP fit",
    mission: "Which of my LinkedIn connections match my ICP: founders or operators at 10 to 200 person companies building with AI? Say which tier each lead is.",
    links: [],
    hint: "Drop your LinkedIn Connections.csv.",
  },
];

const IN_THE_WILD = [
  { who: "Matthew Berman", what: "724 live ads from 37 brands in 40 s for $0.09", href: "https://x.com/TheMattBerman/status/2100654891756589230" },
  { who: "Made with Jev", what: "Roundup of ad demos: 1,891 ads in 19 s, 21,690 persona votes for $0.22", href: "https://madewithjev.com/jev-for-ads" },
  { who: "TypeSafe", what: "Launch post: System One models and Jev", href: "https://typesafe.ai/blog/introducing-system-one-models-and-jev" },
  { who: "TypeSafe evals", what: "Accuracy against cost and time across four workflows", href: "https://evals.typesafe.ai" },
  { who: "jev-shield", what: "Browser extension with live scanned / blocked / call counters", href: "https://github.com/vmendes90/jev-shield" },
  { who: "awesome-typesafe-jev", what: "Community index of Jev projects", href: "https://github.com/AbdelStark/awesome-typesafe-jev" },
];

const PLANNING_LINES = ["Reading your links…", "Sampling the sources…", "Drafting typed questions for Jev…", "Checking the questions can be answered from one item…"];

export function MissionControl({ status, recent }: { status: WorkspaceStatus; recent: RunMeta[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [mission, setMission] = useState("");
  const [links, setLinks] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [planner, setPlanner] = useState<PlannerProvider | "auto">("auto");
  const [phase, setPhase] = useState<"compose" | "planning" | "review">("compose");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [line, setLine] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const from = params.get("from");
    if (!from) return;
    fetch(`/api/runs/${from}`)
      .then((r) => (r.ok ? (r.json() as Promise<RunSnapshot>) : null))
      .then((run) => {
        if (!run) return;
        setMission(run.plan.mission);
        // Re-running a saved plan spends nothing on planning, so its cost must not count again.
        setPlan({ ...run.plan, notes: [], planner: { ...run.plan.planner, ms: 0, costUsd: 0 } });
        setPhase("review");
      });
  }, [params]);

  useEffect(() => {
    if (phase !== "planning") return;
    const t = setInterval(() => setLine((l) => (l + 1) % PLANNING_LINES.length), 2200);
    return () => clearInterval(t);
  }, [phase]);

  const linkList = links
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\/\S+\.\S+/.test(l));

  const upload = async (picked: PickedFile[]) => {
    if (!picked.length) return;
    const { keep, skipped, instagram } = selectFiles(picked);
    if (!keep.length) return setError("Nothing in there the app can read (CSV, JSON, PDF, HTML, TXT, MD).");
    setError(null);
    setUploading(`0 of ${keep.length}`);
    // Batches keep a 400-file export from becoming one giant request.
    for (let i = 0; i < keep.length; i += 100) {
      const form = new FormData();
      for (const p of keep.slice(i, i + 100)) {
        form.append("files", p.file);
        form.append("paths", p.path);
      }
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploading(null);
        return setError(data.error ?? "Upload failed.");
      }
      setUploads((u) => [...u, ...data.uploads]);
      setUploading(`${Math.min(i + 100, keep.length)} of ${keep.length}`);
    }
    setUploading(null);
    if (instagram) {
      const dms = keep.filter((p) => /messages\/inbox\//i.test(p.path)).length;
      setHint(`Instagram export: ${keep.length - dms} follower ${keep.length - dms === 1 ? "list" : "lists"} and ${dms} DM threads added. ${skipped.toLocaleString("en-US")} media and other files skipped. DMs count as a warmth signal; their text never leaves this computer.`);
    } else if (skipped) {
      setHint(`${skipped.toLocaleString("en-US")} files skipped: not a type the app reads.`);
    }
  };

  const makePlan = async () => {
    setError(null);
    if (mission.trim().length < 3) return setError("Say what the mission is.");
    if (!linkList.length && !uploads.length) return setError("Give Jev something to work through: paste links or drop a file.");
    setPhase("planning");
    setLine(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mission, links: linkList, uploadIds: uploads.map((u) => u.id), planner }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Planning failed (HTTP ${res.status}).`);
      setPlan(data.plan);
      setPhase("review");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if ((err as Error).name === "AbortError") return setPhase("compose");
      setError((err as Error).message);
      setPhase("compose");
    }
  };

  const launch = async () => {
    if (!plan) return;
    setLaunching(true);
    setError(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLaunching(false);
      return setError(data.error ?? "Launch failed.");
    }
    router.push(`/runs/${data.id}`);
  };

  return (
    <div className="relative min-h-dvh overflow-x-hidden pb-24">
      <Ambient />
      <header className="relative z-10 mx-auto flex max-w-[1180px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="font-mono text-[12px] tracking-[0.22em] text-ink" onClick={() => setPhase("compose")}>
          JEV<span className="text-muted">/</span>WORKSPACE
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="chip font-mono !text-[11px]" title={status.jev.reason ?? undefined}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.jev.ready ? "#0ca30c" : "#d03b3b" }} />
            Jev {status.jev.ready ? `${status.jev.name === "custom" ? "custom endpoint" : status.jev.name} · ${status.jev.model}` : "· no key"}
          </span>
          <span className="chip hidden font-mono !text-[11px] sm:inline-flex">
            planner · {status.planners[0] === "claude-cli" ? `Claude CLI · ${status.claude.model}` : status.planners[0] === "anthropic" ? `Claude API · ${status.claude.model}` : status.planners[0]}
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-[1180px] px-4 sm:px-6">
        {phase === "review" && plan ? (
          <div className="pt-8">
            <PlanEditor
              plan={plan}
              onChange={setPlan}
              jev={status.jev}
              onBack={() => {
                setPhase("compose");
                setError(null);
              }}
              onLaunch={launch}
              launching={launching}
              error={error}
            />
          </div>
        ) : (
          <>
            <section className="mx-auto max-w-[880px] pt-[9vh]">
              <h1 className="rise font-serif text-[64px] leading-[0.95] tracking-tight text-ink italic sm:text-[104px]">What&rsquo;s the mission?</h1>
              <p className="rise mt-4 max-w-xl text-[16px] leading-relaxed text-ink-2" style={{ animationDelay: "80ms" }}>
                Give Jev a goal and the places to look. It reads everything, judges every item in a fraction of a second, and shows its work and its bill as it goes.
              </p>

              <div className="rise mt-10" style={{ animationDelay: "160ms" }}>
                <label className="eyebrow" htmlFor="mission">
                  Goal
                </label>
                <textarea
                  id="mission"
                  rows={3}
                  className="field mt-2 resize-none pb-3 text-[22px] leading-snug sm:text-[26px]"
                  placeholder="Find every page on these sites that offers a free trial, and say what kind of page it is."
                  value={mission}
                  onChange={(e) => setMission(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void makePlan();
                  }}
                  disabled={phase === "planning"}
                />
              </div>

              <div className="rise mt-8 grid grid-cols-1 gap-6 md:grid-cols-[1.4fr_1fr]" style={{ animationDelay: "240ms" }}>
                <div>
                  <label className="eyebrow" htmlFor="links">
                    Links
                  </label>
                  <textarea
                    id="links"
                    rows={4}
                    className="box mt-2 resize-y font-mono text-[13px] leading-relaxed"
                    placeholder={"https://example.com   (site: crawled)\nhttps://example.com/sitemap.xml\nhttps://example.com/feed.xml\nhttps://docs.google.com/spreadsheets/d/…"}
                    value={links}
                    onChange={(e) => setLinks(e.target.value)}
                    disabled={phase === "planning"}
                  />
                  <p className="mt-1.5 text-[12px] text-muted">
                    {linkList.length ? `${linkList.length} ${linkList.length === 1 ? "link" : "links"}` : "One per line."} Sites are crawled. Sitemaps, feeds, CSV, JSON, PDFs and public Google Sheets are read
                    directly.
                  </p>
                </div>
                <div>
                  <span className="eyebrow">Files</span>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void filesFromDrop(e.dataTransfer).then(upload);
                    }}
                    className="mt-2 flex h-[106px] w-full flex-col items-center justify-center rounded-[10px] border border-dashed border-axis bg-[#121211] text-center text-[13px] text-ink-2 transition hover:border-[#6d6a62]"
                  >
                    {uploading ? `Uploading ${uploading}…` : "Drop files or a folder: CSV, JSON, PDF, HTML, TXT, MD"}
                    <span className="mt-1 text-[11px] text-muted">Contents go to Jev. Keep NDA material out.</span>
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    accept=".csv,.tsv,.json,.pdf,.html,.htm,.xhtml,.txt,.md,.markdown"
                    onChange={(e) => e.target.files && upload(filesFromInput(e.target.files))}
                  />
                  <input
                    ref={folderInput}
                    type="file"
                    hidden
                    {...({ webkitdirectory: "" } as Record<string, string>)}
                    onChange={(e) => e.target.files && upload(filesFromInput(e.target.files))}
                  />
                  <button type="button" className="mt-1.5 text-[12px] text-muted underline decoration-axis underline-offset-4 hover:text-ink" onClick={() => folderInput.current?.click()}>
                    or choose a whole folder, like an Instagram export
                  </button>
                  {uploads.length > 0 && (
                    <ul className="scroll-thin mt-2 max-h-40 space-y-1 overflow-y-auto">
                      {uploads.length > 6 && (
                        <li className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
                          <span>
                            {uploads.length} files · {(uploads.reduce((a, u) => a + u.size, 0) / 1024 / 1024).toFixed(1)} MB
                          </span>
                          <button className="font-mono text-muted hover:text-ink" onClick={() => setUploads([])}>
                            clear all
                          </button>
                        </li>
                      )}
                      {uploads.map((u) => (
                        <li key={u.id} className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
                          <span className="truncate" title={u.path ?? u.name}>
                            {u.path ?? u.name}
                          </span>
                          <span className="flex items-center gap-2 font-mono text-muted">
                            {(u.size / 1024).toFixed(0)} KB
                            <button className="hover:text-ink" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))} aria-label={`Remove ${u.name}`}>
                              ✕
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="rise mt-8 flex flex-wrap items-center justify-between gap-4" style={{ animationDelay: "320ms" }}>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      className="chip hover:!border-[#6d6a62] hover:!text-ink"
                      onClick={() => {
                        setMission(ex.mission);
                        setLinks(ex.links.join("\n"));
                        setHint(ex.hint ?? null);
                      }}
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <select
                    className="box !w-auto !py-2 text-[13px]"
                    value={planner}
                    onChange={(e) => setPlanner(e.target.value as PlannerProvider | "auto")}
                    aria-label="Who drafts the questions"
                    disabled={phase === "planning"}
                  >
                    <option value="auto">Planner: auto</option>
                    {status.planners.map((p) => (
                      <option key={p} value={p}>
                        Planner: {p === "claude-cli" ? "Claude CLI" : p === "anthropic" ? "Claude API" : p === "ollama" ? "local (Ollama)" : "template"}
                      </option>
                    ))}
                  </select>
                  {phase === "planning" ? (
                    <button className="btn btn-ghost" onClick={() => abortRef.current?.abort()}>
                      Cancel
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={makePlan}>
                      Plan the mission →
                    </button>
                  )}
                </div>
              </div>
              {hint && <p className="mt-3 text-[13px] text-uncertain">{hint}</p>}
              {error && <p className="mt-3 text-[13px] text-[#e88a8a]">{error}</p>}
              {phase === "planning" && (
                <div className="mt-8 flex items-center gap-3 font-mono text-[13px] text-ink-2">
                  <span className="live-dot" />
                  {PLANNING_LINES[line]}
                </div>
              )}
              {!status.jev.ready && (
                <p className="mt-6 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-[13px] text-ink-2">
                  {status.jev.reason} You can plan now; launching needs the key.
                </p>
              )}
            </section>

            {recent.length > 0 && (
              <section className="mx-auto mt-24 max-w-[880px]">
                <div className="eyebrow mb-3">Recent missions</div>
                <ul className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface/60">
                  {recent.map((r) => (
                    <RecentRow key={r.id} run={r} />
                  ))}
                </ul>
              </section>
            )}

            <section className="mx-auto mt-16 max-w-[880px]">
              <div className="eyebrow mb-3">Seen in the wild</div>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {IN_THE_WILD.map((d) => (
                  <li key={d.href}>
                    <a
                      href={d.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded-xl border border-hairline px-4 py-3 transition hover:border-[#6d6a62] hover:bg-surface"
                    >
                      <div className="text-[13px] font-semibold text-ink">{d.who}</div>
                      <div className="mt-0.5 text-[12px] text-muted">{d.what}</div>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function RecentRow({ run }: { run: RunMeta }) {
  const total = run.bands.match + run.bands.uncertain + run.bands.reject;
  return (
    <li>
      <Link href={`/runs/${run.id}/results`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-raised/60 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <span className="min-w-0">
          <span className="block truncate text-[14px] text-ink">{run.title}</span>
          <span className="block truncate font-mono text-[11px] text-muted">
            {fmtDate(run.createdAt)} · {run.status} · {fmtInt(run.judged)} {plural(run.judged, run.unit)} · {fmtDuration(run.elapsedMs)} · {fmtUsd(run.costUsd)}
          </span>
        </span>
        <span className="hidden h-2 gap-[2px] sm:flex">
          {total ? (
            (["match", "uncertain", "reject"] as const).map((b) =>
              run.bands[b] ? <span key={b} className="h-full first:rounded-l-[3px] last:rounded-r-[3px]" style={{ flexGrow: run.bands[b], background: BAND_COLOR[b] }} /> : null,
            )
          ) : (
            <span className="h-full w-full rounded bg-hairline" />
          )}
        </span>
        <span className="font-mono text-[12px] text-ink tabular">{fmtInt(run.bands.match)} ✓</span>
      </Link>
    </li>
  );
}

/** A dim field of cells behind the question, lighting up now and then: a preview of what a run looks like. */
function Ambient() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const S = 10;
    const G = 3;
    let cols = 0;
    let rows = 0;
    let cells: { v: number; color: string }[] = [];
    const colors = [BAND_COLOR.match, BAND_COLOR.uncertain, BAND_COLOR.reject, BAND_COLOR.reject, BAND_COLOR.reject];
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(c.clientWidth / (S + G));
      rows = Math.ceil(c.clientHeight / (S + G));
      cells = Array.from({ length: cols * rows }, () => ({ v: 0, color: colors[0] }));
    };
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
      for (let k = 0; k < 3; k++) {
        const i = Math.floor(Math.random() * cells.length);
        cells[i] = { v: 1, color: colors[Math.floor(Math.random() * colors.length)] };
      }
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const x = (i % cols) * (S + G);
        const y = Math.floor(i / cols) * (S + G);
        ctx.globalAlpha = 0.05 + cell.v * 0.4;
        ctx.fillStyle = cell.v > 0.02 ? cell.color : "#2a2a27";
        ctx.fillRect(x, y, S, S);
        cell.v *= 0.965;
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[760px] w-full"
      style={{ maskImage: "radial-gradient(ellipse 70% 60% at 70% 20%, black, transparent 75%)", WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 70% 20%, black, transparent 75%)" }}
    />
  );
}
