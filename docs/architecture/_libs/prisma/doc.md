# @intentic-app/prisma

The database layer for accounts and billing.

```stats
{ "items": [
    {"label": "Lines", "value": "210"},
    {"label": "Files", "value": "5"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

The platform needs to store users and subscriptions. This owns the schema and the typed client for it.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/prisma", "label": "prisma", "note": "this package", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_tools/e2e", "label": "e2e", "note": "uses it", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_libs/prisma", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/api", "to": "_libs/prisma"},
    {"from": "_tools/e2e", "to": "_libs/prisma", "dashed": true}
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
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma (this one)", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Used only by the platform server.
