# @intentic/browser

Drive a real browser by naming elements, not pixels.

```stats
{
  "items": [
    {"label": "Lines", "value": "648"},
    {"label": "Files", "value": "6"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

An agent operating a website by clicking coordinates is guessing: the numbers move when the window
moves, a scroll invalidates every one of them, and "the Submit button" becomes a question about grey
rectangles. A browser will simply say what it is showing, so this asks it — one snapshot returns every
visible element with its role, its name and what it holds, and every action names an element. The same
instruction then works at any window size, on any machine, after any re-render.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_libs/browser", "label": "browser", "note": "this package", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/host", "label": "host", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_libs/browser", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/host", "to": "_libs/browser"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox (10 of 13)",
  "items": [
    {"label": "sandbox", "value": 87958, "display": "88.0k", "accent": "2"},
    {"label": "sandbox-contract", "value": 13428, "display": "13.4k", "accent": "2"},
    {"label": "sync", "value": 2744, "display": "2.7k", "accent": "2"},
    {"label": "host", "value": 2244, "display": "2.2k", "accent": "2"},
    {"label": "scaffold", "value": 1925, "display": "1.9k", "accent": "2"},
    {"label": "webchat-widget", "value": 1457, "display": "1.5k", "accent": "2"},
    {"label": "desktop", "value": 1251, "display": "1.3k", "accent": "2"},
    {"label": "acp-bridge", "value": 1001, "display": "1.0k", "accent": "2"},
    {"label": "local-agent", "value": 687, "display": "687", "accent": "2"},
    {"label": "browser (this one)", "value": 648, "display": "648", "accent": "2"}
  ] }
```

## What is surprising

It speaks the Chrome DevTools Protocol by hand rather than using Puppeteer or Playwright, and that is
a compiled-binary constraint rather than taste: this ships inside a single-file executable, where a
library that finds a native addon by walking up from `__dirname` cannot load at all. The protocol is
JSON over a WebSocket, both of which are globals, so the subset that driving a page actually uses
needs no dependency and cannot fail to load on somebody's laptop.

It also never drives the user's own browser. A browser only accepts this protocol if it was started
with a debugging flag, and restarting theirs would close every tab they had open — so a separate
instance runs with its own profile. Empty the first time, signed in once by the user in a window they
can watch, and persistent afterwards.

## Where it is used

By `@intentic/host`, for the browser tools the agent uses on the user's machine.
