import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bandOf } from "./bands";
import { askClaude, claudeRoute } from "./claude";
import { costUsd, jevAsk, jevConfig, JevError, publicInfo, readAnswer, type JevConfig, type JevQuestion } from "./jev";
import { expandSource, type ExpandContext, type ItemDraft } from "./sources/expand";
import { listRuns, loadRun, saveRun, type RunRecord } from "./store";
import type {
  Answer,
  Band,
  ClientItem,
  Item,
  ItemPatch,
  LogLine,
  Metrics,
  Phase,
  Plan,
  RunEvent,
  RunMeta,
  RunSnapshot,
  RunStatus,
  SourceProgress,
} from "./types";

/**
 * One mission run. Producers expand sources into items, workers send ready
 * items to Jev, and every change streams to subscribers as small batched
 * events. Nothing here renders; the browser draws whatever arrives.
 */

/** LLM baseline for the "same judgments on an LLM" estimate: Claude Sonnet 5 list price, USD per million tokens. */
const LLM_BASELINE = { input: 2, output: 10, overheadTokens: 250, outputTokensPerQuestion: 20 };

const SNIPPET = 320;

interface Question {
  key: string;
  kind: "gate" | "dim" | "persona";
  ref: string;
  q: JevQuestion;
}

export function questionsFor(plan: Plan): Question[] {
  const out: Question[] = [{ key: "gate", kind: "gate", ref: "gate", q: { type: "noul", instructions: plan.gate.instructions } }];
  for (const d of plan.dimensions) {
    const q: JevQuestion = { type: d.type, instructions: d.instructions };
    if (d.type === "choice") q.criteria = Object.fromEntries((d.options ?? []).map((o) => [o.key, o.description || o.key]));
    if (d.type === "score") q.criteria = d.levels ?? [];
    out.push({ key: `d_${d.key}`, kind: "dim", ref: d.key, q });
  }
  for (const p of plan.panel?.personas ?? []) {
    out.push({
      key: `p_${p.key}`,
      kind: "persona",
      ref: p.key,
      q: {
        type: "noul",
        instructions: `Picture this person: ${p.label}. ${p.description} Would this person ${plan.panel!.action} based on this ${plan.unit.singular}?`,
      },
    });
  }
  return out;
}

export function stateFor(item: Item, plan: Plan): string {
  const lines = [`${capitalize(plan.unit.singular)}: ${item.title}`];
  if (item.url) lines.push(`URL: ${item.url}`);
  if (item.locator) lines.push(`Location: ${item.locator}`);
  const text = item.text ?? "";
  const max = plan.limits.maxCharsPerItem;
  lines.push("", text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);
  return lines.join("\n");
}

export { bandOf };

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function emptyMetrics(plan: Plan): Metrics {
  const claudePlanned = plan.planner.provider === "anthropic" || plan.planner.provider === "claude-cli";
  return {
    elapsedMs: 0,
    discovered: 0,
    fetched: 0,
    judged: 0,
    errors: 0,
    skipped: 0,
    bands: { match: 0, uncertain: 0, reject: 0 },
    reviewed: 0,
    reviewQueue: 0,
    entities: [],
    judgments: 0,
    people: plan.panel?.personas.length ?? 0,
    jev: { calls: 0, inputTokens: 0, costUsd: 0, p50: 0, p95: 0, inFlight: 0, throttled: 0, model: null },
    claude: { calls: claudePlanned ? 1 : 0, costUsd: plan.planner.costUsd },
    perSec: 0,
    peakPerSec: 0,
    rate: [],
    projectedCostUsd: 0,
    llmEquivalentUsd: 0,
    histogram: Array(20).fill(0),
    dimensions: {},
    panelYes: {},
  };
}

const ReviewSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(["match", "reject"]),
      reason: z.string().describe("at most 20 words, citing what in the item decided it"),
    }),
  ),
});

const REVIEW_SYSTEM = `You settle items that a fast classifier could not decide. For each item, answer the gate question with a firm verdict: "match" when the answer is yes, "reject" when it is no. Judge only from the item text shown. Give a reason of at most 20 words that cites what in the item decided it.`;

const QualifySchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().int().min(1).max(3),
      why: z.string().describe("one sentence tied to a signal visible in the item"),
      context: z.string().describe("one sentence of outreach context drawn only from what the item shows"),
    }),
  ),
});

const QUALIFY_SYSTEM = `You qualify candidates for outreach against the mission's ideal contact. Score each one:
3 = strong: a warm relationship, a clear fit and a clear problem signal are all visible.
2 = plausible: fit and some relationship are visible; the need is unconfirmed.
1 = weak: one vague signal, or too little evidence to say.
"why" is one sentence that cites the signal in the item that decided the score. "context" is one sentence the user could lean on when reaching out: the relationship (mutual follow, message history and how recent it is), what the bio or handle shows, and any request they made. Use only what the item shows. Never invent facts, never guess at private or sensitive traits (health, religion, politics, sexuality, ethnicity, finances, gender), and say plainly when evidence is thin. Refer to each person by name or as "they", never "he" or "she": a name does not show someone's pronouns, and the user may quote this line.`;

type Listener = (ev: RunEvent) => void;

export class RunEngine {
  readonly record: RunRecord;
  private cfg: JevConfig;
  private listeners = new Set<Listener>();
  private abort = new AbortController();
  private stopRequested = false;
  private queue: Item[] = [];
  private wake: (() => void)[] = [];
  private producersDone = false;
  private pending = new Map<number, ItemPatch>();
  private sourcesDirty = false;
  private latencies: number[] = [];
  private perSecond: number[] = [];
  private startedAt = Date.now();
  private tokensJudged = 0;
  private consecutiveFailures = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private finished: Promise<void> | null = null;
  /** Set once a finished run is reopened (later review), so its clock and rate history stay as they were. */
  private frozen = false;

  constructor(record: RunRecord, cfg: JevConfig) {
    this.record = record;
    this.cfg = cfg;
  }

  static create(plan: Plan): RunEngine {
    const cfg = jevConfig();
    const record: RunRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "running",
      phase: "starting",
      plan,
      jev: publicInfo(cfg),
      items: [],
      sources: plan.sources.map((s) => ({ id: s.id, label: s.label, kind: s.kind, state: "waiting", found: 0 })),
      metrics: emptyMetrics(plan),
      logs: [],
      spotCheck: {},
    };
    return new RunEngine(record, cfg);
  }

  static hydrate(record: RunRecord): RunEngine {
    const e = new RunEngine(record, jevConfig());
    e.startedAt = Date.parse(record.createdAt);
    e.frozen = true;
    return e;
  }

  get id() {
    return this.record.id;
  }

  get running() {
    return this.record.status === "running";
  }

  subscribe(fn: Listener): () => void {
    fn({ t: "snapshot", run: this.snapshot() });
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): RunSnapshot {
    return { ...this.record, items: this.record.items.map(toClient) };
  }

  stop() {
    if (!this.running) return;
    this.stopRequested = true;
    this.log("warn", "Stopped by you. Items already judged are kept.");
    this.abort.abort();
    this.wakeAll();
  }

  start(): Promise<void> {
    this.finished ??= this.main();
    return this.finished;
  }

  private emit(ev: RunEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        this.listeners.delete(fn);
      }
    }
  }

  private log(level: LogLine["level"], msg: string) {
    const line = { at: Date.now(), level, msg };
    this.record.logs.push(line);
    if (this.record.logs.length > 400) this.record.logs.splice(0, this.record.logs.length - 400);
    this.emit({ t: "log", line });
  }

  private patch(item: Item, p: Partial<ClientItem>) {
    Object.assign(item, p);
    const prev = this.pending.get(item.id);
    this.pending.set(item.id, { ...(prev ?? { id: item.id }), ...p, id: item.id });
  }

  private flush() {
    if (this.pending.size) {
      this.emit({ t: "items", items: [...this.pending.values()] });
      this.pending.clear();
    }
    if (this.sourcesDirty) {
      this.sourcesDirty = false;
      this.emit({ t: "sources", sources: this.record.sources.map((s) => ({ ...s })) });
    }
  }

  private setSource(id: string, p: Partial<SourceProgress>) {
    const s = this.record.sources.find((x) => x.id === id);
    if (s) Object.assign(s, p);
    this.sourcesDirty = true;
  }

  private wakeAll() {
    const w = this.wake;
    this.wake = [];
    for (const fn of w) fn();
  }

  private async main() {
    const { plan } = this.record;
    this.timers.push(setInterval(() => this.flush(), 120));
    this.timers.push(setInterval(() => this.publishMetrics(), 400));
    this.timers.push(setInterval(() => void this.persist(), 15_000));
    this.record.phase = "running";
    this.log("info", `Mission launched. Jev ${this.cfg.model} via ${this.cfg.name}, ${this.cfg.requestsPerMinute} requests/min.`);
    if (!this.cfg.ready) {
      this.log("error", this.cfg.reason ?? "Jev is not configured.");
      return this.finish("error");
    }

    const producers = this.produce().finally(() => {
      this.producersDone = true;
      this.wakeAll();
    });
    const workers = Array.from({ length: plan.limits.concurrency }, () => this.worker());
    await Promise.all([producers, ...workers]);

    if (!this.abort.signal.aborted && plan.review.enabled) await this.reviewUncertain(plan.review.max);
    await this.finish(this.abort.signal.aborted ? (this.stopRequested ? "stopped" : "error") : "done");
  }

  private async finish(status: RunStatus) {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.record.status = status;
    this.record.phase = "finished";
    if (!this.frozen || !this.record.finishedAt) this.record.finishedAt = new Date().toISOString();
    this.flush();
    this.publishMetrics();
    const m = this.record.metrics;
    this.log(
      status === "done" ? "info" : "warn",
      `Finished (${status}). ${m.judged} judged, ${m.bands.match} match, ${m.bands.uncertain} uncertain, ${m.bands.reject} reject. Spend $${(m.jev.costUsd + m.claude.costUsd).toFixed(4)}.`,
    );
    await this.persist();
    this.emit({ t: "done", status, finishedAt: this.record.finishedAt });
  }

  private async persist() {
    try {
      await saveRun(this.record);
    } catch (err) {
      this.log("error", `Could not save the run to disk: ${(err as Error).message}`);
    }
  }

  // Producers ---------------------------------------------------------------

  private context(sourceId: string): ExpandContext {
    const { plan } = this.record;
    return {
      limits: plan.limits,
      signal: this.abort.signal,
      full: () => this.record.items.length >= plan.limits.maxItems,
      add: (draft: ItemDraft) => {
        if (this.record.items.length >= plan.limits.maxItems) return null;
        const item: Item = { ...draft, id: this.record.items.length, sourceId, status: "queued", chars: 0 };
        this.record.items.push(item);
        const s = this.record.sources.find((x) => x.id === sourceId);
        if (s) s.found++;
        this.sourcesDirty = true;
        this.pending.set(item.id, toClient(item));
        return item;
      },
      ready: (item, text, p) => {
        item.text = text;
        this.patch(item, { ...p, status: "ready", chars: text.length, snippet: text.slice(0, SNIPPET) });
        this.record.metrics.fetched++;
        this.queue.push(item);
        this.wake.shift()?.();
      },
      patch: (item, p) => this.patch(item, p),
      fail: (item, error) => this.patch(item, { status: "error", error }),
      skip: (item, reason) => this.patch(item, { status: "skipped", error: reason }),
      log: (level, msg) => this.log(level, msg),
    };
  }

  private async produce() {
    const sources = this.record.plan.sources;
    let next = 0;
    const runOne = async () => {
      while (next < sources.length && !this.abort.signal.aborted) {
        const spec = sources[next++];
        if (this.record.items.length >= this.record.plan.limits.maxItems) {
          this.setSource(spec.id, { state: "done" });
          continue;
        }
        this.setSource(spec.id, { state: "active" });
        try {
          await expandSource(spec, this.context(spec.id));
          this.setSource(spec.id, { state: "done" });
        } catch (err) {
          if (this.abort.signal.aborted) break;
          const msg = (err as Error).message;
          this.setSource(spec.id, { state: "error", error: msg });
          this.log("error", `${spec.label}: ${msg}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, runOne));
    if (this.record.items.length >= this.record.plan.limits.maxItems) {
      this.log("info", `Reached the ${this.record.plan.limits.maxItems}-item cap.`);
    }
  }

  // Judges ------------------------------------------------------------------

  private async nextBatch(size: number): Promise<Item[] | null> {
    for (;;) {
      if (this.abort.signal.aborted) return null;
      if (this.queue.length) return this.queue.splice(0, size);
      if (this.producersDone) return null;
      await new Promise<void>((r) => this.wake.push(r));
    }
  }

  private async worker() {
    const size = this.record.plan.limits.itemsPerCall;
    for (;;) {
      const batch = await this.nextBatch(size);
      if (!batch) return;
      await this.judge(batch);
    }
  }

  private async judge(batch: Item[]) {
    const { plan } = this.record;
    const qs = questionsFor(plan);
    const packed = batch.length > 1;
    const questions: Record<string, JevQuestion> = {};
    let state: string;
    if (packed) {
      state = batch.map((it, i) => `=== ITEM ${i + 1} ===\n${stateFor(it, plan)}`).join("\n\n");
      batch.forEach((_, i) => {
        for (const q of qs) {
          questions[`i${i + 1}_${q.key}`] = { ...q.q, instructions: `Look only at ITEM ${i + 1} in the state. ${q.q.instructions}` };
        }
      });
    } else {
      state = stateFor(batch[0], plan);
      for (const q of qs) questions[q.key] = q.q;
    }

    for (const it of batch) this.patch(it, { status: "judging" });
    const m = this.record.metrics;
    m.jev.inFlight++;
    try {
      const r = await jevAsk(this.cfg, state, questions, { signal: this.abort.signal });
      this.consecutiveFailures = 0;
      m.jev.calls++;
      if (m.jev.calls === 1) {
        this.log(
          "info",
          r.tokensEstimated
            ? `First Jev answer in ${r.ms} ms. It carried no token usage, so spend is estimated from request size.`
            : `First Jev answer in ${r.ms} ms from ${r.model ?? this.cfg.model}. Spend is metered from reported input tokens.`,
        );
      }
      m.jev.inputTokens += r.inputTokens;
      m.jev.throttled += r.throttled;
      if (r.model) m.jev.model = r.model;
      const spend = costUsd(r.inputTokens, this.cfg.usdPerMillionInput);
      m.jev.costUsd += spend;
      this.tokensJudged += r.inputTokens;
      this.latencies.push(r.ms);
      if (this.latencies.length > 600) this.latencies.splice(0, this.latencies.length - 600);

      batch.forEach((it, i) => {
        const prefix = packed ? `i${i + 1}_` : "";
        const gate = readAnswer("noul", r.answers[`${prefix}gate`]);
        if (!gate) {
          this.patch(it, { status: "error", error: "Jev returned no answer for the gate question." });
          return;
        }
        const answers: Record<string, Answer> = {};
        const panel: Record<string, number> = {};
        let answered = 1;
        for (const q of qs) {
          if (q.kind === "gate") continue;
          const a = readAnswer(q.q.type, r.answers[`${prefix}${q.key}`]);
          if (!a) continue;
          answered++;
          if (q.kind === "dim") answers[q.ref] = a;
          else panel[q.ref] = a.v as number;
        }
        m.judgments += answered;
        const p = gate.v as number;
        const band = bandOf(p, plan.thresholds);
        const personas = Object.values(panel);
        const appeal = personas.length ? personas.filter((v) => v >= 0.5).length / personas.length : undefined;
        this.patch(it, {
          status: "judged",
          p,
          band,
          finalBand: band,
          answers,
          panel: personas.length ? panel : undefined,
          appeal,
          ms: r.ms,
        });
        this.perSecond[Math.floor((Date.now() - this.startedAt) / 1000)] =
          (this.perSecond[Math.floor((Date.now() - this.startedAt) / 1000)] ?? 0) + 1;
      });
    } catch (err) {
      if (this.abort.signal.aborted) {
        for (const it of batch) if (it.status === "judging") this.patch(it, { status: "ready" });
        return;
      }
      const e = err as JevError;
      for (const it of batch) this.patch(it, { status: "error", error: `Jev: ${e.message}` });
      this.consecutiveFailures++;
      if (e.fatal || this.consecutiveFailures >= 15) {
        this.log("error", `Jev failed ${e.fatal ? "with a fatal error" : "15 times in a row"}: ${e.message}. Stopping the run.`);
        this.abort.abort();
        this.wakeAll();
      } else if (this.consecutiveFailures === 1) {
        this.log("warn", `Jev error: ${e.message}`);
      }
    } finally {
      m.jev.inFlight--;
    }
  }

  // Claude review of the uncertain band --------------------------------------

  async reviewUncertain(max: number, ids?: number[]): Promise<void> {
    const route = await claudeRoute();
    if (!route) {
      this.log("warn", "Uncertain band not reviewed: no Claude route (set ANTHROPIC_API_KEY or install the claude CLI).");
      return;
    }
    const { plan } = this.record;
    const picked = this.record.items
      .filter((it) => it.status === "judged" && !it.review && it.text && (ids ? ids.includes(it.id) : it.band === "uncertain"))
      .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
      .slice(0, max);
    if (!picked.length) return;
    this.record.phase = "reviewing";
    this.record.metrics.reviewQueue = picked.length;
    this.log("info", `Claude is reviewing ${picked.length} uncertain ${picked.length === 1 ? plan.unit.singular : plan.unit.plural}.`);

    const batches: Item[][] = [];
    for (let i = 0; i < picked.length; i += 8) batches.push(picked.slice(i, i + 8));
    let next = 0;
    const m = this.record.metrics;
    const runOne = async () => {
      while (next < batches.length && !this.abort.signal.aborted) {
        const batch = batches[next++];
        const prompt = [
          `Mission: ${plan.mission}`,
          `Gate question: ${plan.gate.instructions}`,
          "",
          ...batch.map((it) => `[id ${it.id}]\n${stateFor({ ...it, text: (it.text ?? "").slice(0, 2500) }, plan)}`),
        ].join("\n\n");
        try {
          const r = await askClaude({ system: REVIEW_SYSTEM, prompt, schema: ReviewSchema, route, signal: this.abort.signal });
          m.claude.calls++;
          m.claude.costUsd += r.costUsd;
          for (const res of r.data.results) {
            const it = batch.find((b) => b.id === res.id);
            if (!it) continue;
            this.patch(it, {
              review: { verdict: res.verdict, reason: res.reason, by: "claude", model: r.model },
              finalBand: res.verdict,
            });
          }
        } catch (err) {
          if (this.abort.signal.aborted) return;
          this.log("warn", `Claude review batch failed: ${(err as Error).message}`);
        }
        m.reviewQueue = Math.max(0, m.reviewQueue - batch.length);
      }
    };
    await Promise.all([runOne(), runOne()]);
    m.reviewQueue = 0;
  }

  /**
   * Claude's second stage on chosen candidates: a 1-3 score, the reason, and
   * outreach context, stored on each item for the outreach sheet.
   */
  async qualify(ids: number[]): Promise<void> {
    if (this.running) throw new Error("run is still going");
    const route = await claudeRoute();
    if (!route) throw new Error("No Claude route: set ANTHROPIC_API_KEY or install the claude CLI.");
    this.frozen = true;
    this.abort = new AbortController();
    this.record.status = "running";
    this.record.phase = "reviewing";
    this.timers.push(setInterval(() => this.flush(), 120));
    this.timers.push(setInterval(() => this.publishMetrics(), 400));
    this.timers.push(setInterval(() => void this.persist(), 15_000));
    const { plan } = this.record;
    const picked = ids.map((id) => this.record.items[id]).filter((it): it is Item => Boolean(it) && it.status === "judged");
    this.log("info", `Claude is qualifying ${picked.length} ${picked.length === 1 ? plan.unit.singular : plan.unit.plural} for outreach.`);
    const batches: Item[][] = [];
    for (let i = 0; i < picked.length; i += 10) batches.push(picked.slice(i, i + 10));
    let next = 0;
    const m = this.record.metrics;
    const describe = (it: Item) => {
      const answers = plan.dimensions
        .map((d) => {
          const a = it.answers?.[d.key];
          if (!a) return null;
          return `${d.label}: ${d.type === "noul" ? `${Math.round((a.v as number) * 100)}% yes` : d.type === "score" ? (d.levels?.[Math.round(a.v as number)] ?? a.v) : String(a.v)}`;
        })
        .filter(Boolean)
        .join("; ");
      return [`[id ${it.id}]`, stateFor({ ...it, text: (it.text ?? "").slice(0, 1500) }, plan), `Jev: P(yes) ${it.p?.toFixed(2)}${answers ? `; ${answers}` : ""}`].join("\n");
    };
    const runOne = async () => {
      while (next < batches.length && !this.abort.signal.aborted) {
        const batch = batches[next++];
        const prompt = [`Mission:\n${plan.mission}`, "", "Candidates:", ...batch.map(describe)].join("\n\n");
        try {
          const r = await askClaude({ system: QUALIFY_SYSTEM, prompt, schema: QualifySchema, route, signal: this.abort.signal });
          m.claude.calls++;
          m.claude.costUsd += r.costUsd;
          for (const res of r.data.results) {
            const it = batch.find((b) => b.id === res.id);
            if (it) this.patch(it, { qual: { score: res.score as 1 | 2 | 3, why: res.why, context: res.context, model: r.model } });
          }
        } catch (err) {
          if (this.abort.signal.aborted) return;
          this.log("warn", `Claude qualification batch failed: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all([runOne(), runOne()]);
    const scored = picked.filter((it) => it.qual);
    this.log("info", `Qualified ${scored.length}: ${scored.filter((it) => it.qual!.score === 3).length} strong, ${scored.filter((it) => it.qual!.score === 2).length} plausible, ${scored.filter((it) => it.qual!.score === 1).length} weak.`);
    await this.finish("done");
  }

  /** Review more of the uncertain band after the run finished. */
  async reviewLater(ids?: number[], max = 50): Promise<void> {
    if (this.running) throw new Error("run is still going");
    // The run already has its final clock and rate history; a review afterwards must not rewrite them.
    this.frozen = true;
    this.abort = new AbortController();
    this.record.status = "running";
    this.timers.push(setInterval(() => this.flush(), 120));
    this.timers.push(setInterval(() => this.publishMetrics(), 400));
    this.timers.push(setInterval(() => void this.persist(), 15_000));
    await this.reviewUncertain(max, ids);
    await this.finish("done");
  }

  // Metrics -----------------------------------------------------------------

  private publishMetrics() {
    const { plan, items } = this.record;
    const m = this.record.metrics;
    if (!this.frozen) {
      const now = this.record.finishedAt && !this.running ? Date.parse(this.record.finishedAt) : Date.now();
      m.elapsedMs = now - this.startedAt;
    }
    m.discovered = items.length;

    const bands: Record<Band, number> = { match: 0, uncertain: 0, reject: 0 };
    const hist = Array(20).fill(0);
    const dims: Record<string, Record<string, number>> = {};
    const panelYes: Record<string, number> = {};
    const domains = new Set<string>();
    const fieldSets = plan.entityFields.map(() => new Set<string>());
    let judged = 0;
    let errors = 0;
    let skipped = 0;
    let reviewed = 0;

    for (const it of items) {
      if (it.domain) domains.add(it.domain);
      plan.entityFields.forEach((f, i) => {
        const v = it.fields?.[f]?.trim();
        if (v) fieldSets[i].add(v.toLowerCase());
      });
      if (it.status === "error") errors++;
      if (it.status === "skipped") skipped++;
      if (it.status !== "judged") continue;
      judged++;
      const band = it.finalBand ?? it.band!;
      bands[band]++;
      if (it.review) reviewed++;
      hist[Math.min(19, Math.floor((it.p ?? 0) * 20))]++;
      for (const d of plan.dimensions) {
        const a = it.answers?.[d.key];
        if (!a) continue;
        const bucket = (dims[d.key] ??= {});
        const label =
          d.type === "choice" ? String(a.v) : d.type === "noul" ? ((a.v as number) >= 0.5 ? "yes" : "no") : String(Math.round(a.v as number));
        bucket[label] = (bucket[label] ?? 0) + 1;
      }
      for (const [k, v] of Object.entries(it.panel ?? {})) if (v >= 0.5) panelYes[k] = (panelYes[k] ?? 0) + 1;
    }

    m.judged = judged;
    m.errors = errors;
    m.skipped = skipped;
    m.bands = bands;
    m.reviewed = reviewed;
    m.histogram = hist;
    m.dimensions = dims;
    m.panelYes = panelYes;
    m.entities = [
      ...plan.entityFields.map((f, i) => ({ label: f, count: fieldSets[i].size })),
      ...(domains.size ? [{ label: "sites", count: domains.size }] : []),
    ];

    const sorted = [...this.latencies].sort((a, b) => a - b);
    m.jev.p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
    m.jev.p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;

    if (!this.frozen) {
      const sec = Math.floor(m.elapsedMs / 1000);
      const window = Math.min(5, Math.max(1, sec));
      let recent = 0;
      for (let s = sec - window; s < sec; s++) recent += this.perSecond[s] ?? 0;
      m.perSec = this.running ? recent / window : 0;
      m.peakPerSec = Math.max(m.peakPerSec, m.perSec);
      const span = Math.min(60, sec + 1);
      m.rate = Array.from({ length: span }, (_, i) => this.perSecond[sec - span + 1 + i] ?? 0);
    } else {
      m.perSec = 0;
    }

    const perItem = judged ? m.jev.costUsd / judged : 0;
    const remaining = Math.max(0, items.length - judged - errors - skipped);
    m.projectedCostUsd = m.jev.costUsd + m.claude.costUsd + perItem * remaining;
    const questionsPerItem = 1 + plan.dimensions.length + (plan.panel?.personas.length ?? 0);
    const tokensPerItem = judged ? this.tokensJudged / Math.max(1, judged) : 0;
    m.llmEquivalentUsd =
      (judged * ((tokensPerItem + LLM_BASELINE.overheadTokens) * LLM_BASELINE.input + questionsPerItem * LLM_BASELINE.outputTokensPerQuestion * LLM_BASELINE.output)) /
      1_000_000;

    this.emit({ t: "metrics", metrics: { ...m, jev: { ...m.jev }, claude: { ...m.claude } }, phase: this.record.phase, status: this.record.status });
  }

  setSpotCheck(labels: Record<string, boolean>) {
    this.record.spotCheck = { ...this.record.spotCheck, ...labels };
    void this.persist();
  }
}

function toClient(it: Item): ClientItem {
  const { text: _text, ...rest } = it;
  return rest;
}

// Registry ------------------------------------------------------------------

const g = globalThis as unknown as { __jevRuns?: Map<string, RunEngine> };
const runs = (g.__jevRuns ??= new Map());

export function launch(plan: Plan): RunEngine {
  const engine = RunEngine.create(plan);
  runs.set(engine.id, engine);
  void engine.start();
  return engine;
}

export function liveRun(id: string): RunEngine | undefined {
  return runs.get(id);
}

export async function engineFor(id: string): Promise<RunEngine | null> {
  const live = runs.get(id);
  if (live) return live;
  const record = await loadRun(id);
  if (!record) return null;
  if (record.status === "running") {
    // The server restarted mid-run. The run cannot resume, so close it out honestly.
    record.status = "error";
    record.phase = "finished";
    record.logs.push({ at: Date.now(), level: "error", msg: "The server restarted while this run was going. Results up to that point are kept." });
  }
  const engine = RunEngine.hydrate(record);
  runs.set(id, engine);
  return engine;
}

/**
 * Saved run summaries, with the registry's status where it knows better: a qualify or review saves
 * its status only every few seconds, and a run cut off by a restart still says "running" on disk.
 */
export async function recentRuns(limit?: number): Promise<RunMeta[]> {
  return (await listRuns(limit)).map((meta) => {
    const live = runs.get(meta.id);
    const status = live ? live.record.status : meta.status === "running" ? "error" : meta.status;
    return status === meta.status ? meta : { ...meta, status };
  });
}
