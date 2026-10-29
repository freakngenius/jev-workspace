export type Band = "match" | "uncertain" | "reject";

/** skipped: gathered but not worth a call, such as a second URL that lands on a page already queued. */
export type ItemStatus = "queued" | "fetching" | "ready" | "judging" | "judged" | "error" | "skipped";

export type SourceKind = "site" | "page" | "sitemap" | "feed" | "table" | "pdf" | "text";

export type PlannerProvider = "anthropic" | "claude-cli" | "ollama" | "template";

export type RunStatus = "running" | "done" | "stopped" | "error";

export type Phase = "starting" | "running" | "reviewing" | "finished";

export interface SourceSpec {
  id: string;
  label: string;
  url?: string;
  uploadId?: string;
  /** Several uploaded files read as one source, one item per file (HTML pages dropped together). */
  uploadIds?: string[];
  /** For uploads: what the file is, e.g. "html". */
  fileType?: string;
  /** Items the sniff expects this source to yield, when it could count them. */
  count?: number;
  /** Account tables (a follower-tool CSV, a bio export) merged into the accounts by handle. */
  tableUploadIds?: string[];
  /** Instagram DM threads, read locally for message counts and dates. */
  dmUploadIds?: string[];
  kind: SourceKind;
  crawl: boolean;
  title?: string;
  columns?: string[];
  sampleRows?: Record<string, string>[];
  note?: string;
}

export interface Unit {
  singular: string;
  plural: string;
}

export type QuestionType = "noul" | "choice" | "score";

/** One extra typed question asked about every item, next to the gate. */
export interface Dimension {
  key: string;
  label: string;
  type: QuestionType;
  instructions: string;
  options?: { key: string; description: string }[];
  levels?: string[];
}

export interface Persona {
  key: string;
  label: string;
  description: string;
}

/** A simulated audience: every persona answers the same yes/no about every item. */
export interface Panel {
  action: string;
  personas: Persona[];
}

export interface Limits {
  maxItems: number;
  maxPagesPerSite: number;
  crawlDepth: number;
  concurrency: number;
  itemsPerCall: number;
  maxCharsPerItem: number;
}

export interface Plan {
  title: string;
  mission: string;
  /** One sentence for dashboards; the full mission stays one click away. */
  summary?: string;
  unit: Unit;
  gate: { instructions: string };
  dimensions: Dimension[];
  panel: Panel | null;
  entityFields: string[];
  thresholds: { yes: number; no: number };
  limits: Limits;
  review: { enabled: boolean; max: number };
  sources: SourceSpec[];
  notes: string[];
  planner: { provider: PlannerProvider; model: string | null; ms: number; costUsd: number };
}

/** Claude's second-stage read of one candidate, for outreach. */
export interface Qualification {
  score: 1 | 2 | 3;
  why: string;
  context: string;
  model: string | null;
}

export interface Review {
  verdict: "match" | "reject";
  reason: string;
  by: "claude";
  model: string | null;
}

/** noul: v is P(yes). choice: v is the option key, c its confidence. score: v is the level position, 0 = lowest. */
export interface Answer {
  v: number | string;
  c?: number;
}

/** An item as the browser sees it: no full text, only a snippet. */
export interface ClientItem {
  id: number;
  sourceId: string;
  title: string;
  url?: string;
  domain?: string;
  locator?: string;
  snippet?: string;
  chars: number;
  fields?: Record<string, string>;
  status: ItemStatus;
  p?: number;
  band?: Band;
  finalBand?: Band;
  answers?: Record<string, Answer>;
  panel?: Record<string, number>;
  appeal?: number;
  ms?: number;
  error?: string;
  review?: Review;
  qual?: Qualification;
}

export interface Item extends ClientItem {
  text?: string;
}

export type ItemPatch = Partial<ClientItem> & { id: number };

export interface SourceProgress {
  id: string;
  label: string;
  kind: SourceKind;
  state: "waiting" | "active" | "done" | "error";
  found: number;
  error?: string;
}

export interface Metrics {
  elapsedMs: number;
  discovered: number;
  fetched: number;
  judged: number;
  errors: number;
  skipped: number;
  bands: Record<Band, number>;
  reviewed: number;
  reviewQueue: number;
  entities: { label: string; count: number }[];
  judgments: number;
  people: number;
  jev: { calls: number; inputTokens: number; costUsd: number; p50: number; p95: number; inFlight: number; throttled: number; model: string | null };
  claude: { calls: number; costUsd: number };
  perSec: number;
  peakPerSec: number;
  rate: number[];
  projectedCostUsd: number;
  llmEquivalentUsd: number;
  histogram: number[];
  dimensions: Record<string, Record<string, number>>;
  panelYes: Record<string, number>;
}

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface JevProviderInfo {
  name: "typesafe" | "openrouter" | "custom";
  model: string;
  usdPerMillionInput: number;
  requestsPerMinute: number;
}

export interface RunSnapshot {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: RunStatus;
  phase: Phase;
  plan: Plan;
  jev: JevProviderInfo;
  items: ClientItem[];
  sources: SourceProgress[];
  metrics: Metrics;
  logs: LogLine[];
  spotCheck: Record<string, boolean>;
}

export interface RunMeta {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: RunStatus;
  title: string;
  mission: string;
  unit: Unit;
  judged: number;
  bands: Record<Band, number>;
  costUsd: number;
  elapsedMs: number;
}

export type RunEvent =
  | { t: "snapshot"; run: RunSnapshot }
  | { t: "items"; items: ItemPatch[] }
  | { t: "sources"; sources: SourceProgress[] }
  | { t: "metrics"; metrics: Metrics; phase: Phase; status: RunStatus }
  | { t: "log"; line: LogLine }
  | { t: "done"; status: RunStatus; finishedAt: string };
