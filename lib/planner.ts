import { z } from "zod";
import { askClaude, claudeRoute, jsonSchema } from "./claude";
import { firstSentence } from "./text";
import type { Dimension, Limits, Persona, Plan, PlannerProvider, SourceSpec, Unit } from "./types";

/**
 * Turns a mission into typed Jev questions. Claude drafts when a route
 * exists, Ollama drafts locally when chosen, and a template is the last
 * resort. Every draft is validated and normalized here, because a model can
 * return schema-valid JSON that is still useless, and the user edits the plan
 * before launch.
 */

const DraftSchema = z.object({
  title: z.string().describe("3 to 6 word name for the mission"),
  summary: z.string().describe("one sentence of at most 25 words saying what this mission looks for, shown under the title on the dashboard"),
  unit_singular: z.string().describe("what one item is, singular, lowercase, e.g. page, ad, lead, post"),
  unit_plural: z.string(),
  gate: z
    .string()
    .describe("the primary yes/no question; yes means the item is what the mission wants"),
  dimensions: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().describe("short column label, 1 to 3 words"),
        type: z.enum(["noul", "choice", "score"]),
        instructions: z.string(),
        options: z
          .array(z.object({ key: z.string(), description: z.string() }))
          .describe("choice only: 3 to 8 mutually exclusive options; empty for noul and score"),
        levels: z.array(z.string()).describe("score only: 3 to 5 levels, lowest first; empty otherwise"),
      }),
    )
    .describe("0 to 6 extra questions"),
  panel_action: z
    .string()
    .describe("only when the mission is about audience reaction: a verb phrase like 'click this ad'; else empty"),
  personas: z
    .array(z.object({ key: z.string(), label: z.string(), description: z.string() }))
    .describe("0, or 5 to 30 distinct audience personas when panel_action is set"),
  entity_fields: z
    .array(z.string())
    .describe("table columns that identify an account, brand, company or person, to count distinct values"),
  max_items: z.number().int().describe("how many items this mission needs, 10 to 5000"),
  match_at: z
    .number()
    .describe("P(yes) a match needs: 0.8 when each item carries enough evidence to verify the gate, 0.6 for discovery over thin items such as handles, titles or one-line rows"),
  notes: z.array(z.string()).describe("0 to 3 short caveats the user should know before launch"),
});

type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You design classification plans for Jev, a System One model from TypeSafe. Jev never writes text. It answers typed questions about one item at a time:
- noul: the probability that the answer is yes.
- choice: one option from a fixed list, each option with a description.
- score: a position on an ordered rubric, lowest level first.

Code gathers the items (web pages, ads, table rows, feed posts, PDF pages). Your plan says what Jev asks about each item.

Know what each item carries before writing questions. The sources list shows columns and sample rows; that is everything Jev will see. Never ask about evidence the items do not contain.

Rules for every question:
- Make it operationally testable. A knowledgeable person could settle it by looking at the item for ten seconds. Put the concrete criteria inside the question.
- Frame it in the direction of what you want to detect. To find risky items, ask whether the item is risky, never whether it is safe.
- Decompose. Several specific questions beat one broad rating.
- It must be answerable from the item alone: no comparisons with other items, no outside lookups, no counting across items.
- Write plain, complete English sentences.

The gate is the primary yes/no question. Yes means the item belongs in the results for this mission.
- The gate asks one thing. Never join two requirements with "and", "both" or "as well as": each extra requirement becomes its own yes/no dimension, so one missing signal does not sink the whole item.
- Never ask Jev to read a value that code can check exactly, such as a column equal to Yes or No, a number, or which list an item is on. The item already shows those values and the results page can filter on them. Ask about meaning instead.
- When items carry little evidence (a handle and a date, a title, a one-line row), no item can prove fit. Make the gate a plausibility check ("worth a closer look because it plausibly is ..."), set match_at to 0.6, and say in the notes that kept items need confirmation later.
- Steps the mission gives to other tools (writing to a database, sending messages, researching the web, deduping) are outside Jev. Mention them in the notes; never turn them into questions.
Dimensions are optional extra questions that give the breakdown the mission asks for. For example, an ad teardown asks the hook type, format, offer, call to action and awareness stage as choice questions. Choice options are mutually exclusive, 3 to 8 of them, with an "other" or "none" option when natural.
Use a panel only when the mission is about how an audience would react (ads, messaging, content, product ideas). Each persona gets the same yes/no question about the action, so write concrete personas: age, role, situation, motivation.
Entity fields only name columns that exist in the table sources shown.
Keys are lowercase snake_case, unique, at most 24 characters.`;

export interface PlanRequest {
  mission: string;
  sources: SourceSpec[];
  planner?: PlannerProvider | "auto";
}

export async function availablePlanners(): Promise<PlannerProvider[]> {
  const out: PlannerProvider[] = [];
  const route = await claudeRoute();
  if (route) out.push(route);
  if (await ollamaModel()) out.push("ollama");
  out.push("template");
  return out;
}

export async function makePlan(req: PlanRequest, signal?: AbortSignal): Promise<Plan> {
  const available = await availablePlanners();
  const wanted = req.planner && req.planner !== "auto" ? req.planner : available[0];
  const provider = available.includes(wanted) ? wanted : available[0];
  const prompt = userPrompt(req.mission, req.sources);
  const notes: string[] = [];

  // A failed draft falls straight to the template, with the reason in the notes. Falling back
  // to a local model instead would leave the user watching a spinner for minutes.
  if (provider === "anthropic" || provider === "claude-cli") {
    try {
      const r = await askClaude({ system: SYSTEM, prompt, schema: DraftSchema, route: provider, signal });
      return normalize(r.data, req, { provider, model: r.model, ms: r.ms, costUsd: r.costUsd }, notes);
    } catch (err) {
      notes.push(`Claude could not draft the plan: ${(err as Error).message}`);
    }
  } else if (provider === "ollama") {
    const model = await ollamaModel();
    if (model) {
      try {
        const started = performance.now();
        const draft = await viaOllama(model, prompt, signal);
        const ms = Math.round(performance.now() - started);
        return normalize(draft, req, { provider: "ollama", model, ms, costUsd: 0 }, notes);
      } catch (err) {
        notes.push(`The local model could not draft the plan: ${(err as Error).message}`);
      }
    }
  }
  return templatePlan(req, notes);
}

function userPrompt(mission: string, sources: SourceSpec[]): string {
  const lines = [`Mission: ${mission.trim()}`, "", "Sources:"];
  for (const s of sources) {
    const mode = s.crawl ? (s.kind === "feed" ? " (each entry's linked page is read)" : " (the site is crawled)") : "";
    lines.push(`- [${s.id}] ${s.kind}${mode}: ${s.label}${s.title ? ` — "${s.title}"` : ""}${s.note ? ` (${s.note})` : ""}`);
    if (s.columns?.length) lines.push(`  columns: ${s.columns.join(", ")}`);
    for (const r of s.sampleRows ?? []) lines.push(`  sample row: ${JSON.stringify(r)}`);
  }
  if (!sources.length) lines.push("- none yet");
  return lines.join("\n");
}

const OLLAMA_PREFERRED = ["gpt-oss:20b", "qwen3:32b", "qwen3:14b", "llama3.1:8b"];

async function ollamaModel(): Promise<string | null> {
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const names = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    const wanted = process.env.OLLAMA_MODEL;
    if (wanted) return names.includes(wanted) ? wanted : null;
    return OLLAMA_PREFERRED.find((m) => names.includes(m)) ?? null;
  } catch {
    return null;
  }
}

async function viaOllama(model: string, prompt: string, signal?: AbortSignal): Promise<Draft> {
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const timeout = AbortSignal.timeout(180_000);
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({
      model,
      stream: false,
      format: jsonSchema(DraftSchema),
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
  const parsed = DraftSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error("draft did not match the schema");
  return parsed.data;
}

export function slug(s: string, fallback: string): string {
  const k = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return k || fallback;
}

function uniqueKeys<T extends { key: string }>(list: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return list.map((x, i) => {
    let k = slug(x.key, `${prefix}${i + 1}`);
    while (seen.has(k)) k = `${k.slice(0, 21)}_${i + 1}`;
    seen.add(k);
    return { ...x, key: k };
  });
}

/** Files the user dropped are all meant to be judged: the item cap grows to cover every counted entry. */
function coverCounted(limits: Limits, sources: SourceSpec[]): Limits {
  const counted = sources.reduce((a, s) => a + (s.uploadId || s.uploadIds ? (s.count ?? 0) : 0), 0);
  return counted > limits.maxItems ? { ...limits, maxItems: Math.min(20000, counted) } : limits;
}

/** The planner's match bar, kept between 0.5 and 0.95; anything unreadable falls back to the strict 0.8. */
export function matchBar(v: number): number {
  return Math.round(Math.min(0.95, Math.max(0.5, Number.isFinite(v) ? v : 0.8)) * 100) / 100;
}

export function defaultLimits(maxItems = 500): Limits {
  return {
    maxItems: clampInt(maxItems, 10, 5000),
    maxPagesPerSite: 80,
    crawlDepth: 2,
    concurrency: 12,
    itemsPerCall: 1,
    maxCharsPerItem: 6000,
  };
}

function normalize(d: Draft, req: PlanRequest, planner: Plan["planner"], notes: string[]): Plan {
  const dropped: string[] = [];
  const dims: Dimension[] = uniqueKeys(d.dimensions, "q")
    .map((x): Dimension | null => {
      const base = { key: x.key, label: x.label.trim().slice(0, 32) || x.key, type: x.type, instructions: x.instructions.trim() };
      if (!usableQuestion(base.instructions)) return null;
      if (x.type === "choice") {
        const options = uniqueKeys(x.options.filter((o) => o.description.trim() || o.key.trim()), "opt").slice(0, 8);
        return options.length >= 2 ? { ...base, options } : null;
      }
      if (x.type === "score") {
        const levels = x.levels.map((l) => l.trim()).filter(Boolean).slice(0, 7);
        return levels.length >= 2 ? { ...base, levels } : null;
      }
      return base;
    })
    .filter((x, i): x is Dimension => {
      if (!x) dropped.push(d.dimensions[i]?.label || `question ${i + 1}`);
      return x !== null;
    })
    .slice(0, 6);
  if (dropped.length) notes.push(`Dropped malformed questions: ${dropped.join(", ")}.`);

  const personas: Persona[] = uniqueKeys(d.personas.filter((p) => p.description.trim().length >= 10), "persona")
    .slice(0, 30)
    .map((p) => ({ key: p.key, label: p.label.trim().slice(0, 40) || p.key, description: p.description.trim() }));
  const panel = d.panel_action.trim() && personas.length >= 2 ? { action: d.panel_action.trim(), personas } : null;

  const columns = new Set(req.sources.flatMap((s) => s.columns ?? []));
  const entityFields = [...new Set(d.entity_fields.filter((f) => columns.has(f)))].slice(0, 3);
  const unit: Unit = {
    singular: d.unit_singular.trim().toLowerCase().slice(0, 40) || "item",
    plural: d.unit_plural.trim().toLowerCase().slice(0, 40) || "items",
  };
  let gate = d.gate.trim();
  if (!usableQuestion(gate)) {
    notes.push("The drafted gate question was unusable, so a template question replaced it. Rewrite it before launch.");
    gate = templateGate(req.mission, unit);
  }
  return {
    title: d.title.trim().slice(0, 60) || req.mission.slice(0, 60),
    mission: req.mission.trim(),
    summary: d.summary.trim().slice(0, 240) || firstSentence(req.mission),
    unit,
    gate: { instructions: gate },
    dimensions: dims,
    panel,
    entityFields,
    thresholds: { yes: matchBar(d.match_at), no: 0.2 },
    limits: coverCounted(defaultLimits(d.max_items), req.sources),
    review: { enabled: true, max: 25 },
    sources: req.sources,
    notes: [...notes, ...d.notes.map((n) => n.trim().slice(0, 240)).filter(Boolean).slice(0, 3)],
    planner,
  };
}

/** A question worth sending: a real sentence, not a type name or a placeholder a model copied. */
export function usableQuestion(q: string): boolean {
  const t = q.trim();
  if (t.length < 15 || t.split(/\s+/).length < 4) return false;
  return !/^(noul|choice|score|yes\/no|question|string|todo|tbd)\b/i.test(t);
}

function templateGate(mission: string, unit: Unit): string {
  return `Does this ${unit.singular} directly satisfy the following goal: "${mission.trim()}"? Answer yes only when the ${unit.singular} itself clearly shows it.`;
}

export function templatePlan(req: PlanRequest, notes: string[] = []): Plan {
  const kinds = new Set(req.sources.map((s) => s.kind));
  const unit: Unit =
    kinds.size === 1 && kinds.has("table")
      ? { singular: "row", plural: "rows" }
      : kinds.size === 1 && kinds.has("feed")
        ? { singular: "post", plural: "posts" }
        : kinds.size === 1 && kinds.has("text")
          ? { singular: "section", plural: "sections" }
          : [...kinds].every((k) => k === "site" || k === "page" || k === "sitemap" || k === "pdf")
            ? { singular: "page", plural: "pages" }
            : { singular: "item", plural: "items" };
  return {
    title: req.mission.trim().split(/\s+/).slice(0, 6).join(" "),
    mission: req.mission.trim(),
    summary: firstSentence(req.mission),
    unit,
    gate: { instructions: templateGate(req.mission, unit) },
    dimensions: [],
    panel: null,
    entityFields: [],
    thresholds: { yes: 0.8, no: 0.2 },
    limits: coverCounted(defaultLimits(), req.sources),
    review: { enabled: false, max: 25 },
    sources: req.sources,
    notes: [...notes, "Template plan: no planner model was available. Rewrite the gate as a concrete yes/no check before launch."],
    planner: { provider: "template", model: null, ms: 0, costUsd: 0 },
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.round(Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)));
}

/** Validates a plan coming back from the browser after the user edited it. */
export const PlanSchema = z.object({
  title: z.string().min(1).max(80),
  mission: z.string().min(1).max(8000),
  summary: z.string().max(400).optional(),
  unit: z.object({ singular: z.string().min(1).max(40), plural: z.string().min(1).max(40) }),
  gate: z.object({ instructions: z.string().min(8).max(2000) }),
  dimensions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{1,24}$/),
        label: z.string().min(1).max(40),
        type: z.enum(["noul", "choice", "score"]),
        instructions: z.string().min(4).max(2000),
        options: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,24}$/), description: z.string().max(500) })).optional(),
        levels: z.array(z.string().min(1).max(300)).optional(),
      }),
    )
    .max(8),
  panel: z
    .object({
      action: z.string().min(2).max(200),
      personas: z
        .array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,24}$/), label: z.string().min(1).max(60), description: z.string().min(2).max(600) }))
        .min(2)
        .max(40),
    })
    .nullable(),
  entityFields: z.array(z.string().max(120)).max(5),
  thresholds: z.object({ yes: z.number().min(0.5).max(1), no: z.number().min(0).max(0.5) }),
  limits: z.object({
    maxItems: z.number().int().min(1).max(20000),
    maxPagesPerSite: z.number().int().min(1).max(5000),
    crawlDepth: z.number().int().min(0).max(5),
    concurrency: z.number().int().min(1).max(64),
    itemsPerCall: z.number().int().min(1).max(8),
    maxCharsPerItem: z.number().int().min(200).max(60000),
  }),
  review: z.object({ enabled: z.boolean(), max: z.number().int().min(0).max(500) }),
  sources: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        url: z.string().optional(),
        uploadId: z.string().optional(),
        uploadIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{8,64}$/)).max(500).optional(),
        fileType: z.string().max(20).optional(),
        count: z.number().int().min(0).optional(),
        tableUploadIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{8,64}$/)).max(50).optional(),
        dmUploadIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{8,64}$/)).max(20000).optional(),
        kind: z.enum(["site", "page", "sitemap", "feed", "table", "pdf", "text"]),
        crawl: z.boolean(),
        title: z.string().optional(),
        columns: z.array(z.string()).optional(),
        sampleRows: z.array(z.record(z.string(), z.string())).optional(),
        note: z.string().optional(),
      }),
    )
    .min(1, "Add at least one link or file."),
  notes: z.array(z.string()),
  planner: z.object({
    provider: z.enum(["anthropic", "claude-cli", "ollama", "template"]),
    model: z.string().nullable(),
    ms: z.number(),
    costUsd: z.number(),
  }),
});
