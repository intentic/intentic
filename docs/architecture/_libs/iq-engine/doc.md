# @intentic/iq-engine

The machinery under the search command.

```stats
{ "items": [
    {"label": "Lines", "value": "6.8k"},
    {"label": "Files", "value": "75"},
    {"label": "Used by", "value": "3 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Good results need several search methods run at once and their answers merged sensibly, inside a token budget.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "this package", "accent": "4"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_libs/workspace-ignore", "label": "workspace-ignore", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/iq", "label": "iq", "note": "uses it", "accent": "4"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_tools/iq-bench", "label": "iq-bench", "note": "uses it", "accent": "4"}
  ],
  "edges": [
    {"from": "_libs/iq-engine", "to": "_libs/sandbox-contract"},
    {"from": "_libs/iq-engine", "to": "_libs/workspace-ignore"},
    {"from": "_libs/iq-engine", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/iq", "to": "_libs/iq-engine"},
    {"from": "_apps/sandbox", "to": "_libs/iq-engine"},
    {"from": "_tools/iq-bench", "to": "_libs/iq-engine"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine (this one)", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp", "value": 1026, "display": "1.0k", "accent": "4"}
  ] }
```

## Where it is used

Used by the search command and, in-process, by the daemon so the editor's search box is the same search.
