# @intentic/lsp

Safe renames and real type errors, from the command line.

```stats
{ "items": [
    {"label": "Lines", "value": "1.0k"},
    {"label": "Files", "value": "12"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Renaming a symbol with find-and-replace breaks things quietly. The TypeScript language service knows the right answer; this hands it to an agent.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/lsp", "label": "lsp", "note": "this package", "accent": "4"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_apps/lsp", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_apps/lsp"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp (this one)", "value": 1026, "display": "1.0k", "accent": "4"}
  ] }
```

## Where it is used

Run by agents when editing TypeScript.
