import { NextResponse } from "next/server";
import { bad, guard } from "@/lib/http";
import { saveUpload } from "@/lib/store";

export const dynamic = "force-dynamic";

const MAX_BYTES = 40_000_000;

export async function POST(req: Request) {
  const refused = guard(req);
  if (refused) return refused;
  const form = await req.formData().catch(() => null);
  if (!form) return bad("Expected multipart form data.");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  // A folder upload sends each file's path inside the folder alongside it, in the same order.
  const paths = form.getAll("paths").map(String);
  if (!files.length) return bad("No files.");
  const saved = [];
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_BYTES) return bad(`${f.name} is over 40 MB.`);
    saved.push(await saveUpload(paths[i] || f.name, f.type, new Uint8Array(await f.arrayBuffer())));
  }
  return NextResponse.json({ uploads: saved });
}
