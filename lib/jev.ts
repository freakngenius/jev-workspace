import type { Answer, JevProviderInfo, QuestionType } from "./types";

/**
 * Jev (TypeSafe's System One model) client. Mirrors the claude-jev plugin's
 * key resolution: TYPESAFE_API_KEY first, then OPENROUTER_API_KEY, and an
 * `sk-or-` key goes to OpenRouter's System One endpoint.
 *
 * Pricing and limits come from docs.typesafe.ai/models (checked 2026-09-25):
 * $0.042 per million input tokens, output free, 1,200 requests per minute.
 */

export const DEFAULT_USD_PER_MILLION_INPUT = 0.042;
export const DEFAULT_RPM = 1200;
const DEFAULT_MODEL = "jev-latest";

const ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
} as const;

export interface JevQuestion {
  type: QuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface JevConfig extends JevProviderInfo {
  ready: boolean;
  url: string;
  key: string;
  reason?: string;
}

export function jevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const model = env.JEV_MODEL?.trim() || DEFAULT_MODEL;
  const usdPerMillionInput = positive(env.JEV_USD_PER_MILLION_INPUT) ?? DEFAULT_USD_PER_MILLION_INPUT;
  const requestsPerMinute = positive(env.JEV_RPM) ?? DEFAULT_RPM;
  const key = env.TYPESAFE_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim() || "";
  const base = { model, usdPerMillionInput, requestsPerMinute };

  const custom = env.JEV_BASE_URL?.trim();
  if (custom) {
    return { ...base, ready: true, name: "custom", url: custom, key };
  }
  if (!key) {
    return {
      ...base,
      ready: false,
      name: "typesafe",
      url: ENDPOINTS.typesafe,
      key: "",
      reason: "No Jev key. Set TYPESAFE_API_KEY (or OPENROUTER_API_KEY) in .env.local and restart.",
    };
  }
  const name = key.startsWith("sk-or-") ? "openrouter" : "typesafe";
  return { ...base, ready: true, name, url: ENDPOINTS[name], key };
}

export function publicInfo(cfg: JevConfig): JevProviderInfo {
  return {
    name: cfg.name,
    model: cfg.model,
    usdPerMillionInput: cfg.usdPerMillionInput,
    requestsPerMinute: cfg.requestsPerMinute,
  };
}

export class JevError extends Error {
  constructor(message: string, readonly status: number | null, readonly fatal: boolean) {
    super(message);
  }
}

export interface JevResult {
  answers: Record<string, unknown>;
  inputTokens: number;
  tokensEstimated: boolean;
  model: string | null;
  ms: number;
  throttled: number;
}

/**
 * Shared request budget. Jev limits requests per minute per key, so every
 * worker in every run draws from one bucket. A 429 pauses the whole bucket.
 */
class RequestBucket {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;

  constructor(private rpm: number) {
    this.tokens = Math.min(8, rpm / 60);
  }

  setRpm(rpm: number) {
    this.rpm = rpm;
  }

  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new JevError("aborted", null, true);
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now, signal);
        continue;
      }
      const perMs = this.rpm / 60_000;
      const burst = Math.max(1, Math.min(8, this.rpm / 60));
      this.tokens = Math.min(burst, this.tokens + (now - this.last) * perMs);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.tokens) / perMs), signal);
    }
  }
}

const globalBucket = globalThis as unknown as { __jevBucket?: RequestBucket };

function bucket(rpm: number): RequestBucket {
  if (!globalBucket.__jevBucket) globalBucket.__jevBucket = new RequestBucket(rpm);
  globalBucket.__jevBucket.setRpm(rpm);
  return globalBucket.__jevBucket;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function jevAsk(
  cfg: JevConfig,
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JevResult> {
  if (!cfg.ready) throw new JevError(cfg.reason ?? "Jev is not configured", null, true);
  const body = JSON.stringify({ state, model: cfg.model, questions });
  const limiter = bucket(cfg.requestsPerMinute);
  let throttled = 0;

  for (let attempt = 0; ; attempt++) {
    await limiter.take(opts.signal);
    const started = performance.now();
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
        },
        body,
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new JevError("aborted", null, true);
      if (attempt < 3) {
        await sleep(backoff(attempt), opts.signal);
        continue;
      }
      throw new JevError(`network: ${(err as Error).message}`, null, false);
    }

    if (res.ok) {
      const payload = (await res.json()) as {
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number };
        model?: string;
      };
      const reported = payload.usage?.input_tokens;
      const estimated = typeof reported !== "number";
      return {
        answers: payload.answers ?? {},
        inputTokens: estimated ? Math.ceil(body.length / 4) : reported,
        tokensEstimated: estimated,
        model: payload.model ?? null,
        ms: Math.round(performance.now() - started),
        throttled,
      };
    }

    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 429) {
      throttled++;
      const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt);
      limiter.pause(wait);
      if (attempt < 6) continue;
    } else if (RETRYABLE.has(res.status) && attempt < 3) {
      await sleep(backoff(attempt), opts.signal);
      continue;
    }
    const fatal = res.status === 401 || res.status === 403 || res.status === 402;
    throw new JevError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status, fatal);
  }
}

/** Reads one answer from Jev's response. Returns null when the shape is not what the type promises. */
export function readAnswer(type: QuestionType, raw: unknown): Answer | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const confidence = typeof a.confidence === "number" ? a.confidence : undefined;
  if (type === "noul") {
    const v = a.noul ?? a.probability;
    return typeof v === "number" && Number.isFinite(v) ? { v: clamp01(v) } : null;
  }
  if (type === "choice") {
    return typeof a.choice === "string" ? { v: a.choice, c: confidence } : null;
  }
  const v = a.score;
  return typeof v === "number" && Number.isFinite(v) ? { v, c: confidence } : null;
}

export function costUsd(inputTokens: number, usdPerMillionInput: number): number {
  return (inputTokens / 1_000_000) * usdPerMillionInput;
}

function positive(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function backoff(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** attempt) + Math.random() * 250;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(250, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(250, at - Date.now()) : null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JevError("aborted", null, true));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new JevError("aborted", null, true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
