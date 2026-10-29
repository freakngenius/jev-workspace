import { NextResponse } from "next/server";
import { z } from "zod";
import { bad, guard } from "@/lib/http";
import { makePlan } from "@/lib/planner";
import { groupHtmlUploads, sniffSource } from "@/lib/sources/expand";
import { isDmThreadPath } from "@/lib/sources/instagram";
import { readUploadMeta } from "@/lib/store";

export const dynamic = "force-dynamic";

const Body = z.object({
  mission: z.string().trim().min(3, "Say what the mission is.").max(8000, "Keep the mission under 8,000 characters."),
  links: z.array(z.string().trim().min(1)).max(40).default([]),
  uploadIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{8,64}$/)).max(5000).default([]),
  planner: z.enum(["auto", "anthropic", "claude-cli", "ollama", "template"]).default("auto"),
});

export async function POST(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Bad request");
  const { mission, links, uploadIds, planner } = parsed.data;
  if (!links.length && !uploadIds.length) return bad("Add at least one link or file for Jev to work through.");

  // DM threads from an Instagram export are not sources of their own: they attach to the accounts as a warmth signal.
  const metas = await Promise.all(uploadIds.map((id) => readUploadMeta(id).catch(() => null)));
  if (metas.some((m) => !m)) return bad("An uploaded file is missing. Upload it again.");
  const dmIds = metas.filter((m) => isDmThreadPath(m!.path ?? "")).map((m) => m!.id);
  const fileIds = metas.filter((m) => !isDmThreadPath(m!.path ?? "")).map((m) => m!.id);
  const inputs = [...links.map((url) => ({ url })), ...fileIds.map((uploadId) => ({ uploadId }))];
  const sniffed = await Promise.all(inputs.map((input, i) => sniffSource(input, `s${i + 1}`, req.signal)));
  const sources = await groupHtmlUploads(sniffed, dmIds);
  const plan = await makePlan({ mission, sources, planner }, req.signal);
  return NextResponse.json({ plan });
}
