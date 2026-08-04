# @intentic-app/e2e

The end-to-end browser test suite.

```stats
{ "items": [
    {"label": "Lines", "value": "906"},
    {"label": "Files", "value": "11"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Unit tests cannot tell you sign-in works against the real app, the real database and a real sandbox image.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/e2e", "label": "e2e", "note": "this package", "accent": "neutral"},
    {"id": "_libs/prisma", "label": "prisma", "note": "it uses", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_tools/e2e", "to": "_libs/prisma", "dashed": true},
    {"from": "_tools/e2e", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Plumbing & retired code",
  "items": [
    {"label": "core", "value": 2221, "display": "2.2k", "accent": "neutral"},
    {"label": "e2e (this one)", "value": 906, "display": "906", "accent": "neutral"},
    {"label": "app", "value": 892, "display": "892", "accent": "neutral"},
    {"label": "src-tauri", "value": 723, "display": "723", "accent": "neutral"},
    {"label": "examples", "value": 163, "display": "163", "accent": "neutral"},
    {"label": "constants", "value": 58, "display": "58", "accent": "neutral"},
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## Where it is used

Run by hand on a dev machine — `pnpm e2e:browser`. Never ships, and never runs in CI: the whole stack it
boots answers on `localhost`, while every CI job publishes its containers' ports on a docker-in-docker
service instead.
