# @intentic-app/api

The small server that handles sign-in and billing.

```stats
{ "items": [
    {"label": "Lines", "value": "3.6k"},
    {"label": "Files", "value": "32"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Accounts and payments need somewhere central. Deliberately kept off the path between you and your sandbox, so it can be down without stopping your work.

```dag
{ "title": "Its neighbours (showing 5 of 7 it uses, 0 of 0 that use it)",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/api", "label": "api", "note": "this package", "accent": "neutral"},
    {"id": "_libs/api-contract", "label": "api-contract", "note": "it uses", "accent": "neutral"},
    {"id": "_libs/prisma", "label": "prisma", "note": "it uses", "accent": "neutral"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_libs/sandbox-run", "label": "sandbox-run", "note": "it uses", "accent": "2"},
    {"id": "_tools/constants", "label": "constants", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/api", "to": "_libs/api-contract"},
    {"from": "_apps/api", "to": "_libs/prisma"},
    {"from": "_apps/api", "to": "_libs/sandbox-contract"},
    {"from": "_apps/api", "to": "_libs/sandbox-run"},
    {"from": "_apps/api", "to": "_tools/constants"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api (this one)", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Called by the editor at sign-in, and for subscription screens.
