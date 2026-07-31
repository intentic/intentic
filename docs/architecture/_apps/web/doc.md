# @intentic-app/web

The browser app — the whole editor you see and click.

```stats
{ "items": [
    {"label": "Lines", "value": "77.7k"},
    {"label": "Files", "value": "470"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Everything a person does here needs a screen: browsing files, talking to an agent, watching a terminal. This is that screen, and it talks straight to your project's own sandbox rather than through a middleman.

```dag
{ "title": "Its neighbours (showing 5 of 22 it uses, 0 of 0 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/web", "label": "web", "note": "this package", "accent": "1"},
    {"id": "_extensions/acceptance", "label": "acceptance", "note": "it uses", "accent": "3"},
    {"id": "_extensions/activity", "label": "activity", "note": "it uses", "accent": "3"},
    {"id": "_extensions/automations", "label": "automations", "note": "it uses", "accent": "3"},
    {"id": "_extensions/documentation", "label": "documentation", "note": "it uses", "accent": "3"},
    {"id": "_extensions/logs", "label": "logs", "note": "it uses", "accent": "3"}
  ],
  "edges": [
    {"from": "_apps/web", "to": "_extensions/acceptance"},
    {"from": "_apps/web", "to": "_extensions/activity"},
    {"from": "_apps/web", "to": "_extensions/automations"},
    {"from": "_apps/web", "to": "_extensions/documentation"},
    {"from": "_apps/web", "to": "_extensions/logs"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

## Where it is used

It IS the product's front end. Every other picture on this page is something the editor shows you.
