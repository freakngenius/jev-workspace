import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandSource, groupHtmlUploads, sniffSource, type ExpandContext } from "@/lib/sources/expand";
import { saveUpload } from "@/lib/store";
import type { ClientItem, Item, SourceSpec } from "@/lib/types";

const PAGE_A = `<!doctype html><html><head><title>Alpha pricing</title>
<link rel="canonical" href="https://alpha.example/pricing"><script>var hidden = "secret";</script></head>
<body><nav>Menu</nav><main><h1>Plans</h1><p>Every plan starts with a 14 day free trial and no card.</p>
<h2>Enterprise</h2><p>Talk to sales for volume pricing, SSO and audit logs on the enterprise plan.</p>
<h2>FAQ</h2><p>You can cancel any time from the billing page, and refunds are prorated.</p></main></body></html>`;

const PAGE_B = `<html><head><title>Beta blog</title></head><body><article><h1>Launch notes</h1>
<p>We shipped a new editor this week with offline support and faster sync for large files.</p></article></body></html>`;

let dir: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "jev-uploads-"));
  process.env.DATA_DIR = dir;
  const enc = (s: string) => new TextEncoder().encode(s);
  ids.a = (await saveUpload("alpha.html", "text/html", enc(PAGE_A))).id;
  ids.b = (await saveUpload("beta.htm", "text/html", enc(PAGE_B))).id;
  ids.csv = (await saveUpload("leads.csv", "text/csv", enc("Name,Company\nAda,Acme\n"))).id;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function collector() {
  const items: Item[] = [];
  const texts = new Map<number, string>();
  const failed = new Map<number, string>();
  const ctx: ExpandContext = {
    limits: { maxItems: 100, maxPagesPerSite: 10, crawlDepth: 1, concurrency: 1, itemsPerCall: 1, maxCharsPerItem: 6000 },
    signal: new AbortController().signal,
    add: (draft) => {
      const item: Item = { ...draft, id: items.length, sourceId: "s1", status: "queued", chars: 0 };
      items.push(item);
      return item;
    },
    ready: (item: Item, text: string, patch?: Partial<ClientItem>) => {
      Object.assign(item, patch);
      texts.set(item.id, text);
    },
    patch: (item, patch) => Object.assign(item, patch),
    fail: (item, error) => failed.set(item.id, error),
    skip: (item, reason) => failed.set(item.id, reason),
    full: () => items.length >= 100,
    log: () => {},
  };
  return { ctx, items, texts, failed };
}

async function sniffAll(): Promise<SourceSpec[]> {
  return groupHtmlUploads([
    await sniffSource({ uploadId: ids.a }, "s1"),
    await sniffSource({ uploadId: ids.b }, "s2"),
    await sniffSource({ uploadId: ids.csv }, "s3"),
  ]);
}

describe("uploaded HTML", () => {
  it("sniffs an HTML file as a page with its title", async () => {
    const spec = await sniffSource({ uploadId: ids.a }, "s1");
    expect(spec).toMatchObject({ kind: "page", fileType: "html", title: "Alpha pricing", crawl: false });
  });

  it("groups HTML files dropped together into one source and leaves other files alone", async () => {
    const specs = await sniffAll();
    expect(specs.map((s) => s.kind)).toEqual(["page", "table"]);
    expect(specs[0]).toMatchObject({ label: "2 HTML files", uploadIds: [ids.a, ids.b], fileType: "html" });
    expect(specs[0].uploadId).toBeUndefined();
  });

  it("reads each file as one item, from disk, without scripts, linked to its declared address", async () => {
    const [group] = await sniffAll();
    const { ctx, items, texts, failed } = collector();
    await expandSource(group, ctx);
    expect(failed.size).toBe(0);
    expect(items.map((i) => i.title)).toEqual(["Alpha pricing", "Beta blog"]);
    expect(items[0]).toMatchObject({ url: "https://alpha.example/pricing", domain: "alpha.example", locator: "alpha.html" });
    expect(items[1].url).toBeUndefined();
    expect(texts.get(0)).toContain("14 day free trial");
    expect(texts.get(0)).not.toContain("secret");
  });

  it("splits each file at its headings when read as text", async () => {
    const [group] = await sniffAll();
    const { ctx, items, texts } = collector();
    await expandSource({ ...group, kind: "text" }, ctx);
    expect(items.map((i) => i.title)).toEqual(["Plans", "Enterprise", "FAQ", "Launch notes"]);
    expect(texts.get(1)).toContain("volume pricing");
    expect([...texts.values()].join(" ")).not.toContain("<p>");
  });
});

const entry = (name: string, date: string) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/${name}">${name}</a></div><div>${date}</div></div></div></div>`;
const entryWithHeading = (name: string) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${name}</h2><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/${name}">https://www.instagram.com/_u/${name}</a></div><div>Sep 24, 2026 9:12 am</div></div></div></div>`;
const exportPage = (title: string, entries: string[]) =>
  `<html><head><title>${title}</title></head><body><div class="_a705"><div class="_a70d"><div class="_a70e">${title}</div></div></div><main class="_a706" role="main">${entries.join("")}</main></body></html>`;

describe("HTML lists", () => {
  it("finds every entry of an export list, named by its handle, linked to the profile", async () => {
    const { htmlRecords } = await import("@/lib/sources/parse");
    const followers = exportPage("Followers", ["ada", "grace", "linus", "margaret", "alan", "barbara"].map((n) => entry(n, "Sep 23, 2026 10:15 am")));
    const records = htmlRecords(followers, "https://upload.invalid/");
    expect(records?.map((r) => r.title)).toEqual(["ada", "grace", "linus", "margaret", "alan", "barbara"]);
    expect(records?.[0]).toMatchObject({ url: "https://www.instagram.com/ada" });
    expect(records?.[0].text).toContain("Sep 23, 2026");

    const following = exportPage("Following", ["ada", "grace", "linus", "margaret", "alan"].map(entryWithHeading));
    expect(htmlRecords(following, "https://upload.invalid/")?.map((r) => r.title)).toEqual(["ada", "grace", "linus", "margaret", "alan"]);
  });

  it("leaves articles and pages with a link menu as one page", async () => {
    const { htmlRecords } = await import("@/lib/sources/parse");
    const prose = `<html><body><article>${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} of an essay about pricing, long enough to read like prose and nothing like a list of links.</p>`).join("")}</article></body></html>`;
    expect(htmlRecords(prose, "https://upload.invalid/")).toBeNull();
    const menu = `<html><body><div class="links">${Array.from({ length: 8 }, (_, i) => `<div class="l"><a href="https://a.example/${i}">Link ${i}</a></div>`).join("")}</div><article>${"A long article body that carries the real content of this page. ".repeat(30)}</article></body></html>`;
    expect(htmlRecords(menu, "https://upload.invalid/")).toBeNull();
  });

  it("reads uploaded export files as one item per account, merging people on both lists", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const f1 = await saveUpload("followers_1.html", "text/html", enc(exportPage("Followers", ["ada", "grace", "linus", "margaret", "alan"].map((n) => entry(n, "Sep 23, 2026")))));
    const f2 = await saveUpload("following.html", "text/html", enc(exportPage("Following", ["Ada", "tim", "ken", "dennis", "bjarne", "guido"].map(entryWithHeading))));
    const f3 = await saveUpload("blocked_profiles.html", "text/html", enc(exportPage("Blocked profiles", [])));
    const specs = await groupHtmlUploads([
      await sniffSource({ uploadId: f1.id }, "s1"),
      await sniffSource({ uploadId: f2.id }, "s2"),
      await sniffSource({ uploadId: f3.id }, "s3"),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "table", count: 11, columns: ["list", "name", "link", "details", "relationship"] });
    expect(specs[0].note).toContain("10 accounts, 1 mutual follows");
    expect(specs[0].sampleRows?.[0]).toMatchObject({ name: "ada", list: "Followers + Following", relationship: "mutual follow" });

    const { ctx, items, texts, failed } = collector();
    await expandSource(specs[0], ctx);
    expect(items).toHaveLength(11);
    expect(items[0]).toMatchObject({ title: "ada", url: "https://www.instagram.com/ada", domain: "instagram.com", fields: { list: "Followers + Following" } });
    expect(texts.get(0)).toContain("list: Followers + Following");
    expect(texts.get(0)).toContain("Following: Ada");
    expect(items[5]).toMatchObject({ title: "tim", url: "https://www.instagram.com/_u/tim", fields: { list: "Following", relationship: "you follow" }, locator: "Following" });
    expect(items[10].title).toBe("Blocked profiles");
    expect(failed.get(10)).toBe("file has no readable text");
  });

  it("merges only handle-like names on the same site", async () => {
    const { mergeListRows } = await import("@/lib/sources/expand");
    const rows = mergeListRows([
      { list: "Bookmarks bar", name: "Home page", link: "https://github.com/", details: "Home page" },
      { list: "Other bookmarks", name: "Home page", link: "https://github.com/", details: "Home page" },
      { list: "Followers", name: "sam", link: "https://www.instagram.com/sam", details: "sam" },
      { list: "Followers", name: "sam", link: "https://x.com/sam", details: "sam" },
    ]);
    expect(rows).toHaveLength(4);
  });

  it("raises the item cap to cover every counted entry in the files dropped", async () => {
    const { templatePlan } = await import("@/lib/planner");
    const big: SourceSpec = { id: "s1", label: "2 HTML files", uploadIds: ["a", "b"], fileType: "html", kind: "table", crawl: false, count: 4698 };
    expect(templatePlan({ mission: "Which accounts are brands?", sources: [big] }).limits.maxItems).toBe(4698);
    const link: SourceSpec = { id: "s1", label: "https://a.example", url: "https://a.example", kind: "site", crawl: true, count: 9000 };
    expect(templatePlan({ mission: "Find pricing pages", sources: [link] }).limits.maxItems).toBe(500);
  });
});
