# @intentic-dev/astro-integrations

The website's Markdown mirror for machine readers, plus a git-derived lastmod for the sitemap.

```stats
{ "items": [
    {"label": "Lines", "value": "576"},
    {"label": "Files", "value": "5"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

An LLM that fetches a page of this site gets tens of kilobytes of Tailwind-classed markup wrapped around a few
hundred words. So every built page is also written as Markdown at the same URL with a `.md` suffix, indexed by
an `llms.txt` at the root and inlined whole into `llms-full.txt` — all derived from what the build just
emitted, so none of it can drift from the site. Pages marked `noindex` are left out: what is not for a search
engine is not for a model either.

The HTML→Markdown step is deliberately DOM-free. Everything else in this area reaches for jsdom, which would
mean shipping a browser DOM implementation into a static build to read prose out of a file the build wrote
seconds earlier.

The second helper is one function: the ISO date of the last commit touching a page's source file, which the
sitemap uses for `<lastmod>` and article schemas for `dateModified`.

**What used to be here and is not any more.** This package also generated OpenGraph card images and pinged
IndexNow after each build. Both are now maintained npm packages —
[`astro-opengraph-images`](https://www.npmjs.com/package/astro-opengraph-images) (the same satori + resvg stack
the in-house version hand-rolled) and [`astro-indexnow`](https://www.npmjs.com/package/astro-indexnow) (no
runtime dependencies) — wired up in the site's `astro.config.mjs`. Only the card's own artwork stayed with us,
as `_apps/site/scripts/og-template.mjs`, because that is branding rather than plumbing.

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
    {"label": "api", "value": 3714, "display": "3.7k", "accent": "neutral"},
    {"label": "site-content", "value": 1554, "display": "1.6k", "accent": "neutral"},
    {"label": "site", "value": 1062, "display": "1.1k", "accent": "neutral"},
    {"label": "api-contract", "value": 653, "display": "653", "accent": "neutral"},
    {"label": "capability-catalog", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "astro-integrations (this one)", "value": 576, "display": "576", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Used only by the website's build — `astro.config.mjs` for the integration, `BaseLayout.astro` for the lastmod.
