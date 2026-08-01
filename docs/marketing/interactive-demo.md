# The interactive demo

The landing page's hero and tour show hand-captured PNGs (`_apps/site/public/assets/product/`). This document
covers what sits behind the *click* on them: the **real app**, running against a fixture instead of a sandbox.
Every section fills with plausible data, the sessions window opens, a turn streams into the chat, a diff opens.
Nothing is re-implemented for marketing.

Run it with `pnpm -C _apps/web demo` (http://localhost:47146). The app's own dev server is untouched.

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
is that wrapper. **No production module changes.**

So the demo is a second Vite entry of the same app:

```
_apps/web
├── demo.html                     # entry; sets a demo window.env inline, then loads src/demo/main.ts
├── vite.demo.config.ts           # `pnpm demo` (47146) · `pnpm demo:build` → dist-demo/
└── src/demo/
    ├── main.ts                   # install transports → seed credentials → import the real ../main.ts
    ├── transport.ts              # what the demo claims from fetch/WebSocket, and the socket shim
    ├── platform.ts               # the platform, as a fetch handler (the session + the sandbox row)
    ├── daemon.ts                 # the daemon, as a fetch handler: the route table + /events
    ├── turn.ts                   # the scripted AgentEvent run behind /agent/attach
    ├── sse.ts                    # the event-iterator wire format
    ├── terminal.ts               # the recorded pty, as TerminalServerMessage frames
    └── fixture/                  # the data: fleet.ts (the roster), workspace.ts (repos, diffs, sessions)
```

Both handlers are plain `Request → Response` functions with contract types on every payload
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
| Review panel | `GET /agents/{id}/diff`, `/{id}/transcript`, `/{id}/{repo}/file-diff` | the soft-deletes agent: 4 files over 2 repos, +210 −55, two of them with real before/after text |
| Chat | `POST /agent`, `POST /agent/attach` (stream), `/agent/commands`, `/agent/refusals`, `POST /agent/reply`, `/agent/steer`, `/agent/stop` | the scripted turn, below |
| Model picker | `GET /claude/accounts`, `/grok/accounts`, `/translator/accounts`, `/{provider}/models` | a connected Claude Max and a ChatGPT subscription in the translator — without these the composer never leaves "Checking your AI accounts…" |
| Sessions window | `GET /sessions?query=` (searchable), `GET /sessions/{id}` | 12 conversations from 90 seconds to 6 days old |
| Workspace | `GET /workspace/tree`, `/workspace/file`, `/git/repos`, `/git/changes`, `/git/{repo}/file-diff` | `acme-shop`: a `web` and an `api` repo, ~30 files, 5 dirty ones across both |
| Sandbox hub | `GET /info`, `/settings`, `/settings/savings`, `/system/usage`, `/secrets/inventory`, `/ports`, `/environment`, `/members`, `/extensions`, `/panels`, `/vpn`, `/ci/runs`, `/chores` | a measured cleaner-savings report; the rest answer their empty shape, which is the truth about a recording |
| Terminal | `GET /system/terminals` + the `/system/terminal` WebSocket | the featured turn's own tmux session, replaying its vitest run — xterm renders the ANSI for real |

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

## Rewiring the actions

Three classes, decided per mutation:

- **Real, in memory** — rename, archive, drag between lanes, tab switches, open a file, open a diff, filter,
  the model picker, sending a message (advances the script). The fixture is mutable state; the UI is honest.
- **Inert with an invitation** — land, push, secrets writes, capability install, sandbox create. The handler
  answers a refusal the app already renders, and the demo shell shows one "this is a demo — start your own
  sandbox" CTA. Deliberately *not* hidden: seeing the land button matters.
- **Absent** — file upload (the XHR path in `sandboxUpload`), the browser view's image stream, extension bundles.
  Not built; the drop zone is simply not part of the tour.

Anything the fixture does not serve answers 404 and logs one line naming the method and path. That console line is
the tool: it is how each of the routes in the table above got found, and how the next one will be.

## On the site

The hero keeps its static screenshot — it is the LCP, and the page ships essentially no JS. Over it sits a play
button; the scrim is nearly clear until hover, so the screenshot still does its job of being the product.

Pressing it opens the demo in a **near-full-viewport overlay**, not in the hero frame. That was the one design
decision the implementation changed: the hero column is ~525px, which puts the app in its mobile shell — a real
surface, but the wrong one for a page whose claim is "an IDE for your agents". The overlay gives it 94vw × 90vh,
where the fleet board, the docked chat and the terminal are all on screen at once. Escape, the backdrop and a
Close button all dismiss it, and the iframe is created once and kept, so re-opening returns to the workspace the
visitor left rather than restarting the recording.

Below 1024px or without a fine pointer, the button opens the demo in its own tab instead, where the app's own
mobile shell can do a better job than any frame of ours. The iframe's `src` is set in the click handler, so until
someone presses it this page has loaded no part of the app.

## What is left

- **Tour deep links** — `#see-it`'s seven shots could each open the overlay at the matching route, turning the
  section into seven doors into one app. The overlay already takes a URL; nothing but the wiring is missing.
- **Screenshot regeneration** — the payoff phase: drive the demo build under Playwright (`_tools/e2e` already
  drives this app) so `public/assets/product/*.png` stop being hand-captured. This is also the mitigation for the
  drift risk below.
- **A deploy target** — `DEMO_URL` points at `demo.intentic.dev`; `pnpm -C _apps/web demo:build` writes
  `dist-demo/`, which is a static directory needing one SPA fallback to `demo.html`. Nothing hosts it yet.

## Risks, honestly

- **Demo bundle weight** (PrimeVue, monaco, xterm, shiki) is real but lands behind a click, in a separate build,
  never on the marketing page's critical path.
- **The demo build shares the app build's worktree limitation**: both fail to resolve `@intentic/extension-ui`
  from `_extensions/maintenance` under an agent worktree's overlaid `node_modules` (see the workspace README).
  `demo:build` is no worse off than `build`, and the dev server is unaffected — but the demo has not yet been
  built in an environment where the app's own build passes.
- **Fixture drift** is the failure mode that would embarrass us. Contract-typed handlers catch shape drift at
  build time; they cannot catch *narrative* drift (a fixture that describes a feature we changed). Phase 3 is the
  mitigation — if the screenshots come from the demo, a stale demo is visible in review.
- **The uncanny valley**: a demo that looks live and dead-ends silently is worse than a screenshot. Every inert
  action must say why in the app's own voice, not fail quietly.
