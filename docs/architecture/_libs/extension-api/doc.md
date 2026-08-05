# @intentic/extension-api

The contract an extension is written against.

```stats
{ "items": [
    {"label": "Lines", "value": "605"},
    {"label": "Files", "value": "7"},
    {"label": "Used by", "value": "14 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Extensions must be able to add screens and commands without reaching into the app's internals — otherwise every app change breaks them, and any extension can do anything.

```dag
{ "title": "Its neighbours (showing 1 of 1 it uses, 5 of 14 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/extension-api", "label": "extension-api", "note": "this package", "accent": "3"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_extensions/acceptance", "label": "acceptance", "note": "uses it", "accent": "3"},
    {"id": "_extensions/activity", "label": "activity", "note": "uses it", "accent": "3"},
    {"id": "_extensions/automations", "label": "automations", "note": "uses it", "accent": "3"}
  ],
  "edges": [
    {"from": "_libs/extension-api", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/extension-api"},
    {"from": "_apps/web", "to": "_libs/extension-api"},
    {"from": "_extensions/acceptance", "to": "_libs/extension-api"},
    {"from": "_extensions/activity", "to": "_libs/extension-api"},
    {"from": "_extensions/automations", "to": "_libs/extension-api"}
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
    {"label": "extension-api (this one)", "value": 605, "display": "605", "accent": "3"}
  ] }
```

## What it hands over rather than letting an extension build

Some things stay the app's however useful they would be to copy: a screen's frame, a command, a file viewer, the terminal — and the one that keeps getting rebuilt, the model picker.

An extension that needs to say which provider, account and model a run will spend asks for the app's own picker instead of drawing its own list. Only the app's list knows which providers this sandbox can actually reach, which accounts still have headroom, and which sign-ins have quietly stopped working. Anything an extension draws itself is a worse version of that: the two that tried both ended up offering runs that failed minutes later on a credential their list had never mentioned.

## Where it is used

Imported by every extension. The manifest it defines is also the approval screen you see before installing one.
