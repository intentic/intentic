# @intentic-dev/site-content

The website's words and page structure, as data.

```stats
{ "items": [
    {"label": "Lines", "value": "915"},
    {"label": "Files", "value": "8"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Copy that lives inside page templates is hard to find and harder to change consistently.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/site-content", "label": "site-content", "note": "this package", "accent": "neutral"},
    {"id": "_tools/constants", "label": "constants", "note": "it uses", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/site", "label": "site", "note": "uses it", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_libs/site-content", "to": "_tools/constants"},
    {"from": "_libs/site-content", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/site", "to": "_libs/site-content"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content (this one)", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Used only by the website.
