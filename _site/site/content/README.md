# The website's editable content

Two files' worth of the public site that changes without touching a page. Both are read at build; one of them
is *also* read at request time, which is the difference between them and the whole reason this directory
exists.

## The two lanes

| | `live.json` | `posts/*.md` |
| --- | --- | --- |
| Reaches the web in | ~30 seconds, no deploy | a deploy |
| Read by | `worker.ts`, at every request | the Astro build |
| Indexed | no, deliberately | yes: sitemap, `.md` mirror, `llms.txt`, OG card, BlogPosting |
| For | a notice, and two kill switches | writing |

### `live.json` — the instant lane

Three things, and nothing else should be added without a reason as good as theirs:

- **`notice`** — the strip across the top of every page. "The hosted sandboxes are degraded." Set `active`
  to `true`, write one sentence into `message`, pick a `tone` (`info`, `warn`, `down`). `href` is optional
  and may only point at a path on this site or at a host on the allowlist in `src/lib/live.ts`.
- **`switches.download`** — `enabled: false` withholds the desktop app. Every download button on the site
  goes dark, **and** `/desktop/windows` and its siblings stop handing over a file: they answer with
  `/download/` instead. The URLs are published and bookmarked, so dressing the pages alone would not have
  stopped anything.
- **`switches.workspace`** — `enabled: false` darkens every "Create your workspace" button. It does not
  close the app; it stops this site sending anybody there.

Put the `reason` on a switch you turn off. It becomes the disabled control's tooltip, and it is the note to
whoever reads this file next week wondering whether it is still true. Say it out loud in the notice too — a
greyed-out button explains nothing on its own.

Commit the change and it is live within about half a minute. There is no build, no pipeline and nothing to
wait for. See the long comment at the top of [`../src/lib/live.ts`](../src/lib/live.ts) for how that works and
what happens when it does not: every failure leaves the page exactly as it was built, which is the last state
somebody committed here.

**The switches are a production control.** `astro dev` does not run the worker, so locally you see whatever is
baked in this file — the notice, but not the switches.

### `posts/*.md` — the blog

One file per post. The filename is the slug: `posts/one-worktree-per-agent.md` is
`/blog/one-worktree-per-agent/`. Frontmatter:

```yaml
---
title: "One worktree per agent, and why the count stops mattering"
description: "Under 160 characters. This is the search result and the card blurb."
date: 2026-09-04
tags: ["engineering"]   # optional
draft: false            # optional; true means no page at all
---
```

`title`, `description` and `date` are required and a missing one fails the build — a post is a page in the
sitemap, and a page with no description of its own inherits the site's, which is how a crawler ends up with
the same 285 characters on twelve URLs. The date may be quoted or not; both are read.

A post is **built**, not fetched. That is what earns it a sitemap entry with a real last-modified date, a
Markdown mirror at `/blog/<slug>.md`, a line in `llms.txt`, its own OpenGraph card and `BlogPosting`
structured data — none of which exist for content a page fetches at runtime. Publishing costs a deploy, and
should.

Body styling is `.docs-body`, the site's one prose style: headings, links, lists, tables, `code`, blockquotes
and rules all work with no classes in the markdown.

## Why this is not a separate repository

It was considered and it is not worth it yet. A content repo of its own buys three things — a smaller
checkout for whoever edits, a commit that cannot break the build, and a publish cadence separate from the
product's. At two files those are worth less than the cost of the split: a second review surface, a schema in
one repo and its data in another, and a deploy hook to build this site when the other one changes.

The monorepo is public, so the worker reads `live.json` straight from `raw.githubusercontent.com` with no
credential either way — the fetch does not care which repository it is in. Splitting later is changing one
URL in `src/lib/live.ts`.

Split it when one of these is true: somebody who should not have write access to the product needs write
access to the content, posts arrive often enough that they dominate the monorepo's history, or the blog grows
its own build step. None of those is true today.
