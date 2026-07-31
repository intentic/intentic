# @intentic-app/api-contract

The rulebook for talking to that small server.

```stats
{ "items": [
    {"label": "Lines", "value": "651"},
    {"label": "Files", "value": "2"},
    {"label": "Used by", "value": "2 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Same reason as the sandbox's rulebook: one written-down shape means a mismatch is a compile error.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/api-contract", "label": "api-contract", "note": "this package", "accent": "neutral"},
    {"id": "_libs/resources", "label": "resources", "note": "it uses", "accent": "5"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/api", "label": "api", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_libs/api-contract", "to": "_libs/resources"},
    {"from": "_libs/api-contract", "to": "_libs/sandbox-contract"},
    {"from": "_libs/api-contract", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/api", "to": "_libs/api-contract"},
    {"from": "_apps/web", "to": "_libs/api-contract"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract (this one)", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Shared by the platform server and the editor.
