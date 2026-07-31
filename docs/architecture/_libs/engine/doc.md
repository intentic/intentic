# @intentic/engine

Compares wanted with actual, then changes the difference.

```stats
{ "items": [
    {"label": "Lines", "value": "1.5k"},
    {"label": "Files", "value": "25"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Deployment is not 'run these steps' — it is 'make reality match this description', repeatedly and safely.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/engine", "label": "engine", "note": "this package", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/resources", "label": "resources", "note": "it uses", "accent": "5"},
    {"id": "_libs/sdk", "label": "sdk", "note": "it uses", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/engine", "to": "_libs/graph"},
    {"from": "_libs/engine", "to": "_libs/resources"},
    {"from": "_libs/engine", "to": "_libs/sdk", "dashed": true},
    {"from": "_libs/engine", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/engine"},
    {"from": "_libs/providers", "to": "_libs/engine"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Deployment engine",
  "items": [
    {"label": "providers", "value": 13686, "display": "13.7k", "accent": "5"},
    {"label": "cli", "value": 6201, "display": "6.2k", "accent": "5"},
    {"label": "state-resolver", "value": 3033, "display": "3.0k", "accent": "5"},
    {"label": "engine (this one)", "value": 1539, "display": "1.5k", "accent": "5"},
    {"label": "sdk", "value": 1503, "display": "1.5k", "accent": "5"},
    {"label": "graph", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

The reconcile loop. Holds no knowledge of any specific service.
