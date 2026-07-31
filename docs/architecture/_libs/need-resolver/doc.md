# @intentic/need-resolver

Turns what you asked for into what is needed.

```stats
{ "items": [
    {"label": "Lines", "value": "507"},
    {"label": "Files", "value": "6"},
    {"label": "Used by", "value": "3 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

'I want an app with a database' is not a deployment plan. This is the first translation step.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/need-resolver", "label": "need-resolver", "note": "this package", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_libs/sdk", "label": "sdk", "note": "uses it", "accent": "5"},
    {"id": "_libs/state-resolver", "label": "state-resolver", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/need-resolver", "to": "_libs/graph"},
    {"from": "_libs/need-resolver", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/need-resolver"},
    {"from": "_libs/sdk", "to": "_libs/need-resolver"},
    {"from": "_libs/state-resolver", "to": "_libs/need-resolver"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Deployment engine",
  "items": [
    {"label": "providers", "value": 13686, "display": "13.7k", "accent": "5"},
    {"label": "cli", "value": 6201, "display": "6.2k", "accent": "5"},
    {"label": "state-resolver", "value": 3033, "display": "3.0k", "accent": "5"},
    {"label": "engine", "value": 1539, "display": "1.5k", "accent": "5"},
    {"label": "sdk", "value": 1503, "display": "1.5k", "accent": "5"},
    {"label": "graph", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver (this one)", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

Step one of the deployment pipeline.
