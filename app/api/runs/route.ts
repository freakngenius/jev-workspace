import { NextResponse } from "next/server";
import { launch, recentRuns } from "@/lib/engine";
import { bad, guard } from "@/lib/http";
import { jevConfig } from "@/lib/jev";
import { PlanSchema } from "@/lib/planner";
import type { Plan } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  return NextResponse.json({ runs: await recentRuns() });
}

export async function POST(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as { plan?: unknown } | null;
  const parsed = PlanSchema.safeParse(body?.plan);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return bad(`Plan is not valid: ${issue?.path.join(".")} ${issue?.message}`);
  }
  const cfg = jevConfig();
  if (!cfg.ready) return bad(cfg.reason ?? "Jev is not configured.", 412);
  const engine = launch(parsed.data as Plan);
  return NextResponse.json({ id: engine.id });
}
