# site

The Astro site behind intentic.dev, prerendered to static pages and served by a Cloudflare Worker that adds redirects, versionless downloads and a live notice.

```mermaid
flowchart LR
    content["site-content<br/>words, page trees"] --> build(["site<br/>astro build"])
    demo["demo build<br/>public/demo/"] --> build
    build --> dist["dist/<br/>pages, .md mirrors, search.json"]
    dist --> worker["worker.ts<br/>Cloudflare Worker"]
    live["content/live.json<br/>read from GitHub"] --> worker
    worker --> visitor["Visitor"]
```

- Pages are `.astro` files under `src/pages/`; their words, navigation and metadata come from `@intentic/site-content`. `/docs`, `/developers` and `/api` share one layout, sidebar and search index (`src/components/docs/`), and `/api` is generated from `@intentic/sandbox-openapi`.
- Headings use **Lora** at regular weight in both themes. Its Latin and extended Latin webfonts are self-hosted; regenerate them and `faces.css` with `node _tools/scripts/fonts.mjs site` from the repository root. The font's license is included under `public/fonts/`.
- Repeated marketing introductions and jump links use `src/components/content/PageHero.astro`; guide and comparison tables use `content/ResponsiveTable.astro`, which owns their desktop columns and labelled mobile cards. `devices/SetupSteps.astro` and `content/NumberedSteps.astro` own the two instruction-list presentations. Phone and watch pairing routes share `devices/DevicePairing.astro`, including the fragment-only handoff to the Android app.
- The developer and Desk landing pages share their section frames, tours, economics, trust, FAQ and closing sections under `src/components/landing/`. Each page retains its own copy, hero composition and screenshot playback; `landing/hero-cta.ts` owns the navigation action's visibility behavior.
- **The landing hero is the demo, live** (2026-10-26). `src/components/landing/live-demo.ts` runs `/demo/` in an iframe inside the hero's window, so a visitor clicks around the real app without leaving the page. The frame stands on a poster, `hero-home` (the `/home` view it opens on, captured from the demo's `hero` recording at the frame's 1280×720), which is the LCP and what a reader without JavaScript sees. Wide screens load the frame once the page is idle and the frame is in view, draw it at 1280×720 scaled to the frame (never below 0.75), and swap it in when the demo posts that it has drawn. Phones and `prefers-reduced-data` keep the poster until it is pressed, then open the app over the whole window. "Full screen" lifts the same frame into the top layer (it is a popover) and back, so the app keeps its state. The frame follows the site's skin: dark Sanctum, or the app unskinned in daylight on the light skin. The demo's half (sealed storage, held focus, the ready message) is `_site/demo/src/embed.ts`. Its layout is scoped in `focused-hero.css` so `/desk/` keeps its own composition.
- **Who reaches what** (2026-10-26). The home page's `#access` band, after "Why a workspace", redraws the app's Sandbox ▸ Map (`_editor/web/src/features/sandbox/map/`) for a visitor: `src/components/figures/AccessMapFigure.astro` draws one sample sandbox as a walled precinct, with the ways in at gates on its west wall, its areas as rooms with their personas inside, its secrets as a vault, and what it reaches leaving through ports on its east wall. Pointing at a way in lights what it reaches; pointing at a thing lights who reaches it; a tour lights each way in while the figure is on screen (off under reduced motion). Every lighting is worked out at build by `src/lib/access-lighting.ts`, whose tests also hold the sample (`site-content/access-map.ts`) to the rules the daemon enforces; the script only draws the wires where the cards landed and switches lightings. Below 60rem the columns stack and the wires drop away.
- `/accessibility/` and `/pl/deklaracja-dostepnosci/` share `src/components/legal/AccessibilityStatement.astro` and are linked
  in the footer. The Polish page sets `lang="pl"`; the statement records the scoped axe review and tells public offices
  to assess and publish a statement for their own deployment. Update its date and findings after each new review.
- Every build also writes a Markdown mirror of each page, `llms.txt`, `search.json`, a sitemap dated from git and an OpenGraph card per page (all via `@intentic/astro-integrations`). The card's look is `scripts/og-template.mjs`; the cards are skipped when the Inter fonts under `scripts/fonts/` are missing.
- **Build time** (2026-10-27). `astro build` took 2m22s, two minutes of it drawing OpenGraph cards: resvg spent ~620 of each card's ~690 ms blurring the window's drop shadow, and the old integration (astro-opengraph-images) also parsed every page with jsdom and drew one card at a time. The shadow is now drawn once per build and laid under each card's window as a picture, and `ogImages` reads the tags with a regex and rasterizes on resvg's thread pool. Pages render four at a time (`build.concurrency`), so the network reads at build (changelog, release, Scorecard, npm, registry) overlap; each of those keeps its promise rather than its value, so pages asking at once share one read.
- **The site's counter** (2026-10-15). `src/lib/visit.ts` counts page views and presses on links into the app, carries a visit's source (`utm_*` tags, or the referring site) on its links into the app, and stores nothing in the browser. It posts to the Worker's `/wire/site`, which `src/lib/site-wire.ts` checks and forwards to PostHog under a daily-rotating hashed visitor id. The Worker needs two secrets, `POSTHOG_KEY` (the PostHog project key, the same one the app uses) and `WIRE_SALT` (any long random string); without the key it counts nothing. Chosen over loading posthog-js (about 290 KB on every page) and over a cookie (a consent question for every European visitor).
- **AI readers** (2026-10-19). A model's fetcher runs no JavaScript, so the counter above never sees it. The Worker itself sends PostHog one `site_ai_fetch` event when a known AI agent (ChatGPT-User, OAI-SearchBot, GPTBot, Claude-User, ClaudeBot, PerplexityBot, CCBot and others) fetches a page, a `.md` mirror, an llms file or robots.txt, after the response has gone (`src/lib/ai-fetch.ts`). It carries the agent, path, status and Cloudflare's verified-bot category, and no address. Same `POSTHOG_KEY`; without it nothing is sent.
- Comparison detail routes share `src/pages/compare/[slug].astro`; their copy comes from `site-content/compare`. `ComparisonFaq.astro` renders the same FAQ entries passed to the layout's structured data. Source-review dates are page-specific, while git modification dates account for the shared copy and route template.
- `worker.ts` runs before static assets (`run_worker_first`). It redirects http and moved paths, serves the install scripts at vanity paths (`INSTALL_SCRIPTS` in `@intentic/constants`) from `public/scripts/`, serves the same scripts with their arguments injected at the one-liner routes (`/<verb>/<arg>`, below), resolves `/desktop/*` to the latest GitHub release asset, falls back to the demo's shell under `/demo/`, and applies [content/live.json](content/live.json) to every HTML page outside `/demo/`.
- The `/extensions/` gallery reads the registry repository at build and falls back to `src/lib/registry.fallback.json` when GitHub is unreachable.
- `scripts/readme/` draws the repository README's pictures into `docs/marketing/readme/`: it photographs the demo build, frames each shot in the site's window, and renders the diagrams, once for GitHub's dark scheme and once for its light one.
- The Worker name `intentic` in `wrangler.jsonc` is the Worker bound to intentic.dev, so a deploy under any other name never reaches the live site.

## One-liner routes

Every command the product hands out is `curl -fsSL https://intentic.dev/<verb>/<arg> | sh` or `irm https://intentic.dev/<verb>/<arg> | iex`. The verb table lives in `@intentic/constants` (`one-liner.ts`), so the Worker that serves a URL and the editor and sandbox that hand it out read the same patterns. [src/lib/worker-verbs.ts](src/lib/worker-verbs.ts) does the serving:

- PowerShell gets the `.ps1` script when the User-Agent says `PowerShell`; everything else gets sh. A trailing `.ps1` or `.sh` on the last segment overrides that.
- sh: right after the shebang come `set -- '<args>'`, `INTENTIC_SCRIPT_URL='<url>'` (for a script that re-runs itself under `sudo`) and the verb's env lines.
- PowerShell: the script is wrapped as `& { … } -Param '<value>'`, so its `param(...)` binds as if it were called by name.
- `uninstall` carries nothing in its URL and keeps what the person adds: its sh gets `set -- "$@"` and its PowerShell block ends in `@args`, so `| sh -s -- --dry-run` and `& ([scriptblock]::Create((irm …))) -DryRun` reach the script. Every other verb's URL replaces anything typed (the table's `typed` flag).
- Each argument must match its verb's pattern and hold only `[A-Za-z0-9._~/-]`; anything else gets a one-sentence 400 and no script. Responses are `no-store` and vary on the User-Agent.

The flat paths (`/connect`, `/fix.ps1`, …) keep answering as before.

## Key files

- [astro.config.mjs](astro.config.mjs) — integrations, sitemap priorities, llms.txt sections and the dev proxy for `/demo`.
- [worker.ts](worker.ts) — request-time routing and the live-content rewrite in production.
- [wrangler.jsonc](wrangler.jsonc) — Worker name, build command (demo first, then Astro) and the asset binding.
- [src/layouts/BaseLayout.astro](src/layouts/BaseLayout.astro) — the head, JSON-LD, OpenGraph tags and notice strip every page shares.
- [src/components/Landing.astro](src/components/Landing.astro) — the home page.
- [src/lib/live.ts](src/lib/live.ts) — the schema, limits and link allowlist for the live document.

## Commands

```sh
pnpm -C _site/site dev          # astro dev; /demo proxies to the demo's dev server, started on first /demo request
pnpm -C _site/site build
pnpm -C _site/site typecheck    # Astro pages and scripts, then the worker tests
pnpm -C _site/site test         # desk palette and mark alignment checks, then the Worker's verb-route tests
pnpm -C _site/site test:compare --content-only  # copy and research-map invariants
pnpm -C _site/site test:compare  # after build: generated comparison HTML and FAQ parity
pnpm -C _site/site run deploy   # wrangler deploy, then IndexNow submission
pnpm -C _site/site readme       # README pictures, from the demo's dev server (DEMO_URL)
```
