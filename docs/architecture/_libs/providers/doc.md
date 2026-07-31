# @intentic/providers

The code that actually talks to real services.

```stats
{ "items": [
    {"label": "Lines", "value": "13.7k"},
    {"label": "Files", "value": "104"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Something has to make the real API calls — to Cloudflare, Postgres, GitHub, a server over SSH. This is all of them, behind one interface.

```dag
{ "title": "Its neighbours (showing 5 of 6 it uses, 1 of 1 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/providers", "label": "providers", "note": "this package", "accent": "5"},
    {"id": "_libs/engine", "label": "engine", "note": "it uses", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/sandbox-run", "label": "sandbox-run", "note": "it uses", "accent": "2"},
    {"id": "_libs/sdk", "label": "sdk", "note": "it uses", "accent": "5"},
    {"id": "_tools/constants", "label": "constants", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/providers", "to": "_libs/engine"},
    {"from": "_libs/providers", "to": "_libs/graph"},
    {"from": "_libs/providers", "to": "_libs/sandbox-run"},
    {"from": "_libs/providers", "to": "_libs/sdk", "dashed": true},
    {"from": "_libs/providers", "to": "_tools/constants"},
    {"from": "_apps/cli", "to": "_libs/providers"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Deployment engine",
  "items": [
    {"label": "providers (this one)", "value": 13686, "display": "13.7k", "accent": "5"},
    {"label": "cli", "value": 6201, "display": "6.2k", "accent": "5"},
    {"label": "state-resolver", "value": 3033, "display": "3.0k", "accent": "5"},
    {"label": "engine", "value": 1539, "display": "1.5k", "accent": "5"},
    {"label": "sdk", "value": 1503, "display": "1.5k", "accent": "5"},
    {"label": "graph", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

The biggest deployment package, and the only one that touches the outside world.
