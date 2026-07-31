# @intentic/iq-recall

Searches what past sessions already did.

```stats
{ "items": [
    {"label": "Lines", "value": "1.9k"},
    {"label": "Files", "value": "23"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The cheapest context is the work someone already finished. This indexes old transcripts so a new session can find the files a topic touched — or resume that session outright.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/iq-recall", "label": "iq-recall", "note": "this package", "accent": "4"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/iq", "label": "iq", "note": "uses it", "accent": "4"}
  ],
  "edges": [
    {"from": "_libs/iq-recall", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/iq", "to": "_libs/iq-recall"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall (this one)", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp", "value": 1026, "display": "1.0k", "accent": "4"}
  ] }
```

## Where it is used

Used by the search command; it is what makes 'a related past session exists' suggestions possible.
