# Article mentions: the pages answer engines quote

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

The five guides under `/guides/` are the on-site half of this. This page is the off-site half: being
*named in someone else's* answer to the same question.

> **Live and verified 2026-08-12.** All five slugs and the index return **200**, and the deployed sitemap is
> up from 54 to 60 URLs with every guide listed: so this channel is unblocked and the outreach below can go.
> (They were 404 earlier the same day, unmerged on an agent branch; shipped since.) The page the outreach
> links, [`/guides/run-multiple-coding-agents-in-parallel/`](https://intentic.dev/guides/run-multiple-coding-agents-in-parallel/),
> checks out against what this page claims for it: it opens with a direct answer, recommends **git worktrees
> first**, tables five approaches with an honest "breaks when" column for each: including the one for
> containers ("The work is a one-line fix. The setup cost is real and a worktree would have done"): and
> reaches intentic only as the second step, in one paragraph. That is why it is safe to send to a writer:
> it reads as a peer's write-up because it argues against itself where the argument deserves it.

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
| 1 | [aq.dev: Run Multiple AI Coding Agents in Parallel (2026)](https://aq.dev/guides/run-multiple-ai-coding-agents-in-parallel/) | Rank 1 for the primary category query. Names 8 tools (Claude Code, Codex, Cursor, Kimi, Grok, dmux, tmux, AQ) and has an FAQ block, which is the structure engines lift from. Covers worktrees and "the isolation rule" and stops exactly where a container per agent begins. | [@aqdotdev](https://x.com/aqdotdev) |
| 2 | [codeagentswarm: The Best Tools to Run Multiple AI Coding Agents in Parallel (2026)](https://www.codeagentswarm.com/en/guides/best-tools-to-run-multiple-ai-coding-agents) | An explicit best-tools roundup, which is the single most-quoted format for "what should I use". Rate-limited us on 2026-08-12; retry before writing. | Find on page after a successful fetch |
| 3 | [agentsroom.dev: How to Run 3 to 8 Coding Agents in Parallel Without Losing Track](https://agentsroom.dev/blog/run-coding-agents-in-parallel) | The "without losing track" framing is the fleet board's exact argument, and the star count of the author's own project suggests a peer rather than a publisher. | [@AgentsRoomDev](https://x.com/AgentsRoomDev), [github.com/jeapostrophe](https://github.com/jeapostrophe) |
| 4 | [Towards Data Science: How to Run Coding Agents in Parallel](https://towardsdatascience.com/how-to-run-coding-agents-in-parallell/) | The only mainstream publication in the result set. Highest authority per mention, slowest route, and the one worth a written pitch rather than a message. | Publication submission process |
| 5 | [runfreetools: How to Run Multiple AI Coding Agents in Parallel (2026)](https://runfreetools.com/blog/run-multiple-ai-coding-agents-parallel) | Ranks on the same query with a tools angle. | [@Runfreetools](https://x.com/Runfreetools) |
| 6 | [vibecoding.app, Agentmaxxing: Run Multiple AI Agents in Parallel (2026)](https://vibecoding.app/blog/agentmaxxing) | Same query, larger audience, less technical framing. | [github.com/Dicklesworthstone](https://github.com/Dicklesworthstone), [github.com/Vibe-Coding-app](https://github.com/Vibe-Coding-app) |
| 7 | [zenvanriel.com: Running Multiple AI Coding Agents in Parallel](https://zenvanriel.com/ai-engineer-blog/running-multiple-ai-coding-agents-parallel) | Individual engineer blog, ranks on the query, likely to reply. | Site contact |
| 8 | [shreyshahh: How to run multiple coding agents without breaking everything](https://shreyshahh.substack.com/p/how-to-run-multiple-coding-agents) | Substack, "without breaking everything" is the isolation argument verbatim. | Substack reply |
| 9 | [codex.danielvaughan.com: Running Multiple Codex Agent Instances](https://codex.danielvaughan.com/2026/04/18/running-multiple-codex-agents-parallel-orchestration/) | Codex-specific, narrower, but a clean fit for "intentic runs Codex too". | Site contact |

None of the nine mention intentic as of 2026-08-12.

## Refresh 2026-08-28: the individual-engineer shortlist

Re-researched against live search results. The 08-12 targets 3 and 5–9 stand (none of the messages below
were ever sent; that backlog is still open). Eight new individual-authored pages found; vendor roundups
(Beam, Superset, Parallel Code, MindStudio, DevToolLab, Like One, amux, Nimbalyst, Augment Code, claudefa.st)
were excluded for the same reason aq.dev was: a product site's comparison never adds a competitor.
Verified 2026-08-28: neither #1 nor #2 below mentions intentic.

| # | Author / page | Why it matters | The gap to lead with | Route |
| --- | --- | --- | --- | --- |
| 1 | [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) | The most influential individual voice in exactly our category. His "Tier 2" (3–10 agents, worktrees + dashboard + diff review + merge control) is intentic's shape verbatim, and his named list (Conductor, Vibe Kanban, Claude Squad, Antigravity, Cursor BG agents) omits us. One mention here outweighs the rest of this table. | Tier 2 tools give agents branch isolation, not runtime isolation: two agents still share one port, one dev DB, one node_modules: and most are macOS-only or die with the terminal. | [@addyosmani](https://x.com/addyosmani) |
| 2 | [Andrew Lock: Running AI agents safely in a microVM](https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox/) | Huge individual .NET readership. His pain framing: "switching between terminal windows to find the agent that's managed to run into a wall": is the fleet board's argument, written by someone else. | A sandbox per session solves safety and none of the visibility: at 4+ agents the failure is not knowing which one is blocked on you. | [@andrewlocknet](https://x.com/andrewlocknet), site contact |
| 3 | [Mukesh Murugan: Git Worktrees in Claude Code](https://codewithmukesh.com/blog/git-worktrees-claude-code/) | Individual .NET blogger + YouTuber, ranks on the worktree query. | Worktrees solve the git half; the .NET-specific runtime half (two Kestrel ports, one LocalDB) is the paragraph after his last one. | [@iammukeshm](https://x.com/iammukeshm) |
| 4 | [Felix Schmidt: Claude Code Worktrees the Right Way](https://felixschmidt.software/en/blog/claude-code-worktrees-2026) | Individual engineer blog ranking on `--worktree` setup. | Same runtime-collision gap. | Site contact |
| 5 | [battyterm on DEV: How I Run a Team of AI Coding Agents in Parallel](https://dev.to/battyterm/how-i-run-a-team-of-ai-coding-agents-in-parallel-p7c) | Individual, and DEV comments are a native reply channel: no cold email needed. | His own opening example (two agents editing the same file) extends to two agents wanting the same port. | DEV comment |
| 6 | [Gijs (Substack): Running multiple AI Agents in parallel](https://gijs.substack.com/p/running-multiple-ai-agents-in-parallel) | Individual, management-of-agents framing rather than tooling: the audience that buys the fleet story. | Managing agents like a team needs the team to have separate desks: shared-machine collisions read as flaky agents. | Substack reply |
| 7 | [Rick Hightower (Towards AI): Drive Your Local Claude Code Session From Your Phone](https://pub.towardsai.net/claude-code-drive-your-local-claude-code-session-from-your-phone-your-browser-anywhere-7885f4528a9c) | The phone/remote angle is our sharpest differentiator, and his piece documents Anthropic's own Remote Control limits: one connection per instance, terminal must stay open, ~10-min timeout. | Those limits are the argument: a session that lives in a container on your hardware has no terminal to keep open. | Medium response |
| 8 | [Developers Digest: Git Worktrees + Claude Code Playbook](https://www.developersdigest.tech/blog/git-worktrees-claude-code-parallel-agents-guide) | Individual creator with a YouTube channel: a mention travels to video. | Worktrees "without context switching" still context-switch the moment agents need to run the app. | X / YouTube |

Send rules unchanged from [What to send](#what-to-send): disclose in the first two lines, link the guide
not the landing page, no ask. One more fact available since 08-12 that makes the messages land better:
the repo is at 29 stars with entries live on four awesome lists, so "six days old and rough" copy is stale:
say "a few weeks old" instead.

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

## Two of the nine are competitors, and the ranking should say so

Added 2026-08-12. Targets 1 and 2 are not neutral editorial: they are vendor content marketing, and the
table above ranks them first without saying so:

- **aq.dev** is published by **AgentQueue / BetterLeap, Inc.** ("© 2026 BetterLeap, Inc.", by "the AQ team"),
  and AQ is one of the eight tools the article names. It is a competitor's own guide.
- **codeagentswarm.com** is likewise a product site publishing a roundup that its own product sits in.

Asking a competitor to add you to their comparison converts at roughly zero, and the ask itself tells them
what to defend against. Both stay on the list as *intelligence*: they show which queries the category is
being won on, and what shape of answer wins: but they should be worked last, if at all. **The yield is in
targets 3 and 5–9: individual engineers writing under their own names**, who reply to their own mentions and
have no product to protect.

## The messages, ready to send

Gated on the guides shipping (see the blocker at the top). Each is short on purpose: the opener is the
whole pitch, and every one leads with a specific thing that page actually says.

**The shared middle**, reused in all of them, adjusted only in length:

> Disclosure first: I build one of these, so treat this as interested rather than neutral.
>
> The thing that surprised me is that worktree isolation solves the git half and none of the runtime half.
> Two agents get their own branches and still share one port, one dev database and one `node_modules`, so
> the failure that actually costs you an afternoon is a migration race that never shows up in a diff, because
> the code was clean. The dividing line I ended up with is whether the agent needs to change the environment
> rather than the code: an `apt install`, a pinned runtime, a service the others are not running. Below that
> line a port offset and a schema per agent is genuinely enough; above it, a container per agent is the only
> thing that holds.

**Openers, per target:**

- **agentsroom.dev (#3)**, "Your 'without losing track' framing is the part most of these pieces skip: the
  hard bit at 3–8 agents is not starting them, it is knowing which one is blocked on you. One thing I would
  add under it -"
- **runfreetools (#5)**: "Your piece lists the tools; the thing readers hit next is the runtime collision
  underneath all of them -"
- **vibecoding.app (#6)**: "Agentmaxxing holds right up until the agents need to *run* what they built -"
- **zenvanriel.com (#7)**: "You stop at worktrees, which is the right first recommendation. The failure
  after it is the one worth a paragraph -"
- **shreyshahh (#8)**: "'Without breaking everything' is exactly the isolation argument, and there is a
  second half to it that bit me -"
- **codex.danielvaughan.com (#9)**, "Codex-specific, so worth saying: the parallel-instance problem is
  identical to the Claude Code one, and the fix is not Codex-specific either -"

**Close, identical everywhere**: no ask, and it survives being forwarded:

> Wrote the long version up here if it is useful for that section: `<guide URL>`. Not asking for anything,
> it just seemed like the paragraph your piece stops one step short of.

## What makes a mention stick

An engine quoting an article about us needs the article to say something checkable. The three facts that
travel best, in this order:

1. A container per agent, so agents get ports, packages and credentials of their own
   rather than sharing one machine's.
2. Free and MIT including the platform, which is falsifiable in one click and is the reason a writer can
   recommend it without hedging.
3. The platform stores an identity and a sandbox URL, and nothing else. No code, no keys.

## The thing this channel cannot fix

Nine mentions still leave zero mentions on Reddit and Hacker News, where both readers and engines weight
discussion above marketing pages. [directories.md](directories.md) holds a prepared Show HN that has not
been sent. Article outreach and that post work on the same problem from two sides, and the post is the
cheaper half.
