import { describe, expect, it } from "vitest";
import { bandOf, questionsFor, stateFor } from "@/lib/engine";
import { costUsd, jevConfig, readAnswer } from "@/lib/jev";
import { PlanSchema, templatePlan } from "@/lib/planner";
import type { Plan } from "@/lib/types";

function plan(extra: Partial<Plan> = {}): Plan {
  return {
    ...templatePlan({ mission: "Find pricing pages", sources: [{ id: "s1", label: "https://a.com", url: "https://a.com", kind: "site", crawl: true }] }),
    ...extra,
  };
}

describe("bands", () => {
  it("cuts P(yes) at the thresholds, inclusive", () => {
    const t = { yes: 0.8, no: 0.2 };
    expect(bandOf(0.8, t)).toBe("match");
    expect(bandOf(0.79, t)).toBe("uncertain");
    expect(bandOf(0.2, t)).toBe("reject");
    expect(bandOf(0.21, t)).toBe("uncertain");
  });
});

describe("questions", () => {
  it("bundles the gate, dimensions and one noul per persona", () => {
    const p = plan({
      dimensions: [
        { key: "hook", label: "Hook", type: "choice", instructions: "Which hook?", options: [{ key: "pain", description: "Names a pain" }, { key: "proof", description: "Shows proof" }] },
        { key: "clarity", label: "Clarity", type: "score", instructions: "How clear?", levels: ["Vague", "Clear"] },
      ],
      panel: { action: "click this ad", personas: [{ key: "mom", label: "Busy parent", description: "Two kids, no time." }, { key: "cto", label: "CTO", description: "Series B." }] },
    });
    const qs = questionsFor(p);
    expect(qs.map((q) => q.key)).toEqual(["gate", "d_hook", "d_clarity", "p_mom", "p_cto"]);
    expect(qs[1].q.criteria).toEqual({ pain: "Names a pain", proof: "Shows proof" });
    expect(qs[2].q.criteria).toEqual(["Vague", "Clear"]);
    expect(qs[3].q.instructions).toContain("Would this person click this ad");
  });
  it("truncates the state to the per-item limit and says so", () => {
    const p = plan();
    p.limits.maxCharsPerItem = 200;
    const s = stateFor({ id: 0, sourceId: "s1", title: "T", url: "https://a.com", status: "ready", chars: 999, text: "x".repeat(999) }, p);
    expect(s).toContain("Page: T");
    expect(s).toContain("[truncated]");
    expect(s.length).toBeLessThan(300);
  });
});

describe("answers", () => {
  it("reads each answer type and rejects the wrong shape", () => {
    expect(readAnswer("noul", { noul: 0.93 })).toEqual({ v: 0.93 });
    expect(readAnswer("noul", { noul: 1.4 })).toEqual({ v: 1 });
    expect(readAnswer("choice", { choice: "pain", confidence: 0.7 })).toEqual({ v: "pain", c: 0.7 });
    expect(readAnswer("score", { score: 2.4 })).toEqual({ v: 2.4, c: undefined });
    expect(readAnswer("noul", { choice: "x" })).toBeNull();
    expect(readAnswer("choice", null)).toBeNull();
  });
  it("prices input tokens only", () => {
    expect(costUsd(1_000_000, 0.042)).toBeCloseTo(0.042, 10);
    expect(costUsd(2500, 0.042)).toBeCloseTo(0.000105, 10);
  });
});

describe("config", () => {
  it("routes sk-or- keys to OpenRouter and reports a missing key", () => {
    expect(jevConfig({ OPENROUTER_API_KEY: "sk-or-abc" } as unknown as NodeJS.ProcessEnv).name).toBe("openrouter");
    expect(jevConfig({ TYPESAFE_API_KEY: "ts-abc" } as unknown as NodeJS.ProcessEnv).url).toBe("https://api.typesafe.ai/v1/systemone");
    const missing = jevConfig({} as unknown as NodeJS.ProcessEnv);
    expect(missing.ready).toBe(false);
    expect(missing.reason).toMatch(/TYPESAFE_API_KEY/);
  });
});

describe("plan schema", () => {
  it("accepts a template plan and rejects a bad question key", () => {
    expect(PlanSchema.safeParse(plan()).success).toBe(true);
    const bad = plan({ dimensions: [{ key: "Bad Key", label: "x", type: "noul", instructions: "Is it?" }] });
    expect(PlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe("planner guards", () => {
  it("refuses type names and placeholders as questions", async () => {
    const { usableQuestion } = await import("@/lib/planner");
    expect(usableQuestion("noul")).toBe(false);
    expect(usableQuestion("choice: which one")).toBe(false);
    expect(usableQuestion("Is it?")).toBe(false);
    expect(usableQuestion("Does this story describe an AI agent or a tool for building agents?")).toBe(true);
  });
  it("emits a draft-7 schema the claude CLI accepts", async () => {
    const { jsonSchema } = await import("@/lib/claude");
    const { z } = await import("zod");
    const js = jsonSchema(z.object({ a: z.string() }));
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe("object");
  });
});

describe("match bar", () => {
  it("keeps the planner's bar between 0.5 and 0.95", async () => {
    const { matchBar } = await import("@/lib/planner");
    expect(matchBar(0.6)).toBe(0.6);
    expect(matchBar(0.2)).toBe(0.5);
    expect(matchBar(1.4)).toBe(0.95);
    expect(matchBar(Number.NaN)).toBe(0.8);
  });
});
