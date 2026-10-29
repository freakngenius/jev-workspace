import { Suspense } from "react";
import { MissionControl } from "@/components/MissionControl";
import { claudeModel, claudeRoute } from "@/lib/claude";
import { recentRuns } from "@/lib/engine";
import { jevConfig, publicInfo } from "@/lib/jev";
import { availablePlanners } from "@/lib/planner";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cfg = jevConfig();
  const [planners, route, recent] = await Promise.all([availablePlanners(), claudeRoute(), recentRuns(12)]);
  const status = {
    jev: { ...publicInfo(cfg), ready: cfg.ready, reason: cfg.reason ?? null },
    planners,
    claude: { route, model: claudeModel() },
  };
  return (
    <Suspense>
      <MissionControl status={status} recent={recent} />
    </Suspense>
  );
}
