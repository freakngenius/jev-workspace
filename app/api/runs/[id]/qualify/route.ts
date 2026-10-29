import { NextResponse } from "next/server";
import { z } from "zod";
import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(z.number().int().min(0)).min(1).max(200) });

/** Claude scores chosen candidates 1-3 with a reason and outreach context. Progress streams on the run's event stream. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("Pick between 1 and 200 items to qualify.");
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);
  if (engine.running) return bad("The run is still going.", 409);
  void engine.qualify(parsed.data.ids).catch(() => {});
  return NextResponse.json({ ok: true });
}
