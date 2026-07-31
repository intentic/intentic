# @intentic/constants

A handful of values more than one package needs.

```stats
{ "items": [
    {"label": "Lines", "value": "58"},
    {"label": "Files", "value": "1"},
    {"label": "Used by", "value": "7 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Two copies of the same constant is one copy that will be wrong eventually.

```dag
{ "title": "Its neighbours (showing 1 of 1 it uses, 5 of 7 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/constants", "label": "constants", "note": "this package", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"},
    {"id": "_libs/sandbox-run", "label": "sandbox-run", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_tools/constants", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/api", "to": "_tools/constants"},
    {"from": "_apps/sandbox", "to": "_tools/constants"},
    {"from": "_apps/web", "to": "_tools/constants"},
    {"from": "_libs/providers", "to": "_tools/constants"},
    {"from": "_libs/sandbox-run", "to": "_tools/constants"}
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
    {"label": "examples", "value": 163, "display": "163", "accent": "neutral"},
    {"label": "constants (this one)", "value": 58, "display": "58", "accent": "neutral"},
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Shared by the platform and deployment sides.
