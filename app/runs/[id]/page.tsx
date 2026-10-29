import { notFound } from "next/navigation";
import { RunDashboard } from "@/components/RunDashboard";
import { engineFor } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const engine = await engineFor(id).catch(() => null);
  if (!engine) notFound();
  return <RunDashboard id={id} initial={engine.snapshot()} />;
}
