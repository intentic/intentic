# @intentic-app/capability-catalog

The list of things you can connect, as data.

```stats
{ "items": [
    {"label": "Lines", "value": "615"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The 'add a connection' screen needs to know what exists, what each one needs, and how to explain it.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/capability-catalog", "label": "capability-catalog", "note": "this package", "accent": "neutral"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_libs/capability-catalog", "to": "_libs/extension-api"},
    {"from": "_libs/capability-catalog", "to": "_libs/sandbox-contract"},
    {"from": "_libs/capability-catalog", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_libs/capability-catalog"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog (this one)", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Rendered by the editor's capability screens.
