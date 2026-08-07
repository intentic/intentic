# @intentic-dev/astro-integrations

The build-time integrations the public site needs and Astro does not ship.

## Responsibilities

- Stamp each page's last-modified date from git rather than from the filesystem.
- Compute the repository statistics the site displays.
- Read this repository's published security score, for the same reason.
- Emit a markdown rendering of each page, and the `llms.txt` that points at them.

## Key files

- [src/index.mjs](src/index.mjs) — the integrations, and what each hooks into.
- [src/git-lastmod.mjs](src/git-lastmod.mjs) — real last-modified dates, from history.
- [src/git-stats.mjs](src/git-stats.mjs) — how much of the repository its own agents wrote.
- [src/scorecard.mjs](src/scorecard.mjs) — the OpenSSF Scorecard score, from the public API.
- [src/llms-text.mjs](src/llms-text.mjs) — the machine-readable index of the site.
- [src/html-to-markdown.mjs](src/html-to-markdown.mjs) — the rendering that feeds it.

## How it fits

Used only by `_site/site`. It is a package rather than a directory in the site so the integrations can be tested
and versioned apart from the pages they process.

## Conventions & gotchas

- **Plain `.mjs`, with a hand-written `index.d.ts`.** Astro integrations are loaded by the Astro config at build
  time, before any TypeScript build step exists to have compiled them.
- The last-modified date comes from git, not from `stat`. A checkout gives every file the same mtime, which would
  make every page look edited today.
- **Every figure here is measured, and every one fails to `null`.** A shallow clone, a build with no network, an
  API that moved — each returns nothing rather than a guess, and the page renders its sentence without the
  number. A trust section showing a wrong figure costs more than one showing none.
