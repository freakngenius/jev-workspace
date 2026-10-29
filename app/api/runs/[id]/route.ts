import { NextResponse } from "next/server";
import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);
  return NextResponse.json(engine.snapshot());
}
