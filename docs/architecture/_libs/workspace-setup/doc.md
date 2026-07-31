# @intentic/workspace-setup

Guesses which package manager a dropped project needs.

```stats
{ "items": [
    {"label": "Lines", "value": "270"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

You drop a folder in and expect it to just install. That means reading the lockfile names and deciding npm, pnpm, yarn or something else.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/workspace-setup", "label": "workspace-setup", "note": "this package", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_libs/workspace-setup", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/workspace-setup"},
    {"from": "_apps/web", "to": "_libs/workspace-setup"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup (this one)", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Used by the drop-a-project screen and by the daemon when it prepares a workspace.
