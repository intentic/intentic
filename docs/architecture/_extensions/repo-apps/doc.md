# @intentic/ext-repo-apps

The apps inside a monorepo, with their preview links and tests.

```stats
{ "items": [
    {"label": "Lines", "value": "1.0k"},
    {"label": "Files", "value": "15"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A monorepo has many runnable things. Which ones, are they up, and do their tests pass, is a question with no home otherwise.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_extensions/repo-apps", "label": "repo-apps", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/repo-apps", "to": "_libs/extension-api"},
    {"from": "_extensions/repo-apps", "to": "_libs/extension-ui"},
    {"from": "_extensions/repo-apps", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/repo-apps", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/repo-apps"}
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
    {"label": "repo-apps (this one)", "value": 1025, "display": "1.0k", "accent": "3"},
    {"label": "imap", "value": 989, "display": "989", "accent": "3"},
    {"label": "memory", "value": 914, "display": "914", "accent": "3"},
    {"label": "preview", "value": 658, "display": "658", "accent": "3"},
    {"label": "extension-api", "value": 605, "display": "605", "accent": "3"}
  ] }
```

## Where it is used

One sidebar tile.
