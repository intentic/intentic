# @intentic/iq-bench

Measures whether a search change actually helped.

```stats
{ "items": [
    {"label": "Lines", "value": "1.9k"},
    {"label": "Files", "value": "20"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Search quality is easy to break and hard to eyeball. This scores it against fixed datasets, and runs real agent tasks with and without it.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_tools/iq-bench", "label": "iq-bench", "note": "this package", "accent": "4"},
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "it uses", "accent": "4"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_tools/iq-bench", "to": "_libs/iq-engine"},
    {"from": "_tools/iq-bench", "to": "_libs/sandbox-contract"},
    {"from": "_tools/iq-bench", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench (this one)", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp", "value": 1026, "display": "1.0k", "accent": "4"}
  ] }
```

## Where it is used

Development only. Never ships.
