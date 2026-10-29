import { NextResponse } from "next/server";
import { liveRun } from "@/lib/engine";
import { bad, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const engine = liveRun(id);
  if (!engine) return bad("No live run with that id.", 404);
  engine.stop();
  return NextResponse.json({ ok: true });
}
