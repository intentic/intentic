# @intentic-app/localhost-https

Local HTTPS certificates for development.

```stats
{ "items": [
    {"label": "Lines", "value": "0"},
    {"label": "Files", "value": "0"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Sign-in and cookies behave differently over plain HTTP, so local development has to be HTTPS too.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/localhost-https", "label": "localhost-https", "note": "this package", "accent": "neutral"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_apps/api", "to": "_tools/localhost-https"},
    {"from": "_apps/web", "to": "_tools/localhost-https"}
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
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https (this one)", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Development only.
