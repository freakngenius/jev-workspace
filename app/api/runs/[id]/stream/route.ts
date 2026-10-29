import { engineFor } from "@/lib/engine";
import { bad, guard } from "@/lib/http";
import type { RunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Server-sent events: a full snapshot first, then batched deltas until the run finishes. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guard(req);
  if (refused) return refused;
  const { id } = await params;
  const engine = await engineFor(id).catch(() => null);
  if (!engine) return bad("No such run.", 404);

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      const send = (ev: RunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        if (ev.t === "done") setTimeout(close, 50);
      };
      const unsubscribe = engine.subscribe(send);
      const ping = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      if (!engine.running) send({ t: "done", status: engine.record.status, finishedAt: engine.record.finishedAt ?? "" });
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
