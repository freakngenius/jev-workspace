"use client";

import { useEffect, useRef } from "react";
import type { ClientItem, Plan } from "@/lib/types";
import { BAND_COLOR, BAND_LABEL } from "./format";
import { useTooltip } from "./Tooltip";
import type { RunStore } from "./useRun";

const GAP = 2;
const MAX_CELL = 30;
const MIN_CELL = 4;
const FLASH_MS = 650;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RGB = Object.fromEntries(Object.entries(BAND_COLOR).map(([k, v]) => [k, hexToRgb(v)])) as Record<
  keyof typeof BAND_COLOR,
  [number, number, number]
>;

function strength(it: ClientItem, plan: Plan): number {
  const p = it.p ?? 0.5;
  const band = it.finalBand ?? it.band;
  if (it.review) return 1;
  if (band === "match") return 0.55 + 0.45 * Math.min(1, (p - plan.thresholds.yes) / Math.max(0.01, 1 - plan.thresholds.yes));
  if (band === "reject") return 0.55 + 0.45 * Math.min(1, (plan.thresholds.no - p) / Math.max(0.01, plan.thresholds.no));
  return 0.9;
}

/**
 * Every item is one cell. Cells appear when found, fill as they are read,
 * flash when Jev answers, and settle into their band color. Brighter means
 * more confident.
 */
export function TileField({
  store,
  version,
  maxHeight = 340,
  onPick,
}: {
  store: RunStore;
  version: number;
  maxHeight?: number;
  onPick?: (item: ClientItem) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useRef({ width: 0, size: MAX_CELL, cols: 1, n: 0 });
  const hover = useRef<number | null>(null);
  const { show, hide } = useTooltip();
  const draw = useRef<() => void>(() => {});

  draw.current = () => {
    const c = canvas.current;
    const run = store.run;
    if (!c || !run) return;
    const items = run.items;
    const L = layout.current;
    const n = Math.max(items.length, 1);
    const width = L.width || c.parentElement?.clientWidth || 800;
    const ideal = Math.floor(Math.sqrt((width * maxHeight) / n)) - GAP;
    const size = Math.max(MIN_CELL, Math.min(L.n ? L.size : MAX_CELL, ideal, MAX_CELL));
    const cols = Math.max(1, Math.floor((width + GAP) / (size + GAP)));
    const rows = Math.ceil(n / cols);
    const height = Math.max(size + GAP, rows * (size + GAP));
    Object.assign(L, { size, cols, n: items.length, width });

    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const now = performance.now();
    const radius = size >= 8 ? 2 : 1;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      const x = (i % cols) * (size + GAP);
      const y = Math.floor(i / cols) * (size + GAP);
      let key: keyof typeof BAND_COLOR;
      let alpha = 1;
      if (it.status === "judged") {
        key = it.finalBand ?? it.band ?? "uncertain";
        alpha = strength(it, run.plan);
      } else {
        key = it.status;
        if (it.status === "judging") alpha = 0.85;
      }
      const [r, g, b] = RGB[key];
      const flashAt = store.flash.get(it.id);
      const t = flashAt ? (now - flashAt) / FLASH_MS : 1;
      const grow = t < 1 ? (1 - t) * 1.5 : 0;

      if (it.status === "queued") {
        ctx.strokeStyle = "rgba(90,88,82,0.55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      } else {
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        ctx.roundRect(x - grow, y - grow, size + grow * 2, size + grow * 2, radius);
        ctx.fill();
      }
      if (t < 1) {
        ctx.fillStyle = `rgba(255,248,232,${(1 - t) * 0.75})`;
        ctx.beginPath();
        ctx.roundRect(x - grow, y - grow, size + grow * 2, size + grow * 2, radius);
        ctx.fill();
      } else if (flashAt) {
        store.flash.delete(it.id);
      }
      if (it.review && size >= 6) {
        ctx.fillStyle = "#efe6d2";
        const d = Math.max(2, size * 0.28);
        ctx.fillRect(x + (size - d) / 2, y + (size - d) / 2, d, d);
      }
      if (hover.current === i) {
        ctx.strokeStyle = "#efe6d2";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 1, y - 1, size + 2, size + 2);
      }
    }
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      layout.current.width = Math.floor(entry.contentRect.width);
      layout.current.n = 0;
      draw.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      draw.current();
      if (store.run?.status === "running" || store.flash.size) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store, version]);

  const pick = (e: { clientX: number; clientY: number }): ClientItem | null => {
    const c = canvas.current;
    const run = store.run;
    if (!c || !run) return null;
    const rect = c.getBoundingClientRect();
    const { size, cols } = layout.current;
    const col = Math.floor((e.clientX - rect.left) / (size + GAP));
    const row = Math.floor((e.clientY - rect.top) / (size + GAP));
    if (col < 0 || col >= cols || row < 0) return null;
    return run.items[row * cols + col] ?? null;
  };

  return (
    <div ref={wrap} className="scroll-thin w-full overflow-y-auto" style={{ maxHeight: maxHeight + 40 }}>
      <canvas
        ref={canvas}
        className="block cursor-crosshair"
        role="img"
        aria-label={`Grid of ${store.run?.items.length ?? 0} items colored by verdict`}
        onPointerMove={(e) => {
          const it = pick(e);
          hover.current = it?.id ?? null;
          if (!it) return hide();
          const band = it.finalBand ?? it.band;
          show({
            x: e.clientX,
            y: e.clientY,
            value:
              it.status === "judged"
                ? `${BAND_LABEL[band!]} · p ${it.p!.toFixed(2)}${it.review ? " · reviewed by Claude" : ""}`
                : it.status === "error"
                  ? "Error"
                  : it.status === "skipped"
                    ? "Skipped"
                  : it.status === "judging"
                    ? "Jev is judging…"
                    : it.status === "ready"
                      ? "Read, waiting for Jev"
                      : it.status === "fetching"
                        ? "Fetching…"
                        : "Found, queued",
            label: it.title,
            color: it.status === "judged" ? BAND_COLOR[band!] : BAND_COLOR[it.status],
            detail: it.error ?? [it.domain, it.locator].filter(Boolean).join(" · "),
          });
          draw.current();
        }}
        onPointerLeave={() => {
          hover.current = null;
          hide();
          draw.current();
        }}
        onClick={(e) => {
          const it = pick(e);
          if (it && onPick) onPick(it);
        }}
      />
    </div>
  );
}
