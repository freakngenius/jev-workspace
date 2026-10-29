import { NextResponse } from "next/server";
import { z } from "zod";
import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({ labels: z.record(z.string().regex(/^\d+$/), z.boolean()) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("Bad request");
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);
  engine.setSpotCheck(parsed.data.labels);
  return NextResponse.json({ spotCheck: engine.record.spotCheck });
}
