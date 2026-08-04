# @intentic/desktop

Capture a screen and move a real mouse and keyboard, without native modules.

```stats
{
  "items": [
    {"label": "Lines", "value": "1.3k"},
    {"label": "Files", "value": "12"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some things on a user's computer have no API — a settings dialog, a native app, an installer. Doing
them means looking at the screen and using the pointer. Every off-the-shelf library for that ships a
compiled addon, and this code has to survive being packed into a single-file executable, so instead
each platform is driven through tools it already has.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_libs/desktop", "label": "desktop", "note": "this package", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/host", "label": "host", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_libs/desktop", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/host", "to": "_libs/desktop"}
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
    {"label": "desktop (this one)", "value": 1251, "display": "1.3k", "accent": "2"},
    {"label": "acp-bridge", "value": 1001, "display": "1.0k", "accent": "2"},
    {"label": "local-agent", "value": 687, "display": "687", "accent": "2"},
    {"label": "sandbox-run", "value": 650, "display": "650", "accent": "2"}
  ] }
```

## How it works, and where it stops

Windows goes through PowerShell into the OS's own input calls. Linux has two backends behind one
interface, because X11 lets any client synthesise input and Wayland deliberately does not. macOS can
capture but not type, and the methods say so rather than silently doing nothing.

The Wayland limits are worth reading as design rather than as gaps: a compositor refuses to let one
client enumerate another's windows for exactly the reason it refuses to let it fake a keypress. Where
that cannot be worked around, the error explains why instead of returning an empty list that reads as
"nothing is open".

One vocabulary of key names is fixed here and translated per backend. Without it every caller would
have to be platform-aware, which is the coupling this package exists to remove.

## Where it is used

By `@intentic/host`, which owns the question this package refuses to ask — whether the click is
allowed. Keeping the two apart is what makes the policy testable, since a real click can only be
checked by a human watching a screen.
