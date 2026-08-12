# Article mentions — the pages answer engines quote

The third off-site channel, and the one with no coverage until now.
[awesome-lists.md](awesome-lists.md) covers curated GitHub directories, [directories.md](directories.md)
covers listings and launch platforms. This page covers **editorial articles**: the guide-shaped blog posts
that currently own the category queries, and that a chat assistant reads out when somebody asks how to do
the thing intentic does.

Researched 2026-08-12 against live search results and the pages themselves.

## Why this is a separate channel

An awesome list is a link. An article is prose with an argument in it, and prose is what an answer engine
quotes. Asked "how do I run several coding agents at once", no assistant reads out a GitHub list: it
paraphrases whichever article explained the problem best, and names the tools that article named.

Two searches from 2026-08-12 set the stakes:

- **`"intentic" agents docker sandbox`** returns four results. All four are ours: the site twice, our own
  GitHub twice. No independent source exists for an engine to corroborate anything against.
- **`run multiple coding agents in parallel own hardware self-hosted`** returns ten results and intentic is
  in none of them. Every one is a guide rather than a product page, which is the shape of the whole
  category.

The five guides now live under `/guides/` are the on-site half of this. This page is the off-site half:
being *named in someone else's* answer to the same question.

## The floor is different here, and lower

The awesome lists gate on stars and age. These do not. An article's author is choosing what to mention on
relevance, and the ones below are written by individuals who reply to their own mentions. At 8 stars we fail
several list gates and none of these.

What they will judge instead: whether the tool is a real answer to the paragraph it would sit in, and
whether the person writing to them has read the piece.

## Targets, in order

Ranked by how directly the page owns a query we want, then by whether the author is reachable.

| # | Page | Why it matters | Route |
| --- | --- | --- | --- |
| 1 | [aq.dev — Run Multiple AI Coding Agents in Parallel (2026)](https://aq.dev/guides/run-multiple-ai-coding-agents-in-parallel/) | Rank 1 for the primary category query. Names 8 tools (Claude Code, Codex, Cursor, Kimi, Grok, dmux, tmux, AQ) and has an FAQ block, which is the structure engines lift from. Covers worktrees and "the isolation rule" and stops exactly where a container per agent begins. | [@aqdotdev](https://x.com/aqdotdev) |
| 2 | [codeagentswarm — The Best Tools to Run Multiple AI Coding Agents in Parallel (2026)](https://www.codeagentswarm.com/en/guides/best-tools-to-run-multiple-ai-coding-agents) | An explicit best-tools roundup, which is the single most-quoted format for "what should I use". Rate-limited us on 2026-08-12; retry before writing. | Find on page after a successful fetch |
| 3 | [agentsroom.dev — How to Run 3 to 8 Coding Agents in Parallel Without Losing Track](https://agentsroom.dev/blog/run-coding-agents-in-parallel) | The "without losing track" framing is the fleet board's exact argument, and the star count of the author's own project suggests a peer rather than a publisher. | [@AgentsRoomDev](https://x.com/AgentsRoomDev), [github.com/jeapostrophe](https://github.com/jeapostrophe) |
| 4 | [Towards Data Science — How to Run Coding Agents in Parallel](https://towardsdatascience.com/how-to-run-coding-agents-in-parallell/) | The only mainstream publication in the result set. Highest authority per mention, slowest route, and the one worth a written pitch rather than a message. | Publication submission process |
| 5 | [runfreetools — How to Run Multiple AI Coding Agents in Parallel (2026)](https://runfreetools.com/blog/run-multiple-ai-coding-agents-parallel) | Ranks on the same query with a tools angle. | [@Runfreetools](https://x.com/Runfreetools) |
| 6 | [vibecoding.app — Agentmaxxing: Run Multiple AI Agents in Parallel (2026)](https://vibecoding.app/blog/agentmaxxing) | Same query, larger audience, less technical framing. | [github.com/Dicklesworthstone](https://github.com/Dicklesworthstone), [github.com/Vibe-Coding-app](https://github.com/Vibe-Coding-app) |
| 7 | [zenvanriel.com — Running Multiple AI Coding Agents in Parallel](https://zenvanriel.com/ai-engineer-blog/running-multiple-ai-coding-agents-parallel) | Individual engineer blog, ranks on the query, likely to reply. | Site contact |
| 8 | [shreyshahh — How to run multiple coding agents without breaking everything](https://shreyshahh.substack.com/p/how-to-run-multiple-coding-agents) | Substack, "without breaking everything" is the isolation argument verbatim. | Substack reply |
| 9 | [codex.danielvaughan.com — Running Multiple Codex Agent Instances](https://codex.danielvaughan.com/2026/04/18/running-multiple-codex-agents-parallel-orchestration/) | Codex-specific, narrower, but a clean fit for "intentic runs Codex too". | Site contact |

None of the nine mention intentic as of 2026-08-12.

## What to send

The failure mode is a pitch. These authors write about a problem, and the thing that earns a mention is
being useful about that problem.

- **Lead with the gap in their piece, not with us.** Every one of these stops at worktrees or tmux. The
  honest observation is that both stop working the moment agents need to run the app: two dev servers want
  one port, two test runs want one database. That is a real hole in their article and they will recognise it.
- **Link the guide, not the landing page.** `/guides/run-multiple-coding-agents-in-parallel/` argues the
  same case they are arguing, recommends worktrees first, and names five approaches before ours. It reads as
  a peer's write-up because it is one. The landing page reads as an ad.
- **Say we made it, in the first two lines.** Same rule as the list PRs. Undisclosed self-promotion is what
  gets an author to blacklist a domain, and one blacklist costs more than nine mentions gain.
- **Ask for nothing.** "Thought this might be useful for the isolation section" outperforms "would you
  consider adding us", and it survives being forwarded.

## What makes a mention stick

An engine quoting an article about us needs the article to say something checkable. The three facts that
travel best, in this order:

1. A container per agent, on hardware you own, so agents get ports, packages and credentials of their own
   rather than sharing one machine's.
2. Free and MIT including the platform, which is falsifiable in one click and is the reason a writer can
   recommend it without hedging.
3. The platform stores an identity and a sandbox URL, and nothing else. No code, no keys.

## The thing this channel cannot fix

Nine mentions still leave zero mentions on Reddit and Hacker News, where both readers and engines weight
discussion above marketing pages. [directories.md](directories.md) holds a prepared Show HN that has not
been sent. Article outreach and that post work on the same problem from two sides, and the post is the
cheaper half.
