# @intentic-dev/site-content

The website's words and page structure, as data.

```stats
{ "items": [
    {"label": "Lines", "value": "2397"},
    {"label": "Files", "value": "11"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Copy that lives inside page templates is hard to find and harder to change consistently.

It is also where the site's *shape* is decided, not just its words. `landing.ts` is the clearest case:
its `LandingContent` interface is the list of bands the homepage is allowed to have, so cutting the
page from fourteen sections to six was a change to a type, and `Landing.astro` could not compile until
it agreed. `product.ts` works the same way — a page's `group` drives which mega-menu column it appears
in and where the footer lists it, so moving Doorbell out of the core surfaces was one field.

`about.ts` is the file two surfaces share: the landing page's trust band and `/about/` both read the
creator, the profile links and the four trust cards from it, so the two cannot drift into telling
slightly different stories about who is behind the product. The one number those cards carry is
deliberately *not* here — commit counts come from `gitStats()` in `_libs/astro-integrations`, measured
during the build, because a figure that changes on every land is the fastest thing on the site to rot.

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
    {"label": "api", "value": 3714, "display": "3.7k", "accent": "neutral"},
    {"label": "site-content (this one)", "value": 2216, "display": "2.2k", "accent": "neutral"},
    {"label": "site", "value": 1203, "display": "1.2k", "accent": "neutral"},
    {"label": "capability-catalog", "value": 1116, "display": "1.1k", "accent": "neutral"},
    {"label": "api-contract", "value": 664, "display": "664", "accent": "neutral"},
    {"label": "astro-integrations", "value": 576, "display": "576", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Used only by the website.
