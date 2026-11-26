---
name: webq
description: Web pages as token-budgeted markdown via the `webq` CLI: one call fetches and renders a URL, prunes the chrome, prints what fits your budget and saves the whole page. Use for docs pages, crawling a docs site into files, query-focused extraction, and any page WebFetch returns empty. Not for pages behind a sign-in.
---

# webq: the web as markdown, sized for context

One page:

```
webq fetch https://docs.example.com/guide
```

Read the capsule first: `title · final URL · token cost · fit|raw · cache|network|browser`, then `saved:`
(the whole page as a file), then the content up to `--budget` (default 4000 tokens). If it was cut, the last
line says where the rest starts: `[cut at line 212 of 1480, ~19,100 of 23,100 tokens left: continue with Read
<file> from line 212, or raise --budget]`. Read the file from that line — prefer that over refetching with a
bigger budget.

| I want… | Run |
|---|---|
| one page, clean | `webq fetch <url>` |
| just the parts about X | `webq fetch <url> --query "rate limits"` |
| the whole page, chrome and all | `webq fetch <url> --raw` |
| a docs site as files | `webq crawl <url> --max-pages 30` |
| the pages about X, best first | `webq crawl <url> --query "webhooks" --max-pages 10` |
| seed from the site's sitemap | `webq crawl <url> --sitemap` |
| force/skip JS rendering | `--browser force` / `--browser never` |
| bypass the 15-min cache | `--fresh` |

Crawls write one markdown file per page plus `index.md` / `index.json`; read the index, then `Read` only
the files whose titles matter. Skip counts (`robots`, `offsite`, `beyond-cap`, `http-errors`) tell you what
the crawl did NOT cover — a capped crawl is not a complete one.

When to reach for what:

- **webq** — public pages, docs, articles; anything you'd otherwise WebFetch repeatedly or that WebFetch
  returns empty (JS app shells render through the image's Chromium automatically).
- **WebFetch** — a one-off page where a summary is enough.
- **Browser tools** — pages needing sign-in, clicks, or form input; webq is read-only and credential-free.

Notes in the capsule are honesty, not noise: "byte cap hit", "no Chromium in this image", "query matched
too little: kept the whole page" each change what you should conclude from the output.

Exit codes: 0 content, 1 none (HTTP error / empty crawl), 2 broken invocation or install. A broken install
says so on stdout — never read it as an empty page.

A failure is one line, `webq: error: <code>: <message>`, usually followed by `webq: next: <step>`: do the step.

| code | what happened | usual next step |
|---|---|---|
| `not_found` | HTTP 404 or 410; any body shown is the site's error page | check the URL |
| `blocked` | 401/407 sign-in, 403/451 refusal, 429 rate limit, or robots.txt | `--browser force --fresh`; a signed-in browser for a sign-in |
| `fetch_failed` | no answer (DNS, refused, reset) or another HTTP error | check the host; `--fresh` in a minute |
| `timeout` | slower than `--timeout` | a longer `--timeout` |
| `missing_tool` | `--browser force` with no Chromium in the image | `--browser never` |
| `usage` | a wrong verb, flag or value | the verb's `--help` |
| `broken_install`, `internal` | webq's own fault | report it; never read it as an empty page |

An error page is cached like any page, so asking again means `--fresh`.
