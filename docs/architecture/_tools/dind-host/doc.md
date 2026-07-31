# @intentic/dind-host

A throwaway Docker-in-Docker host for tests.

```stats
{ "items": [
    {"label": "Lines", "value": "0"},
    {"label": "Files", "value": "0"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Testing 'deploy to a server' needs a server. Making one on demand is cheaper than owning one.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/dind-host", "label": "dind-host", "note": "this package", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_apps/cli", "to": "_tools/dind-host", "dashed": true}
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
    {"label": "dind-host (this one)", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Test infrastructure only.
