# @intentic-dev/site-content

Every word on the public website, as data. So the marketing copy is reviewable in a diff instead of buried in
markup.

## Responsibilities

- Hold the copy for each page: landing, product, docs, compare, about, FAQ, legal.
- Hold the site's own constants: URLs, taglines, navigation, page metadata.
- Hold the structured data search engines read.

## Key files

- [src/site.ts](src/site.ts): URLs, org name and tagline; the constants everything else composes from.
- [src/landing.ts](src/landing.ts): the front page's copy.
- [src/docs.ts](src/docs.ts): the docs tree, with four shelves sorted by who is reading, their sub-groups and nested
  pages. The sidebar, the top bar's Docs menu, the footer's docs column, the prev/next footer and every docs
  page's metadata all derive from it, so they cannot disagree about the shape of the documentation.
- [src/nav.ts](src/nav.ts) / [src/page-meta.ts](src/page-meta.ts): navigation and per-page metadata.
- [src/structured-data.ts](src/structured-data.ts): the JSON-LD the site emits.

## How it fits

Consumed by `_site/site` (the Astro build). Separating copy from layout means a wording change is a one-line diff
someone can review without reading a template.

## Conventions & gotchas

- `DEMO_PATH` is relative on purpose. The interactive demo builds into the site's own `public/`, so the hero's
  iframe is SAME-ORIGIN: a cross-origin frame gets partitioned storage, and the demo seeds credentials into
  localStorage before the app boots. A preview deploy therefore embeds its own copy rather than production's.
