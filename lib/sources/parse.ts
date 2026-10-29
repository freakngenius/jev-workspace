import { parse as parseHtmlDoc, type HTMLElement } from "node-html-parser";
import Papa from "papaparse";

/** Pure parsers. No network, no disk: every function here takes text or bytes and returns data. */

export interface ParsedPage {
  title: string;
  description: string;
  text: string;
  links: string[];
  /** The page's own address when it declares one (canonical link or og:url); saved pages keep it. */
  canonical: string | null;
}

const DROP = "script,style,noscript,svg,iframe,template,nav,footer,form,button,select";

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const root = parseHtmlDoc(html, {
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });
  const meta = (sel: string) => root.querySelector(sel)?.getAttribute("content")?.trim() ?? "";
  const title =
    clean(root.querySelector("title")?.text ?? "") ||
    meta('meta[property="og:title"]') ||
    clean(root.querySelector("h1")?.text ?? "");
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const declared = root.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || meta('meta[property="og:url"]');
  const canonical = declared && /^https?:\/\//i.test(declared) ? declared : null;

  const links = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    const abs = href ? absolute(href, baseUrl) : null;
    if (abs) links.add(abs);
  }

  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll(DROP)) el.remove();
  const main = pickMain(body);
  const text = collapse(main.structuredText);
  return { title, description, text, links: [...links], canonical };
}

export interface HtmlRecord {
  title: string;
  url: string | null;
  text: string;
}

/**
 * Finds the list inside a page, if the page is a list: one container whose
 * children repeat the same shape, most carrying their own distinct link, and
 * holding most of the page's text. Data exports (Instagram followers,
 * bookmarks) and saved search results pass; articles and pages with a link
 * menu do not, so they return null and stay one item.
 */
export function htmlRecords(html: string, baseUrl: string): HtmlRecord[] | null {
  const root = parseHtmlDoc(html, {
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });
  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll(DROP)) el.remove();
  const pageText = collapse(body.structuredText).length;
  const shape = (el: HTMLElement) =>
    `${el.rawTagName?.toLowerCase()}.${(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort().join(".")}`;
  const linkOf = (el: HTMLElement) => {
    for (const a of el.querySelectorAll("a[href]")) {
      const url = absolute(a.getAttribute("href") ?? "", baseUrl);
      if (url) return url;
    }
    return null;
  };

  let best: HTMLElement[] | null = null;
  for (const el of body.querySelectorAll("*")) {
    const kids = el.childNodes.filter((c): c is HTMLElement => c.nodeType === 1);
    if (kids.length < 5) continue;
    const groups = new Map<string, HTMLElement[]>();
    for (const k of kids) {
      const g = groups.get(shape(k));
      if (g) g.push(k);
      else groups.set(shape(k), [k]);
    }
    for (const members of groups.values()) {
      if (members.length < 5 || members.length < kids.length / 2 || (best && members.length <= best.length)) continue;
      const links = members.map(linkOf).filter((l): l is string => l !== null);
      if (links.length < members.length * 0.8 || new Set(links).size < links.length * 0.8) continue;
      const listText = members.reduce((a, m) => a + collapse(m.structuredText).length, 0);
      if (listText < pageText * 0.5) continue;
      best = members;
    }
  }
  if (!best) return null;

  return best.map((m) => {
    const text = collapse(m.structuredText);
    const url = linkOf(m);
    const heading = clean(m.querySelector("h1,h2,h3,h4,h5,h6")?.text ?? "");
    const anchor = clean(m.querySelector("a[href]")?.text ?? "");
    const title =
      heading || (anchor && !/^https?:\/\//i.test(anchor) ? anchor : "") || (url ? labelFromUrl(url) : "") || text.split("\n")[0];
    return { title: title.slice(0, 140), url, text };
  });
}

/** The last meaningful path segment of a link, e.g. a profile handle; the host when there is none. */
function labelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The page's <title> without extracting the whole body text. */
export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1]) : "";
}

/** HTML to plain text with h1-h3 turned into markdown headings, so splitText can cut a long document into sections. */
export function htmlToHeadedText(html: string): string {
  const root = parseHtmlDoc(html, {
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });
  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll(DROP)) el.remove();
  for (const h of body.querySelectorAll("h1,h2,h3")) {
    const text = clean(h.text);
    if (text) h.textContent = `# ${text}`;
  }
  return collapse(body.structuredText);
}

function pickMain(body: HTMLElement): HTMLElement {
  for (const sel of ["main", "article", '[role="main"]', "#content", ".content"]) {
    const el = body.querySelector(sel);
    if (el && collapse(el.structuredText).length > 200) return el;
  }
  return body;
}

function absolute(href: string, base: string): string | null {
  if (/^(mailto|tel|javascript|data):/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export interface SitemapResult {
  urls: string[];
  sitemaps: string[];
}

export function parseSitemap(xml: string): SitemapResult {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    decodeEntities(m[1].trim()),
  );
  return /<sitemapindex[\s>]/i.test(xml) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

export interface FeedEntry {
  title: string;
  link: string;
  text: string;
  date: string;
}

export function parseFeed(xml: string): FeedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const body =
      tag(b, "content:encoded") || tag(b, "content") || tag(b, "description") || tag(b, "summary");
    return {
      title: htmlToText(tag(b, "title")),
      link: decodeEntities((atomLink ?? tag(b, "link")).trim()),
      text: htmlToText(body),
      date: (tag(b, "pubDate") || tag(b, "updated") || tag(b, "published")).trim(),
    };
  });
}

export function isFeed(text: string): boolean {
  return /<rss[\s>]|<feed[\s>][\s\S]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(text.slice(0, 4000));
}

export function isSitemap(text: string): boolean {
  return /<urlset[\s>]|<sitemapindex[\s>]/i.test(text.slice(0, 4000));
}

function tag(block: string, name: string): string {
  const esc = name.replace(":", "\\:");
  const m = block.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

export function htmlToText(fragment: string): string {
  if (!fragment) return "";
  const decoded = /&lt;/.test(fragment) && !/</.test(fragment.replace(/&lt;/g, "")) ? decodeEntities(fragment) : fragment;
  return collapse(parseHtmlDoc(decoded).structuredText);
}

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const out = Papa.parse<Record<string, unknown>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return out.data.map(stringifyRow).filter((r) => Object.values(r).some((v) => v.trim()));
}

/** A JSON array of objects, or the largest such array one or two levels down. */
export function parseJsonRows(text: string): Row[] {
  const data: unknown = JSON.parse(text);
  const arr = findArray(data, 0);
  return arr ? arr.map((r) => stringifyRow(isObject(r) ? r : { value: r })) : [];
}

function findArray(v: unknown, depth: number): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!isObject(v) || depth > 2) return null;
  let best: unknown[] | null = null;
  for (const child of Object.values(v)) {
    const arr = findArray(child, depth + 1);
    if (arr && (!best || arr.length > best.length)) best = arr;
  }
  return best;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyRow(r: Record<string, unknown>): Row {
  const row: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (!k) continue;
    row[k] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return row;
}

/** Best column to title a row with: the first header that looks like a name or title. */
export function titleColumn(columns: string[]): string | null {
  const prefs = [
    /^(title|headline|name|full.?name|ad.?title|ad.?name|subject)$/i,
    /title|headline|subject/i,
    /name/i,
    /^(company|brand|advertiser|organization)$/i,
  ];
  for (const re of prefs) {
    const hit = columns.find((c) => re.test(c));
    if (hit) return hit;
  }
  return columns[0] ?? null;
}

/** Titles a row. "First Name" plus "Last Name" (a LinkedIn export) reads as one name. */
export function rowTitler(columns: string[]): (row: Row) => string {
  const first = columns.find((c) => /^first.?name$/i.test(c));
  const last = columns.find((c) => /^last.?name$/i.test(c));
  if (first) return (r) => [r[first], last ? r[last] : ""].filter(Boolean).join(" ").trim();
  const col = titleColumn(columns);
  return (r) => (col ? (r[col] ?? "").trim() : "");
}

export async function parsePdf(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map(collapse);
}

export interface Chunk {
  title: string;
  text: string;
}

/** Splits prose into sections: markdown headings when present, else paragraph groups near `target` chars. */
export function splitText(text: string, target = 1500): Chunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headed: Chunk[] = [];
  let current: Chunk | null = null;
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      if (current && current.text.trim()) headed.push(current);
      current = { title: h[1].trim(), text: "" };
    } else {
      current ??= { title: "", text: "" };
      current.text += line + "\n";
    }
  }
  if (current && current.text.trim()) headed.push(current);
  if (headed.length > 1) return headed.map((c) => ({ title: c.title, text: collapse(c.text) }));

  // One heading over the whole text still names it; long bodies are cut into titled parts.
  const heading = headed.length === 1 ? headed[0].title : "";
  const body = heading ? headed[0].text : text;
  const paras = body.split(/\n\s*\n/).map(collapse).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length > target) {
      chunks.push({ title: "", text: buf });
      buf = "";
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push({ title: "", text: buf });
  if (!heading) return chunks;
  return chunks.map((c, i) => ({ title: chunks.length > 1 ? `${heading} · part ${i + 1}` : heading, text: c.text }));
}

export function collapse(s: string): string {
  return s
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clean(s: string): string {
  return collapse(decodeEntities(s)).replace(/\n/g, " ");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
