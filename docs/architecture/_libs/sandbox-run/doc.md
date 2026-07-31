# @intentic/sandbox-run

How the box itself is launched — names, permissions, environment.

```stats
{ "items": [
    {"label": "Lines", "value": "440"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "5 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A container can be started from several places. If each one passes slightly different flags, one of them is quietly less safe than the others.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/sandbox-run", "label": "sandbox-run", "note": "this package", "accent": "2"},
    {"id": "_tools/constants", "label": "constants", "note": "it uses", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/sandbox-run", "to": "_tools/constants"},
    {"from": "_libs/sandbox-run", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/api", "to": "_libs/sandbox-run"},
    {"from": "_apps/cli", "to": "_libs/sandbox-run"},
    {"from": "_apps/sandbox", "to": "_libs/sandbox-run"},
    {"from": "_apps/web", "to": "_libs/sandbox-run"},
    {"from": "_libs/providers", "to": "_libs/sandbox-run"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run (this one)", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Every path that creates a sandbox composes its docker command from here.
