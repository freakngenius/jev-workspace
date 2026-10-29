import { NextResponse } from "next/server";

/**
 * This app spends API credit and fetches URLs on request, so it only answers
 * the browser tab it served. Cross-site requests and foreign Host headers
 * (DNS rebinding) are refused. Set ALLOW_REMOTE=1 to serve other hosts.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function guard(req: Request): NextResponse | null {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (process.env.ALLOW_REMOTE !== "1" && !LOCAL_HOSTS.has(host)) {
    return NextResponse.json({ error: "Forbidden host" }, { status: 403 });
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.get("host")) {
        return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    }
  }
  return null;
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
