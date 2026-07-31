# @intentic/iq

One search command an agent can actually use.

```stats
{ "items": [
    {"label": "Lines", "value": "1.9k"},
    {"label": "Files", "value": "28"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Finding code means several different questions — where is this defined, who calls it, what changed lately, and plain 'how does X work'. Four tools means four guesses; this is one entry point that answers all of them.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/iq", "label": "iq", "note": "this package", "accent": "4"},
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "it uses", "accent": "4"},
    {"id": "_libs/iq-recall", "label": "iq-recall", "note": "it uses", "accent": "4"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/iq", "to": "_libs/iq-engine"},
    {"from": "_apps/iq", "to": "_libs/iq-recall"},
    {"from": "_apps/iq", "to": "_libs/sandbox-contract"},
    {"from": "_apps/iq", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq (this one)", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp", "value": 1026, "display": "1.0k", "accent": "4"}
  ] }
```

## Where it is used

Run by agents constantly. Also available to you in a terminal.
