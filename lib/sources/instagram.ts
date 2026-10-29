import { parse as parseHtmlDoc } from "node-html-parser";
import { warmthRank } from "../text";
import type { Row } from "./parse";

/**
 * Instagram data exports: DM threads as a warmth signal, and extra tables
 * (a follower-tool CSV with names, flags or bios) merged into the accounts
 * from the followers and following lists.
 *
 * Message text is read here, on this machine, only to count messages and to
 * spot a few "can you help" phrases. No message text is stored or sent on.
 */

/** Path of one DM thread inside an export: messages/inbox/<name>_<id>/message_1.html. */
export function isDmThreadPath(path: string): boolean {
  return /(^|\/)messages\/(inbox|message_requests)\/[^/]+\/message_\d+\.html$/i.test(path);
}

export function dmFolderOf(path: string): string {
  return path.split("/").slice(-2, -1)[0] ?? "";
}

/** Lowercase letters and digits only, accents folded: how Instagram names thread folders, and a fair key for handles. */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Phrases that mean "this person asked for help or a way to work together", from the audit brief.
const ASKS: [RegExp, string][] = [
  [/\bcan you help\b|\bcould you help\b|\bhelp me (with|set|figure|build)\b/i, "asked for help"],
  [/\bwork (together|with you)\b|\bcollab(orate)?\b/i, "work together"],
  [/\bteach me\b|\bshow me how\b|\bhow do (i|you) (set up|build|use)\b/i, "teach me"],
  [/\bhow much (do you|would you|for)\b|\byour rates?\b|\bhire you\b|\bpricing\b/i, "asked about pricing"],
  [/\b(hop|jump|get) on a call\b|\bbook a call\b|\bcan we (chat|talk|meet)\b/i, "wants a call"],
];

export interface DmThread {
  folder: string;
  title: string;
  keys: string[];
  group: boolean;
  total: number;
  fromThem: number;
  fromOwner: number;
  first: string | null;
  last: string | null;
  lastFrom: "them" | "owner" | null;
  asks: string[];
}

interface RawMessage {
  sender: string;
  at: Date | null;
  text: string;
}

interface RawThread {
  folder: string;
  title: string;
  messages: RawMessage[];
}

export function parseDmThread(html: string, folder: string): RawThread {
  const root = parseHtmlDoc(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = (root.querySelector("title")?.text ?? "").trim();
  const messages: RawMessage[] = [];
  for (const block of root.querySelectorAll("main > div")) {
    const sender = (block.querySelector("h2")?.text ?? "").trim();
    if (!sender) continue;
    const stamp = block.querySelector("div._a6-o")?.text?.trim() ?? block.childNodes.at(-1)?.text?.trim() ?? "";
    const when = Date.parse(stamp);
    const text = (block.querySelector("div._a6-p")?.text ?? "").trim();
    messages.push({ sender, at: Number.isFinite(when) ? new Date(when) : null, text });
  }
  return { folder, title, messages };
}

/** The export's owner is the one sender present in nearly every thread. */
export function ownerOf(threads: RawThread[]): string | null {
  const seen = new Map<string, number>();
  for (const t of threads) for (const s of new Set(t.messages.map((m) => m.sender))) seen.set(s, (seen.get(s) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const e of seen) if (!best || e[1] > best[1]) best = e;
  return best && best[1] >= Math.max(2, threads.length * 0.5) ? best[0] : null;
}

/** YYYY-MM-DD in local time: a UTC date shifts evening messages to the next day. */
const day = (d: Date | null) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null;

export function summarizeThreads(raw: RawThread[]): { owner: string | null; threads: DmThread[] } {
  const owner = ownerOf(raw);
  const threads = raw.map((t): DmThread => {
    const senders = new Set(t.messages.map((m) => m.sender));
    const dated = t.messages.filter((m) => m.at).sort((a, b) => a.at!.getTime() - b.at!.getTime());
    const theirs = t.messages.filter((m) => m.sender !== owner);
    const asks = new Set<string>();
    for (const m of theirs) for (const [re, label] of ASKS) if (re.test(m.text)) asks.add(label);
    const lastMsg = dated.at(-1) ?? t.messages[0];
    const slug = t.folder.replace(/_\d+$/, "");
    return {
      folder: t.folder,
      title: t.title,
      keys: [...new Set([slug, normName(t.title)].filter((k) => k.length >= 3 && !/^\d+$/.test(k)))],
      group: [...senders].filter((s) => s !== owner).length > 1,
      total: t.messages.length,
      fromThem: theirs.length,
      fromOwner: t.messages.length - theirs.length,
      first: day(dated[0]?.at ?? null),
      last: day(lastMsg?.at ?? null),
      lastFrom: lastMsg ? (lastMsg.sender === owner ? "owner" : "them") : null,
      asks: [...asks],
    };
  });
  return { owner, threads };
}

// Table columns that are identifiers or plumbing, not evidence: they cost tokens and tell Jev nothing.
const NOISE = /^(entity ?id|id|avatar|profile ?pic.*|source ?id|source ?type|source|session ?id|captured ?at|username|user ?name|handle|profile ?url|url|link)$/i;

function handleColumn(columns: string[]): string | null {
  return columns.find((c) => /^(username|user ?name|handle|instagram( handle)?)$/i.test(c.trim())) ?? null;
}

export function hasHandleColumn(columns: string[]): boolean {
  return handleColumn(columns) !== null;
}

/** A table is account data when it names accounts by handle: a follower-tool CSV, a bio export. */
export function isAccountTable(rows: Row[]): boolean {
  const cols = Object.keys(rows[0] ?? {});
  return rows.length > 0 && handleColumn(cols) !== null;
}

export { warmthRank };

function relationshipOf(list: string, dms: boolean): string {
  const mutual = list.includes("Followers") && list.includes("Following");
  if (dms && mutual) return "DMs + mutual follow";
  if (dms) return list ? "DMs" : "DMs only";
  if (mutual) return "mutual follow";
  if (list.includes("Followers") || /follower/i.test(list)) return "follows you";
  if (list.includes("Following")) return "you follow";
  return "unknown";
}

export interface AccountMerge {
  rows: Row[];
  accounts: number;
  tableRowsMerged: number;
  tableRowsAdded: number;
  threads: number;
  threadsMatched: number;
  threadsAdded: number;
}

/**
 * One row per account. List rows (from followers/following HTML) are the
 * spine; account tables fill in names, flags or bios by handle, and add the
 * accounts the lists lack; DM threads attach by name, and one-to-one threads
 * that match no account become their own rows ("DMs only") so no warm
 * contact is dropped.
 */
export function mergeAccounts(listRows: Row[], tables: Row[][], threads: DmThread[]): AccountMerge {
  const rows = listRows.map((r) => ({ ...r }));
  const byHandle = new Map<string, Row>();
  for (const r of rows) if (r.name) byHandle.set(normName(r.name), r);

  let tableRowsMerged = 0;
  let tableRowsAdded = 0;
  for (const table of tables) {
    const hc = handleColumn(Object.keys(table[0] ?? {}));
    if (!hc) continue;
    for (const t of table) {
      const handle = (t[hc] ?? "").trim().replace(/^@/, "");
      if (!handle) continue;
      const extra: Row = {};
      for (const [k, v] of Object.entries(t)) if (!NOISE.test(k.trim()) && v.trim() && !/^https?:\/\/[^ ]*\.(fbcdn|cdninstagram)\./i.test(v)) extra[k.trim()] = v.trim();
      const existing = byHandle.get(normName(handle));
      if (existing) {
        for (const [k, v] of Object.entries(extra)) if (!existing[k]) existing[k] = v;
        tableRowsMerged++;
      } else {
        const relation = extra.Relation ?? extra.relation ?? "";
        const row: Row = {
          list: /follower/i.test(relation) ? "Followers" : /following/i.test(relation) ? "Following" : "Table",
          name: handle,
          link: t["Profile URL"] ?? t.profile_url ?? `https://www.instagram.com/${handle}`,
          details: "",
          ...extra,
        };
        rows.push(row);
        byHandle.set(normName(handle), row);
        tableRowsAdded++;
      }
    }
  }

  // Name keys: the handle itself, and a display name when a table supplied one.
  const byKey = new Map<string, Row | null>();
  const claim = (key: string, row: Row) => {
    if (key.length < 3) return;
    const prev = byKey.get(key);
    byKey.set(key, prev === undefined || prev === row ? row : null); // two accounts on one key: ambiguous, attach neither
  };
  for (const r of rows) {
    claim(normName(r.name ?? ""), r);
    const display = r.Name ?? r["Full name"] ?? r.full_name ?? r["Display name"];
    if (display) claim(normName(display), r);
  }

  let threadsMatched = 0;
  let threadsAdded = 0;
  const oneToOne = threads.filter((t) => !t.group && t.total > 0);
  for (const t of oneToOne) {
    const row = t.keys.map((k) => byKey.get(k)).find((r): r is Row => Boolean(r));
    const fields: Row = {
      dm_messages: String(t.total),
      dm_from_them: String(t.fromThem),
      dm_first: t.first ?? "",
      dm_last: t.last ?? "",
      dm_last_from: t.lastFrom === "owner" ? "you" : t.lastFrom === "them" ? "them" : "",
      dm_signals: t.asks.join(", "),
    };
    if (row && !row.dm_messages) {
      Object.assign(row, fields, { dm_name: t.title });
      threadsMatched++;
    } else if (!row) {
      rows.push({ list: "", name: t.title, link: "", details: `DM thread with ${t.title}`, ...fields });
      threadsAdded++;
    }
  }

  for (const r of rows) r.relationship = relationshipOf(r.list ?? "", Boolean(r.dm_messages));
  return { rows, accounts: rows.length, tableRowsMerged, tableRowsAdded, threads: threads.length, threadsMatched, threadsAdded };
}
