# @intentic/ui

The shared look and feel — buttons, cards, charts, rendered prose.

```stats
{ "items": [
    {"label": "Lines", "value": "7.4k"},
    {"label": "Files", "value": "70"},
    {"label": "Used by", "value": "3 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Without one kit, every screen invents its own buttons and spacing, and dark mode breaks in a different place each time. One kit means one answer.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/ui", "label": "ui", "note": "this package", "accent": "1"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_archive/desktop-tauri/app", "label": "app", "note": "uses it", "accent": "neutral"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "uses it", "accent": "3"}
  ],
  "edges": [
    {"from": "_libs/ui", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_libs/ui"},
    {"from": "_archive/desktop-tauri/app", "to": "_libs/ui"},
    {"from": "_libs/extension-ui", "to": "_libs/ui"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

## Where it is used

Used by the editor and, through a curated slice, by every extension — so extension screens look native instead of bolted on.
