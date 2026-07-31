# @intentic/ext-imap

An email inbox as something the agent can read.

```stats
{ "items": [
    {"label": "Lines", "value": "989"},
    {"label": "Files", "value": "10"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Plenty of work arrives by email. Watching a mailbox lets a new message start a turn.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_extensions/imap", "label": "imap", "note": "this package", "accent": "3"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_extensions/imap", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Extensions (10 of 15)",
  "items": [
    {"label": "acceptance", "value": 3287, "display": "3.3k", "accent": "3"},
    {"label": "documentation", "value": 2374, "display": "2.4k", "accent": "3"},
    {"label": "automations", "value": 2143, "display": "2.1k", "accent": "3"},
    {"label": "pipelines", "value": 1545, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "repo-apps", "value": 1025, "display": "1.0k", "accent": "3"},
    {"label": "imap (this one)", "value": 989, "display": "989", "accent": "3"},
    {"label": "memory", "value": 914, "display": "914", "accent": "3"},
    {"label": "preview", "value": 658, "display": "658", "accent": "3"},
    {"label": "extension-api", "value": 605, "display": "605", "accent": "3"}
  ] }
```

## Where it is used

Ships a small always-on watcher process plus the agent's cheat-sheet.
