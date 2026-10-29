# Jev Workspace

A local web app: you type a mission and some links, Jev judges every item live, and the run ends on a results page.

## What this is
Next.js 16 app on 127.0.0.1:3131. Sources (sites, sitemaps, feeds, CSV/JSON, PDFs, text) become items; Jev (TypeSafe's System One model, `lib/jev.ts`) answers a gate plus breakdown and persona questions per item; Claude drafts the plan and settles the uncertain band, through the API when `ANTHROPIC_API_KEY` is set, otherwise the local `claude` CLI. Runs and uploads live on disk under `DATA_DIR` (default `.data/`). README.md has the full picture.

## Non-negotiables
- Mock runs never touch real history. `scripts/mock-jev.mjs` returns fake answers; any server pointed at it runs with `DATA_DIR=.data-test`.
- The app spends API credit and fetches URLs on request. Every API route calls `guard()` from `lib/http.ts`, and the server stays bound to 127.0.0.1.
- DM text never leaves the machine. `lib/sources/instagram.ts` reads message text only to count and to label requests; only counts, dates and those labels go into item fields, which are sent to Jev and Claude. Never put message text in a field.
- The app never fetches Instagram itself: instagram.com's robots.txt disallows it and the unofficial profile API needs spoofed headers. Bios come from files the user drops.
- Tests: `npm test` and `npm run typecheck` must both pass, verified by exit code, before anything ships.
- Nothing personal goes in git. Keys stay in `.env.local`, runs and uploads in `.data/`, agent notes in `.agent/`, all ignored. Test fixtures use invented people and links, never rows from a real export.

## Architecture seams that bite
- New field on `Metrics`: add it in `lib/types.ts`, in `emptyMetrics()` and `publishMetrics()` in `lib/engine.ts`, and in the UI that reads it. Saved runs lack new fields, so read them with a `??` default.
- New `ItemStatus`: add its color in `BAND_COLOR` (`components/format.ts`), its tooltip in `components/TileField.tsx`, the dashboard `Legend`, and the counts in `publishMetrics()`.
- JSON Schema handed to the claude CLI must be draft-7 without `$schema` (`jsonSchema()` in `lib/claude.ts`). The 2020-12 URI makes the CLI exit, and the planner then falls back to the template.
- The CLI planner runs `claude -p --setting-sources project --strict-mcp-config --tools ""` from an empty temp directory, so global CLAUDE.md rules, plugins and hooks stay out of plan text. Keep it that way.
- Account data is one merge (`mergeAccounts`): follower and following rows are the spine, tables join by handle, DM threads join by name keys (thread folder slug and title against handle and display name), and ambiguous keys attach nothing. A new signal about accounts belongs there, not in the engine.
- `warmthRank` lives in `lib/text.ts` because browser code imports it; `lib/sources/*` pulls in the HTML parser and must stay server-side.
- The engine mutates run state in place and the browser store does too; React views that memoize over items must depend on the `version` counter from `useRun`.
- Run lists go through `recentRuns()` in `lib/engine.ts`, never `listRuns()` directly: saved files lag a qualify or review and keep saying "running" after a restart, and the live registry knows better. The desktop app's quit warning counts "running" in that list.
- The desktop app (`desktop/`, `npm run desktop`) uses any server already on 3131; otherwise `desktop/serve.sh` builds into `.next-app` (`NEXT_DIST_DIR`), so it never collides with `npm run dev`, and its watchdog stops that server if the app dies. A running server keeps engines from before a code change (the registry lives on `globalThis`), so restart it after engine edits.
- The app's quit is synchronous on purpose: `.terminateLater` plus a Swift `Task` never completed while AppKit waited. It handles SIGTERM with a no-op handler plus a dispatch source, never `SIG_IGN`, because an ignored signal stays ignored in every process it starts.

## Verification discipline
- Capture exit codes explicitly: `cmd > out.txt 2>&1; echo "exit=$?"`.
  A piped `tail` reports tail's status, and `set -o pipefail` with `grep -q`
  reports failure on a successful match.
- Prove a new regression test fails without its fix before believing it.
- Silence is a failure mode: a planner draft can be schema-valid and useless (a local model once returned the gate "noul"). `usableQuestion()` in `lib/planner.ts` is the loud check; extend it rather than trusting a draft.

## Style
Comments explain why, not what, and stay sparse. UI copy is plain English, sentence case. Numbers in the UI: durations as `54s`, `5m23s`; dates `YYYY-MM-DD`.
