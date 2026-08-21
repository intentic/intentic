# @intentic/browser

Drive a Chromium-family browser from Node over CDP: open pages, read them as **structured text**, and click and
type by element reference. No dependencies.

```ts
import { browser } from "@intentic/browser";

const web = browser();
const page = await web.open("https://example.com/login");
// page.elements → [{ ref: "e0", role: "textbox", name: "Email" }, …]

await web.fill("e0", "someone@example.com");
await web.fill("e1", "…", true);          // true = submit
const after = await web.snapshot();
```

## Why references instead of coordinates

A browser can be operated by clicking pixels, and it is miserable: the coordinates move when the window moves, a
scroll invalidates every one of them, and "the Submit button" is a guess about which grey rectangle is which.

A browser will simply tell you what it is showing. So this asks it: one snapshot returns every visible element
with its role (`link`, `button`, `textbox`), its accessible name, and what it currently holds: and every action
names an element rather than a position. The same instruction then works at any window size, on any machine,
after any re-render.

**Refs are deliberately short-lived.** They index an array parked on the page, and the next snapshot replaces it,
so a ref taken before a click that navigated cannot silently address whatever now occupies that slot. A stale ref
fails loudly, which is the behaviour worth having.

## Which browser it drives

**Not the user's own.** A browser only speaks CDP if it was started with `--remote-debugging-port`, and nobody's
everyday browser was; restarting theirs to add the flag would close every tab they had open. So: if a debugging
endpoint is already there, it is used; otherwise a separate instance starts with its own profile directory under
`~/.intentic/host/browser`.

That separate profile is a feature rather than a compromise. It is empty the first time, so the user signs into
whatever is needed once, in a window they can watch, and it persists afterwards. Their own session is never
automated and never at risk from a misfired click.

## Why hand-rolled CDP rather than Puppeteer or Playwright

**Not because Playwright is too heavy to ship.** It bundles into the `bun build --compile` binary this ends up
inside perfectly well: one `--external chromium-bidi`, for a require its own bundle makes and never resolves, and
about 6 MB on top of a binary that already weighs ~95 MB. Anyone who assumes packaging is the obstacle will try
it, watch it compile, and conclude this package exists for no reason.

**It is that Playwright cannot reach a browser from Bun.** `chromium.connectOverCDP()` fetches the debugger's
WebSocket URL over HTTP, then stalls on the upgrade and times out thirty seconds later. That happens compiled and
uncompiled alike, so it is the runtime rather than the bundling: and the same script against the same Chrome on
Node drives the page and returns an accessibility snapshot. Bun's own global `WebSocket`, which is what this
package is built on, connects from inside the compiled binary and gets a CDP reply back.

CDP needs no dependency either way. The protocol is JSON, `fetch` and `WebSocket` are globals, and the ~200 lines
here are the subset that driving a page actually uses.

**Worth re-testing rather than inheriting.** The above was measured against playwright-core 1.62.1 on Bun 1.3.14.
If a later pair connects, Playwright's accessibility snapshot is a better instrument than the DOM walk in
`snapshot.ts`, and this whole package is ~500 lines: the trade would be worth making, not merely tolerable.

## What is testable without a browser

`snapshot.ts`'s renderer and ref parsing, and the per-platform browser search: all pure. The CDP calls end in a
real Chrome painting a real page; those need a machine, not a test.

## Key files

- [src/index.ts](src/index.ts): the public surface.
- [src/cdp.ts](src/cdp.ts): the hand-rolled Chrome DevTools Protocol client.
- [src/snapshot.ts](src/snapshot.ts): a page as structured text with stable element references.
- [src/launch.ts](src/launch.ts): finding and starting a browser.
