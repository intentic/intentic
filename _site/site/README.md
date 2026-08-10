# @intentic-dev/site

The public website at intentic.dev — an Astro build, all copy imported rather than written in the markup.

## Responsibilities

- Render the marketing and documentation pages.
- Ship the interactive demo into its own `public/`, so it is a page of this site at `/demo/`.
- Emit the machine-readable surface: per-page markdown and `llms.txt`.

## Key files

- [src/pages/index.astro](src/pages/index.astro) — the landing page, whose hero shot links to the demo.
- [src/pages/docs](src/pages/docs) — the documentation pages.
- [src/components/DocsLayout.astro](src/components/DocsLayout.astro) — every docs page's shell, and the one place
  that sees a page's whole rendered body: it anchors the headings, builds the section list, and checks a page's
  authored index against the headings that actually exist.
- [src/lib/docs-headings.ts](src/lib/docs-headings.ts) — the render pass that gives every prose heading a stable
  id and an anchor. Derived rather than authored; see the file for why.
- [src/pages/docs/search.json.ts](src/pages/docs/search.json.ts) — the docs search index, section by section.
- [src/lib/registry.ts](src/lib/registry.ts) — the extension registry the marketplace pages read.
- [src/lib/changelog.ts](src/lib/changelog.ts) — the published GitHub Releases `/changelog/` reads, and the
  parser for the "What's new" section `_tools/scripts/publish-github.sh` writes into each release body.
- [astro.config.mjs](astro.config.mjs) — where the build-time integrations are wired in.

## How it fits

Copy comes from `@intentic-dev/site-content` and build-time behaviour from `@intentic-dev/astro-integrations`.
This package is layout and routing; a wording change should not need to touch it.

## Conventions & gotchas

- **Docs pages author prose headings BARE** — `<h2>`, not `<h2 class="…">`. That is what marks a heading as a
  section of the page rather than furniture inside a card, and it is what earns it an anchor and a place in the
  section list. A heading that needs a class is a component's, and is skipped on purpose.
- A docs page that writes its own index table passes `requireAnchors` to `DocsLayout`, which fails the build if a
  row points at a heading that no longer exists. A dead in-page link is invisible in a diff and in a screenshot.
- The demo is built into this site's `public/` deliberately: it seeds credentials into localStorage before the
  app boots, so it has to be served from this site's own origin rather than linked to somewhere else.
- The demo opens as its own full page, never in an overlay: an IDE wants the whole viewport, and every link to
  it on the site — nav, hero, product and compare CTAs — is a plain `<a>` to `/demo/`.
