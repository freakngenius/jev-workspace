import { readUpload } from "../store";
import {
  dmFolderOf,
  hasHandleColumn,
  mergeAccounts,
  normName,
  parseDmThread,
  summarizeThreads,
  warmthRank,
  type AccountMerge,
  type DmThread,
} from "./instagram";
import type { ClientItem, Item, Limits, SourceKind, SourceSpec } from "../types";
import { checkUrl, decodeText, FetchError, politeFetch, robotsAllows, type Fetched } from "./fetch";
import {
  isFeed,
  isSitemap,
  parseCsv,
  parseFeed,
  parseHtml,
  parseJsonRows,
  parsePdf,
  parseSitemap,
  collapse,
  htmlRecords,
  htmlTitle,
  htmlToHeadedText,
  splitText,
  rowTitler,
  type Row,
} from "./parse";

/** Turns links and uploads into items. Code produces the candidates; Jev only judges them. */

export type ItemDraft = Omit<Item, "id" | "status" | "chars" | "sourceId">;

export interface ExpandContext {
  limits: Limits;
  signal: AbortSignal;
  /** Creates a tile. Returns null once the run holds maxItems. */
  add(draft: ItemDraft): Item | null;
  /** Hands an item's text to the judge queue. */
  ready(item: Item, text: string, patch?: Partial<ClientItem>): void;
  patch(item: Item, patch: Partial<ClientItem>): void;
  fail(item: Item, error: string): void;
  skip(item: Item, reason: string): void;
  full(): boolean;
  log(level: "info" | "warn" | "error", msg: string): void;
}

const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|zip|gz|tgz|rar|7z|dmg|exe|pkg|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|rss|atom|csv|xlsx?|docx?|pptx?)$/i;

export function sheetsExportUrl(raw: string): string {
  const m = raw.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return raw;
  const gid = raw.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export function guessKindFromName(name: string): SourceKind | null {
  const n = name.toLowerCase().split(/[?#]/)[0];
  if (/docs\.google\.com\/spreadsheets/.test(name)) return "table";
  if (/sitemap[^/]*\.xml$/.test(n)) return "sitemap";
  if (/\.(csv|tsv|json)$/.test(n)) return "table";
  if (/\.pdf$/.test(n)) return "pdf";
  if (/\.(rss|atom)$|\/(feed|rss)\/?$|\/feed\.xml$|\/atom\.xml$/.test(n)) return "feed";
  if (/\.(txt|md|markdown)$/.test(n)) return "text";
  if (/\.(html?|xhtml)$/.test(n)) return "page";
  return null;
}

function kindFromContent(contentType: string, head: string): SourceKind | null {
  if (contentType.includes("pdf") || head.startsWith("%PDF")) return "pdf";
  if (contentType.includes("csv") || contentType.includes("tab-separated")) return "table";
  if (contentType.includes("json") || /^\s*[[{]/.test(head)) return "table";
  if (isSitemap(head)) return "sitemap";
  if (isFeed(head)) return "feed";
  if (contentType.includes("html") || /<html|<!doctype html/i.test(head.slice(0, 2000))) return "page";
  if (contentType.startsWith("text/")) return "text";
  return null;
}

/** Shallow paths look like a site to crawl; deep paths look like one page. */
function crawlByDefault(url: string): boolean {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  return segs.length <= 1;
}

/** Looks at a link or upload before planning: what it is, its title, and for tables a sample. */
export async function sniffSource(
  input: { url?: string; uploadId?: string },
  id: string,
  signal?: AbortSignal,
): Promise<SourceSpec> {
  if (input.uploadId) {
    const { meta, bytes } = await readUpload(input.uploadId);
    const head = new TextDecoder().decode(bytes.subarray(0, 4000));
    const kind = guessKindFromName(meta.name) ?? kindFromContent(meta.type, head) ?? "text";
    const spec: SourceSpec = { id, label: meta.name, uploadId: meta.id, kind, crawl: false, title: meta.name };
    if (kind === "table") Object.assign(spec, tablePreview(meta.name, new TextDecoder().decode(bytes)));
    if (kind === "pdf") spec.note = await pdfNote(bytes);
    if (kind === "page" || kind === "site") {
      const html = new TextDecoder().decode(bytes);
      const rows = htmlListRows(html, meta.name);
      const title = htmlTitle(html) || meta.name;
      if (rows) {
        // A list page (an export, saved search results) reads one item per entry, like a table.
        Object.assign(spec, {
          kind: "table",
          fileType: "html",
          title,
          count: rows.length,
          columns: Object.keys(rows[0]),
          sampleRows: rows.slice(0, 3).map((r) => trimRow(r, 160)),
          note: `${rows.length.toLocaleString("en-US")} list entries`,
        });
      } else {
        Object.assign(spec, { kind: "page", fileType: "html", title, count: 1, note: "HTML file" });
      }
    }
    return spec;
  }

  const raw = sheetsExportUrl(input.url!.trim());
  const label = input.url!.trim();
  try {
    checkUrl(raw);
  } catch (err) {
    return { id, label, url: raw, kind: "page", crawl: false, note: (err as Error).message };
  }
  const guessed = guessKindFromName(raw);
  let f: Fetched;
  try {
    f = await politeFetch(raw, { signal, maxBytes: 600_000, timeoutMs: 12_000 });
  } catch (err) {
    return {
      id, label, url: raw,
      kind: guessed ?? "site",
      crawl: guessed ? false : crawlByDefault(raw),
      note: `Could not reach it yet: ${(err as Error).message}`,
    };
  }
  const text = decodeText(f);
  const kind = guessed ?? kindFromContent(f.contentType, text.slice(0, 4000)) ?? "page";
  const spec: SourceSpec = { id, label, url: f.url, kind, crawl: false };
  if (f.status >= 400) spec.note = `HTTP ${f.status}`;
  if (kind === "page") {
    spec.crawl = crawlByDefault(f.url);
    if (spec.crawl) spec.kind = "site";
    spec.title = parseHtml(text, f.url).title || undefined;
  } else if (kind === "table") {
    Object.assign(spec, tablePreview(f.url, text, f.truncated));
  } else if (kind === "feed") {
    const entries = parseFeed(text);
    const avg = entries.reduce((a, e) => a + e.text.length, 0) / Math.max(1, entries.length);
    // Title-only feeds (Hacker News, many aggregators) give Jev almost nothing to judge. Read the linked pages instead.
    spec.crawl = entries.length > 0 && avg < 200 && entries.some((e) => e.link);
    spec.note = `${entries.length} entries${spec.crawl ? ", short, so linked pages get read" : ""}`;
  } else if (kind === "sitemap") {
    const s = parseSitemap(text);
    spec.note = s.sitemaps.length ? `sitemap index, ${s.sitemaps.length} sitemaps` : `${s.urls.length} URLs`;
  } else if (kind === "pdf") {
    spec.note = f.truncated ? "PDF (large)" : await pdfNote(f.bytes);
  }
  return spec;
}

async function pdfNote(bytes: Uint8Array): Promise<string> {
  try {
    const pages = await parsePdf(bytes.slice());
    return `${pages.length} pages`;
  } catch {
    return "PDF (unreadable preview)";
  }
}

function tablePreview(name: string, text: string, truncated = false): Partial<SourceSpec> {
  try {
    const rows = parseRows(name, text, truncated);
    const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].slice(0, 40);
    return {
      columns,
      sampleRows: rows.slice(0, 3).map((r) => trimRow(r, 160)),
      count: truncated ? undefined : rows.length,
      note: truncated ? `${rows.length}+ rows (preview)` : `${rows.length} rows`,
    };
  } catch (err) {
    return { note: `Table did not parse: ${(err as Error).message}` };
  }
}

function isHtml(name: string, text: string): boolean {
  return /\.(html?|xhtml)$/i.test(name) || /^\s*<(!doctype html|html)[\s>]/i.test(text.slice(0, 500));
}

/**
 * The entries of a list page as rows: which list (the page title), the entry's
 * name, its link, and everything it says. Null when the page is not a list.
 */
export function htmlListRows(html: string, fileName: string): Row[] | null {
  const records = htmlRecords(html, UPLOAD_BASE);
  if (!records || records.length < 5) return null;
  const list = htmlTitle(html) || fileName;
  return records.map((r) => ({ list, name: r.title, link: r.url ?? "", details: r.text }));
}

function parseRows(name: string, text: string, truncated = false): Row[] {
  if (isHtml(name, text)) return htmlListRows(text, name) ?? [];
  const trimmed = text.trimStart();
  if (/\.json(\?|$)/i.test(name) || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseJsonRows(text);
  }
  if (truncated) text = text.slice(0, text.lastIndexOf("\n"));
  return parseCsv(text);
}

function trimRow(r: Row, n: number): Row {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.length > n ? `${v.slice(0, n)}…` : v]));
}

/** Relative links inside an uploaded page resolve against this placeholder and are never fetched. */
const UPLOAD_BASE = "https://upload.invalid/";

function uploadIdsOf(spec: SourceSpec): string[] {
  return spec.uploadIds ?? (spec.uploadId ? [spec.uploadId] : []);
}

/**
 * Uploads that belong together become one source. Plain HTML files dropped
 * together read as "50 HTML files". Account data (follower and following
 * lists, DM threads, and any table keyed by handle) becomes one table with a
 * row per account, counted after merging: the number the run will judge.
 */
export async function groupHtmlUploads(specs: SourceSpec[], dmIds: string[] = []): Promise<SourceSpec[]> {
  const html = specs.filter((s) => s.uploadId && s.fileType === "html");
  const lists = html.filter((s) => s.kind === "table");
  if (!lists.length && !dmIds.length) {
    if (html.length < 2) return specs;
    const titles = html.map((s) => s.title).filter((t): t is string => Boolean(t)).slice(0, 3);
    return replaceWith(specs, html, {
      id: html[0].id,
      label: `${html.length} HTML files`,
      uploadIds: html.map((s) => s.uploadId!),
      fileType: "html",
      kind: "page",
      crawl: false,
      title: `${html.length} HTML files`,
      count: html.length,
      note: `${html.length} files, one item each${titles.length ? `, e.g. ${titles.map((t) => `"${t.slice(0, 40)}"`).join(", ")}` : ""}`,
    });
  }

  const tables = specs.filter((s) => s.uploadId && s.kind === "table" && s.fileType !== "html" && hasHandleColumn(s.columns ?? []));
  const parts = [
    lists.length && `${lists.length} ${lists.length === 1 ? "list" : "lists"}`,
    html.length - lists.length && `${html.length - lists.length} other HTML`,
    tables.length && `${tables.length} ${tables.length === 1 ? "table" : "tables"}`,
    dmIds.length && `${dmIds.length.toLocaleString("en-US")} DM threads`,
  ].filter(Boolean);
  const group: SourceSpec = {
    id: [...html, ...tables][0]?.id ?? "dms",
    label: parts.join(" · "),
    uploadIds: html.length ? html.map((s) => s.uploadId!) : undefined,
    tableUploadIds: tables.length ? tables.map((s) => s.uploadId!) : undefined,
    dmUploadIds: dmIds.length ? dmIds : undefined,
    fileType: "html",
    kind: "table",
    crawl: false,
    title: "Accounts",
  };
  const { merge, pages } = await accountRows(group);
  const rel = (name: string) => merge.rows.filter((r) => r.relationship === name).length;
  const withDms = rel("DMs + mutual follow") + rel("DMs") + rel("DMs only");
  const fmt = (n: number) => n.toLocaleString("en-US");
  group.count = merge.rows.length + pages.length;
  group.columns = [...new Set(merge.rows.slice(0, 300).flatMap((r) => Object.keys(r)))].slice(0, 40);
  group.sampleRows = [...merge.rows]
    .sort((a, b) => warmthRank(b.relationship) - warmthRank(a.relationship))
    .slice(0, 3)
    .map((r) => trimRow(r, 160));
  group.note = [
    `${fmt(merge.rows.length)} accounts`,
    `${fmt(rel("DMs + mutual follow") + rel("mutual follow"))} mutual follows`,
    dmIds.length && `${fmt(withDms)} with DMs (${fmt(merge.threadsAdded)} only in DMs)`,
    tables.length && `${fmt(merge.tableRowsMerged)} table rows merged, ${fmt(merge.tableRowsAdded)} added`,
  ]
    .filter(Boolean)
    .join(", ");
  return replaceWith(specs, [...html, ...tables], group);
}

function replaceWith(specs: SourceSpec[], members: SourceSpec[], group: SourceSpec): SourceSpec[] {
  const at = members.length ? specs.indexOf(members[0]) : specs.length;
  const rest = specs.filter((s) => !members.includes(s));
  rest.splice(Math.min(at, rest.length), 0, group);
  return rest;
}

const threadCache = new Map<string, ReturnType<typeof parseDmThread>>();

/** DM threads summarized across the whole inbox; parsed once per upload and kept for the run. */
async function dmThreads(ids: string[]): Promise<DmThread[]> {
  const raws = [];
  for (const id of ids) {
    let raw = threadCache.get(id);
    if (!raw) {
      const { meta, bytes } = await readUpload(id);
      raw = parseDmThread(new TextDecoder().decode(bytes), dmFolderOf(meta.path ?? meta.name));
      if (threadCache.size > 20_000) threadCache.clear();
      threadCache.set(id, raw);
    }
    raws.push(raw);
  }
  return summarizeThreads(raws).threads;
}

/** Everything an account source holds, merged into one row per account, plus HTML files that hold no list. */
async function accountRows(spec: SourceSpec): Promise<{ merge: AccountMerge; pages: { text: string; name: string }[] }> {
  const docs = await Promise.all(
    (spec.uploadIds ?? []).map(async (id) => {
      const { meta, bytes } = await readUpload(id);
      return { text: new TextDecoder().decode(bytes), name: meta.name };
    }),
  );
  const lists = docs.map((d) => ({ doc: d, rows: htmlListRows(d.text, d.name) }));
  const tables = await Promise.all(
    (spec.tableUploadIds ?? []).map(async (id) => {
      const { meta, bytes } = await readUpload(id);
      return parseRows(meta.name, new TextDecoder().decode(bytes));
    }),
  );
  const merge = mergeAccounts(mergeListRows(lists.flatMap((l) => l.rows ?? [])), tables, await dmThreads(spec.dmUploadIds ?? []));
  return { merge, pages: lists.filter((l) => !l.rows).map((l) => l.doc) };
}

/** "Display Name · @handle" when a table or DM thread supplied a name that is not just the handle. */
function accountTitle(row: Row): string {
  const handle = row.name ?? "";
  const display = row.Name || row.dm_name || "";
  if (!row.link) return display || handle;
  return display && normName(display) !== normName(handle) ? `${display} · @${handle}` : handle;
}

async function mergedListRows(uploadIds: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const id of uploadIds) {
    const { meta, bytes } = await readUpload(id);
    rows.push(...(htmlListRows(new TextDecoder().decode(bytes), meta.name) ?? []));
  }
  return mergeListRows(rows);
}

/**
 * One entry per account across lists: the same handle in Followers and in
 * Following becomes one row whose list reads "Followers + Following", which
 * is also the plainest warmth signal an export carries. Only handle-like
 * names (no spaces) on the same site merge, so two different bookmarks that
 * share a title stay apart.
 */
export function mergeListRows(rows: Row[]): Row[] {
  const out: Row[] = [];
  const seen = new Map<string, Row>();
  const line = (list: string, details: string) => `${list}: ${details.replace(/\s*\n\s*/g, " · ")}`;
  for (const r of rows) {
    const handle = (r.name ?? "").trim().toLowerCase();
    const key = handle && !/\s/.test(handle) ? `${domainOf(r.link ?? "")}|${handle}` : null;
    const prev = key ? seen.get(key) : undefined;
    if (!prev) {
      const row = { ...r };
      out.push(row);
      if (key) seen.set(key, row);
      continue;
    }
    if (prev.list.split(" + ").includes(r.list)) continue;
    if (!prev.list.includes(" + ")) prev.details = line(prev.list, prev.details);
    prev.details = `${prev.details}\n${line(r.list, r.details)}`;
    prev.list = `${prev.list} + ${r.list}`;
  }
  return out;
}

/** Loads a source's bytes: an upload from disk, or a link over the network. */
async function load(spec: SourceSpec, ctx: ExpandContext): Promise<{ bytes: Uint8Array; text: string; url?: string; name: string }> {
  if (spec.uploadId) {
    const { meta, bytes } = await readUpload(spec.uploadId);
    return { bytes, text: new TextDecoder().decode(bytes), name: meta.name };
  }
  const f = await politeFetch(spec.url!, { signal: ctx.signal, maxBytes: 40_000_000, timeoutMs: 60_000 });
  if (f.status >= 400) throw new FetchError(`HTTP ${f.status}`);
  return { bytes: f.bytes, text: decodeText(f), url: f.url, name: f.url };
}

export async function expandSource(spec: SourceSpec, ctx: ExpandContext): Promise<void> {
  switch (spec.kind) {
    case "site":
    case "page":
      if (uploadIdsOf(spec).length) return fromHtmlFiles(spec, ctx);
      return spec.crawl ? crawlSite(spec, ctx) : singlePage(spec, ctx);
    case "sitemap":
      return fromSitemap(spec, ctx);
    case "feed":
      return fromFeed(spec, ctx);
    case "table":
      return fromTable(spec, ctx);
    case "pdf":
      return fromPdf(spec, ctx);
    case "text":
      return fromText(spec, ctx);
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : decodeURIComponent(u.pathname);
  } catch {
    return url;
  }
}

function canonical(url: string): string {
  const u = new URL(url);
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

async function fetchPageInto(item: Item, ctx: ExpandContext, landed?: Set<string>): Promise<string[]> {
  ctx.patch(item, { status: "fetching" });
  try {
    const f = await politeFetch(item.url!, { signal: ctx.signal });
    if (f.status >= 400) throw new FetchError(`HTTP ${f.status}`);
    if (landed) {
      const final = canonical(f.url);
      if (landed.has(final)) {
        ctx.skip(item, "Same page as an earlier item (the link redirects there).");
        return [];
      }
      landed.add(final);
    }
    const type = f.contentType.split(";")[0];
    if (type === "text/plain" || type === "text/markdown") {
      const text = collapse(decodeText(f));
      if (text.length < 40) throw new FetchError("file has no readable text");
      ctx.ready(item, text, { url: f.url });
      return [];
    }
    if (type && !type.includes("html") && !type.includes("xml")) {
      throw new FetchError(`not a web page (${type})`);
    }
    const page = parseHtml(decodeText(f), f.url);
    const text = [page.description, page.text].filter(Boolean).join("\n\n");
    if (text.length < 40) throw new FetchError("page has no readable text (it may need JavaScript)");
    ctx.ready(item, text, { title: page.title || item.title, url: f.url });
    return page.links;
  } catch (err) {
    if (ctx.signal.aborted) return [];
    ctx.fail(item, (err as Error).message);
    return [];
  }
}

async function singlePage(spec: SourceSpec, ctx: ExpandContext) {
  const item = ctx.add({ title: spec.title || pathLabel(spec.url!), url: spec.url, domain: domainOf(spec.url!) });
  if (item) await fetchPageInto(item, ctx);
}

async function crawlSite(spec: SourceSpec, ctx: ExpandContext) {
  const seed = canonical(spec.url!);
  const host = domainOf(seed);
  const seen = new Set<string>([seed]);
  const landed = new Set<string>();
  const queue: { item: Item; depth: number }[] = [];
  const cap = ctx.limits.maxPagesPerSite;
  let enqueued = 0;

  const enqueue = (url: string, depth: number) => {
    if (enqueued >= cap || ctx.full()) return;
    const item = ctx.add({ title: pathLabel(url), url, domain: host, locator: depth ? `depth ${depth}` : "seed" });
    if (!item) return;
    enqueued++;
    queue.push({ item, depth });
  };
  enqueue(seed, 0);

  const worker = async () => {
    while (queue.length && !ctx.signal.aborted) {
      const { item, depth } = queue.shift()!;
      const links = await fetchPageInto(item, ctx, landed);
      if (depth >= ctx.limits.crawlDepth) continue;
      for (const link of links) {
        if (enqueued >= cap || ctx.full()) break;
        let url: string;
        try {
          url = canonical(link);
        } catch {
          continue;
        }
        if (seen.has(url) || domainOf(url) !== host || SKIP_EXT.test(new URL(url).pathname)) continue;
        seen.add(url);
        if (!(await robotsAllows(url, ctx.signal))) continue;
        enqueue(url, depth + 1);
      }
    }
  };
  // Pages discovered while workers are busy are picked up by whichever worker frees first.
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < 4 && queue.length && !ctx.signal.aborted) {
        active++;
        worker().finally(() => {
          active--;
          if (!active && (!queue.length || ctx.signal.aborted)) resolve();
          else pump();
        });
      }
      if (!active) resolve();
    };
    pump();
  });
  if (enqueued >= cap) ctx.log("info", `${host}: reached ${cap} pages, the per-site cap.`);
}

async function fromSitemap(spec: SourceSpec, ctx: ExpandContext) {
  const root = await load(spec, ctx);
  let { urls, sitemaps } = parseSitemap(root.text);
  for (const child of sitemaps.slice(0, 20)) {
    if (urls.length >= ctx.limits.maxPagesPerSite) break;
    try {
      const f = await politeFetch(child, { signal: ctx.signal, maxBytes: 20_000_000 });
      urls = urls.concat(parseSitemap(decodeText(f)).urls);
    } catch (err) {
      ctx.log("warn", `Skipped child sitemap ${child}: ${(err as Error).message}`);
    }
  }
  const picked = [...new Set(urls)].filter((u) => !SKIP_EXT.test(u)).slice(0, ctx.limits.maxPagesPerSite);
  const items = picked
    .map((url) => ctx.add({ title: pathLabel(url), url, domain: domainOf(url) }))
    .filter((i): i is Item => i !== null);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < items.length && !ctx.signal.aborted) await fetchPageInto(items[next++], ctx);
    }),
  );
}

async function fromFeed(spec: SourceSpec, ctx: ExpandContext) {
  const src = await load(spec, ctx);
  const pending: { item: Item; entryText: string }[] = [];
  for (const e of parseFeed(src.text)) {
    const item = ctx.add({ title: e.title || "(untitled entry)", url: e.link || undefined, domain: domainOf(e.link), locator: e.date || undefined });
    if (!item) break;
    const entryText = [e.title, e.text].filter(Boolean).join("\n\n");
    if (spec.crawl && e.link) pending.push({ item, entryText });
    else if (e.text.length < 20 && !e.title) ctx.fail(item, "entry has no text");
    else ctx.ready(item, entryText);
  }
  // "Read linked pages": the feed entry heads the text, the page body follows. A page that will not
  // load still gets judged on its entry, so one dead link never costs an item.
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < pending.length && !ctx.signal.aborted) {
        const { item, entryText } = pending[next++];
        ctx.patch(item, { status: "fetching" });
        try {
          const f = await politeFetch(item.url!, { signal: ctx.signal });
          if (f.status >= 400 || (f.contentType && !f.contentType.includes("html"))) throw new FetchError("not a readable page");
          const page = parseHtml(decodeText(f), f.url);
          ctx.ready(item, [entryText, page.description, page.text].filter(Boolean).join("\n\n"));
        } catch {
          if (ctx.signal.aborted) return;
          ctx.ready(item, entryText, { error: undefined });
        }
      }
    }),
  );
}

async function fromTable(spec: SourceSpec, ctx: ExpandContext) {
  if (spec.fileType === "html" && (spec.uploadIds || spec.dmUploadIds)) {
    // Lists, account tables and DM threads merge into one entry per account before anything is judged.
    const { merge, pages } = await accountRows(spec);
    addRows(merge.rows, (row) => row.list || "DM thread", ctx, accountTitle);
    for (const p of pages) if (!ctx.full()) htmlPageItem(p.text, p.name, ctx);
    if (merge.threads || merge.tableRowsMerged || merge.tableRowsAdded) {
      ctx.log(
        "info",
        `Accounts: ${merge.rows.length}. DM threads: ${merge.threads}, ${merge.threadsMatched} matched to an account, ${merge.threadsAdded} added as DM-only. Table rows: ${merge.tableRowsMerged} merged, ${merge.tableRowsAdded} added.`,
      );
    }
    return;
  }
  const docs = spec.uploadIds
    ? await Promise.all(
        spec.uploadIds.map(async (id) => {
          const { meta, bytes } = await readUpload(id);
          return { text: new TextDecoder().decode(bytes), name: meta.name };
        }),
      )
    : [await load(spec, ctx)];
  for (const doc of docs) {
    if (ctx.full()) break;
    const rows = parseRows(doc.name, doc.text);
    if (!rows.length && isHtml(doc.name, doc.text)) {
      // An HTML file without a list still counts: it becomes one item instead of silently vanishing.
      htmlPageItem(doc.text, doc.name, ctx);
      continue;
    }
    addRows(rows, (_, i) => (spec.uploadIds ? `${doc.name} · ${i + 1}` : `row ${i + 1}`), ctx);
  }
}

function addRows(rows: Row[], locate: (row: Row, i: number) => string, ctx: ExpandContext, title?: (row: Row) => string) {
  const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
  const titleOf = title ?? rowTitler(columns);
  const urlCol = columns.find((c) => /^(url|link|website|landing.?page|profile.?url|ad.?url)$/i.test(c));
  for (let i = 0; i < rows.length && !ctx.full(); i++) {
    const row = rows[i];
    const url = urlCol && /^https?:\/\//.test(row[urlCol]) ? row[urlCol] : undefined;
    const item = ctx.add({
      title: titleOf(row).slice(0, 140) || `Row ${i + 1}`,
      url,
      domain: url ? domainOf(url) : undefined,
      locator: locate(row, i),
      fields: row,
    });
    if (!item) break;
    const text = Object.entries(row)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (!text) ctx.fail(item, "empty row");
    else ctx.ready(item, text);
  }
}

async function fromPdf(spec: SourceSpec, ctx: ExpandContext) {
  const src = await load(spec, ctx);
  const pages = await parsePdf(src.bytes.slice());
  const name = spec.title || spec.label.split("/").pop() || "PDF";
  pages.forEach((text, i) => {
    if (ctx.full()) return;
    const item = ctx.add({ title: `${name} · page ${i + 1}`, url: spec.url, locator: `page ${i + 1}` });
    if (!item) return;
    if (text.length < 20) ctx.fail(item, "page has no extractable text (scanned image?)");
    else ctx.ready(item, text);
  });
}

/** Uploaded HTML read from disk: each file is one item, judged on its text, linked to its own address when it declares one. */
async function fromHtmlFiles(spec: SourceSpec, ctx: ExpandContext) {
  for (const id of uploadIdsOf(spec)) {
    if (ctx.full() || ctx.signal.aborted) break;
    const { meta, bytes } = await readUpload(id);
    if (!htmlPageItem(new TextDecoder().decode(bytes), meta.name, ctx)) break;
  }
}

function htmlPageItem(html: string, fileName: string, ctx: ExpandContext): boolean {
  const page = parseHtml(html, UPLOAD_BASE);
  const url = page.canonical ?? undefined;
  const item = ctx.add({ title: page.title || fileName, url, domain: url ? domainOf(url) : undefined, locator: fileName });
  if (!item) return false;
  const text = [page.description, page.text].filter(Boolean).join("\n\n");
  if (text.length < 40) ctx.fail(item, "file has no readable text");
  else ctx.ready(item, text);
  return true;
}

async function fromText(spec: SourceSpec, ctx: ExpandContext) {
  const docs = spec.uploadIds
    ? await Promise.all(
        spec.uploadIds.map(async (id) => {
          const { meta, bytes } = await readUpload(id);
          return { text: new TextDecoder().decode(bytes), name: meta.name, url: undefined as string | undefined };
        }),
      )
    : [await load(spec, ctx)];
  for (const doc of docs) {
    if (ctx.full()) break;
    // An HTML document split as text keeps its headings as section breaks instead of arriving as raw markup.
    const html = spec.fileType === "html" || /\.(html?|xhtml)$/i.test(doc.name) || /<(html|body)[\s>]/i.test(doc.text.slice(0, 5000));
    const chunks = splitText(html ? htmlToHeadedText(doc.text) : doc.text);
    // Sections of a saved page still link back to the page's own address when it declares one.
    if (html && !doc.url) doc.url = parseHtml(doc.text, UPLOAD_BASE).canonical ?? undefined;
    const name = (spec.uploadIds ? doc.name : spec.title || spec.label.split("/").pop()) || "Text";
    chunks.forEach((c, i) => {
      if (ctx.full()) return;
      const item = ctx.add({ title: c.title || `${name} · part ${i + 1}`, url: doc.url ?? spec.url, locator: spec.uploadIds ? `${doc.name} · part ${i + 1}` : `part ${i + 1}` });
      if (item) ctx.ready(item, c.text);
    });
  }
}
