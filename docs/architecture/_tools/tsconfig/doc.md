# @intentic/tsconfig

One shared TypeScript configuration.

```stats
{ "items": [
    {"label": "Lines", "value": "0"},
    {"label": "Files", "value": "0"},
    {"label": "Used by", "value": "46 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Forty-odd packages with their own compiler settings drift apart, and the differences are invisible until something breaks.

```dag
{ "title": "Its neighbours (showing 0 of 0 it uses, 5 of 46 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "this package", "accent": "neutral"},
    {"id": "_apps/acp-bridge", "label": "acp-bridge", "note": "uses it", "accent": "2"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/iq", "label": "iq", "note": "uses it", "accent": "4"},
    {"id": "_apps/lsp", "label": "lsp", "note": "uses it", "accent": "4"}
  ],
  "edges": [
    {"from": "_apps/acp-bridge", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/api", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/iq", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/lsp", "to": "_tools/tsconfig", "dashed": true}
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
    {"label": "constants", "value": 58, "display": "58", "accent": "neutral"},
    {"label": "tsconfig (this one)", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Inherited by nearly every package in the repo.
