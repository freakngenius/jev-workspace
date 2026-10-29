import { describe, expect, it } from "vitest";
import { briefSections } from "@/components/MissionBrief";
import { firstSentence } from "@/lib/text";

const BRIEF = `Opportunity-contact audit for Example.com. GOAL: Find warm contacts who fit a paid AI systems project. Add rows to https://example.com/p/tracker/3de785 — tag each "Instagram group". IDEAL CONTACT: nontechnical solo operator, consultant, founder; already uses AI, automation, ChatGPT. OFFER ("The Starter Build"): Workflow map = fixed-price audit. DISQUALIFY: students, hobbyists. WORKFLOW (staged): Stage 1 (cheap discovery): search followers. Stage 2 (qualify): score each 3/2/1.`;

describe("mission brief", () => {
  it("summarizes by the first sentence", () => {
    expect(firstSentence(BRIEF)).toBe("Opportunity-contact audit for Example.com.");
    expect(firstSentence("x".repeat(300))).toHaveLength(201);
  });

  it("splits a long brief at its all-caps labels, not at acronyms", () => {
    const s = briefSections(BRIEF);
    expect(s.map((x) => x.label)).toEqual([null, "GOAL", "IDEAL CONTACT", 'OFFER ("The Starter Build")', "DISQUALIFY", "WORKFLOW (staged)"]);
    expect(s[1].body).toContain("https://example.com/p/tracker/3de785");
    expect(s[2].body).toContain("AI, automation, ChatGPT");
    expect(s[5].body).toMatch(/^Stage 1/);
  });

  it("keeps a brief without labels as one section", () => {
    expect(briefSections("Find pricing pages that offer a free trial.")).toEqual([{ label: null, body: "Find pricing pages that offer a free trial." }]);
  });
});
