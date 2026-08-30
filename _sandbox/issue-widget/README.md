# @intentic/issue-sdk

The **bug reporter** a website or app embeds to send crashes and user reports to a sandbox agent. One IIFE
bundle with no dependencies, served by the daemon at `/intake/sdk.js`, plus an ESM build for bundlers.

```html
<script src="https://sandbox-<id>.<zone>/intake/sdk.js"
        data-automation="bugs" data-release="a1b2c3d" defer></script>
```

`data-automation` is the intake's automation id and the only thing the snippet must carry. The daemon to talk
to is the origin the script itself came from: the one thing a copy-pasted snippet cannot get wrong.
`data-base` overrides it for a site fronting the sandbox behind its own proxy.

With a bundler instead:

```ts
import { init, captureException, openReportDialog } from "@intentic/issue-sdk";

const client = await init({ automationId: "bugs", base: "https://sandbox-…", release: __GIT_SHA__ });
```

## What it sends, and what it refuses to send

- **Crashes** — `error` and `unhandledrejection`, added as listeners, never assigned to `window.onerror`
  (that slot belongs to whatever the site already had there).
- **Written reports** — `report({ description, email? })`, or the built-in dialog via `openReportDialog()`.
- **Breadcrumbs** — the last 40 of: `console.warn`/`console.error`, **failed** requests, navigations, clicks.
  Never request bodies, never keystrokes, never `console.log`. A click is recorded as `button#checkout "Pay
  now"`, not as the page's text.
- **`beforeSend`** is the host's last word: return a modified report, or `null` to drop it.

`data-release` is the field worth wiring up. The agent has the repository, so a commit sha is enough for it to
check that build out and read your real frames — **there are no sourcemaps to upload anywhere in this product.**

## Gotchas worth knowing before you edit this

- **This must never be the thing that breaks the page.** Every send path swallows its own failures and
  `report()` resolves rather than rejecting. The only failure that reaches the caller is the config fetch at
  startup, because a reporter that silently posts into the void is worse than one that says it could not start.
- **`ErrorEvent.error` is `null` when absent, not `undefined`.** An `=== undefined` check lets every broken
  `<img>` through as a crash whose message is the string `"null"`. A resource error is told apart by
  `event.target instanceof Element` — *not* by `target !== window`, which is false in a jsdom global proxy and
  in any iframe.
- **`keepalive: true` on the report POST is load-bearing.** A crash is usually followed by a navigation or a
  reload, and an ordinary fetch is cancelled with the document. It caps the body at 64 kB in every browser,
  which is why the ingest schema's bounds sit well under that. `sendBeacon` cannot set a JSON content-type
  without a preflight it cannot answer.
- **`all: initial` on the dialog host in `styles.ts` is load-bearing.** A shadow root blocks the page's
  *selectors* but not inherited properties: without it the dialog wears the host site's font and colour.
- **The proof of work guards written reports only.** A crash handler fires on a dying page, where there is no
  second to spend and nobody waiting. What bounds the crash path is the daemon's grouping.
- **Types come from `@intentic/sandbox-contract`, imported as types only.** That is why it is a
  *devDependency*: the import is erased at build, so zod never reaches a visitor's browser. A value import from
  the contract would multiply the bundle size.

## Commands

```sh
./node_modules/.bin/vite build     # → dist/sdk.js (IIFE) + dist/sdk.mjs (ESM)
./node_modules/.bin/vitest run
```

The daemon takes this package as a **prod dependency** and resolves `dist/sdk.js` through its export, so
`pnpm --filter @intentic/sandbox deploy --prod` carries the built bundle into the image with no Dockerfile
change. The other half of the wire is `_sandbox/sandbox/src/issues/`.

## Key files

- [src/main.ts](src/main.ts): the entry — auto-boots from a `<script>` tag, or `init()` from an import.
- [src/client.ts](src/client.ts): everything between "an error happened" and "the daemon has it".
- [src/capture.ts](src/capture.ts): the uncaught-error handlers, and what they decline to report.
- [src/breadcrumbs.ts](src/breadcrumbs.ts): the ring buffer, and what it deliberately does not instrument.
- [src/dialog.ts](src/dialog.ts) / [src/styles.ts](src/styles.ts): the optional report box.
