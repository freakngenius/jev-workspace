import { describe, expect, it } from "vitest";
import { parseRobots } from "@/lib/sources/fetch";
import { isPrivateHost } from "@/lib/sources/fetch";
import { guessKindFromName, sheetsExportUrl } from "@/lib/sources/expand";
import { parseCsv, parseFeed, parseHtml, parseJsonRows, parseSitemap, rowTitler, splitText, titleColumn } from "@/lib/sources/parse";

describe("parseHtml", () => {
  it("pulls title, description, main text and absolute links, and drops scripts and nav", () => {
    const html = `<!doctype html><html><head><title>Pricing &amp; Plans</title>
      <meta name="description" content="Start free for 14 days"></head>
      <body><nav><a href="/nav-only">Nav</a> Menu words</nav>
      <main><h1>Pricing</h1><p>Our free trial lasts 14 days. No card needed. This paragraph is long enough to count as the main content of the page for sure, with plenty of words in it.</p>
      <a href="/signup?utm_source=x#top">Sign up</a><a href="mailto:a@b.c">mail</a></main>
      <script>var secret = "nope";</script><footer>Footer text</footer></body></html>`;
    const page = parseHtml(html, "https://acme.com/pricing");
    expect(page.title).toBe("Pricing & Plans");
    expect(page.description).toBe("Start free for 14 days");
    expect(page.text).toContain("free trial lasts 14 days");
    expect(page.text).not.toContain("secret");
    expect(page.text).not.toContain("Footer text");
    expect(page.links).toContain("https://acme.com/signup?utm_source=x");
    expect(page.links.some((l) => l.startsWith("mailto:"))).toBe(false);
  });
});

describe("parseSitemap", () => {
  it("reads url sets and sitemap indexes", () => {
    expect(parseSitemap(`<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc> https://a.com/y </loc></url></urlset>`)).toEqual({
      urls: ["https://a.com/x?a=1&b=2", "https://a.com/y"],
      sitemaps: [],
    });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`).sitemaps).toEqual(["https://a.com/s1.xml"]);
  });
});

describe("parseFeed", () => {
  it("reads RSS items with CDATA and escaped HTML", () => {
    const xml = `<rss><channel><item><title><![CDATA[Agents ship]]></title><link>https://n.com/1</link>
      <description>&lt;p&gt;An &lt;b&gt;agent&lt;/b&gt; framework&lt;/p&gt;</description><pubDate>Thu, 25 Sep 2026</pubDate></item></channel></rss>`;
    const [e] = parseFeed(xml);
    expect(e.title).toBe("Agents ship");
    expect(e.link).toBe("https://n.com/1");
    expect(e.text).toBe("An agent framework");
  });
  it("reads Atom entries with link href", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Paper</title><link href="https://arxiv.org/abs/1"/><summary>We introduce a benchmark.</summary><updated>2026-09-25</updated></entry></feed>`;
    const [e] = parseFeed(xml);
    expect(e.link).toBe("https://arxiv.org/abs/1");
    expect(e.text).toContain("benchmark");
  });
});

describe("tables", () => {
  it("parses CSV with a BOM and skips empty rows", () => {
    const rows = parseCsv("\uFEFFName,Company\nAda,Acme\n,\nGrace,Navy\n");
    expect(rows).toEqual([
      { Name: "Ada", Company: "Acme" },
      { Name: "Grace", Company: "Navy" },
    ]);
  });
  it("finds the biggest array of objects in JSON", () => {
    const rows = parseJsonRows(JSON.stringify({ meta: { n: 2 }, data: { ads: [{ id: 1, body: "Buy" }, { id: 2, body: "Sell" }] } }));
    expect(rows).toEqual([
      { id: "1", body: "Buy" },
      { id: "2", body: "Sell" },
    ]);
  });
  it("picks a title column", () => {
    expect(titleColumn(["id", "Company", "headline"])).toBe("headline");
    expect(titleColumn(["ad_title", "body"])).toBe("ad_title");
    expect(titleColumn(["id", "Company"])).toBe("Company");
    expect(titleColumn(["ad_id", "page_name", "ad_creative_link_title"])).toBe("ad_creative_link_title");
  });
  it("titles LinkedIn rows by full name", () => {
    const title = rowTitler(["First Name", "Last Name", "Company"]);
    expect(title({ "First Name": "Ada", "Last Name": "Lovelace", Company: "Engines" })).toBe("Ada Lovelace");
  });
});

describe("splitText", () => {
  it("splits on markdown headings when present", () => {
    const chunks = splitText("# One\nalpha\n## Two\nbeta");
    expect(chunks.map((c) => c.title)).toEqual(["One", "Two"]);
  });
  it("groups paragraphs near the target size otherwise", () => {
    const para = "word ".repeat(100).trim();
    const chunks = splitText([para, para, para, para].join("\n\n"), 1100);
    expect(chunks.length).toBe(2);
  });
});

describe("robots.txt", () => {
  it("applies the * group and ignores other agents", () => {
    const rules = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok\n");
    expect(rules.disallow).toEqual(["/private"]);
    expect(rules.allow).toEqual(["/private/ok"]);
  });
});

describe("url helpers", () => {
  it("guesses kinds from names", () => {
    expect(guessKindFromName("https://a.com/sitemap.xml")).toBe("sitemap");
    expect(guessKindFromName("leads.csv")).toBe("table");
    expect(guessKindFromName("https://a.com/feed")).toBe("feed");
    expect(guessKindFromName("https://a.com/report.pdf?x=1")).toBe("pdf");
    expect(guessKindFromName("https://a.com/about")).toBeNull();
  });
  it("turns a Google Sheets edit link into a CSV export", () => {
    expect(sheetsExportUrl("https://docs.google.com/spreadsheets/d/AbC_123/edit#gid=77")).toBe(
      "https://docs.google.com/spreadsheets/d/AbC_123/export?format=csv&gid=77",
    );
  });
  it("flags private hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.2.3.4", "192.168.1.9", "172.20.0.1", "[::1]", "printer.local"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["example.com", "172.32.0.1", "8.8.8.8"]) expect(isPrivateHost(h)).toBe(false);
  });
});
