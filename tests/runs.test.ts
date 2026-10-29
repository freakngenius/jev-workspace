import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentRuns } from "@/lib/engine";
import type { RunMeta, RunStatus } from "@/lib/types";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "jev-runs-"));
  process.env.DATA_DIR = dir;
  await mkdir(path.join(dir, "runs"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function saved(status: RunStatus, createdAt: string): Promise<string> {
  const id = randomUUID();
  const meta: RunMeta = {
    id,
    createdAt,
    status,
    title: "Lead triage",
    mission: "Find warm leads",
    unit: { singular: "account", plural: "accounts" },
    judged: 0,
    bands: { match: 0, uncertain: 0, reject: 0 },
    costUsd: 0,
    elapsedMs: 0,
  };
  await writeFile(path.join(dir, "runs", `${id}.meta.json`), JSON.stringify(meta));
  return id;
}

describe("recentRuns", () => {
  it("reports what the server is doing, not what the files last said", async () => {
    // Cut off by a restart: the file still says running, but nothing is.
    const lost = await saved("running", "2026-10-01T00:00:00.000Z");
    // Finished, then reopened for a qualify that has not saved yet.
    const qualifying = await saved("done", "2026-10-02T00:00:00.000Z");
    const finished = await saved("done", "2026-10-03T00:00:00.000Z");
    const registry = (globalThis as { __jevRuns?: Map<string, unknown> }).__jevRuns!;
    registry.set(qualifying, { record: { status: "running" } });
    try {
      const status = Object.fromEntries((await recentRuns()).map((r) => [r.id, r.status]));
      expect(status).toEqual({ [lost]: "error", [qualifying]: "running", [finished]: "done" });
    } finally {
      registry.delete(qualifying);
    }
  });
});
