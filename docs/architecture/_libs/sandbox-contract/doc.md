# @intentic/sandbox-contract

The rulebook both sides of the wire agree on.

```stats
{ "items": [
    {"label": "Lines", "value": "7.3k"},
    {"label": "Files", "value": "59"},
    {"label": "Used by", "value": "21 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The browser and the daemon are separate programs. If they disagree about the shape of a message, things break silently at runtime. Written down once here, a mismatch becomes a compile error instead.

```dag
{ "title": "Its neighbours (showing 2 of 2 it uses, 5 of 21 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "this package", "accent": "2"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/acp-bridge", "label": "acp-bridge", "note": "uses it", "accent": "2"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/iq", "label": "iq", "note": "uses it", "accent": "4"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_libs/sandbox-contract", "to": "_libs/extension-api"},
    {"from": "_libs/sandbox-contract", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/acp-bridge", "to": "_libs/sandbox-contract"},
    {"from": "_apps/api", "to": "_libs/sandbox-contract"},
    {"from": "_apps/cli", "to": "_libs/sandbox-contract"},
    {"from": "_apps/iq", "to": "_libs/sandbox-contract"},
    {"from": "_apps/sandbox", "to": "_libs/sandbox-contract"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract (this one)", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

The most depended-on package in the repo: the daemon, the editor and every extension all speak through it.
