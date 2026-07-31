# @intentic-app/desktop

Retired: an abandoned desktop-app experiment.

```stats
{ "items": [
    {"label": "Lines", "value": "892"},
    {"label": "Files", "value": "9"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

The product was once going to be a desktop application. It is a browser app now; this is kept for reference.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_archive/desktop-tauri/app", "label": "app", "note": "this package", "accent": "neutral"},
    {"id": "_libs/ui", "label": "ui", "note": "it uses", "accent": "1"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_archive/desktop-tauri/app", "to": "_libs/ui"},
    {"from": "_archive/desktop-tauri/app", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Plumbing & retired code",
  "items": [
    {"label": "core", "value": 2221, "display": "2.2k", "accent": "neutral"},
    {"label": "e2e", "value": 906, "display": "906", "accent": "neutral"},
    {"label": "app (this one)", "value": 892, "display": "892", "accent": "neutral"},
    {"label": "src-tauri", "value": 723, "display": "723", "accent": "neutral"},
    {"label": "examples", "value": 163, "display": "163", "accent": "neutral"},
    {"label": "constants", "value": 58, "display": "58", "accent": "neutral"},
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Not built, not shipped, not part of the product.
