# @intentic-dev/astro-integrations

Small build-time helpers for the website.

```stats
{ "items": [
    {"label": "Lines", "value": "643"},
    {"label": "Files", "value": "5"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Social images, last-modified dates and search-engine pings are all mechanical work best done at build time.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/astro-integrations", "label": "astro-integrations", "note": "this package", "accent": "neutral"},
    {"id": "_apps/site", "label": "site", "note": "uses it", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/site", "to": "_libs/astro-integrations"}
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
    {"label": "astro-integrations (this one)", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Used only by the website's build.
