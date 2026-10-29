import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Claude does the judgment work around Jev: turning a mission into typed
 * questions, and reviewing the uncertain band. Two routes:
 *   - ANTHROPIC_API_KEY set: the Anthropic SDK.
 *   - otherwise: the local `claude` CLI in headless mode, on the user's own
 *     Claude login. It reports its own dollar cost per call.
 */

const DEFAULT_MODEL = "claude-opus-5";

/** USD per million tokens, from the claude-api skill's model table (cached 2026-06-24). */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type ClaudeRoute = "anthropic" | "claude-cli";

export interface ClaudeResult<T> {
  data: T;
  costUsd: number;
  ms: number;
  model: string;
  route: ClaudeRoute;
}

export class ClaudeError extends Error {}

export function claudeModel(): string {
  return process.env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
}

export async function claudeRoute(): Promise<ClaudeRoute | null> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return (await findClaudeBin()) ? "claude-cli" : null;
}

export async function askClaude<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  route?: ClaudeRoute;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ClaudeResult<z.infer<S>>> {
  const route = opts.route ?? (await claudeRoute());
  if (!route) throw new ClaudeError("No Claude route: set ANTHROPIC_API_KEY or install the claude CLI.");
  return route === "anthropic" ? viaSdk(opts) : viaCli(opts);
}

async function viaSdk<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ClaudeResult<z.infer<S>>> {
  const model = claudeModel();
  const client = new Anthropic();
  const started = performance.now();
  try {
    const response = await client.messages.parse(
      {
        model,
        max_tokens: 16000,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
        output_config: { format: zodOutputFormat(opts.schema) },
      },
      { signal: opts.signal, timeout: opts.timeoutMs ?? 180_000 },
    );
    if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined the request.");
    if (response.parsed_output == null) throw new ClaudeError("Claude returned output that did not match the schema.");
    const price = PRICES[model] ?? PRICES[DEFAULT_MODEL];
    const u = response.usage;
    const inputTokens =
      u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
    return {
      data: response.parsed_output as z.infer<S>,
      costUsd: (inputTokens * price.input + u.output_tokens * price.output) / 1_000_000,
      ms: Math.round(performance.now() - started),
      model,
      route: "anthropic",
    };
  } catch (err) {
    if (err instanceof ClaudeError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError("ANTHROPIC_API_KEY was rejected.");
    if (err instanceof Anthropic.RateLimitError) throw new ClaudeError("Claude rate limit hit. Try again shortly.");
    if (err instanceof Anthropic.APIError) throw new ClaudeError(`Claude API error ${err.status}: ${err.message}`);
    throw new ClaudeError(`Claude request failed: ${(err as Error).message}`);
  }
}

async function viaCli<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ClaudeResult<z.infer<S>>> {
  const bin = await findClaudeBin();
  if (!bin) throw new ClaudeError("claude CLI not found.");
  const model = claudeModel();
  // An empty working directory keeps project CLAUDE.md files and settings out.
  const cwd = path.join(os.tmpdir(), "jev-workspace-claude");
  await mkdir(cwd, { recursive: true });
  const args = [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchema(opts.schema)),
    "--system-prompt", opts.system,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--tools", "",
    "--no-session-persistence",
  ];
  const started = performance.now();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ClaudeError("claude CLI timed out."));
    }, opts.timeoutMs ?? 240_000);
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude CLI failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new ClaudeError("aborted"));
      if (code !== 0 && !out.trim()) {
        return reject(new ClaudeError(`claude CLI exited ${code}: ${stripAnsi(err).trim().slice(0, 300)}`));
      }
      resolve(out);
    });
    child.stdin.end(opts.prompt);
  });

  let payload: {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
    modelUsage?: Record<string, unknown>;
  };
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new ClaudeError(`claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (payload.is_error) throw new ClaudeError(`claude CLI error: ${String(payload.result ?? "unknown").slice(0, 300)}`);
  let raw = payload.structured_output;
  if (raw == null && typeof payload.result === "string") {
    try {
      raw = JSON.parse(payload.result);
    } catch {
      raw = null;
    }
  }
  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) throw new ClaudeError("Claude returned output that did not match the schema.");
  return {
    data: parsed.data,
    costUsd: payload.total_cost_usd ?? 0,
    ms: Math.round(performance.now() - started),
    model: mainModel(payload.modelUsage) ?? model,
    route: "claude-cli",
  };
}

/** The CLI also spends a little on a small helper model; name the model that did most of the work. */
function mainModel(usage: Record<string, unknown> | undefined): string | null {
  const entries = Object.entries(usage ?? {}).map(([k, v]) => [k, Number((v as { costUSD?: number })?.costUSD ?? 0)] as const);
  if (!entries.length) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Draft-7 JSON Schema without the `$schema` tag: the CLI's validator rejects the 2020-12 URI zod emits by default. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

let cachedBin: string | null | undefined;

export async function findClaudeBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local/bin/claude"),
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "claude")),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      cachedBin = p;
      return p;
    } catch {}
  }
  cachedBin = null;
  return null;
}
