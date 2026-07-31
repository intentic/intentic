# @intentic/sync

Keeps a folder on your computer in step with the sandbox.

```stats
{ "items": [
    {"label": "Lines", "value": "2.3k"},
    {"label": "Files", "value": "14"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some people want their own editor and their own terminal. This mirrors files both ways and forwards ports, so a dev server in the cloud behaves like one on your laptop.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/sync", "label": "sync", "note": "this package", "accent": "2"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/sync", "to": "_libs/sandbox-contract"},
    {"from": "_apps/sync", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync (this one)", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Runs on your own machine, not in the sandbox. Optional.
