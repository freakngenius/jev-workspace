import { describe, expect, it } from "vitest";
import { isDmThreadPath, mergeAccounts, parseDmThread, summarizeThreads } from "@/lib/sources/instagram";
import { outreachRows } from "@/lib/outreach";
import type { RunSnapshot } from "@/lib/types";

const msg = (sender: string, text: string, stamp: string) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${sender}</h2><div class="_3-95 _a6-p"><div><div></div><div>${text}</div><div></div><div></div></div></div><div class="_3-94 _a6-o">${stamp}</div></div>`;
const thread = (title: string, messages: string[]) => `<html><head><title>${title}</title></head><body><main>${messages.join("")}</main></body></html>`;

const OWNER = "Alex Rivera";
const raws = [
  parseDmThread(thread("Jane Doe", [msg("Jane Doe", "Can you help me set up an agent for my studio?", "Sep 20, 2026 9:15 pm"), msg(OWNER, "Happy to", "Sep 21, 2026 8:00 am")]), "janedoe_1790000000000001"),
  parseDmThread(thread("sam.makes", [msg(OWNER, "love the new reel", "Jan 5, 2026 10:00 am")]), "sammakes_1790000000000002"),
  parseDmThread(thread("Pat Stranger", [msg("Pat Stranger", "hey!", "Mar 1, 2026 1:00 pm"), msg(OWNER, "hi", "Mar 1, 2026 1:05 pm")]), "patstranger_1790000000000003"),
  parseDmThread(thread("Crew chat", [msg("Ana", "yo", "Feb 2, 2026 1:00 pm"), msg("Bo", "sup", "Feb 2, 2026 1:01 pm"), msg(OWNER, "hey all", "Feb 2, 2026 1:02 pm")]), "crewchat_1790000000000004"),
];

describe("Instagram DMs", () => {
  it("recognizes DM thread files by their place in the export", () => {
    expect(isDmThreadPath("instagram-x/your_instagram_activity/messages/inbox/janedoe_123/message_1.html")).toBe(true);
    expect(isDmThreadPath("instagram-x/connections/followers_and_following/following.html")).toBe(false);
  });

  it("finds the export's owner and summarizes each thread without keeping text", () => {
    const { owner, threads } = summarizeThreads(raws);
    expect(owner).toBe(OWNER);
    const jane = threads[0];
    expect(jane).toMatchObject({ title: "Jane Doe", total: 2, fromThem: 1, fromOwner: 1, first: "2026-09-20", last: "2026-09-21", lastFrom: "owner", group: false });
    expect(jane.asks).toEqual(["asked for help"]);
    expect(jane.keys).toContain("janedoe");
    expect(JSON.stringify(threads)).not.toContain("studio");
    expect(threads[3].group).toBe(true);
  });

  it("merges tables and DMs into one row per account, keeping warm people who match nobody", () => {
    const { threads } = summarizeThreads(raws);
    const lists = [
      { list: "Followers + Following", name: "jd.studio", link: "https://www.instagram.com/jd.studio", details: "" },
      { list: "Following", name: "sam.makes", link: "https://www.instagram.com/_u/sam.makes", details: "" },
    ];
    const table: Record<string, string>[] = [
      { Username: "jd.studio", Name: "Jane Doe", Biography: "Brand studio for founders", Avatar: "https://scontent.cdninstagram.com/x.jpg", "Entity ID": "42" },
      { Username: "newperson", Name: "New Person", Relation: "follower", Biography: "" },
    ];
    const merged = mergeAccounts(lists, [table], threads);
    const byName = Object.fromEntries(merged.rows.map((r) => [r.name, r]));
    expect(byName["jd.studio"]).toMatchObject({ Name: "Jane Doe", Biography: "Brand studio for founders", dm_messages: "2", dm_signals: "asked for help", relationship: "DMs + mutual follow" });
    expect(byName["jd.studio"].Avatar).toBeUndefined();
    expect(byName["jd.studio"]["Entity ID"]).toBeUndefined();
    expect(byName["sam.makes"]).toMatchObject({ dm_messages: "1", dm_last_from: "you", relationship: "DMs" });
    expect(byName.newperson).toMatchObject({ list: "Followers", relationship: "follows you" });
    expect(byName["Pat Stranger"]).toMatchObject({ relationship: "DMs only", link: "" });
    expect(merged).toMatchObject({ threads: 4, threadsMatched: 2, threadsAdded: 1, tableRowsMerged: 1, tableRowsAdded: 1 });
  });
});

describe("outreach sheet", () => {
  const item = (id: number, p: number, relationship: string, qual?: 1 | 2 | 3) => ({
    id,
    sourceId: "s1",
    title: `acct${id}`,
    url: `https://www.instagram.com/acct${id}`,
    status: "judged" as const,
    chars: 10,
    p,
    band: "reject" as const,
    fields: { name: `acct${id}`, relationship, dm_messages: relationship.startsWith("DMs") ? "4" : "" },
    qual: qual ? { score: qual, why: `why ${id}`, context: `context ${id}`, model: null } : undefined,
  });
  const run = (items: ReturnType<typeof item>[]) =>
    ({ plan: { dimensions: [], thresholds: { yes: 0.8, no: 0.2 } }, items }) as unknown as RunSnapshot;

  it("lists qualified 2s and 3s, strongest and warmest first", () => {
    const rows = outreachRows(run([item(1, 0.4, "you follow", 2), item(2, 0.3, "DMs + mutual follow", 2), item(3, 0.9, "mutual follow", 3), item(4, 0.95, "DMs", 1)]), { yes: 0.8, no: 0.2 });
    expect(rows.map((r) => r.Handle)).toEqual(["@acct3", "@acct2", "@acct1"]);
    expect(rows[0]).toMatchObject({ "Qualification score": 3, "Why qualified": "why 3", "Outreach context": "context 3", Relationship: "mutual follow" });
  });

  it("falls back to matches at the chosen cut before anyone is qualified", () => {
    const rows = outreachRows(run([item(1, 0.45, "you follow"), item(2, 0.35, "DMs"), item(3, 0.2, "mutual follow")]), { yes: 0.3, no: 0.2 });
    expect(rows.map((r) => r.Handle)).toEqual(["@acct2", "@acct1"]);
    expect(rows[0]["DM messages"]).toBe("4");
  });
});
