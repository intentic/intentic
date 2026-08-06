# @intentic-dev/demo

The landing page's playable demo — the real editor, running on a recording instead of a sandbox.

It is **the actual `@intentic-app/web` app**, not a mock-up. Its entry installs a fake platform and a fake daemon on the two globals
the app reaches the outside world through, seeds the credentials the router gates look for, and then imports the
app's own `main.ts`. Nothing in the app is aware of it.

```sh
pnpm -C _site/demo dev      # http://localhost:47146/demo/
pnpm -C _site/demo build    # → _site/site/public/demo/ (Astro copies it into the site's dist)
```

Working on the marketing site's hero overlay means running **both** dev servers: `astro dev` proxies `/demo/`
to this one (`_site/site/astro.config.mjs`), because `public/demo/` is a build output that nothing produces
during `astro dev`. Without it the overlay says so in the frame rather than 404ing.

## Why it is its own package

It lived in `_editor/web/src/demo/` first, which was wrong in three checkable ways: a fixture edit matched CI's
`_editor/web/**/*` glob and re-released the **product** images, knip reported the whole directory as unused files
(web's entry list can't see a second html), and the package emitted two dist directories while its Dockerfile
assumes one. The boundary also does what a boundary is for — app code cannot reach the fixture by accident.

The dependency runs one way and only one way: this package depends on `@intentic-app/web`, imports its entry
through the `./main` export, its compiled-in extension registry through `./builtins`, and shares its Vite setup
through `./vite-shared`. Web knows nothing about this.

## Layout

| File | What it is |
| --- | --- |
| `index.html` | the entry; sets `window.env` inline (sentinel origins) and loads `src/main.ts` |
| `popout.html` | the window a popped-out panel is teleported into; loads `src/popout.ts`, which is the app's keeper and nothing else |
| `src/transport.ts` | what the demo claims from `fetch`/`WebSocket`/`XMLHttpRequest`, and the socket shim |
| `src/platform.ts` | the platform as a fetch handler: the session and the sandbox row the gates need |
| `src/daemon.ts` | the daemon as a fetch handler: the route table and the `/events` stream |
| `src/turn.ts` | the recorded `AgentEvent` run behind `/agent/attach`, with its frame log |
| `src/sse.ts` | the event-iterator wire format |
| `src/terminal.ts` | the recorded pty, as `TerminalServerMessage` frames |
| `src/browser.ts` | the recorded screencast of the agent's Chromium, played from the pages below |
| `src/mode.ts` | how full the recording is — the three states, and which one this page load serves |
| `src/switcher.ts` | the bar at the bottom of the screen that switches between them; the demo's only chrome |
| `src/fixture/` | the data — `fleet.ts` (the roster), `transcripts.ts` (what a finished agent's chat holds), `workspace.ts` (the filesystem, diffs, landing), `chores.ts`, `acceptance.ts`, `docs.ts`, `storefront.ts`, `ci.ts`, `memory.ts`, `automations.ts`, `sandbox.ts` |

`fixture/workspace.ts` holds one flat path → content table that the tree, every directory listing, every read,
the content search and every write derive from — so the surfaces whose whole state is FILES (Acceptance's
stories and runs, Documentation's published and staged sets, Maintenance's run history) are fixtured by adding
paths to it, and the extensions walk exactly what they would walk against a real daemon. `sandbox.ts`'s
`demoPanels()` is the other half of that: the per-repo facts every extension's `detect()` runs over, and
therefore which tiles the rail carries at all.

It also owns the file CONTENT the featured run edits, which `turn.ts` imports rather than repeats — the tool
card in the chat and the row in the Changes panel are the same edit seen twice, and two copies of the string
drift. A path it carries no diff for opens on a note saying so, written as an addition in prose: two identical
sides are not a change and there would be nothing to render, and a note written as a comment is taken back out
by the reading setting that strips comments before the diff is computed.

Anything the fixture does not serve answers 404 and logs one line naming the method and path. That console line
is the tool: it is how the served routes were found, and how the next one will be.

## How full it is — the three modes

The fixture is written to prove every surface exists, which made the opening frame a workspace at full tilt:
nine agents, a question, a land conflict, fourteen extensions in the rail. Fullness is a **control** now
(`src/mode.ts`), and the play button opens the middle one.

| Mode | The board | The rail |
| --- | --- | --- |
| `minimal` | the featured agent alone | no extensions at all |
| `default` | three agents — one running, one asking, one ready to land | Acceptance, Documentation, Pipelines (+ `viewers`, which has no tile) |
| `full` | the whole roster, every lane occupied | every extension |

Two knobs decide almost all of it, because they are what the shell builds itself out of: which agents the
roster carries, and which extensions the owner left switched on. A third drops the teammate's presence in
`minimal`. Everything else the fixture serves is the same in all three — the workspace, the sessions history,
the pipelines' record, the connected accounts are read on the way in to a surface the visitor asked for, not
things the opening frame is made of.

The mode is applied where it is **served** — `daemon.ts` filters the roster, the presence frame and the
workflow run; `fixture/sandbox.ts` decides each extension's switch — so the fixture stays one full cast and a
mode is a view onto it. Every extension is still listed in the hub's Extensions tab with a working switch, so a
visitor in `minimal` can turn the rail back on one tile at a time.

Switching **reloads** and lands on the fleet board. The extension host activates the daemon's list once per app
load, so which tiles the rail carries is decided on the way in; and the route a visitor is standing on may
belong to an extension the next mode switches off. The choice lives in `sessionStorage` (per tab, so a later
visit still meets the curated opening frame) and `?mode=minimal` on the address seeds it once, then is stripped
from the URL so it cannot outrank the switcher.

Two things this package owns that the app resolves against its BASE rather than the origin root, because here
that root belongs to the marketing site: the pop-out window's page (`popout.html`, which the dev server's SPA
fallback excepts by name and the build emits as a second entry) and the address the recording opens on —
`src/main.ts` rewrites a bare `/demo/` to `/demo/agents` before the app boots, so a visitor who presses play
lands on the fleet board rather than on an empty workspace.

Design notes, the route/event coverage table and what is deliberately absent:
[`docs/marketing/interactive-demo.md`](../../docs/marketing/interactive-demo.md).

## Key files

- [src/main.ts](src/main.ts) — the entry: install the fakes, seed credentials, then import the app's own `main.ts`.
- [src/platform.ts](src/platform.ts) / [src/daemon.ts](src/daemon.ts) — the two globals the app reaches the outside world through.
- [src/fixture](src/fixture) — the recording: every surface's contents, as data.
- [src/turn.ts](src/turn.ts) — replaying an agent turn convincingly, including its timing.
- [src/mode.ts](src/mode.ts) — what the demo allows and what it quietly declines.
