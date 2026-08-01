# The interactive demo — scope

The landing page's hero and tour currently show hand-captured PNGs (`_apps/site/public/assets/product/`). This
document scopes replacing the *click* on them with the **real app**, running against a fixture instead of a
sandbox: every section fills with plausible data, the sessions window opens, a turn streams into the chat, a
diff opens. Nothing is re-implemented for marketing.

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
├── demo.html                     # entry; loads a demo window.env, then src/demo/main.ts
└── src/demo/
    ├── main.ts                   # install transports → seed credentials → mount the real App.vue
    ├── platform.ts               # the platform, as a fetch handler (5 routes)
    ├── daemon/
    │   ├── router.ts             # implement(sandboxContract) — a partial daemon, contract-typed
    │   ├── events.ts             # the /events generator: hello, agents, workspaceChanged, presence
    │   └── turn.ts               # the scripted AgentEvent stream behind /agent/attach
    ├── socket.ts                 # WebSocket shim: replays TerminalServerMessage frames
    └── fixture/                  # the data: fleet, repos, tree, transcripts, capabilities
```

Built with `vite build --mode demo`, deployed as a static bundle. The demo daemon is a real
`OpenAPIHandler(implement(sandboxContract))` — the same construction as `_apps/sandbox/src/app.ts:131` — so
its handlers are typed by the contract and its responses are schema-validated on the way out. A contract change
that the fixture doesn't follow is a build error, not a silently stale demo. (`@orpc/server` + `@orpc/openapi`
become web devDependencies, present only in the demo bundle.)

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

Per surface, the routes each one actually calls:

| Surface | Routes | Fixture |
| --- | --- | --- |
| Fleet board `/agents` | `GET /agents`, `/agents/search`, `/agents/{id}/rename`, `/archive`, `/unarchive`, `/{id}/seen` | 6–8 agents spread over Attention / Active / Done, with tokens, cost, ±diffstat, context %, live activity lines |
| Review panel | `GET /agents/{id}/diff`, `/{id}/transcript`, `/{id}/{repo}/file-diff` | one agent with a real multi-file diff |
| Chat | `POST /agent`, `GET /agent/attach` (stream), `/agent/commands`, `/agent/refusals`, `POST /agent/reply`, `/agent/steer`, `/agent/stop` | the scripted turn, below |
| Sessions window | `GET /sessions?query=`, `GET /sessions/{id}` | ~12 sessions, a few with transcripts |
| Workspace | `GET /git/repos`, `/git/changes`, `/git/{repo}/log`, `/git/{repo}/file-diff`, `/workspace` tree + `/workspace/raw` | 2 repos, a few dozen files, 3 dirty ones |
| Capabilities | `GET /capabilities`, `/capabilities/marketplace` | the real catalog shape, a couple installed |
| Sandbox hub | `GET /info`, `/system/usage`, `/secrets/inventory`, `/ports`, `/environment`, `/members`, `/extensions`, `/panels` | enough for each tab to read as populated |
| Terminal | `GET /system/terminals` + the WebSocket | a recorded `{type:"data"}` script — xterm renders it for real |

**The scripted turn is the centrepiece.** `AgentEventSchema` (`_libs/sandbox-contract/src/events.ts:186`) is the
whole streaming-turn protocol, and `/agent/attach` yields `{kind:"frame", seq, event}`. Emitting a recorded
sequence on a timer gives, in the real UI with no special-casing: `thinking` folding open, `delta` text typing,
`tool_call` → `tool_call_update` cards resolving (a Read, an Edit with a diff, a Bash), `todos` ticking off,
`context_usage` and `usage` moving the meters, then a `plan` card and a `question` card that **wait for the
visitor's click** before the script continues. That last part is the demo: the visitor answers an agent.

## Rewiring the actions

Three classes, decided per mutation:

- **Real, in memory** — rename, archive, drag between lanes, tab switches, open a file, open a diff, filter,
  the model picker, sending a message (advances the script). The fixture is mutable state; the UI is honest.
- **Inert with an invitation** — land, push, secrets writes, capability install, sandbox create. The handler
  answers a refusal the app already renders, and the demo shell shows one "this is a demo — start your own
  sandbox" CTA. Deliberately *not* hidden: seeing the land button matters.
- **Absent** — file upload (XHR path, `sandboxUpload`), the browser view's image stream, extension bundles.
  Out of scope for v1; the drop zone is simply not part of the tour.

## On the site

The hero keeps its static screenshot — it is the LCP, and the page currently ships essentially no JS. The
screenshot gets a play affordance; clicking swaps in a lazily-loaded `<iframe>` of the demo (or opens it in a
tab on mobile, where an embedded IDE is not a good experience). Tour shots deep-link into the matching demo
route, so `#see-it` becomes seven doors into one app instead of seven pictures. The site build stays static and
independent of the app bundle.

## Phases

1. **Spine** — transports, gates, `/events` with `hello`/`heartbeat`/`agents`, the fleet board and the scripted
   turn. This is the whole hero moment and is worth shipping alone.
2. **Breadth** — workspace tree + diffs, sessions window, capabilities, sandbox hub tabs, the terminal replay.
3. **Payoff** — the tour shots regenerate from the demo build under Playwright (`_tools/e2e` already drives this
   app), so the product screenshots stop being hand-captured and stop going stale.

## Risks, honestly

- **Demo bundle weight** (PrimeVue, monaco, xterm, shiki) is real but lands behind a click, in a separate build,
  never on the marketing page's critical path.
- **Fixture drift** is the failure mode that would embarrass us. Contract-typed handlers catch shape drift at
  build time; they cannot catch *narrative* drift (a fixture that describes a feature we changed). Phase 3 is the
  mitigation — if the screenshots come from the demo, a stale demo is visible in review.
- **The uncanny valley**: a demo that looks live and dead-ends silently is worse than a screenshot. Every inert
  action must say why in the app's own voice, not fail quietly.
