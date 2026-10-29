"use client";

import { createContext, useCallback, useContext, useState } from "react";

export interface TipContent {
  value: string;
  label?: string;
  detail?: string;
  color?: string;
}

interface Tip extends TipContent {
  x: number;
  y: number;
}

const Ctx = createContext<{ show: (t: Tip) => void; hide: () => void }>({ show: () => {}, hide: () => {} });

/** One floating tooltip for the whole page. Value first and strong, label second, as a line key. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = useCallback((t: Tip) => setTip(t), []);
  const hide = useCallback(() => setTip(null), []);
  return (
    <Ctx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-[320px] rounded-lg border border-hairline bg-[#0f0f0e]/95 px-3 py-2 shadow-2xl backdrop-blur"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 330), top: tip.y + 14 }}
        >
          <div className="font-mono text-[13px] font-semibold text-ink">{tip.value}</div>
          {tip.label && (
            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-2">
              {tip.color && <span className="inline-block h-[2px] w-3 rounded" style={{ background: tip.color }} />}
              <span className="line-clamp-2">{tip.label}</span>
            </div>
          )}
          {tip.detail && <div className="mt-1 text-[11px] leading-snug text-muted">{tip.detail}</div>}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useTooltip() {
  const { show, hide } = useContext(Ctx);
  const bind = useCallback(
    (content: TipContent) => ({
      onPointerMove: (e: React.PointerEvent) => show({ ...content, x: e.clientX, y: e.clientY }),
      onPointerLeave: hide,
      onFocus: (e: React.FocusEvent) => {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        show({ ...content, x: r.right, y: r.top });
      },
      onBlur: hide,
    }),
    [show, hide],
  );
  return { show, hide, bind };
}
