import { notFound } from "next/navigation";
import { ResultsView } from "@/components/ResultsView";
import { engineFor } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const engine = await engineFor(id).catch(() => null);
  if (!engine) notFound();
  return <ResultsView initial={engine.snapshot()} />;
}
