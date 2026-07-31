# @intentic/workspace-ignore

What must never be read, indexed or shown.

```stats
{ "items": [
    {"label": "Lines", "value": "214"},
    {"label": "Files", "value": "4"},
    {"label": "Used by", "value": "3 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Secrets, .git internals and browser profiles must stay out of search results and out of an agent's reach. Junk like build output just wastes everyone's time.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/workspace-ignore", "label": "workspace-ignore", "note": "this package", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "uses it", "accent": "4"}
  ],
  "edges": [
    {"from": "_libs/workspace-ignore", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/workspace-ignore"},
    {"from": "_apps/web", "to": "_libs/workspace-ignore"},
    {"from": "_libs/iq-engine", "to": "_libs/workspace-ignore"}
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
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore (this one)", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Used wherever files are walked: search indexing, the file tree, the agent's own view of the workspace.
