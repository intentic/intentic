# @intentic/scaffold

Makes the starter files for a new project.

```stats
{ "items": [
    {"label": "Lines", "value": "1.9k"},
    {"label": "Files", "value": "17"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A new workspace needs a sensible skeleton. Two different programs create workspaces, and they must produce the same skeleton.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/scaffold", "label": "scaffold", "note": "this package", "accent": "2"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_libs/scaffold", "to": "_libs/graph"},
    {"from": "_libs/scaffold", "to": "_libs/sandbox-contract"},
    {"from": "_libs/scaffold", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/scaffold"},
    {"from": "_apps/sandbox", "to": "_libs/scaffold"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold (this one)", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Shared by the command-line tool's `init` and by the daemon.
