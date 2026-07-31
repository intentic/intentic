# @intentic/resources

The closed list of things that can be deployed.

```stats
{ "items": [
    {"label": "Lines", "value": "135"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "4 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

The core data structure deliberately does not know what a 'database' is. Something has to, and it should be exactly one list.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/resources", "label": "resources", "note": "this package", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_libs/api-contract", "label": "api-contract", "note": "uses it", "accent": "neutral"},
    {"id": "_libs/engine", "label": "engine", "note": "uses it", "accent": "5"},
    {"id": "_libs/sdk", "label": "sdk", "note": "uses it", "accent": "5"},
    {"id": "_libs/state-resolver", "label": "state-resolver", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/resources", "to": "_libs/graph"},
    {"from": "_libs/resources", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_libs/api-contract", "to": "_libs/resources"},
    {"from": "_libs/engine", "to": "_libs/resources"},
    {"from": "_libs/sdk", "to": "_libs/resources"},
    {"from": "_libs/state-resolver", "to": "_libs/resources"}
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
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources (this one)", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

Shared by the resolver, the engine and the providers.
