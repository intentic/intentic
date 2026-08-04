# @intentic/local-agent

The install-and-stay-alive plumbing every intentic program on a user's machine shares.

```stats
{
  "items": [
    {"label": "Lines", "value": "687"},
    {"label": "Files", "value": "8"},
    {"label": "Used by", "value": "3 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Three programs ship to a user's own computer — the host agent, file sync, and the editor bridge — and
they have nothing in common except how they are installed and how they survive a reboot. Each copy of
that plumbing was made from the last one, which is a shape with a known ending: the copy freezes the
original as of the day it was taken, and every fix afterwards lands in only one of them.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_libs/local-agent", "label": "local-agent", "note": "this package", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/acp-bridge", "label": "acp-bridge", "note": "uses it", "accent": "2"},
    {"id": "_apps/host", "label": "host", "note": "uses it", "accent": "2"},
    {"id": "_apps/sync", "label": "sync", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_libs/local-agent", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/acp-bridge", "to": "_libs/local-agent"},
    {"from": "_apps/host", "to": "_libs/local-agent"},
    {"from": "_apps/sync", "to": "_libs/local-agent"}
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
    {"label": "local-agent (this one)", "value": 687, "display": "687", "accent": "2"},
    {"label": "sandbox-run", "value": 650, "display": "650", "accent": "2"}
  ] }
```

## What the copies had already cost

One agent wrote its credential file world-readable, because it was copied from another *before* the
0600 floor was added there. One had no macOS autostart and wrote an entry nothing on macOS reads.
Two platform rules — how to spawn a background process on Windows without leaving a black console
window on the desktop, and how a compiled binary reports its own path — were written out at length in
two files each, in prose, cross-referencing the other program by name.

This package is those lessons as code, in four small modules: the state home and its permission
floor, how to re-invoke this CLI, login autostart per platform, and the detached background loop.
The fourth program inherits them by importing rather than by reading.

## Where it is used

By `@intentic/host`, `@intentic/sync` and `@intentic/acp-bridge`. It knows nothing about sandboxes,
tunnels or tools — what an agent does stays in the agent.
