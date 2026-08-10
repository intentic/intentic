# @intentic-dev/site

The public website at intentic.dev — an Astro build, all copy imported rather than written in the markup.

## Responsibilities

- Render the marketing and documentation pages.
- Ship the interactive demo into its own `public/`, so it is a page of this site at `/demo/`.
- Emit the machine-readable surface: per-page markdown and `llms.txt`.

## Key files

- [src/pages/index.astro](src/pages/index.astro) — the landing page, whose hero shot links to the demo.
- [src/pages/docs](src/pages/docs) — the documentation pages.
- [src/layouts](src/layouts) — the shells every page composes into.
- [src/lib/registry.ts](src/lib/registry.ts) — the extension registry the marketplace pages read.
- [src/lib/changelog.ts](src/lib/changelog.ts) — the published GitHub Releases `/changelog/` reads, and the
  parser for the "What's new" section `_tools/scripts/publish-github.sh` writes into each release body.
- [astro.config.mjs](astro.config.mjs) — where the build-time integrations are wired in.

## How it fits

Copy comes from `@intentic-dev/site-content` and build-time behaviour from `@intentic-dev/astro-integrations`.
This package is layout and routing; a wording change should not need to touch it.

## Conventions & gotchas

- `dist/` is checked in for the docs pages' markdown mirrors. Do not read it as source.
- The demo is built into this site's `public/` deliberately: it seeds credentials into localStorage before the
  app boots, so it has to be served from this site's own origin rather than linked to somewhere else.
- The demo opens as its own full page, never in an overlay: an IDE wants the whole viewport, and every link to
  it on the site — nav, hero, product and compare CTAs — is a plain `<a>` to `/demo/`.
