# @intentic/examples

Example deployment configs.

```stats
{ "items": [
    {"label": "Lines", "value": "163"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

The authoring surface needs something real to point at, and something that breaks if the surface changes.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/examples", "label": "examples", "note": "this package", "accent": "neutral"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/sdk", "label": "sdk", "note": "it uses", "accent": "5"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_tools/examples", "to": "_libs/graph"},
    {"from": "_tools/examples", "to": "_libs/sdk"},
    {"from": "_tools/examples", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Plumbing & retired code",
  "items": [
    {"label": "core", "value": 2221, "display": "2.2k", "accent": "neutral"},
    {"label": "e2e", "value": 906, "display": "906", "accent": "neutral"},
    {"label": "app", "value": 892, "display": "892", "accent": "neutral"},
    {"label": "src-tauri", "value": 723, "display": "723", "accent": "neutral"},
    {"label": "examples (this one)", "value": 163, "display": "163", "accent": "neutral"},
    {"label": "constants", "value": 58, "display": "58", "accent": "neutral"},
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Reference material and a compile check.
