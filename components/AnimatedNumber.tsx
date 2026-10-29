"use client";

import { useEffect, useRef } from "react";

/**
 * A number that eases toward its target instead of jumping. Writes straight to
 * the DOM on each frame, so a counter ticking 60 times a second never
 * re-renders React.
 */
export function AnimatedNumber({
  value,
  format,
  className,
  speed = 0.18,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  speed?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const target = useRef(value);
  const formatRef = useRef(format);
  formatRef.current = format;
  target.current = value;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const diff = target.current - shown.current;
      if (Math.abs(diff) > Math.abs(target.current) * 1e-6 + 1e-9) {
        shown.current += diff * speed;
        if (Math.abs(target.current - shown.current) < Math.abs(diff) * 0.02) shown.current = target.current;
      } else {
        shown.current = target.current;
      }
      if (ref.current) ref.current.textContent = formatRef.current(shown.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}
