import { bandOf } from "./bands";
import { warmthRank } from "./text";
import type { ClientItem, Plan, RunSnapshot } from "./types";

const pick = (f: Record<string, string> | undefined, ...keys: string[]) => keys.map((k) => f?.[k]?.trim()).find(Boolean) ?? "";

/**
 * The sheet for outreach: Claude-qualified candidates scored 2 or 3 when any
 * exist, otherwise the matches at the cut the user chose (top 100). Warmest
 * and strongest first, with every piece of context the run gathered.
 */
export function outreachRows(run: RunSnapshot, thresholds: Plan["thresholds"]) {
  const judged = run.items.filter((i) => i.status === "judged");
  const qualified = judged.filter((i) => (i.qual?.score ?? 0) >= 2);
  const band = (i: ClientItem) => i.review?.verdict ?? bandOf(i.p ?? 0, thresholds);
  const chosen = (qualified.length ? qualified : judged.filter((i) => band(i) === "match")).sort(
    (a, b) => (b.qual?.score ?? 0) - (a.qual?.score ?? 0) || warmthRank(b.fields?.relationship) - warmthRank(a.fields?.relationship) || (b.p ?? 0) - (a.p ?? 0),
  );
  return chosen.slice(0, qualified.length ? 500 : 100).map((it) => {
    const f = it.fields;
    const handle = it.url && f?.name ? f.name : "";
    const row: Record<string, string | number> = {
      "Contact name": pick(f, "Name", "Full name", "full_name", "dm_name") || (handle ? "" : it.title),
      Handle: handle ? `@${handle}` : "",
      "Profile URL": it.url ?? "",
      Relationship: pick(f, "relationship"),
      "DM messages": pick(f, "dm_messages"),
      "Last DM": pick(f, "dm_last"),
      "Last message from": pick(f, "dm_last_from"),
      "DM signals": pick(f, "dm_signals"),
      Bio: pick(f, "Biography", "biography", "Bio", "bio"),
      Website: pick(f, "External URL", "external_url", "Website", "website"),
      Category: pick(f, "Category", "category", "category_name"),
      "Qualification score": it.qual?.score ?? "",
      "Why qualified": it.qual?.why ?? "",
      "Outreach context": it.qual?.context ?? "",
      "Fit P(yes)": it.p != null ? Number(it.p.toFixed(3)) : "",
    };
    for (const d of run.plan.dimensions) {
      const a = it.answers?.[d.key];
      row[d.label] = a == null ? "" : d.type === "choice" ? String(a.v).replace(/_/g, " ") : d.type === "score" ? (d.levels?.[Math.round(a.v as number)] ?? String(a.v)) : `${Math.round((a.v as number) * 100)}% yes`;
    }
    row["Claude review"] = it.review ? `${it.review.verdict}: ${it.review.reason}` : "";
    return row;
  });
}
