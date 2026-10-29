import Papa from "papaparse";
import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";
import { bandOf } from "@/lib/bands";
import { slug } from "@/lib/planner";
import { outreachRows } from "@/lib/outreach";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);
  const run = engine.snapshot();
  const format = new URL(req.url).searchParams.get("format") ?? "csv";
  const name = `jev-${slug(run.plan.title, "run")}-${run.id.slice(0, 8)}`;

  if (format === "json") {
    return new Response(JSON.stringify(run, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${name}.json"`,
      },
    });
  }

  const { plan } = run;
  // The results page can re-cut the bands; its export follows the cut the user is looking at.
  const query = new URL(req.url).searchParams;
  const cut = (name: "yes" | "no") => {
    const v = Number(query.get(name));
    return query.has(name) && Number.isFinite(v) && v >= 0 && v <= 1 ? v : plan.thresholds[name];
  };
  const thresholds = { yes: cut("yes"), no: Math.min(cut("no"), cut("yes")) };
  if (format === "outreach") {
    return new Response(Papa.unparse(outreachRows(run, thresholds)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-outreach.csv"`,
      },
    });
  }

  const rows = run.items.map((it) => {
    const row: Record<string, string | number> = {
      id: it.id,
      band: it.review?.verdict ?? (it.p != null ? bandOf(it.p, thresholds) : it.status),
      p_yes: it.p != null ? Number(it.p.toFixed(4)) : "",
      title: it.title,
      url: it.url ?? "",
      domain: it.domain ?? "",
      location: it.locator ?? "",
    };
    for (const d of plan.dimensions) {
      const a = it.answers?.[d.key];
      row[d.label] = a == null ? "" : d.type === "choice" ? String(a.v) : Number((a.v as number).toFixed(3));
    }
    if (plan.panel) {
      row.appeal = it.appeal != null ? Number(it.appeal.toFixed(3)) : "";
      for (const p of plan.panel.personas) row[`persona: ${p.label}`] = it.panel?.[p.key] != null ? Number(it.panel[p.key].toFixed(3)) : "";
    }
    for (const f of plan.entityFields) row[f] = it.fields?.[f] ?? "";
    row.claude_verdict = it.review?.verdict ?? "";
    row.claude_reason = it.review?.reason ?? "";
    row.error = it.error ?? "";
    return row;
  });
  return new Response(Papa.unparse(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
    },
  });
}
