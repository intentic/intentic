# @intentic-dev/site

The public website at intentic.dev — an Astro build, all copy imported rather than written in the markup.

## Responsibilities

- Render the marketing and documentation pages.
- Ship the interactive demo into its own `public/`, so the hero iframe is same-origin.
- Emit the machine-readable surface: per-page markdown and `llms.txt`.

## Key files

- [src/pages/index.astro](src/pages/index.astro) — the landing page, and the hero the demo runs in.
- [src/pages/docs](src/pages/docs) — the documentation pages.
- [src/layouts](src/layouts) — the shells every page composes into.
- [src/lib/registry.ts](src/lib/registry.ts) — the extension registry the marketplace pages read.
- [astro.config.mjs](astro.config.mjs) — where the build-time integrations are wired in.

## How it fits

Copy comes from `@intentic-dev/site-content` and build-time behaviour from `@intentic-dev/astro-integrations`.
This package is layout and routing; a wording change should not need to touch it.

## Conventions & gotchas

- `dist/` is checked in for the docs pages' markdown mirrors. Do not read it as source.
- The demo is built into this site's `public/` deliberately: a cross-origin iframe gets partitioned storage, and
  the demo seeds credentials into localStorage before the app boots.
