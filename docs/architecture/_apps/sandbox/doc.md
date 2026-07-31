# @intentic/sandbox

The daemon — the program running inside your project's box.

```stats
{ "items": [
    {"label": "Lines", "value": "67.9k"},
    {"label": "Files", "value": "449"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Agents need somewhere real to work: a filesystem, git, terminals, running dev servers. This is the thing that owns all of it and answers the editor's questions about it.

```dag
{ "title": "Its neighbours (showing 5 of 12 it uses, 0 of 0 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/sandbox", "label": "sandbox", "note": "this package", "accent": "2"},
    {"id": "_apps/lsp", "label": "lsp", "note": "it uses", "accent": "4"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/graph", "label": "graph", "note": "it uses", "accent": "5"},
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "it uses", "accent": "4"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"}
  ],
  "edges": [
    {"from": "_apps/sandbox", "to": "_apps/lsp"},
    {"from": "_apps/sandbox", "to": "_libs/extension-api"},
    {"from": "_apps/sandbox", "to": "_libs/graph"},
    {"from": "_apps/sandbox", "to": "_libs/iq-engine"},
    {"from": "_apps/sandbox", "to": "_libs/sandbox-contract"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox (this one)", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

The backend for everything in the editor. Also the thing that starts, watches and stops agent turns.
