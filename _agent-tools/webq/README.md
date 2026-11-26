# webq

A CLI that fetches web pages for an agent as pruned, token-budgeted markdown and crawls a site into files, over one shared cache.

```mermaid
flowchart LR
    agent["Agent<br/>webq fetch · crawl"] --> webq(["webq"])
    webq --> cache["Shared cache<br/>per URL and render mode"]
    webq --> http["Static HTTP"]
    webq --> chromium["Headless Chromium<br/>empty app shells"]
    webq --> out["Capsule on stdout<br/>whole page saved"]
```

- A raw page is mostly navigation and script, and one docs page can fill a context window. `webq fetch` prints a
  capsule (title, final URL, token cost, cache, network or browser), then the page with its chrome pruned and clipped
  to `--budget`, and saves the whole page as markdown with front matter. A cut names the saved file's line the rest
  starts on, past the front matter, so an agent reads on from there instead of from the top.
- A failure is one line with a stable code, `webq: error: <code>: <message>`, and usually `webq: next: <step>`
  (agent-cli's [errors](../agent-cli/README.md) has the codes). An HTTP error status prints that line before the
  capsule and still shows the error page, exit 1: 404 and 410 are `not_found`; 401, 403, 407, 429 and 451 are
  `blocked`; the rest are `fetch_failed`. A fetch that got no answer is `fetch_failed` or `timeout`, exit 2, and a
  crawl that saved no pages says why with one of them, exit 1.
- `--query` keeps only the blocks relevant to a question (BM25). On a crawl it also visits matching links first.
- When the static HTML is an empty app shell, the page renders in the image's Chromium if that feature pack is
  installed; without it webq says so and serves the static HTML.
- Crawls stay on the start origin, obey `robots.txt` and report every skipped URL by reason, so a capped crawl never
  reads as complete.
- The sandbox image puts `webq` on PATH and loads [plugin/skills/webq/SKILL.md](plugin/skills/webq/SKILL.md), which
  tells agents when to use it over WebFetch. It does not handle pages behind a sign-in. [fileq](../fileq) reuses the
  `./dom` and `./markdown` exports for HTML-based documents.

## Usage

```sh
webq fetch https://docs.example.com/guide --query "rate limits"
webq crawl https://docs.example.com --max-pages 30
```

## Key files

- [src/app.ts](src/app.ts) — the commands and the `--help` text an agent reads.
- [src/lib/page.ts](src/lib/page.ts) — one URL to one `PageResult`: cache, static fetch, browser fallback, notes.
- [src/lib/prune.ts](src/lib/prune.ts) — scores elements and drops navigation and page chrome.
- [src/lib/markdown.ts](src/lib/markdown.ts) — DOM to markdown with absolute links, and `markdownTable`, the table writer fileq shares.
- [src/lib/crawl.ts](src/lib/crawl.ts) — bounded crawl, breadth-first or query-steered, with skip counts.
- [src/cli.integration.test.ts](src/cli.integration.test.ts) — the CLI end to end against a loopback fixture site.

## Commands

```sh
pnpm --filter @intentic/webq test
```
