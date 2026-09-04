# @intentic-dev/site

The public website at intentic.dev: an Astro build, all copy imported rather than written in the markup.

## Responsibilities

- Render the marketing and documentation pages.
- Ship the interactive demo into its own `public/`, so it is a page of this site at `/demo/`.
- Emit the machine-readable surface: per-page markdown and `llms.txt`.

## Key files

- [src/pages/index.astro](src/pages/index.astro): the landing page, whose hero shot links to the demo. It is
  three lines; the page itself is [src/components/Landing.astro](src/components/Landing.astro), with its own
  arrangement in [src/styles/home.css](src/styles/home.css).
- [src/styles/global.css](src/styles/global.css), the design system, and the first file to read: the metals,
  the three type tiers and the size band each is fenced to, and every shared recipe (`.btn`, `.card`,
  `.window`, `.frame`, `.eyebrow`, `.display`, the plate). Nothing on this site is rounded and every rule is
  gold; both are decided here.
- [src/components/Window.astro](src/components/Window.astro): the one frame every product screenshot on the
  site sits in, ledge and turned corners included.
- [src/components/AutomateFigure.astro](src/components/AutomateFigure.astro): the automation machine, drawn —
  six events feeding one bus, the check that may veto a run, the session it turns into. The one figure both the
  home page and a feature page carry, so it takes its arrangement from a `@container` query rather than the
  window: wide in the home page's 1296px plate, stacked in a column half that, from the same markup. Its words
  are `site-content/automate.ts`; its motion is one gold pulse a beat, and none under `prefers-reduced-motion`.
- [src/components/PageBackdrop.astro](src/components/PageBackdrop.astro): the temple behind every page's
  first screen. The home page's hero paints its own; every other page gets this one, which is why the bar
  has the same carved band behind it wherever you are.
- [src/components/Nav.astro](src/components/Nav.astro): the bar. Transparent on every page, over that
  backdrop, taking a ground only once the plate has scrolled out from behind it. Its height is
  `--bar-height` in global.css: a stylesheet value, not a measurement, so it cannot differ by a pixel
  between one page and the next.
- [src/components/ornaments.ts](src/components/ornaments.ts): the four drawn shapes (lotus, lozenge, corner,
  divider) every flourish here is one of, as strings so markup and CSS `background-image` share one definition.
  `scripts/icons.mjs` reads the lotus out of it to build every favicon, so the mark in the bar and the mark in
  a browser tab cannot become two drawings.
- [src/pages/docs](src/pages/docs): the documentation pages.
- [src/components/DocsLayout.astro](src/components/DocsLayout.astro): every docs page's shell, and the one place
  that sees a page's whole rendered body: it anchors the headings, builds the section list, and checks a page's
  authored index against the headings that actually exist.
- [src/lib/docs-headings.ts](src/lib/docs-headings.ts): the render pass that gives every prose heading a stable
  id and an anchor. Derived rather than authored; see the file for why.
- [src/pages/docs/search.json.ts](src/pages/docs/search.json.ts): the docs search index, section by section.
- [src/lib/registry.ts](src/lib/registry.ts): the extension registry the marketplace pages read; the public gallery includes only exact sources carrying current deterministic-scan and agent-audit evidence.
- [src/lib/changelog.ts](src/lib/changelog.ts): the published GitHub Releases `/changelog/` reads, and the
  parser for the "What's new" section `_tools/scripts/release/publish-github.sh` writes into each release body.
- [src/lib/desktop-downloads.ts](src/lib/desktop-downloads.ts): the desktop builds, named once, so the download
  page and the landing page's download button can never point at different files.
- [src/components/DownloadCta.astro](src/components/DownloadCta.astro): the download button, which names the
  reader's own platform. It renders the general case and narrows it in the browser; see the file for why that
  order matters.
- [astro.config.mjs](astro.config.mjs): where the build-time integrations are wired in.

## How it fits

Copy comes from `@intentic-dev/site-content` and build-time behaviour from `@intentic-dev/astro-integrations`.
This package is layout and routing; a wording change should not need to touch it.

## Conventions & gotchas

- **Docs pages author prose headings BARE**: `<h2>`, not `<h2 class="…">`. That is what marks a heading as a
  section of the page rather than furniture inside a card, and it is what earns it an anchor and a place in the
  section list. A heading that needs a class is a component's, and is skipped on purpose.
- A docs page that writes its own index table passes `requireAnchors` to `DocsLayout`, which fails the build if a
  row points at a heading that no longer exists. A dead in-page link is invisible in a diff and in a screenshot.
- The demo is built into this site's `public/` deliberately: it seeds credentials into localStorage before the
  app boots, so it has to be served from this site's own origin rather than linked to somewhere else.
- The demo opens as its own full page, never in an overlay: an IDE wants the whole viewport, and every link to
  it on the site (nav, hero, product and compare CTAs) is a plain `<a>` to `/demo/`.
- **Some paths are the worker's, not Astro's**: `/desktop/*`, `/connect` and the other vanity routes are
  answered by `worker.ts`, which does not run under `astro dev`. `/desktop/*` is stood in for by a dev-only
  middleware reading the worker's own table, so download links work locally; the script routes are not, and a
  new vanity path needs the same treatment or it will 404 on every developer's machine and nowhere else.
