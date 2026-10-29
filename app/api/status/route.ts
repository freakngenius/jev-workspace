import { NextResponse } from "next/server";
import { claudeModel, claudeRoute } from "@/lib/claude";
import { guard } from "@/lib/http";
import { jevConfig, publicInfo } from "@/lib/jev";
import { availablePlanners } from "@/lib/planner";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const cfg = jevConfig();
  return NextResponse.json({
    jev: { ...publicInfo(cfg), ready: cfg.ready, reason: cfg.reason ?? null },
    planners: await availablePlanners(),
    claude: { route: await claudeRoute(), model: claudeModel() },
  });
}
