# @intentic/webq

Agent-native web fetch: any URL as clean, token-budgeted markdown, and bounded same-site crawls, over one shared cache.

`webq` is to the web what `iq` is to the workspace — the tool an agent reaches for when the answer is on a
page, sized for a context window instead of a screen. A fetch prints a capsule (title, final URL, token
cost, where the bytes came from), the content up to a budget, and always saves the whole page to a file the
agent can `Read` later. A crawl turns a docs site into a directory of markdown files plus an index, under
hard caps it reports rather than hides.

The interesting decisions:

- **Fit-first.** By default pages are pruned to their readable content with a scoring walk (text density,
  link density, tag kind, class/id smell) ported from crawl4ai's `PruningContentFilter` (Apache-2.0) —
  battle-tested weights, our tree. `--raw` turns it off; `--query` adds a BM25 pass that keeps only blocks
  relevant to a question.
- **The cheap path has to be earned out of.** Static HTTP first; the image's Chromium (the browser feature
  pack) is launched only when the static HTML is visibly an empty app shell, or on `--browser force`.
  Without the pack, webq serves the static HTML and says so — it never downloads a browser mid-command.
- **Honesty over completeness.** Byte caps, page caps, robots exclusions, sitemap truncation and JS-without-
  browser degradation all surface as notes and per-reason skip counts. A capped crawl that reads like a
  complete one is the failure mode the output format exists to prevent.
- **One cache, raw HTML.** Fetches are cached by (URL, render mode) for 15 minutes, before any transform, so
  every mode reuses one fetch and parallel subagents researching the same site stop paying the network twice.
- **Crawls are polite by default.** robots.txt is parsed with Google's longest-match semantics and obeyed
  (`--ignore-robots` is an explicit responsibility transfer), crawl-delay is honored (capped), crawls stay on
  the start origin, and a `--query` makes the frontier best-first: links whose anchor text shares words with
  the question are visited before their siblings.

## Key files

- [src/lib/page.ts](src/lib/page.ts) — the pipeline every command runs: cache → HTTP → app-shell check → browser → prune/filter → markdown.
- [src/lib/prune.ts](src/lib/prune.ts) — the fit-content scorer (the crawl4ai port, with attribution and the divergences noted).
- [src/lib/markdown.ts](src/lib/markdown.ts) — DOM → markdown written for an agent reader: no escaping noise, absolute URLs, flow handling for loose text.
- [src/lib/crawl.ts](src/lib/crawl.ts) — frontier, caps, robots, best-first scoring, and the skip accounting.
- [src/app.ts](src/app.ts) — the CLI surface and the `--help` contract.
- [src/cli.integration.test.ts](src/cli.integration.test.ts) — the whole surface driven against a loopback fixture site.

## How it fits

The sandbox image bakes the CLI onto `PATH` out of the daemon's own dependency tree (the `lsp`/`iq`
precedent in `_sandbox/sandbox/Dockerfile`), and ships [plugin/](plugin) — a skill teaching agents when to
prefer `webq` over `WebFetch` (JS pages, whole-docs-site reads, repeated fetches) and when not to (one-off
simple pages, anything needing sign-in, which belongs to the browser tools). The package is otherwise a
dependency island: nothing in the daemon imports it.

## Conventions & gotchas

- Output and cache live under `WEBQ_HOME` (default `~/.cache/webq`); saved pages carry front matter
  (url, title, fetched_at) so a file found later still says what it is.
- Exit codes follow the grep convention agents already know: 0 content, 1 none (HTTP error, empty crawl),
  2 broken invocation or broken install — and a broken install announces itself on stdout instead of
  dying as a bare stack, for the same reason iq's does.
- The integration suite drives the CLI in-process, not as a child process: some sandboxes give each process
  its own loopback, which turns a spawn-based suite into a hang that says nothing about webq.
