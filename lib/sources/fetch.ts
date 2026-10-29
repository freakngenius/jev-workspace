/**
 * Polite fetching for crawls: a size cap, a timeout, manual redirects with a
 * private-address check on every hop, a per-host concurrency limit, and
 * robots.txt for pages the crawler discovers on its own.
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; JevWorkspace/0.1; local research crawler)";

export interface Fetched {
  url: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

export class FetchError extends Error {}

export function allowPrivate(): boolean {
  return process.env.ALLOW_PRIVATE_URLS === "1";
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  return false;
}

export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`Not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError(`Only http(s) URLs: ${raw}`);
  if (!allowPrivate() && isPrivateHost(u.hostname)) {
    throw new FetchError(`Blocked private address ${u.hostname} (set ALLOW_PRIVATE_URLS=1 to allow).`);
  }
  return u;
}

class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const hostGates = new Map<string, Gate>();
const globalGate = new Gate(16);

function gateFor(host: string): Gate {
  let g = hostGates.get(host);
  if (!g) hostGates.set(host, (g = new Gate(4)));
  return g;
}

export async function politeFetch(
  raw: string,
  opts: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; accept?: string } = {},
): Promise<Fetched> {
  const first = checkUrl(raw);
  return globalGate.run(() =>
    gateFor(first.host).run(async () => {
      let url = first;
      for (let hop = 0; hop < 6; hop++) {
        const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await fetch(url, {
            redirect: "manual",
            signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          });
        } catch (err) {
          throw new FetchError(timeout.aborted ? "timed out" : (err as Error).message);
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          url = checkUrl(new URL(res.headers.get("location")!, url).toString());
          await res.body?.cancel();
          continue;
        }
        const { bytes, truncated } = await readCapped(res, opts.maxBytes ?? 3_000_000);
        return {
          url: url.toString(),
          status: res.status,
          contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
          bytes,
          truncated,
        };
      }
      throw new FetchError("too many redirects");
    }),
  );
}

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
    if (size >= max) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const p of parts) {
    const take = Math.min(p.byteLength, out.byteLength - off);
    out.set(p.subarray(0, take), off);
    off += take;
    if (off >= out.byteLength) break;
  }
  return { bytes: out, truncated };
}

export function decodeText(f: Fetched): string {
  const charset = f.contentType.match(/charset=([^;]+)/)?.[1]?.trim();
  try {
    return new TextDecoder(charset || "utf-8").decode(f.bytes);
  } catch {
    return new TextDecoder("utf-8").decode(f.bytes);
  }
}

interface RobotRules {
  allow: string[];
  disallow: string[];
}

const robotsCache = new Map<string, Promise<RobotRules>>();

/** True when robots.txt lets a generic crawler fetch this URL. Missing or unreadable robots.txt allows all. */
export async function robotsAllows(raw: string, signal?: AbortSignal): Promise<boolean> {
  const u = new URL(raw);
  let rules = robotsCache.get(u.origin);
  if (!rules) {
    rules = loadRobots(u.origin, signal);
    robotsCache.set(u.origin, rules);
  }
  const { allow, disallow } = await rules;
  const target = u.pathname + u.search;
  const longest = (list: string[]) =>
    list.filter((p) => p && matchRobots(p, target)).reduce((a, p) => Math.max(a, p.length), -1);
  const a = longest(allow);
  const d = longest(disallow);
  return d < 0 || a >= d;
}

async function loadRobots(origin: string, signal?: AbortSignal): Promise<RobotRules> {
  try {
    const f = await politeFetch(`${origin}/robots.txt`, { signal, maxBytes: 200_000, timeoutMs: 6_000, accept: "text/plain" });
    if (f.status >= 400) return { allow: [], disallow: [] };
    return parseRobots(decodeText(f));
  } catch {
    return { allow: [], disallow: [] };
  }
}

export function parseRobots(text: string): RobotRules {
  const rules: RobotRules = { allow: [], disallow: [] };
  let applies = false;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      const matches = agent === "*" || agent.includes("jevworkspace");
      applies = lastWasAgent ? applies || matches : matches;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if (key === "disallow") rules.disallow.push(value);
    if (key === "allow") rules.allow.push(value);
  }
  return rules;
}

function matchRobots(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}
