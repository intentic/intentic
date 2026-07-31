# @intentic-dev/site

The public marketing website.

```stats
{ "items": [
    {"label": "Lines", "value": "905"},
    {"label": "Files", "value": "5"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

People need to read about the product before they sign up.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/site", "label": "site", "note": "this package", "accent": "neutral"},
    {"id": "_libs/astro-integrations", "label": "astro-integrations", "note": "it uses", "accent": "neutral"},
    {"id": "_libs/site-content", "label": "site-content", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/site", "to": "_libs/astro-integrations"},
    {"from": "_apps/site", "to": "_libs/site-content"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site (this one)", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Built and deployed separately from the app.
