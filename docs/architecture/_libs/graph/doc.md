# @intentic/graph

The shape of 'what should exist' — the deployment engine's core data structure.

```stats
{ "items": [
    {"label": "Lines", "value": "563"},
    {"label": "Files", "value": "11"},
    {"label": "Used by", "value": "10 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Everything downstream needs one agreed way to describe servers, secrets and the links between them, without knowing what kinds of thing exist yet.

```dag
{ "title": "Its neighbours (showing 1 of 1 it uses, 5 of 10 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/graph", "label": "graph", "note": "this package", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_libs/engine", "label": "engine", "note": "uses it", "accent": "5"},
    {"id": "_libs/need-resolver", "label": "need-resolver", "note": "uses it", "accent": "5"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/graph", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/graph"},
    {"from": "_apps/sandbox", "to": "_libs/graph"},
    {"from": "_libs/engine", "to": "_libs/graph"},
    {"from": "_libs/need-resolver", "to": "_libs/graph"},
    {"from": "_libs/providers", "to": "_libs/graph"}
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
    {"label": "graph (this one)", "value": 563, "display": "563", "accent": "5"},
    {"label": "need-resolver", "value": 507, "display": "507", "accent": "5"},
    {"label": "resources", "value": 135, "display": "135", "accent": "5"}
  ] }
```

## Where it is used

The base of the deployment engine. Every other deployment package builds on it.
