# @intentic/sdk

The friendly way to write down what you want.

```stats
{ "items": [
    {"label": "Lines", "value": "1.5k"},
    {"label": "Files", "value": "9"},
    {"label": "Used by", "value": "5 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The underlying data structure is precise and unpleasant to type. This is the sentence-like surface a person actually writes.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/sdk", "label": "sdk", "note": "this package", "accent": "5"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/need-resolver", "label": "need-resolver", "note": "it uses", "accent": "5"},
    {"id": "_libs/resources", "label": "resources", "note": "it uses", "accent": "5"},
    {"id": "_libs/state-resolver", "label": "state-resolver", "note": "it uses", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_libs/engine", "label": "engine", "note": "uses it", "accent": "5"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"},
    {"id": "_tools/examples", "label": "examples", "note": "uses it", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_libs/sdk", "to": "_libs/graph"},
    {"from": "_libs/sdk", "to": "_libs/need-resolver"},
    {"from": "_libs/sdk", "to": "_libs/resources"},
    {"from": "_libs/sdk", "to": "_libs/state-resolver"},
    {"from": "_libs/sdk", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/sdk", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/sdk"},
    {"from": "_libs/engine", "to": "_libs/sdk", "dashed": true},
    {"from": "_libs/providers", "to": "_libs/sdk", "dashed": true},
    {"from": "_tools/examples", "to": "_libs/sdk"}
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
    {"label": "sdk (this one)", "value": 1503, "display": "1.5k", "accent": "5"},
    {"label": "graph", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

What you import in a project's deploy config file.
