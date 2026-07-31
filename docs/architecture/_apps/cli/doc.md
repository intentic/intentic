# @intentic/cli

The `intentic` command — tunnels, deployment, scaffolding.

```stats
{ "items": [
    {"label": "Lines", "value": "6.2k"},
    {"label": "Files", "value": "66"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some things belong in a terminal: opening a tunnel, planning a deploy, starting a new project.

```dag
{ "title": "Its neighbours (showing 5 of 11 it uses, 0 of 0 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/cli", "label": "cli", "note": "this package", "accent": "5"},
    {"id": "_libs/engine", "label": "engine", "note": "it uses", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/need-resolver", "label": "need-resolver", "note": "it uses", "accent": "5"},
    {"id": "_libs/providers", "label": "providers", "note": "it uses", "accent": "5"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"}
  ],
  "edges": [
    {"from": "_apps/cli", "to": "_libs/engine"},
    {"from": "_apps/cli", "to": "_libs/graph"},
    {"from": "_apps/cli", "to": "_libs/need-resolver"},
    {"from": "_apps/cli", "to": "_libs/providers"},
    {"from": "_apps/cli", "to": "_libs/sandbox-contract"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Deployment engine",
  "items": [
    {"label": "providers", "value": 13686, "display": "13.7k", "accent": "5"},
    {"label": "cli (this one)", "value": 6201, "display": "6.2k", "accent": "5"},
    {"label": "state-resolver", "value": 3033, "display": "3.0k", "accent": "5"},
    {"label": "engine", "value": 1539, "display": "1.5k", "accent": "5"},
    {"label": "sdk", "value": 1503, "display": "1.5k", "accent": "5"},
    {"label": "graph", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

Published to npm. Also used by the connect script that starts a sandbox on your machine.
