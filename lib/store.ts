import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Item, RunMeta, RunSnapshot } from "./types";

/** Runs and uploads live on local disk under DATA_DIR (default .data). */

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DATA_DIR || ".data");
}

const runsDir = () => path.join(dataDir(), "runs");
const uploadsDir = () => path.join(dataDir(), "uploads");

/** What goes to disk: the snapshot plus each item's full text, so a later review can reread it. */
export interface RunRecord extends Omit<RunSnapshot, "items"> {
  items: Item[];
}

export interface UploadMeta {
  id: string;
  name: string;
  /** Path inside a dropped folder, e.g. your_instagram_activity/messages/inbox/ana_123/message_1.html. */
  path?: string;
  size: number;
  type: string;
  createdAt: string;
}

const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/;

function assertId(id: string) {
  if (!SAFE_ID.test(id)) throw new Error(`bad id: ${id}`);
}

async function writeAtomic(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function saveUpload(name: string, type: string, bytes: Uint8Array): Promise<UploadMeta> {
  const rel = name
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(-400);
  const meta: UploadMeta = {
    id: randomUUID(),
    name: path.basename(name).slice(0, 200),
    path: rel.includes("/") ? rel : undefined,
    size: bytes.byteLength,
    type,
    createdAt: new Date().toISOString(),
  };
  await mkdir(uploadsDir(), { recursive: true });
  await writeFile(path.join(uploadsDir(), meta.id), bytes);
  await writeAtomic(path.join(uploadsDir(), `${meta.id}.json`), JSON.stringify(meta));
  return meta;
}

export async function readUploadMeta(id: string): Promise<UploadMeta> {
  assertId(id);
  return JSON.parse(await readFile(path.join(uploadsDir(), `${id}.json`), "utf8")) as UploadMeta;
}

export async function readUpload(id: string): Promise<{ meta: UploadMeta; bytes: Uint8Array }> {
  assertId(id);
  const meta = JSON.parse(await readFile(path.join(uploadsDir(), `${id}.json`), "utf8")) as UploadMeta;
  const bytes = new Uint8Array(await readFile(path.join(uploadsDir(), id)));
  return { meta, bytes };
}

export function metaOf(run: RunRecord | RunSnapshot): RunMeta {
  return {
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    status: run.status,
    title: run.plan.title,
    mission: run.plan.mission,
    unit: run.plan.unit,
    judged: run.metrics.judged,
    bands: run.metrics.bands,
    costUsd: run.metrics.jev.costUsd + run.metrics.claude.costUsd,
    elapsedMs: run.metrics.elapsedMs,
  };
}

export async function saveRun(run: RunRecord): Promise<void> {
  assertId(run.id);
  await writeAtomic(path.join(runsDir(), `${run.id}.json`), JSON.stringify(run));
  await writeAtomic(path.join(runsDir(), `${run.id}.meta.json`), JSON.stringify(metaOf(run)));
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  assertId(id);
  try {
    return JSON.parse(await readFile(path.join(runsDir(), `${id}.json`), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export async function listRuns(limit = 30): Promise<RunMeta[]> {
  let names: string[];
  try {
    names = await readdir(runsDir());
  } catch {
    return [];
  }
  const metas = await Promise.all(
    names
      .filter((n) => n.endsWith(".meta.json"))
      .map(async (n) => {
        try {
          return JSON.parse(await readFile(path.join(runsDir(), n), "utf8")) as RunMeta;
        } catch {
          return null;
        }
      }),
  );
  return metas
    .filter((m): m is RunMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
