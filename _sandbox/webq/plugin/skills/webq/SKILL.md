---
name: webq
description: Web pages as clean, token-budgeted markdown via the `webq` CLI — one call fetches a URL (JS-rendered if needed), prunes the chrome, prints what fits your budget and saves the whole page to a file. Use for reading docs pages, crawling a whole docs site into files, query-focused extraction ("just the parts about X"), and any page WebFetch returns empty because it needs JavaScript. Not for pages behind a sign-in (use the browser tools as the account).
---

# webq: the web as markdown, sized for context

One page:

```
webq fetch https://docs.example.com/guide
```

Read the capsule first: `title · final URL · token cost · fit|raw · cache|network|browser`, then `saved:`
(the whole page as a file), then the content up to `--budget` (default 4000 tokens). If it was cut, the cut
line names the file to `Read` for the rest — prefer that over refetching with a bigger budget.

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
