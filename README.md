# Jev Workspace

Give Jev a mission and some links. It gathers every item, judges each one in a fraction of a second, and shows the whole thing live: counters climbing, a tile for every item lighting up as it is judged, throughput against the rate limit, and the API bill ticking up to the fraction of a cent. When it finishes you get a results page you can sort, filter, spot-check and export.

Jev is TypeSafe's System One model. It never writes text. It answers typed questions about one item at a time: a yes/no probability (`noul`), one pick from a fixed list (`choice`), or a position on a rubric (`score`). Code produces the candidates; Jev only selects.

It runs on your own computer with your own keys. There is no server of ours in the middle: your keys stay in `.env.local`, your runs and uploads stay in `.data/`, and the only calls that leave your machine go to Jev, to Claude when you use it, and to the links you give it.

## Set it up

You need:

- [Node.js](https://nodejs.org) 22 or newer.
- A Jev API key from [TypeSafe](https://typesafe.ai). An [OpenRouter](https://openrouter.ai) key that starts with `sk-or-` works too.
- Optional: an [Anthropic API key](https://console.anthropic.com), or [Claude Code](https://claude.com/claude-code) installed and logged in, so Claude can draft plans and review uncertain items. Without either, you start from a template plan you can edit.
- Optional, for the Mac app: macOS 14 or newer with Apple's command line tools (`xcode-select --install`).

```bash
git clone https://github.com/freakngenius/jev-workspace.git
cd jev-workspace
npm install
npm run setup   # asks for your keys, saves them to .env.local, can test the Jev key
npm run app     # builds, then serves http://127.0.0.1:3131
```

Open http://127.0.0.1:3131, type a mission, paste links or drop files, and launch. Run `npm run setup` again any time to change keys, or edit `.env.local` by hand: `.env.example` lists every setting.

`npm run app` is the fast everyday mode. `npm run dev` serves the same app with live reload while you change code. To open it like any other app instead, see [Desktop app](#desktop-app).

An `sk-or-` key in either `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` goes to OpenRouter's System One endpoint instead of `api.typesafe.ai`, the same way the claude-jev plugin resolves keys.

The planner and the uncertain-band review use Claude. With `ANTHROPIC_API_KEY` set they call the API; without it they call your local `claude` CLI headlessly, on your normal Claude login. Choose a different model with `CLAUDE_MODEL` (default `claude-opus-5`).

## Desktop app

```bash
npm run desktop
```

This builds **Jev Workspace.app** into `~/Applications`, with its own icon. Open it from Spotlight or Launchpad, and keep it in the Dock by right-clicking its icon there and choosing Options, then Keep in Dock.

- On launch it uses a server that already answers on 127.0.0.1:3131, such as `npm run dev`. Otherwise it starts its own with `desktop/serve.sh`, which rebuilds into `.next-app/` when the code changed since its last build (usually under a minute), then serves the production build.
- Quitting stops the server the app started, after a warning if a run is still going. If the app crashes, that server stops within a couple of seconds instead of holding the port.
- To change code with live reload, quit the app, start `npm run dev`, then open the app again: it will use the dev server.
- Exports save to `~/Downloads`. Links to other sites open in your default browser.
- The server's output is in `~/Library/Logs/Jev Workspace/server.log` (Help, then Show Server Log). The app's own events go to the unified log: `/usr/bin/log show --last 10m --predicate 'subsystem == "local.jev-workspace"'`.
- The app remembers where the project lives and where node is. Run `npm run desktop` again after moving the folder or reinstalling node.
- `open -a "Jev Workspace" --args -open /runs/<id>/results` opens straight to a page.

## How a mission runs

1. **Mission.** Type the goal, paste links, drop files.
2. **Sniff.** Each link is fetched once to see what it is: a site to crawl, a single page, a sitemap, an RSS or Atom feed, a CSV or JSON table (public Google Sheets links become CSV exports), a PDF, or plain text. Tables report their columns and a sample. Uploaded HTML files are read from disk, never fetched, and files dropped together become one source. A file that is a list (an Instagram "followers and following" export, bookmarks, saved search results) becomes one item per entry, with the list's name, the entry's name, its link and its text as columns. Any other HTML file becomes one item, linked to the page's own address when it declares one. In the plan you can switch between "list", "page" and "text" (split each file into sections at its headings). The item cap grows to cover every entry in the files you dropped.
3. **Plan.** Claude drafts the questions: one yes/no **gate** (yes means the item belongs in the results), up to six **breakdown** questions (hook type, offer, awareness stage, ...), and, when the mission is about how people react, a **panel** of personas who each answer the same yes/no. You edit everything before launch. Every draft is validated: a question that is a type name or a placeholder gets replaced and flagged.
4. **Run.** Crawlers and parsers turn sources into items. Workers send each item to Jev with every question in one call, capped at the key's request rate. Items land in three bands: match at P(yes) ≥ 0.80, reject at ≤ 0.20, uncertain in between.
5. **Review.** Up to 25 uncertain items (configurable) go to Claude for a firm verdict with a one-line reason.
6. **Qualify and hand off.** On the results page, move the match cutoff, filter by fields such as `relationship`, sort warmest first, and have Claude score the top candidates 1 to 3 with a reason and outreach context. **Outreach sheet** exports the 2s and 3s (or, before any scoring, the matches at your cutoff) with everything gathered about each one.
7. **Results.** Matches, uncertain, rejects and errors; breakdown bars; counts by account or site; an account-by-answer grid ("every hook, by brand"); panel approval rates; a ten-item spot-check; cost and speed; CSV and JSON export; and "Re-run plan".

## Instagram exports

Choose the whole export folder with **or choose a whole folder** under the drop zone, or drop the folder on it. The app keeps only the follower and following lists and the DM threads, and skips all media.

- Followers and following merge into one row per account, and people on both lists are marked as mutual follows.
- DM threads attach to accounts by name, adding message counts, first and last message dates, who wrote last, and a label when someone asked for help, to work together, about pricing, or for a call. People you message who match no handle stay in as "DMs only" rows. Message text is read on this computer for those numbers and labels only. It is never stored, sent to Jev or Claude, or written to the sheet.
- Drop any table keyed by `Username` (a follower-tool CSV) with the folder, and its names, flags and bios merge into the matching accounts. That is also how bios get in: the app never fetches Instagram profiles itself, because instagram.com disallows automated fetching.
- Every account gets a `relationship` field: DMs + mutual follow, DMs, DMs only, mutual follow, follows you, you follow.

## What the live counters mean

| Counter | Source |
|---|---|
| Found / Read / Judged | items created, items with text, items Jev answered |
| Judgments | every answer Jev returned: gate + breakdown + one per persona |
| Accounts / sites | distinct values of the table columns you mark under "Count distinct", and distinct domains |
| Spend | Jev: `usage.input_tokens` from each response × the published price. Claude: the CLI's reported `total_cost_usd`, or API usage × list price |
| Same on an LLM | an estimate: the same questions sent to Claude Sonnet 5 at list price ($2 in, $10 out per million tokens). Not a measurement |

## Jev facts this app relies on

From docs.typesafe.ai/models, checked 2026-09-25. Change them in `.env.local` if TypeSafe changes them.

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{ state, model, questions }`.
- Price: $0.042 per million input tokens; output tokens are free (`JEV_USD_PER_MILLION_INPUT`).
- Limits: 1,200 requests per minute and 250,000 tokens per second per key (`JEV_RPM`). TypeSafe says limits adjust under load, so the client backs off on 429 and the dashboard shows how often it was throttled.
- Context: 32k tokens for the state plus the longest question. Items are cut at 6,000 characters by default.

## Testing without a key

`scripts/mock-jev.mjs` is a stand-in for the Jev endpoint with the same response shape and realistic latency. **Its answers are fake.** Use it only to exercise the UI and the pipeline, and keep its runs out of your real history:

```bash
npm run mock:jev
JEV_BASE_URL=http://127.0.0.1:8787/v1/systemone DATA_DIR=.data-test npm run dev
```

```bash
npm test          # parsers, bands, answer parsing, planner guards
npm run typecheck
```

## Seen in the wild

The demos this workspace is modeled on:

- Matthew Berman: 724 live ads from 37 brands broken down (hook, format, offer, CTA, awareness stage, landing-page mismatch) in about 40 seconds for 9 cents. https://x.com/TheMattBerman/status/2100654891756589230
- Made with Jev, ads roundup: 1,891 ads in 19 s for $0.12, 723 ads × 30 personas (21,690 decisions) for $0.22, and more. https://madewithjev.com/jev-for-ads
- TypeSafe launch post. https://typesafe.ai/blog/introducing-system-one-models-and-jev
- TypeSafe workflow evals (accuracy against cost and time, including invoice processing). https://evals.typesafe.ai
- jev-shield, a browser extension with live scanned / blocked / API-call counters. https://github.com/vmendes90/jev-shield
- awesome-typesafe-jev, a community index. https://github.com/AbdelStark/awesome-typesafe-jev

## Safety

- The server binds to 127.0.0.1 and refuses cross-site requests and foreign Host headers, because it spends API credit and fetches URLs on request.
- Links to localhost and private network addresses are blocked unless `ALLOW_PRIVATE_URLS=1`.
- Crawls follow robots.txt for pages they discover, stay on the starting site, run at most four requests per host at once, and stop at the per-site cap.
- Everything you upload or link is sent to Jev (TypeSafe or OpenRouter). Keep NDA material out.
- Keys live only in `.env.local`, and runs and uploads only in `.data/`. Git ignores both, and `npm run setup` makes `.env.local` readable by your user account alone.

## Limits worth knowing

- Sites that render their text with JavaScript return little to a plain fetch; those pages show up as errors with that reason.
- There is no Meta Ad Library connector. Export ads to CSV or JSON (Ad Library, Apify, and similar) and drop the file in.
- "Items per call" above 1 packs several items into one Jev call for throughput. It is experimental: the questions tell Jev which item to look at, but cross-item bleed is possible. Spot-check before trusting it.
- Runs live on local disk in `.data/`. A run interrupted by a server restart is kept but closed out as an error. Runs, qualifying and reviews save every 15 seconds, so a crash loses at most the last 15 seconds of work.

## Code map

| Path | What it does |
|---|---|
| `lib/jev.ts` | Jev client: key resolution, shared rate limiter, retries, answer parsing, pricing |
| `lib/claude.ts` | Claude via the SDK or the headless CLI, with structured output and cost |
| `lib/planner.ts` | mission to plan: prompt, validation, template fallback, plan schema |
| `lib/sources/` | fetching (robots, caps, private-address guard), parsers, source expansion |
| `lib/engine.ts` | the run: producers, Jev workers, bands, Claude review, live metrics, event stream |
| `lib/store.ts` | runs and uploads on disk |
| `app/api/` | plan, runs, stream (server-sent events), stop, review, spot-check, export, uploads |
| `components/` | mission screen, plan editor, live dashboard, tile field, charts, results |
| `desktop/` | the macOS app: window, icon, and the server it starts and stops (`npm run desktop`) |
| `scripts/` | `setup.mjs` behind `npm run setup`, and `mock-jev.mjs`, a fake Jev endpoint for testing |

## License

MIT. See [LICENSE](LICENSE).
