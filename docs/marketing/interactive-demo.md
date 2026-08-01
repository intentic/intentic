# The interactive demo

The landing page's hero and tour show hand-captured PNGs (`_apps/site/public/assets/product/`). This document
covers what sits behind the *click* on them: the **real app**, running against a fixture instead of a sandbox.
Every section fills with plausible data, the sessions window opens, a turn streams into the chat, a diff opens.
Nothing is re-implemented for marketing.

Run it with `pnpm -C _apps/demo dev` (http://localhost:47146/demo/). The app's own dev server is untouched.

The finding that shapes everything below: **the app does not need to be decoupled from its logic for this.**
It needs its two transports pointed somewhere else. Component-level decoupling (props/events instead of
composable singletons) would touch 19 of the 25 chat/agents components and add exactly the wrapper indirection
`AGENTS.md` forbids — while the transports are two well-commented modules that already resolve their global
per call, on purpose.

## The seam

Every browser→outside call in the web app goes through one of two globals, resolved at call time:

| Transport | Where | Reaches |
| --- | --- | --- |
| `globalThis.fetch` | `composables/sandbox/sandboxClient.ts:43` (raw path calls), `sandboxRpc.ts:60` (typed + streams), `useApi.ts` (platform), better-auth's client | the daemon's `OpenAPIHandler` and the platform's `/rpc` + `/api/auth/*` |
| `globalThis.WebSocket` | `composables/terminal/terminalSession.ts:160`, `composables/browser/useBrowserView.ts:122` | `/system/terminal`, `/system/browser-view` |

`sandboxRpc.ts:43` already documents why its fetch is a hook rather than a captured reference — *"a fetch bound
then is invisible to anything that replaces it afterwards (a test's stub, an instrumentation wrapper)"*. The demo
is that wrapper, and it needs no branch anywhere in the app.

## The package

`@intentic-dev/demo` (`_apps/demo/`) — its own package, depending on `@intentic-app/web` and importing the app's
entry through its `./main` export. Its [README](../../_apps/demo/README.md) has the file-by-file layout.

It lived inside `_apps/web/src/demo/` first, and that was wrong in three ways that are checkable rather than
stylistic: a fixture edit matched CI's `_apps/web/**/*` glob and re-released the **product images**, `knip`
reported all ten files as unused (web's entry list cannot see a second html), and the package emitted a second
dist beside the one its Dockerfile assumes. The dependency now runs one way only — the demo knows the app, the
app knows nothing — which is also what stops app code reaching the fixture by accident.

**It cost the app three lines**, all of which are fixes rather than accommodations, because building the same
source under a path prefix is what surfaced them:

- `router/index.ts` now passes `import.meta.env.BASE_URL` to `createWebHistory()`. vue-router's default is a
  `<base href>` element or `/` — it never reads Vite's base — so an app served under a prefix routed as if it
  were at the root. `/` for the app, so nothing there changes.
- `styles.css` now names its own source in an `@source`. Tailwind's auto-detection is rooted at the *build's*
  root, which was the app's directory only because the app was the only thing building it; the demo's first run
  came up as real markup with three-quarters of a design system.
- `usePopout.ts` resolves the pop-out window's page against `import.meta.env.BASE_URL` instead of the origin
  root. `/popout.html` under a prefix is the *marketing site's* 404 page, and nothing in it can answer the
  keeper's handshake — so the window opened and then sat there while the panel stayed docked, which is exactly
  the failure the liveness contract is written to prevent, arriving through the address rather than the realm.
  The demo owns its own `popout.html` (same keeper, its own document, since the page is addressed by URL).

Both fixture handlers are plain `Request → Response` functions with contract types on every payload
(`satisfies AgentsList`, `: SavingsReport`, …), so a shape that drifts from the wire is a build error. They are
deliberately *not* an oRPC server: `OpenAPIHandler` would put `@orpc/server` in the bundle to re-validate
payloads this fixture is the only writer of, and the client re-validates none of them anyway. The one piece of
protocol the demo does own is the event-iterator framing in `sse.ts` — three lines, rather than a dependency on
`@orpc/standard-server` (a transitive dep of the client, not one web declares).

## The three gates, and why none needs a branch

1. **`requireAuth`** (`router/index.ts:17`) → better-auth `getSession` against `environment.api.url`. The demo
   `window.env` points `api.url` at a sentinel origin the interceptor owns; the handler answers a canned session.
2. **`requireSetup`** (`router/index.ts:29`) → `apiClient.sandbox.list()`. Answers one sandbox row whose
   `daemonUrl` is the demo daemon's sentinel base, carrying a connect token.
3. **Daemon credential** (`sandboxSession.ts`) → a Google ID token exchanged at `POST /system/session`. Seed
   `localStorage` with a fake credential and let the demo daemon mint the session — this is exactly what the e2e
   tier already does (`_tools/e2e/README.md`), so it is a proven path, not a new one.

The `hello` frame omits `routes`, which `useDaemonRoutes.ts:22` reads as *assume supported* — so no feature
gates itself off, and the fixture doesn't have to enumerate `SANDBOX_ROUTE_NAMES`.

## What the fixture must serve

Frames first, because they are what makes it feel alive. `/events` is `eventIterator(SystemEventSchema)` and
`systemEvents.ts` routes it into the stores, so a generator that yields these *is* the daemon as far as the
app's liveness, fleet, presence and invalidation logic can tell:

`hello` (once) · `heartbeat` (every 2s, or the 10s watchdog tears the stream down) · `agents` + `rev` (the fleet
roster, snapshot-not-diff) · `presence` (a teammate's avatar, for the sharing story) · `workspaceChanged` ·
`reposChanged` · `boot` (optional; a first-run progress moment).

Per surface, the routes it actually calls and what the fixture answers with:

| Surface | Routes | Fixture |
| --- | --- | --- |
| Fleet board `/agents` | `GET /agents`, `/agents/search`, `/agents/{id}/rename`, `/archive`, `/unarchive`, `/{id}/seen` | 7 agents, one in every lane state: `awaiting` (a question), `conflict`, two `running` (one delegating to subagents), `ready`, `landed`, and an automation's overnight `idle` |
| Review panel | `GET /agents/{id}/diff`, `/{id}/transcript`, `/{id}/{repo}/file-diff` | the soft-deletes agent: 4 files over 2 repos, +210 −55, two of them with real before/after text — and the conversation that produced them, so opening the card lands on its transcript rather than on "start a conversation". Every other agent still answers an empty one |
| Chat | `POST /agent`, `POST /agent/attach` (stream), `/agent/commands`, `/agent/refusals`, `POST /agent/reply`, `/agent/steer`, `/agent/stop` | the scripted turn, below |
| Model picker | `GET /claude/accounts`, `/grok/accounts`, `/translator/accounts`, `/{provider}/models` | a connected Claude Max and a ChatGPT subscription in the translator — without these the composer never leaves "Checking your AI accounts…" |
| Sessions window | `GET /sessions?query=` (searchable), `GET /sessions/{id}` | 12 conversations from 90 seconds to 6 days old |
| Workspace | `GET /workspace/tree`, `/workspace/children`, `/workspace/file`, `/workspace/raw`, `POST /workspace/upload-diff`, `POST /workspace/upload`, `DELETE /workspace/entry`, `/git/repos`, `/git/changes`, `/git/{repo}/file-diff` | `acme-shop`: a `web` and an `api` repo over one flat path → content table, ~60 files, 5 dirty ones across both. Reads that miss answer 404, writes land in the table — including a dropped folder, which the queue walks for real and uploads file by file |
| Sandbox hub | `GET /info`, `/settings`, `/settings/savings`, `/system/usage`, `/secrets/inventory`, `/ports`, `/environment`, `/members`, `/extensions`, `/vpn` | a measured cleaner-savings report; the rest answer their empty shape, which is the truth about a recording |
| Maintenance | `GET /chores`, `POST /chores/ledger`, `/chores/probe` | four probes per repo and the cheap signals behind them, chosen to produce one row of every state the book distinguishes — due, snoozed, clear, unmeasured, not-applicable. The ledger is real state (a snooze holds; a finished run promotes into a row); re-running a probe refuses |
| Acceptance | `GET /workspace/children`, `/workspace/file`, `/workspace/raw`, `/panels`, `POST /workspace/upload` | five stories in two repos and one recorded run: a pass, a fail with a defect, a blocked story, and a fourth never tested. Its screenshots are the same storefront pages the browser view plays |
| Documentation | `GET /workspace/children`, `/workspace/file` | `web` published (a map, a reading order, three pages, one marked stale because the fleet is editing that very directory) and `api` staged — the draft that lights the rail badge and the "nothing is in the repository until you publish it" banner |
| Terminal | `GET /system/terminals` + the `/system/terminal` WebSocket | the featured turn's own tmux session, replaying its vitest run — xterm renders the ANSI for real |
| Browsers | `GET /system/browsers` + the `/system/browser-view` WebSocket | the checkout agent's Chromium: the pricing page, the Stripe session it created, and the API docs it read. See below |
| Pipelines | `GET /ci/runs`, `POST /ci/runs/jobs`, `/ci/seen` | 7 runs over two repos on two hosts (`web` on GitHub, `api` on GitLab) — one still going, one broken, and one job broken twice so the "failing repeatedly" analysis has something true to say |
| Automations | `GET /automations`, `/automations/pending` | one of each trigger the union has — a nightly chore, a Discord listener, a Doorbell held for approval, a land-triggered doc check, a disabled CI webhook — each with the run history that makes a row honest |
| Memory | `GET /memory`, `/memory/file` (+ PUT/DELETE) | four notes about acme-shop, editable and forgettable: the fixture is the store, so the red pen works |

**`GET /panels` decides which of those rows a visitor can even reach.** It carries the per-repo facts every
extension's `detect()` runs over, so a fixture that answered it with an empty list — as this one did at first —
has no Documentation, Acceptance, Maintenance or Preview in the rail at all, and no way to tell that anything is
missing: an extension that detects nothing contributes nothing, silently. `web` ships a dev server and both
repos carry `docs/user-stories`, which is the evidence those three areas activate on.

**Three of those areas are backed by files rather than by routes**, which is what makes them fixturable at all:
a story is markdown in a repo, an acceptance run is a directory under `.intentic/acceptance/`, a document set is
`docs/architecture/` (published) mirrored by `.intentic/docs/` (staged). So they are fixtured by adding paths to
`fixture/workspace.ts`, and the extensions walk exactly what they would walk against a real daemon — no route
was invented for them and none of their code knows the difference. What the demo does refuse is STARTING one:
a `POST /agent` whose conversation id carries a run prefix (`xt-`, `dg-`, `mt-`) is a fan-out of isolated agents
against a checkout that does not exist here, so it comes back as a refusal the extension already renders.

**The scripted turn is the centrepiece.** `AgentEventSchema` (`_libs/sandbox-contract/src/events.ts:186`) is the
whole streaming-turn protocol, and `/agent/attach` yields `{kind:"frame", seq, event}`. A recorded sequence on a
timer gives, in the real UI with no special-casing: `thinking` folding open, `delta` text typing,
`tool_call` → `tool_call_update` cards resolving with their line stats derived from the diffs (a Read, a Write, an
Edit, a Bash), `todos` ticking off, `context_usage` moving the meter, then a `plan` card and a `question` card that
**wait for the visitor's click** before the script continues. That last part is the demo: the visitor answers an
agent, and approving the plan even auto-opens the plan document in the main view, because that is what the app
does with an approved plan.

A run keeps a **frame log**, which is not an optimisation but the contract: `attach` replays the log and reports
the boundary as the head frame's `seq`, so a reload, a second tab, or the panel remounting joins the turn in
progress instead of restarting the script mid-sentence. `stop`, `steer` and a fresh `POST /agent` all land on the
same run registry, so the composer starts a short honest reply — "this is a recorded workspace; start a sandbox
and the same agent works on your repos" — rather than going nowhere.

**The agent's browser is the second recorded stream**, and it costs almost nothing: `/system/browser-view` is a
socket of frames whose payload is a base64 image, so a few hundred lines of generated SVG *are* a screencast as
far as the view can tell — three pages, a moving cursor, and the page tabs really switching, because the fixture
answers the `bind` frame the strip sends. No captured PNGs to go stale, nothing in the bundle but markup.

## Landing, which is the press the board exists for

`POST /agents/{id}/land` is the one mutation that changes four surfaces at once, so the demo does it for real
rather than refusing: the ready agent's delta moves into the main tree, its review rows flip to *landed*, its
card crosses into Finished, the Changes panel grows those files **with that agent's chip on them**, and a
`workspaceChanged` frame tells every open panel to re-read. It is the difference between a fleet board and a
list of jobs, and it is one click from the hero.

The conflicted agent is the other half, and it refuses exactly as the daemon does — nothing applied, the
worktree intact, and a report naming both causes: one file the main line moved under (the agent can rebase it)
and one held by the owner's own uncommitted edits (only they can clear it). That report is what the panel's
button ladder is built on, so refusing here is not a dead end but the second half of the story.

## Rewiring the actions

Three classes, decided per mutation:

- **Real, in memory** — rename, archive, drag between lanes, tab switches, open a file, open a diff, filter,
  the model picker, **landing**, **dropping a folder in**, extension switches, automation edits and approvals,
  memory edits, marking the pipelines board read, sending a message (advances the script). The fixture is
  mutable state; the UI is honest.
- **Inert with an invitation** — push, secrets writes, capability install, sandbox create, firing an automation,
  rerunning or cancelling someone else's pipeline. The handler answers a refusal the app already renders, and
  the demo shell shows one "this is a demo — start your own sandbox" CTA. Deliberately *not* hidden: seeing the
  button matters.
- **Absent** — git-installed extension bundles, and the tar path a drop of more than 20 files takes (a streaming
  fetch body the fixture would have to un-tar; under the threshold the per-file path serves the same drop).

**The drop is the third transport, and the only one the app opens by hand.** `sandboxUpload` posts each file
over `XMLHttpRequest` rather than fetch — a streaming fetch body needs HTTP/2, and the daemon's loopback
shortcut is HTTP/1.1 — so `installXhr` (`src/transport.ts`) claims the same two origins the fetch shim does and
routes them to the same handlers. What arrives is written into the flat path table, which is why the tree really
grows the dropped repository and every file in it opens.

**The extension list is read off the app build, not re-typed.** `GET /extensions` enumerates
`@intentic-app/web`'s own `builtinModules`, because the extension host treats a compiled-in extension the daemon
never mentioned as image/app version drift and says so on every row — true of a dogfooding sandbox, alarming
nonsense on a marketing page. Listing them from the registry means a new first-party extension appears here the
day it is added, with a switch that works, instead of appearing as a warning nobody wrote.

Anything the fixture does not serve answers 404 and logs one line naming the method and path. That console line is
the tool: it is how each of the routes in the table above got found, and how the next one will be.

## On the site

The hero keeps its static screenshot — it is the LCP, and the page ships essentially no JS. Over it sits a play
button; the scrim is nearly clear until hover, so the screenshot still does its job of being the product.

Pressing it opens the demo in a **near-full-viewport overlay**, not in the hero frame. That was the one design
decision the implementation changed: the hero column is ~525px, which puts the app in its mobile shell — a real
surface, but the wrong one for a page whose claim is "an IDE for your agents". The overlay gives it 94vw × 90vh,
where the fleet board, the docked chat and the terminal are all on screen at once. Escape, the backdrop and a
Close button all dismiss it, and the iframe is created once and kept, so re-opening returns to the screen the
visitor left rather than restarting the recording.

**It opens on `/demo/agents`.** The app's own default lands a desktop on the workspace, which for someone who
has just pressed play is the one screen with nothing in it — an empty tree and a drop zone, for files this
visitor does not have. The fleet board arrives full, and it is the thing being claimed. The redirect is written
into the URL by `src/main.ts` before the app boots, so there is no first paint of the wrong screen and no
history entry to press Back into; only the bare base is redirected, since every other address is one the
visitor chose. The app's own routing is untouched.

It sits **above the nav** (`z-200` over the nav's `z-100`), which is what makes it read as a window rather than
as another section of the page. The nav is `fixed`, so a lower overlay left the marketing header — and its
bottom border — stapled across the top of the IDE.

Below 1024px or without a fine pointer, the button opens the demo in its own tab instead, where the app's own
mobile shell can do a better job than any frame of ours. The iframe's `src` is set in the click handler, so until
someone presses it this page has loaded no part of the app.

## How it deploys

It ships **with the marketing site, at the same origin**, and needs no host of its own:

1. `_apps/demo` builds (`base: /demo/`) into `_apps/site/public/demo/` — gitignored, and Astro copies `public/`
   into its dist verbatim, so the demo lands in the site's own asset bundle.
2. The site's Cloudflare worker gains one rule: a navigation under `/demo/` that no asset answers serves
   `/demo/index.html`. That is the SPA fallback its history routes need, and the same rule its dev server runs.
3. `_apps/site` declares `@intentic-dev/demo` as a devDependency purely for ORDER — turbo's `^build` then builds
   the demo before Astro reads `public/`. Nothing is imported across that edge, and a site built without the
   demo present is still a valid site: `/demo/` simply isn't there.

Locally none of that applies: `public/demo/` is a build output, and `astro dev` runs no build, so the site's dev
server **proxies `/demo/` to the demo's own dev server** (`_apps/site/astro.config.mjs`, dev only). Two servers —
`pnpm -C _apps/site dev` and `pnpm -C _apps/demo dev` — and the overlay shows the live app with HMR, with no build
step between a fixture edit and the frame. With the demo's server down the proxy answers a page that says which
command to run, because a silent 404 in the overlay reads as a broken demo.

Same-origin is not just convenience. A cross-origin iframe gets **partitioned storage**, and the demo seeds
credentials into `localStorage` before the app boots — on a separate host that seeding is one browser policy away
from breaking the demo outright. `DEMO_PATH` is a relative `/demo/`, so a preview deploy embeds its own copy.

## What is left

- **Tour deep links** — `#see-it`'s seven shots could each open the overlay at the matching route, turning the
  section into seven doors into one app. The overlay already takes a URL; nothing but the wiring is missing.
- **Screenshot regeneration** — the payoff phase: drive the demo build under Playwright (`_tools/e2e` already
  drives this app) so `public/assets/product/*.png` stop being hand-captured. This is also the mitigation for the
  drift risk below.
- **One `pnpm install`** — `_apps/demo` is a new workspace package, so the lockfile has to catch up before its
  `dev`/`build` scripts run anywhere.

## Risks, honestly

- **Demo bundle weight** (PrimeVue, monaco, xterm, shiki) is real but lands behind a click, in a separate build,
  never on the marketing page's critical path.
- **The demo build shares the app build's worktree limitation**: both fail to resolve `@intentic/extension-ui`
  from `_extensions/maintenance` under an agent worktree's overlaid `node_modules` (see the workspace README).
  The demo's build is no worse off than the app's, and the dev server is unaffected — but neither the demo's
  production bundle nor the site's `/demo/` has been built in an environment where the app's own build passes.
- **`optimizeDeps.include` is anchored at the consuming config's root**, so `_apps/demo` declares the five
  packages that list names (`shiki`, `@shikijs/langs`, `@shikijs/themes`, `@vue-flow/core`, `@dagrejs/dagre`)
  even though it imports none of them directly — pnpm does not hoist. If that list in `vite.shared.ts` grows,
  the demo's `package.json` has to grow with it or its highlighting silently degrades.
- **Fixture drift** is the failure mode that would embarrass us. Contract-typed handlers catch shape drift at
  build time; they cannot catch *narrative* drift (a fixture that describes a feature we changed). Phase 3 is the
  mitigation — if the screenshots come from the demo, a stale demo is visible in review.
- **The uncanny valley**: a demo that looks live and dead-ends silently is worse than a screenshot. Every inert
  action must say why in the app's own voice, not fail quietly.
