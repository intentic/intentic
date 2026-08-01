# @intentic-dev/demo

The interactive demo behind the landing page's hero: **the real `@intentic-app/web` app**, running against a
recorded fixture instead of a sandbox. Its entry installs a fake platform and a fake daemon on the two globals
the app reaches the outside world through, seeds the credentials the router gates look for, and then imports the
app's own `main.ts`. Nothing in the app is aware of it.

```sh
pnpm -C _apps/demo dev      # http://localhost:47146/demo/
pnpm -C _apps/demo build    # → _apps/site/public/demo/ (Astro copies it into the site's dist)
```

Working on the marketing site's hero overlay means running **both** dev servers: `astro dev` proxies `/demo/`
to this one (`_apps/site/astro.config.mjs`), because `public/demo/` is a build output that nothing produces
during `astro dev`. Without it the overlay says so in the frame rather than 404ing.

## Why it is its own package

It lived in `_apps/web/src/demo/` first, which was wrong in three checkable ways: a fixture edit matched CI's
`_apps/web/**/*` glob and re-released the **product** images, knip reported the whole directory as unused files
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
| `src/fixture/` | the data — `fleet.ts` (the roster), `transcripts.ts` (what a finished agent's chat holds), `workspace.ts` (the filesystem, diffs, landing), `chores.ts`, `acceptance.ts`, `docs.ts`, `storefront.ts`, `ci.ts`, `memory.ts`, `automations.ts`, `sandbox.ts` |

`fixture/workspace.ts` holds one flat path → content table that the tree, every directory listing, every read,
the content search and every write derive from — so the surfaces whose whole state is FILES (Acceptance's
stories and runs, Documentation's published and staged sets, Maintenance's run history) are fixtured by adding
paths to it, and the extensions walk exactly what they would walk against a real daemon. `sandbox.ts`'s
`demoPanels()` is the other half of that: the per-repo facts every extension's `detect()` runs over, and
therefore which tiles the rail carries at all.

Anything the fixture does not serve answers 404 and logs one line naming the method and path. That console line
is the tool: it is how the served routes were found, and how the next one will be.

Two things this package owns that the app resolves against its BASE rather than the origin root, because here
that root belongs to the marketing site: the pop-out window's page (`popout.html`, which the dev server's SPA
fallback excepts by name and the build emits as a second entry) and the address the recording opens on —
`src/main.ts` rewrites a bare `/demo/` to `/demo/agents` before the app boots, so a visitor who presses play
lands on the fleet board rather than on an empty workspace.

Design notes, the route/event coverage table and what is deliberately absent:
[`docs/marketing/interactive-demo.md`](../../docs/marketing/interactive-demo.md).
