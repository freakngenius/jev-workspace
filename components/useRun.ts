"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientItem, RunEvent, RunSnapshot } from "@/lib/types";

export interface RunStore {
  run: RunSnapshot | null;
  /** Newest judgments first, for the live feed. */
  recent: ClientItem[];
  /** Item id to the moment it was judged, for the tile flash. */
  flash: Map<number, number>;
  done: boolean;
  error: string | null;
}

function apply(store: RunStore, ev: RunEvent) {
  switch (ev.t) {
    case "snapshot":
      store.run = ev.run;
      store.done = ev.run.status !== "running";
      if (!store.recent.length) {
        store.recent = ev.run.items.filter((i) => i.status === "judged").slice(-24).reverse();
      }
      break;
    case "items": {
      const run = store.run;
      if (!run) return;
      const now = performance.now();
      for (const patch of ev.items) {
        const existing = run.items[patch.id];
        const wasJudged = existing?.status === "judged";
        const merged = existing ? Object.assign(existing, patch) : (run.items[patch.id] = patch as ClientItem);
        if (merged.status === "judged" && !wasJudged) {
          store.flash.set(merged.id, now);
          store.recent.unshift(merged);
        }
      }
      if (store.recent.length > 40) store.recent.length = 40;
      break;
    }
    case "sources":
      if (store.run) store.run.sources = ev.sources;
      break;
    case "metrics":
      if (store.run) {
        store.run.metrics = ev.metrics;
        store.run.phase = ev.phase;
        store.run.status = ev.status;
      }
      break;
    case "log":
      if (store.run) store.run.logs = [...store.run.logs.slice(-199), ev.line];
      break;
    case "done":
      store.done = true;
      if (store.run) {
        store.run.status = ev.status;
        store.run.phase = "finished";
        store.run.finishedAt = ev.finishedAt || store.run.finishedAt;
      }
      break;
  }
}

/**
 * Subscribes to a run's event stream. State lives in a ref and React
 * re-renders at most once per animation frame, so thousands of events a
 * second stay cheap. Bump `epoch` to reconnect (after a later review).
 */
export function useRun(id: string, initial?: RunSnapshot | null, epoch = 0) {
  const store = useRef<RunStore>({
    run: initial ?? null,
    recent: [],
    flash: new Map(),
    done: initial ? initial.status !== "running" : false,
    error: null,
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let raf = 0;
    let closed = false;
    const bump = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion((v) => v + 1);
      });
    };
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEvent;
      apply(store.current, ev);
      if (ev.t === "done") {
        closed = true;
        es.close();
      }
      bump();
    };
    es.onerror = () => {
      if (closed) return;
      if (es.readyState === EventSource.CLOSED) {
        store.current.error = "Lost the connection to the run.";
        bump();
      }
    };
    return () => {
      closed = true;
      es.close();
      cancelAnimationFrame(raf);
    };
  }, [id, epoch]);

  return { store: store.current, version };
}
