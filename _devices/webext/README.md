# @intentic/webext

The browser extension that lets your sandbox work **in the browser you are already signed into**, on the sites
you allow, while you watch it happen.

It is the machine half of the `webext` capability; the sandbox half is `_sandbox/sandbox/src/webext/`.

```
your browser                                   your sandbox
┌───────────────────────────────┐              ┌─────────────────────────────┐
│ service worker                │ one outbound │ /system/webext/connect (hub)│
│  ├─ oRPC server               │ ──── wss ──▶ │   holds the oRPC CLIENT     │
│  │   describe/setScopes/      │ webextContract│ /mcp/webext/<id>  (bridge) │
│  │   ping/mcp                 │              │        ▲                    │
│  ├─ MCP tools ──┐             │              │   the agent's tools         │
│  ├─ per-site grants (Chrome's)│              └─────────────────────────────┘
│  └─ activity log│             │
│     popup ──────┘             │  POST /system/webext/session ──▶ (cookies, never a tool result)
│                               │  POST /system/webext/lend    ◀── (the same door, outbound)
└───────────────────────────────┘
        │ chrome.scripting
        ▼
  the page: snapshot, click, type, and a banner saying so
```

## Why this exists next to the sandbox's own browser

The sandbox already has a Chromium with logged-in profiles, and it is the right tool for most work: it runs
while nobody is at the keyboard. What it can never be is **you** — your passkey, your hardware second factor,
your employer's SSO, your bank's device fingerprint. Those sites are not a matter of having the right cookie;
they are a matter of being the browser the account was enrolled on.

So this borrows that browser without copying its profile or sign-ins as part of normal use. Content from a site
the person allows is sent to the sandbox so the agent can understand and operate that page. A site's session
cookies leave only through the separate hand-over action, behind an off-by-default switch and an in-page
confirmation. The person is sitting in front of it, which is the other half of the design: every action draws
a line in the corner of the tab it happened in, and anything that looks like paying, deleting or submitting a
credential asks them first, in the page.

**And the same door runs the other way.** The sandbox can show its own browser and let the owner drive it, which
covers most things and cannot cover a passkey bound to an authenticator they physically hold, a hardware key
that has to be touched, or an SSO that checks the device. For those, driving a remote browser is not a worse
experience — it is an impossible one. `lend_site` borrows that account's session into THIS browser for the
length of that step, the person finishes it as themselves, and `connect_site` hands the refreshed session back.
Same switch, same in-page confirmation, same rule about the socket, one site at a time.

## The three gates, and only one of them is ours

1. **Chrome's own host permissions.** Sites are granted one at a time, by the person, from the popup, and
   revocable in the browser's own settings. `chrome.scripting.executeScript` on an ungranted origin fails at the
   browser, below any code in this package. The agent cannot grant itself a site — `permissions.request` only
   resolves true under a user gesture in an extension page, which is why `ask_access` leaves a request in the
   popup and stops.
2. **The read/act mode**, per site, stored here. Chrome has no concept for "may look, may not touch"; this
   supplies it.
3. **The card's switches** (`read`, `act`, `screenshot`, `cookies`, `confirm`), pushed down the socket from the
   sandbox and enforced in `background/policy.ts` — the only place any of them is checked. The daemon checks
   nothing, so there is no second implementation to drift.

A sandbox that was talked into something by a web page still cannot widen any of the three: it asks, and this
answers.

## Gotchas worth knowing before you edit this

- **Every function in `page/driver.ts` is serialized and re-parsed in somebody's page.** It may not close over
  anything in this bundle. A helper hoisted out of one of them type-checks, builds, and throws `ReferenceError`
  on a stranger's website. That file's header says it louder.
- **An MV3 service worker is not a process.** Chrome kills it after ~30 seconds idle and rebuilds it on the next
  event, so nothing that matters may live in module state: the token, the switches and the pause flag are in
  `chrome.storage`. An open WebSocket keeps its own worker alive (Chrome 116+ counts socket traffic as
  activity), which is why the daemon heartbeats at **20s** and not the machine hub's 30 — and why a
  `chrome.alarms` timer re-dials anyway, for the gap after a laptop sleeps.
- **`tabs` is deliberately not in `permissions`.** Without it, `chrome.tabs.query` returns a tab's URL and title
  only for origins the person granted. That is the privacy property this connector rests on: allowing the agent
  on your Jira does not show it the other eleven tabs. The listing says so in words rather than showing blanks.
- **`chrome.debugger` is not used, on purpose.** It would give higher-fidelity input events and a scary
  permanent infobar on every tab, plus a much slower store review. Content-script events with the native value
  setter (see `fillRef`) cover the real web; the cases they do not are canvas apps, where `screenshot` is the
  honest answer anyway.
- **The page vocabulary is shared, the walk is not.** `renderPage`, `refIndex` and `PageElement` come from
  `@intentic/browser/page`, so an agent that learned `[e4] button "Send"` driving the sandbox's browser has
  nothing new to learn here. The DOM walk itself is this package's own, because it can be better: real DOM
  types, shadow roots pierced, password contents never read back.
- **The background bundle is ~740 kB minified**, most of it the contract's schema surface reached through the
  barrel import. The content script is 374 bytes, which is the number that mattered — it is injected into
  every sandbox page — and it is why `@intentic/sandbox-contract/webext-links` exists. Trimming the background
  the same way needs the webext schemas to get their own contract entry point.

- **The mark and the accent are the product's, not this package's.** The icons are rendered from the same
  `LOTUS` in `_site/site/src/components/ornaments.ts` that the favicon and the desktop app draw from — one
  drawing, never a hand-copy — and the ember (`#e07b27`) in the popup button, the in-page banner and the
  toolbar badge is `--color-primary-500` from the site's palette. This shipped once with an invented purple
  browser-and-cursor icon, which is exactly the second logo that rule exists to prevent.

## Commands

```sh
pnpm --filter @intentic/webext build      # → dist/, loadable as an unpacked extension
pnpm --filter @intentic/webext test
pnpm --filter @intentic/webext package    # → dist.zip, what the store takes
pnpm --filter @intentic/webext icons      # re-render static/icons/ from the shared lotus
pnpm --filter @intentic/webext store-assets # re-render the required 440×280 listing tile
```

Then in Chrome: **Extensions → Developer mode → Load unpacked → `_devices/webext/dist`**. Pair it with the
code from a `webext` capability's card (**Connect**), or open the card in the same browser and the extension
picks the code up on its own.

A locally built extension reports version **0.0.0.1**: Chrome rejects the workspace's all-zero sentinel, and
this deliberately low valid version is what creates the listing on its first manual upload. Release versions
live on git tags (`_tools/scripts/lib/packages.sh`), and `scripts/stamp-manifest.mjs` derives the manifest number
from the stamped package in CI. After that first upload, do not hand-publish another zip — every store version
must be strictly newer, and the release pipeline owns the sequence.

## Publishing

Every release publishes itself: `.github/workflows/webstore-publish.yml` builds this package at the tag,
packs it, uploads it and submits it for review. It skips loudly while the five `CHROME_WEBSTORE_*` values are
unset, which is the state until the listing has been created by hand once.

- [PUBLISHING.md](PUBLISHING.md): the one-time setup — developer account, first upload, OAuth credentials.
- [STORE-LISTING.md](STORE-LISTING.md): every field of the listing form, written out.

## Key files

- [src/background/link.ts](src/background/link.ts): the one socket, and why reconnection is shaped by the worker's lifetime.
- [src/background/mcp.ts](src/background/mcp.ts): the tool surface the agent sees. Adding a tool is a store release, not a daemon one.
- [src/background/policy.ts](src/background/policy.ts): the enforcement point. Every refusal a person will read starts here.
- [src/background/tools/session.ts](src/background/tools/session.ts): handing a site's session TO the sandbox — the one place a credential leaves this browser.
- [src/background/tools/lend.ts](src/background/tools/lend.ts): borrowing one back, for the steps no remote browser can perform, and why the cookies ride an HTTPS response rather than the socket.
- [src/page/driver.ts](src/page/driver.ts): what runs inside the page — the walk, the actions, the banner, the confirmation.
- [src/popup/popup.ts](src/popup/popup.ts): the 340 pixels that make this installable, and the only place a permission is ever asked for.
- [static/manifest.json](static/manifest.json): four permissions, one optional host pattern, one content script.
- [scripts/pack.mjs](scripts/pack.mjs): dist/ as one zip, written by hand because the CI image has no `zip`.
- [scripts/render-icons.mjs](scripts/render-icons.mjs): the four PNGs, read out of the site's lotus rather than redrawn.
- [scripts/render-store-assets.mjs](scripts/render-store-assets.mjs): the mandatory promotional tile, from that same lotus.
