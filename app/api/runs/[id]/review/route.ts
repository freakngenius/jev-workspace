import { NextResponse } from "next/server";
import { z } from "zod";
import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int().min(0)).max(500).optional(),
  max: z.number().int().min(1).max(200).default(50),
});

/** Sends more of the uncertain band to Claude after the run finished. Progress streams on the run's event stream. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad("Bad request");
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);
  if (engine.running) return bad("The run is still going.", 409);
  void engine.reviewLater(parsed.data.ids, parsed.data.max).catch(() => {});
  return NextResponse.json({ ok: true });
}
