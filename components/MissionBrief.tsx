"use client";

import { useState } from "react";
import { firstSentence } from "@/lib/text";
import type { Plan } from "@/lib/types";

interface Section {
  label: string | null;
  body: string;
}

// An all-caps label ending in a colon starts a section: "GOAL:", "IDEAL CONTACT:", "OFFER (\"The First Build\"):".
const LABEL = /(^|\s)([A-Z][A-Z0-9&/'’-]*(?:\s+[A-Z][A-Z0-9&/'’-]*)*)(\s*\([^)]{0,60}\))?:(?=\s)/g;

export function briefSections(text: string): Section[] {
  const out: Section[] = [];
  let last = 0;
  let label: string | null = null;
  for (const m of text.matchAll(LABEL)) {
    const name = m[2];
    if (name.replace(/[^A-Z]/g, "").length < 3) continue;
    const start = (m.index ?? 0) + m[1].length;
    const body = text.slice(last, start).trim();
    if (body || label) out.push({ label, body });
    label = `${name}${m[3] ?? ""}`.trim();
    last = start + m[0].length - m[1].length;
  }
  const tail = text.slice(last).trim();
  if (tail || label) out.push({ label, body: tail });
  return out;
}

function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p}</span>;
        const href = p.replace(/[.,;:—]+$/, "");
        const shown = href.replace(/^https?:\/\/(www\.)?/, "");
        return (
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="text-ink underline decoration-axis underline-offset-4 hover:decoration-cream" title={href}>
            {shown.length > 48 ? `${shown.slice(0, 46)}…` : shown}
          </a>
        );
      })}
    </>
  );
}

/** "Stage 1 (…): … Stage 2 (…): …" reads as steps, not one run-on paragraph. */
function Body({ text }: { text: string }) {
  const steps = text.split(/(?=\bStage \d+\b)/).map((s) => s.trim()).filter(Boolean);
  if (steps.length > 1) {
    return (
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="border-l border-hairline pl-3">
            <Linked text={s} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <p>
      <Linked text={text} />
    </p>
  );
}

/**
 * A mission's one-line summary, with the full brief a click away. Long briefs
 * are split at their all-caps labels so a 600-word prompt reads as sections.
 */
export function MissionBrief({ plan, className = "" }: { plan: Plan; className?: string }) {
  const [open, setOpen] = useState(false);
  const summary = plan.summary?.trim() || firstSentence(plan.mission);
  const words = plan.mission.trim().split(/\s+/).length;
  const long = plan.mission.trim().length > summary.length + 40;
  return (
    <div className={className}>
      <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">{summary}</p>
      {long && (
        <button className="mt-2 font-mono text-[11px] tracking-[0.08em] text-muted uppercase hover:text-ink" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide the full brief" : `Show the full brief · ${words} words`}
        </button>
      )}
      {open && (
        <div className="rise scroll-thin mt-3 max-h-[60vh] max-w-4xl space-y-4 overflow-y-auto rounded-2xl border border-hairline bg-surface p-5 text-[14px] leading-relaxed text-ink-2">
          {briefSections(plan.mission).map((s, i) => (
            <section key={i}>
              {s.label && <div className="eyebrow mb-1 !text-cream/70">{s.label}</div>}
              <Body text={s.body} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
