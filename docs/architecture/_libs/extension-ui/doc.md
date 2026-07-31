# @intentic/extension-ui

The component kit extensions draw with.

```stats
{ "items": [
    {"label": "Lines", "value": "99"},
    {"label": "Files", "value": "2"},
    {"label": "Used by", "value": "11 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

An extension that bundles its own buttons looks foreign and ships a second copy of everything. This hands it the app's real components at runtime instead.

```dag
{ "title": "Its neighbours (showing 2 of 2 it uses, 5 of 11 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "this package", "accent": "3"},
    {"id": "_libs/ui", "label": "ui", "note": "it uses", "accent": "1"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_extensions/acceptance", "label": "acceptance", "note": "uses it", "accent": "3"},
    {"id": "_extensions/activity", "label": "activity", "note": "uses it", "accent": "3"},
    {"id": "_extensions/automations", "label": "automations", "note": "uses it", "accent": "3"},
    {"id": "_extensions/documentation", "label": "documentation", "note": "uses it", "accent": "3"}
  ],
  "edges": [
    {"from": "_libs/extension-ui", "to": "_libs/ui"},
    {"from": "_libs/extension-ui", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_libs/extension-ui"},
    {"from": "_extensions/acceptance", "to": "_libs/extension-ui"},
    {"from": "_extensions/activity", "to": "_libs/extension-ui"},
    {"from": "_extensions/automations", "to": "_libs/extension-ui"},
    {"from": "_extensions/documentation", "to": "_libs/extension-ui"}
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
    {"label": "imap", "value": 989, "display": "989", "accent": "3"},
    {"label": "memory", "value": 914, "display": "914", "accent": "3"},
    {"label": "preview", "value": 658, "display": "658", "accent": "3"},
    {"label": "extension-api", "value": 605, "display": "605", "accent": "3"}
  ] }
```

## Where it is used

Imported by every extension that has a screen.
