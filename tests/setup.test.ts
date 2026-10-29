import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/setup.mjs");
const EXAMPLE = path.resolve(import.meta.dirname, "../.env.example");
const dirs: string[] = [];

function scratch(envLocal?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-setup-"));
  dirs.push(dir);
  copyFileSync(EXAMPLE, path.join(dir, ".env.example"));
  if (envLocal !== undefined) writeFileSync(path.join(dir, ".env.local"), envLocal);
  return dir;
}

// Answers go in on stdin, one per question, the way a person would type them.
function setup(dir: string, answers: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: answers.map((a) => `${a}\n`).join(""),
    env: { ...process.env, JEV_SETUP_ROOT: dir, JEV_BASE_URL: "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const file = path.join(dir, ".env.local");
  return { status: r.status, out: `${r.stdout}${r.stderr}`, env: existsSync(file) ? readFileSync(file, "utf8") : null };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("npm run setup", () => {
  it("saves a Jev key into a new .env.local built from .env.example, readable only by its owner", () => {
    const dir = scratch();
    const r = setup(dir, ["jev-test-key-1234", "", "n"]);
    expect(r.status).toBe(0);
    expect(r.env).toMatch(/^TYPESAFE_API_KEY=jev-test-key-1234$/m);
    expect(r.env).toMatch(/^# ANTHROPIC_API_KEY=$/m);
    expect(r.env).toContain("# DATA_DIR=.data");
    expect(r.out).not.toContain("jev-test-key-1234");
    if (process.platform !== "win32") expect(statSync(path.join(dir, ".env.local")).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("turns on the Anthropic key when one is given", () => {
    const dir = scratch();
    const r = setup(dir, ["jev-test-key-1234", "anthropic-test-key", "n"]);
    expect(r.status).toBe(0);
    expect(r.env).toMatch(/^ANTHROPIC_API_KEY=anthropic-test-key$/m);
    expect(r.env).not.toMatch(/^# ANTHROPIC_API_KEY=/m);
    expect(r.out).not.toContain("anthropic-test-key");
  }, 30_000);

  it("keeps a saved key and every other setting unless told to replace it", () => {
    const dir = scratch("TYPESAFE_API_KEY=old-key-abcd\nDATA_DIR=.custom\n");
    const kept = setup(dir, ["", "", "n"]);
    expect(kept.status).toBe(0);
    expect(kept.env).toBe("TYPESAFE_API_KEY=old-key-abcd\nDATA_DIR=.custom\n");
    expect(kept.out).toContain("…abcd");
    expect(kept.out).not.toContain("old-key-abcd");

    const replaced = setup(dir, ["n", "new-key-5678", "", "n"]);
    expect(replaced.status).toBe(0);
    expect(replaced.env).toBe("TYPESAFE_API_KEY=new-key-5678\nDATA_DIR=.custom\n");
  }, 30_000);

  it("refuses something that is not a key and saves nothing", () => {
    const dir = scratch();
    const r = setup(dir, ["not a key", "", "n"]);
    expect(r.status).toBe(1);
    expect(r.env).toBeNull();
  }, 30_000);
});
