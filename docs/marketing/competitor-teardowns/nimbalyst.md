# Nimbalyst: marketing teardown

As of 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/nimbalyst/` (file names cited inline as `raw:`). Statements are measured unless marked **Inference**.

Data caveats:

- GitHub's stargazer listing is closed to us in 2026 (REST 404, unauthenticated 401, GraphQL returns no edges), so the star curve comes from Wayback Machine snapshots of the repo page (raw: `wayback-stars-nimbalyst.csv`, `wayback-stars-crystal.csv`).
- GH Archive and OSSInsight undercount badly from mid-2026. Global WatchEvents fell from about 2.9M in Jan 2026 to 80k in Jul 2026 (raw: `gharchive_global_watch_by_month.tsv`), and OSSInsight flags its own data as "severely degraded since 2026-05-01". They are used only for the shape of 2025 spikes.
- Reddit scores come from the arctic-shift archive and may have been captured before voting finished.

## 1. What it is and who is behind it

**Product.** Nimbalyst is a free, MIT-licensed Electron desktop app for macOS, Windows and Linux, plus iOS and Android companion apps. The current README calls it an "Open-source visual workspace for building with Codex, Claude Code, OpenCode, and other coding agents" ([README](https://github.com/nimbalyst/nimbalyst)). It provides WYSIWYG editors for markdown, mockups, Excalidraw, Mermaid, CSV and data models, with red/green diffs of agent edits rendered in place; a kanban board of sessions; git worktrees; a task tracker; an extension SDK; and an MCP client. You bring your own Claude Code or Codex subscription, an API key, or LM Studio ([pricing FAQ](https://nimbalyst.com/pricing/)). In October 2026 the homepage switched its lead to a new product, the **Nimbalyst Wiki**: "a wiki your agents write for you", shipped as a free plugin for Claude Code, Codex, Cowork, Cursor and VS Code that needs no app or account ([nimbalyst.com](https://nimbalyst.com/), repo [nimbalyst/nimbalyst-wiki](https://github.com/nimbalyst/nimbalyst-wiki), created 2026-10-13, 5 stars).

**Company and founders.** Nimbalyst, Inc. was formerly Stravu; the Crunchbase profile still sits at [/organization/stravu](https://www.crunchbase.com/organization/stravu) and the changelog records a "Final Stravu -> Nimbalyst rename" (`/work/refs/nimbalyst/CHANGELOG.md`, release 0.58.x, Apr 2026). Founders, per the [about page](https://nimbalyst.com/about/):

- Karl Wirth, CEO. Founded Evergage (sold to Salesforce in 2020), was SVP Personalization at Salesforce, then CPO and SVP Engineering at Treasure Data. He announced joining "@StravuHQ as co-founder and CEO" around Nov 2024 ([X post](https://x.com/wirthkarl/status/1853544349189206358)).
- Greg Hinkle, CTO. Evergage founder and CTO, later VP Engineering at Salesforce. Top committer (`ghinkle`, 4,920 commits; raw: `contributors.json`).
- Jordan Bentley, co-founder, and the author of Crystal. Listed as a maker on [Product Hunt](https://www.producthunt.com/products/nimbalyst) and on [ClaudeLog](https://claudelog.com/nimbalyst/).

Funding is not disclosed. Crunchbase shows a round with no amount and a 1–10 headcount ([search summary](https://www.crunchbase.com/organization/stravu)); [rywalker.com](https://rywalker.com/research/nimbalyst) also says "not publicly disclosed". LinkedIn has 315 followers ([company page](https://www.linkedin.com/company/nimbalyst)).

**Lineage and launch dates.**

| Date | Event | Source |
|---|---|---|
| 2025-06-12 | Crystal (stravu/crystal), an OSS Electron app for parallel Claude Code sessions in worktrees, first release | [releases](https://github.com/stravu/crystal/releases), raw: `crystal_releases.json` |
| 2025-06-25 | Stravu "Collaborative AI workspace" (editable AI notebooks) enters beta | [r/Stravu](https://www.reddit.com/r/Stravu/comments/1lkl5nn/), HN [44510354](https://news.ycombinator.com/item?id=44510354) |
| 2025-07-23 | Nimbalyst code starts ("Initial start from lexical playground") | `git log` in /work/refs/nimbalyst |
| 2025-10-30 | Public GitHub repo created; it holds binaries only (closed source, free) | [repo](https://github.com/nimbalyst/nimbalyst), HN comment "this is not an open source project" ([46048338](https://news.ycombinator.com/item?id=46048338)) |
| 2025-12-11 | Product Hunt "Nimbalyst Beta" | [PH launches](https://www.producthunt.com/products/nimbalyst/launches) |
| 2026-02-26 | Crystal deprecated; README now reads "Crystal Is Now Nimbalyst" | [stravu/crystal](https://github.com/stravu/crystal) |
| 2026-03-07 | iOS app released | [App Store](https://apps.apple.com/app/id6756393105) |
| 2026-04-29/30 | Source opened under MIT ("oss-prep" commits 04-28/29; [blog post](https://nimbalyst.com/blog/open-sourcing-nimbalyst/)) | git log |
| 2026-09-02/03 | Nimbalyst Teams (multiplayer) | [nimbalyst.com/teams](https://nimbalyst.com/teams/) |
| 2026-10-02 to 10-16 | Nimbalyst Wiki and Wiki Teams | blog posts Oct 2–16 (raw: `blog_posts.csv`) |

**Pricing and business model.** The app and the personal wiki are free for individuals, with "no feature limits, no trial period". Wiki Teams costs $200/user/year and is free during beta ([pricing](https://nimbalyst.com/pricing/)). The September "Teams" plan was renamed to Wiki Teams by Oct 18 ([whichcodingtools PR](https://github.com/benjamincanac/whichcodingtools/pull/225)). The homepage cites logos ("Automattic, Gainsight, Amperity", "Trusted by thousands of builders"); these are unverified.

## 2. Growth curve

**GitHub stars, nimbalyst/nimbalyst** (Wayback anchors measured; month-end values interpolated linearly between anchors):

| Anchor date | Stars | Source |
|---|---|---|
| 2026-03-18 | 79 | Wayback (binary-only repo) |
| 2026-04-30 13:59 UTC | 161 | Wayback, about 20 min after the Show HN |
| 2026-05-02 | 260 | Wayback |
| 2026-05-03 | 280 | Wayback |
| 2026-05-28 | 628 | Wayback |
| 2026-06-01 | 679 | Wayback (/actions page) |
| 2026-07-26 | 1,325 | Wayback (blob page) |
| 2026-09-10 | 1,686 | Wayback |
| 2026-10-03 | 1,828 | Wayback |
| 2026-10-19 | 1,935 | GitHub API (also 311 forks, 13 watchers) |

| Month | Est. gain | Note |
|---|---|---|
| Nov 2025–Apr 2026 | about 160 total | binary-only repo |
| May 2026 | about +505 | open-sourcing month, the largest |
| Jun 2026 | about +355 | steady, about 11.7/day from Jun 1 to Jul 26 |
| Jul 2026 | about +345 | |
| Aug 2026 | about +245 | |
| Sep 2026 | about +200 | Teams launch, no visible bump |
| Oct 1–19 | about +125 | Wiki launch |

**Crystal (stravu/crystal), the predecessor, 3,134 stars today.** Wayback anchors: 3 (2025-06-12), 266 (06-26), 1,817 (09-08), 2,017 (09-30), 2,192 (10-16), 2,597 (12-18), 2,821 (2026-01-29), 2,959 (02-28), 3,032 (04-23). OSSInsight's lower-bound monthly gains: Jun 2025 +215, **Jul +502**, Aug +285, Sep +139, Oct +111, then under +70 a month (raw: `ossinsight-crystal.json`). After the Feb 2026 deprecation Crystal gained only about 175 stars in eight months, and the repo now points its audience at Nimbalyst.

**Downloads (GitHub release assets, all 124 releases since 2025-11-14; raw: `releases_downloads.csv`).** The site's download buttons link straight to GitHub release assets, so these counts cover website downloads too. Downloads are bucketed by the month the release was published.

| Release month | macOS .dmg | Windows .exe (also update payload) | Linux | latest-mac.yml checks | latest.yml (Win) checks |
|---|---|---|---|---|---|
| 2025-11 | 279 | 275 | 273 | 4,626 | 612 |
| 2025-12 | 800 | 538 | 410 | 27,524 | 1,946 |
| 2026-01 | 2,209 | 1,258 | 1,169 | 189,863 | 18,301 |
| 2026-02 | 3,342 | 2,039 | 1,333 | 337,786 | 32,816 |
| 2026-03 | 5,492 | 3,866 | 705 | 724,946 | 84,962 |
| 2026-04 | 3,593 | 3,233 | 694 | 403,634 | 60,120 |
| 2026-05 | 6,491 | 6,457 | 1,721 | 706,848 | 138,778 |
| 2026-06 | 6,029 | 6,819 | 1,989 | 694,403 | 163,564 |
| 2026-07 | 7,021 | 12,616 | 3,008 | 860,228 | 226,714 |
| 2026-08 | 4,615 | 11,509 | 2,097 | 612,034 | 178,089 |
| 2026-09 | 6,204 | 13,184 | 3,158 | 850,428 | 256,099 |
| 2026-10 (to 19th) | 1,812 | 4,348 | 1,145 | 234,126 | 69,709 |
| **Total** | **47,887** | **66,142** | **17,702** | **5.65M** | |

The app checks for updates at launch and then hourly (`packages/electron/src/main/services/autoUpdater.ts`, `startAutoUpdateCheck(intervalMinutes = 60)`). **Inference:** about 850k mac checks a month suggests a few thousand monthly-active mac installs. The usage base is far larger than 1.9k stars would imply. Crystal, by comparison, had 3.1k stars but only 7,282 .dmg downloads (raw: `crystal_releases.json`).

Other counts: Homebrew cask `nimbalyst` 632 installs/365d, 230/90d, 82/30d; `stravu-crystal` 418/365d ([formulae.brew.sh](https://formulae.brew.sh/api/cask/nimbalyst.json)). winget package `Nimbalyst.Nimbalyst` ([PR](https://github.com/microsoft/winget-pkgs/pull/454399)). iOS app: 9 ratings, 4.9 average. The repo's own PostHog write-ups (published in the public repo) report early usage: 4,474 session starts and 434 users who created AI sessions between 2025-11-14 and 2026-01-05 (`posthog-analyses/q01-*.md`, `q04-*.md`).

**Biggest jumps and what matched them.**

1. **Crystal, Jun 19 to Jul 11, 2025.** GH Archive daily WatchEvents (a lower bound) spike on 06-19/20 (16, 23) and 07-10/11 (44, 36). Those days match u/radial_symmetry's (**Inference:** Jordan Bentley, Crystal's author) "I built a UI to manage multiple Claude Code worktree sessions" in r/ChatGPTCoding (06-19, 68 points/23 comments) and "I built a tool to run and manage Claude Code worktrees" in r/ClaudeAI (07-10, 125/47). July 2025 was Crystal's best month. Spikes on 06-23 (45), 07-03 (54) and 07-21 (41) have no HN or Reddit match; **Inference:** X posts or newsletters, which this teardown cannot see.
2. **Open-sourcing, Apr 29–May 31, 2026.** 161 → about 665 stars. That month combined the MIT release, a Show HN (8 points), a Product Hunt launch, several subreddit posts (all 0–3 points) and the redirect of Crystal's 3.1k-star audience. No single post got traction, so **Inference:** the jump came from the open-source news itself plus the existing install base and the Crystal redirect, not from any one launch post.
3. **Jun–Jul 2026, steady at about 12 stars a day.** No launch event matches. **Inference:** compounding search traffic (146 blog posts and more than 300 landing, compare and docs pages; section 9), the [Developers Digest article](https://www.developersdigest.tech/blog/nimbalyst-visual-workspace-codex-claude-code) (about early July), the [Remote Frog review](https://remotefrog.com/2026/06/05/claude-code-is-brilliant-the-terminal-not-so-much-so-nimbalyst-it/) (Jun 5), and organic HN comments recommending it (Jun 27, Jun 29; raw: `hn_comments_nimbalyst.json`). Windows .exe downloads nearly doubled in July (6.8k → 12.6k).
4. **Downloads, Jan–Mar 2026, before open source.** .dmg downloads went 800 → 2.2k → 3.3k → 5.5k a month. This coincides with the start of the ClaudeLog sponsorship (Nimbalyst is absent from claudelog.com on 2026-01-03 and appears 5 times on 02-02 and 17 times on 03-02 in Wayback) and the blog's SEO surge (14 posts in Feb, 29 in Mar). Correlation only.

## 3. Channel inventory

| Channel | Where | Size and activity | Cadence and status |
|---|---|---|---|
| Website, Astro on Cloudflare Pages | [nimbalyst.com](https://nimbalyst.com/) | 480 URLs in the sitemap (raw: `sitemap_urls.txt`) | Rebuilt constantly; sitemap lastmod 2026-10-17 |
| Blog | [/blog](https://nimbalyst.com/blog/), RSS [/rss.xml](https://nimbalyst.com/rss.xml) | 146 posts, 2025-06-03 to 2026-10-16 | Posts per month: Feb 14, **Mar 29**, Apr 19, **May 26**, Jun 8, Jul 5, Aug 13, Sep 3, Oct 8. Active |
| Dev blog | [/dev](https://nimbalyst.com/dev/) | 1 post (2026-02-18) | Abandoned |
| Docs | [docs.nimbalyst.com](https://docs.nimbalyst.com/) (GitBook) plus 110 /docs pages on the site | | Updated with each feature |
| Changelog | GitHub releases, `PUBLIC_RELEASE_NOTES.md`, [/changelog](https://nimbalyst.com/changelog/), [/release-updates](https://nimbalyst.com/release-updates/) | 124 GitHub releases (51 stable, 73 alpha) | About 11 releases a month |
| GitHub org | [github.com/nimbalyst](https://github.com/nimbalyst) | 11 repos: app, wiki, skills (28★), PM commands (54★), dev commands (28★), extensions | Active |
| Discord | [discord.gg/FgD9S2MCYB](https://discord.gg/FgD9S2MCYB) | **923 members, 117 online**; created 2025-10-18. The old Crystal server has 121 members | Active |
| X | [@nimbalyst](https://x.com/nimbalyst), founder [@wirthkarl](https://x.com/wirthkarl) | Not measured (out of scope) | |
| YouTube | [@nimbalyst](https://youtube.com/@nimbalyst) | **386 subscribers**, 30 videos on the Videos tab plus Shorts; best 1.3K views ("I Used Nimbalyst for 13 Minutes (Full Workflow)"); 26 of 30 under 500 (raw: `youtube_videos.csv`, `youtube_feed_latest15.csv`) | Bursts: 2 videos about May 2026, 21 about June, 8 Shorts Jul 29–Aug 5 (39–104 views), 3 on Aug 3, 4 on Aug 31–Sep 2, 1 on Sep 29 |
| LinkedIn | [company](https://www.linkedin.com/company/nimbalyst), [Karl](https://www.linkedin.com/in/karlewirth/) | 315 followers | Low |
| Reddit, own subreddit | r/Nimbalyst | 45 posts by u/StravuKarl, average 1.3 points, max 6 | Daily "Feature Log #nn" and "Workflow of the Day" posts in Jul 2026; dormant since Sep 2 |
| Reddit, founders | u/StravuKarl (88 posts since 2025-06), u/radial_symmetry (Crystal) | See section 4 | Karl's last post is 2026-09-02 |
| Reddit, brand account | u/nimbalyst | 4 profile posts Jan–Feb 2026, 0–1 points | **Inference:** promoted-post (ad) creatives |
| Hacker News | wek (Karl), ghinkle, radial_symmetry, jbentley1 | 25 product submissions, best 29 points | Sporadic |
| Product Hunt | [products/nimbalyst](https://www.producthunt.com/products/nimbalyst) | 61 followers, 3 launches | Each new product identity gets a launch |
| Instagram, TikTok | @nimbalyst (linked in the site footer) | Not measured | Unknown |
| Mobile stores | iOS "Nimbalyst" (id 6756393105, released 2026-03-07, v1.2.1) | 9 ratings, 4.9 | Not on Google Play under `com.nimbalyst.app` (404) |
| Paid sponsorship | [ClaudeLog](https://claudelog.com/nimbalyst/), "ClaudeLog's official sponsor" | UTM `utm_campaign=partner` | Since about Jan/Feb 2026 |
| Newsletter, podcasts, talks | None found | | |
| Localization | None: no i18n READMEs, no hreflang, English-only app | | |

## 4. Launch history

**Hacker News** (every submission found; raw: `hn_launches.csv`):

| Date | Day, UTC | Account | Title (exact) | Points/comments |
|---|---|---|---|---|
| 2025-06-12 | Thu 16:09 | jbentley1 | "Multiple Claude Code Sessions in an Easy UI: Crystal" | 8/6 |
| 2025-06-18 | Wed 13:42 | jbentley1 | "Show HN: I built new type of dev environment for agentic coding" | 6/0 |
| 2025-06-20 | Fri 02:53 | handfuloflight | "Crystal: An IVE: Integrated Vibe Environment" | 2/1 |
| 2025-06-26 | Thu 15:20 | jbentley1 | "Show HN: I built a UI to manage Claude Code worktrees" | 4/0 |
| 2025-07-09 | Wed 14:17 | wek | "Show HN: Stravu – Editable, multi-player AI notebooks with text, tables, diagram" | 11/2 |
| 2025-07-21 | Mon 13:33 | wek | "Show HN: Stravu – Editable AI text, tables, diagrams (also multi-player AI)" | 3/0 |
| 2025-08-06 | Wed 14:40 | jbentley1 | "Crystal: Claude Code Needs an Agent Management Platform, Not an IDE" | 4/1 |
| 2025-08-13 | Wed 13:39 | jbentley1 | "Open Source worktree manager for Claude Code" | 6/1 |
| 2025-08-14 | Thu 12:54 | jbentley1 | "Crystal: Parallel Claude Code Development" | 3/1 |
| 2025-08-15 | Fri 14:40 | jbentley1 | "Claude Code, Diff Viewing, and Testing All on Git Worktrees" | 1/0 |
| 2025-08-18 | Mon 10:17 | moondowner | "Crystal – Multi-Session Claude Code Manager" | 3/0 |
| 2025-08-18 | Mon 15:54 | jbentley1 | "Show HN: We open-sourced our worktree manager for Claude Code" | 1/0 |
| 2025-09-22 | Mon 14:36 | jbentley1 | "Crystal v0.3: Codex support in Git Worktrees" | 9/4 |
| 2025-09-25 | Thu 14:50 | jbentley1 | "A manager for running agents in worktrees" | 3/0 |
| 2025-10-15 | Wed 14:07 | jbentley1 | "Compare Claude Code and Codex with one click" | 1/1 |
| 2025-10-16 | Thu 12:40 | radial_symmetry | "A tool that runs Claude Code and Codex side-by-side in worktrees" | 3/2 |
| 2025-11-25 | Tue 17:41 | wek | "Nimbalyst: WYSIWYG Markdown editor with visual diffs powered by Claude Code" | 5/2 |
| 2025-12-01 | Mon 22:26 | wek | "A complete guide to the best Markdown editors" | 3/0 |
| 2025-12-11 | Thu 16:25 | radial_symmetry | "Show HN: Nimbalyst: local WYSIWYG Markdown/mockup tool powered by Claude Code" | 3/0 |
| 2025-12-15 | Mon 16:41 | lrkwa | "Show HN: Local WYSIWYG Markdown/mockup editor powered by Claude Code – Nimbalyst" | 1/1 |
| 2025-12-18 | Thu 20:26 | wek | "Local WYSIWYG Markdown, mockup, data model editor powered by Claude Code" | **29/5**, the best product post |
| 2026-04-30 | Thu 13:36 | ghinkle | "Show HN: Nimbalyst open-source visual workspace for ClaudeCode, Codex, OpenCode" | 8/4 |
| 2026-05-12 | Tue 13:38 | wek | "Show HN: Nimbalyst open source Obsidian, Codex app, and Linear for coding agents" | 7/1 |
| 2026-05-26 | Tue 13:23 | wek | "Building the harness around our coding agents. Eight failure modes and pillars" | 3/0 |
| 2026-09-02 | Wed 14:23 | wek | "Multiplayer for Claude Code and Codex" | 1/0 |

**Product Hunt** ([launches](https://www.producthunt.com/products/nimbalyst/launches)), all on Thursdays:

| Date | Tagline (exact) | Result |
|---|---|---|
| 2025-12-11 | "Local, WYSIWYG markdown and mockup editor for Claude Code" ("Nimbalyst Beta") | 90 upvotes, 17 comments, #22 of the day (hunted.space data as returned by a search engine; [hunted.space](https://hunted.space/product/nimbalyst)) |
| 2026-04-30 | "Open-source workspace for building with Codex & Claude Code" | Votes not retrievable; not in the rendered top of the [Apr 30 leaderboard](https://www.producthunt.com/leaderboard/daily/2026/4/30/all) |
| 2026-09-03 | "Multiplayer for Claude Code and Codex" ("Nimbalyst Teams") | **3 upvotes, 1 comment, #81, not featured** ([hunted.space](https://hunted.space/dashboard/nimbalyst)) |

**Reddit** (main attempts; all 117 rows from founder, brand and third-party accounts in raw: `reddit_posts.csv`):

| Date | Day, UTC | Sub | Title (exact) | Score/comments |
|---|---|---|---|---|
| 2025-06-19 | Thu 12:25–12:28 | r/ChatGPTCoding | "A full UI for managing parallel Claude Code worktree sessions", then "I built a full UI for managing Claude Code worktree sessions" twice | 1/0, 1/0, 0/3 (reposted within 3 minutes) |
| 2025-06-19 | Thu 12:36 | r/ChatGPTCoding | "I built a UI to manage multiple Claude Code worktree sessions" | **68/23** |
| 2025-06-26 | Thu 15:33 | r/ClaudeCode | "I built a UI to manage multiple Claude Code worktree sessions" | 20/10 |
| 2025-06-26 | Thu 15:54 | r/ClaudeAI | "I built a dev env around managing Claude Code worktree sessions" | 8/9 |
| 2025-07-10 | Thu 14:53–14:55 | r/Anthropic, r/ClaudeAI | "I built a tool to run and manage Claude Code worktrees" | 26/5, **125/47** |
| 2025-09-22 | Mon 14:38–14:41 | r/ChatGPTCoding, r/ClaudeCode, r/codex | "Crystal v0.3: Codex support in isolated Git worktrees" and variants | 15/1, 17/4, 16/9 |
| 2025-10-14 | Tue 14:45 | r/ProductManagement | "How are you using Claude Code in your Product Management work?" | **43/32** |
| 2025-10-16 | Thu 13:05–13:08 | 7 subs | "Compare Claude Code and Codex from one prompt" | 0–2 each |
| 2025-11-13 | Thu 17:52 | r/ProductManagement | "Let's collaborate on a /plan command to have Claude Code assist us in Feature Planning and PRDs" | **39/30** |
| 2025-12-02 | Tue 16:09–18:58 | r/Markdown (4 posts) | "Feedback on Nimbalyst Alpha: Local, AI-First, WYSIWYG Markdown Editor" and variants | 0–1 each |
| 2025-12-06 | Sat 16:19/17:00 | r/ClaudeCode, r/ClaudeAI | "Nimbalyst: UI for Claude Code + Markdown Editor + Session Manager" | 1/0, 1/1 |
| 2025-12-11 | Thu 17:38 | r/BMAD_Method | "UI for BMAD with Claude Code. WYSIWYG markdown editor. Session Management" | 15/3 |
| 2026-04-30 | Thu 15:09 / 21:51 | r/ClaudeCode, r/codex | "We open-sourced Nimbalyst: a visual workspace for Claude Code, Codex, Opencode, etc" | 1/0, 0/0 |
| 2026-05-04 to 05-07 | Mon–Thu | r/opensource (x2), r/ArtificialInteligence, r/opencode | "Open source visual editor and session manager to increase bandwidth while working with Claude C…" | 1–3 each |
| 2026-06-27 | Sat 16:28 | r/ClaudeAI (third party, u/fagnerbrack) | "Nimbalyst: Visual Editor for Claude Code & Codex (Open Source)" | 5/0 |
| 2026-09-02 | Wed 15:49 | r/ClaudeAI | "We made Claude Code multiplayer: two people, two local agents, one live document." | 1/2 |

Titles naming Nimbalyst in r/ClaudeAI (all time) and r/ClaudeCode (since Nov 2025) come only from the founders and one prolific link poster, u/fagnerbrack (2026-06-08 r/ClaudeCode 1/2; 2026-06-27 r/ClaudeAI 5/0). No organic third-party launch thread was found in those subreddits. Searches in the other subreddits were still rate-limited by the archive when this was written.

## 5. Content patterns

- **First-person build posts with a demo video.** Crystal's Reddit titles all begin "I built a UI/tool/dev env to manage…" and name the job concretely: "multiple Claude Code worktree sessions". The README led with a video from 2025-07-10 ("Replace screenshots with video in README" in [Crystal's README history](https://github.com/stravu/crystal/commits/main/README.md)).
- **SEO listicles and comparisons, at scale.** Most of the 146 blog posts are search-shaped: "Best Claude Code GUI in 2026: 5 Tools Compared", "Best Conductor Alternatives 2026: Windows, Linux, and Open Source", "Vibe Kanban After Bloop: What Happens to Users, and Where to Go", "OpenCode vs Codex (2026)". There are 45 /compare pages, among them [nimbalyst-vs-conductor](https://nimbalyst.com/compare/nimbalyst-vs-conductor/), [nimbalyst-vs-vibe-kanban](https://nimbalyst.com/compare/nimbalyst-vs-vibe-kanban/), [nimbalyst-vs-openwork-vs-paseo](https://nimbalyst.com/compare/nimbalyst-vs-openwork-vs-paseo/) and [nimbalyst-vs-superconductor-vs-conductor](https://nimbalyst.com/compare/nimbalyst-vs-superconductor-vs-conductor/). About 30 root-level keyword pages exist too ([claude-code-gui](https://nimbalyst.com/claude-code-gui/), [codex-gui](https://nimbalyst.com/codex-gui/), [conductor-for-windows-and-linux](https://nimbalyst.com/conductor-for-windows-and-linux/), [crystal](https://nimbalyst.com/crystal/), plus vertical pages such as [coding-agents-for-hedge-funds](https://nimbalyst.com/coding-agents-for-hedge-funds/) and [research](https://nimbalyst.com/research/)), along with 34 use-case pages and 38 skill pages. Competitor pages open by conceding the competitor's strength before naming a gap. The Conductor page says: "Conductor is a well-made macOS app… Its own installation documentation says it is available for macOS and not available for Windows or Linux yet."
- **News-jacking.** Posts follow the news within days: "Cursor Just Picked a Side: What the SpaceX Deal Means for AI Coding" (2026-04-22, same week as the deal), "Vibe Kanban After Bloop" (05-04), "Karpathy's LLM Wiki: Have Your Agents Write One for You and Your Team" (10-07). Karl also dropped product mentions into big HN threads, such as the SpaceX/Cursor thread on 2026-04-22: "Consider Nimbalyst, its a free visual workspace…".
- **Manifesto and founder voice.** The about page ("The future is small nimble teams", "Six beliefs") and posts like "Humans Are Visual. Enough With the Terminal." and "The Terminal: A 1970s UI for a 2026 Problem". Every blog post carries Karl Wirth's byline with schema.org `sameAs` links to X and LinkedIn.
- **Free artifacts as lead magnets.** [product-manager-claude-code-commands](https://github.com/nimbalyst/product-manager-claude-code-commands) (54★, created 2025-10-28, two weeks after the PM survey post), developer commands (28★), [skills](https://github.com/nimbalyst/skills) (28★), and [wrapped](https://github.com/nimbalyst/wrapped) ("Your Agents, Wrapped plus a Grader report", 2★).
- **Thought-leadership benchmarks.** [Agent Harness Benchmark Protocol](https://nimbalyst.com/harness/benchmark/) and "8 Pillars of a Coding Agent Harness" (blog, video, HN, Reddit).
- **Short tutorial videos and serialized feature posts.** YouTube titles mirror search queries ("A Kanban Board for Claude Code and Codex Sessions", 699 views; "Run 5 Codex Agents in Parallel with Git Worktrees", 295). On r/Nimbalyst the same features ran as "Feature Log #01–#07" and "Workflow of the Day".
- **Automated asset pipeline.** A Playwright system renders marketing screenshots and videos from the real app with fake data and a fake cursor (`docs/MARKETING_SCREENSHOTS.md`), and agents write docs, site YAML and blog drafts ([How We Automated Software-to-Marketing](https://nimbalyst.com/blog/how-we-automated-the-software-to-marketing-pipeline/), 2026-02-26). **Inference:** this pipeline explains the blog's pace (29 posts in Mar 2026, published on all seven weekdays).
- **Copy register.** Headlines are benefit-and-pain framed and the vocabulary is "bandwidth" and "context". Examples: "Overwhelmed and disorganized by Codex and Claude Code?" (homepage, Oct 2026); "Stop editing in one place and working with your coding agents in another" (Aug 2026); "Crystal lets you use AI on isolated copies of your code so you can work on multiple tasks instead of waiting for your agents to finish" (Crystal README, Oct 2025).

## 6. What resonated

| # | Content | Date | Engagement | Why it likely worked (inference) |
|---|---|---|---|---|
| 1 | r/ClaudeAI "I built a tool to run and manage Claude Code worktrees" ([link](https://www.reddit.com/r/ClaudeAI/comments/1lwet1z/)) | 2025-07-10 | 125 points, 47 comments; Crystal's best star month | Early in the parallel-worktree wave; first person, OSS, a concrete job in the title, and the founder answering in the comments |
| 2 | r/ChatGPTCoding "I built a UI to manage multiple Claude Code worktree sessions" ([link](https://www.reddit.com/r/ChatGPTCoding/comments/1lf9q07/)) | 2025-06-19 | 68/23; GH Archive star spike the same day | Same pattern; it was the fourth attempt in 11 minutes (third distinct title) |
| 3 | r/ProductManagement "How are you using Claude Code in your Product Management work?" ([link](https://www.reddit.com/r/ProductManagement/comments/1o6hgqb/)) | 2025-10-14 | 43/32 | A question, not a pitch, aimed at an underserved role community; it produced the PM commands repo and blog series |
| 4 | r/ProductManagement "Let's collaborate on a /plan command…" ([link](https://www.reddit.com/r/ProductManagement/comments/1ow7ue8/)) | 2025-11-13 | 39/30 | Offers a free artifact and invites co-creation. `/plan` later became 70.7% of slash-command use in the app (`posthog-analyses/q12-*.md`) |
| 5 | Product Hunt "Nimbalyst Beta" | 2025-12-11 | 90 upvotes, 17 comments, #22 | The founders' Evergage/Salesforce credibility and a concrete visual hook ("WYSIWYG markdown and mockup editor for Claude Code") |
| 6 | HN "Local WYSIWYG Markdown, mockup, data model editor powered by Claude Code" ([link](https://news.ycombinator.com/item?id=46318191)) | 2025-12-18, Thu 20:26 | 29/5 | The third submission of this pitch in 8 days; specific nouns rather than category words |

Outside product content, Karl's HN submissions of arXiv papers on coding agents reached the front page: "Constraint Decay…" 287 points (2026-05-24), "An empirical study of harness design for coding agents" 225 (2026-09-18), "Speed at the cost of quality: Study of use of Cursor AI…" 148 (2026-03-16) (raw: `hn_author_wek.json`). His HN profile says "Co-founder of Nimbalyst". **Inference:** this buys karma and some name exposure but has not lifted product posts, none of which went past 29 points.

## 7. What did not work

- **Teams launch, Sep 2–3, 2026.** HN 1 point, Product Hunt 3 upvotes (#81, not featured), r/ClaudeAI 1 point, YouTube Teams videos at 90–224 views, no visible star bump. About six weeks later the plan was renamed and folded into "Wiki Teams".
- **Open-source launch posts.** Show HN got 8 points, the repost on 05-12 got 7, and the Reddit posts in r/ClaudeCode, r/codex and r/opensource got 0–3. The open-source news still moved stars (section 2), so the posts failed but the event did not.
- **Repost and cross-post blasts.** Team accounts submitted Crystal to HN 12 times in four months (jbentley1 11, radial_symmetry 1; max 9 points), including four submissions between Aug 13 and 18, 2025 (6, 3, 1, 1). jbentley1's "We open-sourced our worktree manager" wording marks it as a team account. "Compare Claude Code and Codex from one prompt" went to 7 subreddits in 3 minutes on 2025-10-16 for 0–2 points each. Four near-identical r/Markdown posts on 2025-12-02 drew 0–1 each. The Dec 2025 Show HN was submitted by three accounts (radial_symmetry, lrkwa, wek) within 8 days.
- **Owned-subreddit content.** 45 r/Nimbalyst posts averaged 1.3 points. The series has been dormant since Sep 2.
- **"Open" before open source.** On 2025-11-25 an HN commenter wrote: "there are a couple of screenshots in this repo, but no code. This is not an open source project." Karl replied: "Yes, Nimbalyst is closed source. It is a free download." ([thread](https://news.ycombinator.com/item?id=46048338)). The binary-only repo collected 79 stars in 4.5 months.
- **Messaging churn.** Homepage H1 by Wayback snapshot (raw: `homepage_history.txt`):
  - Nov 2025: "an integrated markdown environment for managing Claude Code"
  - Dec 2025: "Nimbalyst gets you the best results with Claude Code"
  - Jan 2026: "A Better Way to Work with Claude Code"
  - Feb 2026: "The Best Way to Work with Claude Code"
  - Mar 2026: "Agent-native visual workspace for builders"
  - Apr 2026: "The visual workspace for building with Codex and Claude Code"
  - May 2026: "The open-source visual workspace for building with Codex, Claude Code, and more"
  - Aug 2026: "Stop editing in one place and working with your coding agents in another"
  - Sep 2026: "The visual workspace for Codex and Claude Code"
  - Oct 2026: "Overwhelmed and disorganized by Codex and Claude Code?" with the title now "Agent Wiki and Workspace"

  That is ten headlines in twelve months. The README pitch moved the same way: "AI-native markdown workspace for teams" (Oct 2025), then "humans and AI agents collaborate through rich, specialized editors" (Jan 2026), then "for developers, product managers, designers, builders" (Jul 2026), then "Codex, Claude Code, OpenCode, and other coding agents" (now). The audience swung between PMs and developers. The company has shipped three product identities in 16 months (Stravu notebooks, Crystal, Nimbalyst), and Nimbalyst itself went from editor to workspace to Teams to Wiki.
- **Abandoned or weak channels.** Stravu's AI notebook (Show HN 11 and 3 points, beta-tester subs at 1 point) was dropped. The dev blog stopped after one post. Wrapped got 2★ and its page is now excluded in robots.txt. The u/nimbalyst profile posts scored 0–1. 13 of the 30 videos on the YouTube Videos tab have under 100 views.
- **Product signal from their own analytics.** Only 0.53% of AI messages used slash commands (`posthog-analyses/q12-*.md`). The early walkthrough came after the first AI session for 99.5% of users, so onboarding did not drive activation (`q01-*.md`).

## 8. Timing

- **HN.** 20 of 25 submissions were posted 12:40–17:41 UTC (8:40am–1:40pm US Eastern), Monday to Thursday. The best product post was the outlier at Thu 20:26 UTC. Scores are too small to show any timing effect.
- **Reddit.** Both Crystal hits went up on Thursdays, 12:36 and 14:55 UTC. Karl's two PM hits went up Tue 14:45 and Thu 17:52 UTC. The flops spread across all days, so timing does not explain them; title type does (section 6).
- **Product Hunt.** All three launches on Thursdays.
- **Blog.** Posts land every day of the week: Wed 30, Tue 27, Mon 24, Fri 21, Thu 16, Sat 16, Sun 12. Output comes in bursts (Mar–May 2026, then the Oct 2026 wiki series).
- **Releases.** 124 GitHub releases between 2025-11-14 and 2026-10-16, about 11 a month (51 stable, 73 alpha). Stable releases usually ship Fri (13), Wed (11) or Thu (9), most often 17:00–19:00 UTC. Local git tags peaked at 78 in Feb 2026 (raw: `tags_dates.txt`). v0.81.7 reached Homebrew and winget the same day it shipped (both PRs dated 2026-10-16).
- **News-driven timing.** Launches and posts cluster around external events: the open-sourcing landed a week after the SpaceX/Cursor news, and Karl announced it in that HN thread ("And as of today Nimbalyst is open source!", 2026-04-30), and the wiki series rides Karpathy's LLM-wiki idea.

## 9. Community and distribution mechanics

- **Predecessor redirect.** Crystal's 3,134-star README is now a Nimbalyst landing page ("Crystal Is Now Nimbalyst", with download, docs and GitHub links and a migration FAQ). [nimbalyst.com/crystal](https://nimbalyst.com/crystal/) keeps the Crystal search term alive, and the app tracked users who arrived from Crystal ("Track users who have opened from Crystal", CHANGELOG 0.45.35, 2025-11-20).
- **In-app community prompt.** A popup with Discord, LinkedIn, YouTube and X appears after 3 completed agent sessions that used tools, or after 5 launches, until dismissed (`shouldShowCommunityPopup()` in `packages/electron/src/main/utils/store.ts`). The Help menu also links Discord. Discord stands at 923 members.
- **Open-source contribution funnel.** 52 contributors, 443 PRs (258 merged) and 1,348 issues (GitHub search API). The README routes people to Discussions, a public roadmap (GitHub Project views for "Community" and "Good first issues"), and says "We rank features and bugs by 👍 reactions". An extension SDK has drawn third-party extensions and forks (terraphim/nimbalyst-terraphim, Firework-Labs/nimbalyst-mr-projects, theme repos); see raw: `gh_search_issues.json`. The team publishes niche extensions as demos: [electronics/PCB](https://github.com/nimbalyst/nimbalyst-electronics), [Replicad CAD](https://github.com/nimbalyst/nimbalyst-replicad), [Jupyter](https://github.com/nimbalyst/nimbalyst-jupyter).
- **Paid placement on a community docs site.** ClaudeLog's official sponsor, with a full [vendor page](https://claudelog.com/nimbalyst/) and UTM `utm_campaign=partner`, since about Jan/Feb 2026.
- **Lists and directories.** [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) lists Nimbalyst. Crystal is in [jqueryscript/awesome-claude-code](https://github.com/jqueryscript/awesome-claude-code), [milisp/awesome-codex-cli](https://github.com/milisp/awesome-codex-cli) and ai-for-developers/awesome-ai-coding-tools. Directory listings: [G2](https://www.g2.com/sellers/nimbalyst) (0 reviews), [StackShare](https://stackshare.io/nimbalyst-visual-workspace-for-claude-code-codex), [AlternativeTo](https://alternativeto.net/software/nimbalyst), [ai-tldr.dev](https://ai-tldr.dev/tools/nimbalyst/), explainx.ai, whichcodingtools. Package managers: Homebrew, winget, agents.nix.
- **SEO and GEO.** 480 indexed URLs, 45 compare pages and keyword pages aimed at competitor gaps. robots.txt explicitly allows GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot, anthropic-ai, Applebot-Extended and Google-Extended "for citations". Author schema carries `sameAs` links. The blog cross-links heavily, with about 30 internal links in the open-source post.
- **Free tier as marketing.** Everything is free for individuals and AI access is BYO. Money comes only from team sharing (Wiki Teams). The wiki plugin ("No app, no account and no credit card") is a new top-of-funnel that does not require installing the app.
- **Integrations as reach.** The product supports Claude Code, Codex, OpenCode (with an [opencode-plugin package](https://github.com/nimbalyst/nimbalyst/tree/main/packages)), Copilot and Gemini, and launches get posted into each agent's subreddit (r/codex, r/opencode, r/BMAD_Method, r/speckit).
- **Transparency.** The public repo includes the internal PostHog analyses and dashboard rules (`posthog-analyses/`, `docs/WEEKLY_DASHBOARD.md`).

## 10. Lessons for intentic

1. **First-person Reddit build posts beat HN for this category.** Across 25 HN submissions Nimbalyst and Crystal never passed 29 points. Two Thursday Reddit posts with demo videos ("I built a UI to manage multiple Claude Code worktree sessions", 68/23; "I built a tool to run and manage Claude Code worktrees", 125/47) produced Crystal's only clear star spikes. For intentic: write one "I built…" post per major capability (phones, hosted sandboxes, parallel agents), with a 30-second video, in r/ClaudeAI and r/ClaudeCode, and post it once.
2. **Questions in role communities outperform product posts 10–40x.** Karl's r/ProductManagement survey and his "/plan" co-creation post (43/32 and 39/30) beat his own product posts (0–3). Ask a real question in a community intentic serves, then turn the answers into a free artifact such as a commands or skills repo.
3. **Build the comparison and alternative pages before a competitor writes them about you.** Nimbalyst already ranks pages against Conductor ("Conductor is Mac only…"), Vibe Kanban, Paseo, OpenWork and Superconductor. They are produced by an agent pipeline: 146 posts and more than 300 landing pages in 16 months. intentic's distinct facts (reachable from any browser or phone, hosted or own-machine sandboxes, BYO Claude/Codex/Grok) are exactly what Nimbalyst, a desktop-only Electron app, cannot claim. A "Nimbalyst alternative / works from your phone and browser" page is an open slot today.
4. **Keep one category phrase.** Ten homepage H1s in twelve months, plus Teams, Wrapped and Wiki launches each under a new identity, coincided (correlation only) with a falling star rate, about +505 in May to about +200 in Sep, and with flat launches (Teams: 3 PH upvotes). intentic should pick its noun phrase and keep it through at least three release cycles.
5. **Measure installs and active use, not stars.** Nimbalyst has 1.9k stars but 47.9k mac .dmg and 66k Windows .exe downloads and about 850k mac update checks a month. Linking downloads to GitHub release assets gives a free public counter. intentic should publish one clear usage number per launch and track it monthly.
6. **Turn every user into a community member at the moment of success.** The popup after 3 successful agent sessions (or 5 launches) helped build a 923-member Discord for a 1.9k-star repo. intentic can trigger the same prompt after a user's first finished parallel run, and once more from the phone.
7. **Sponsor the community docs hub.** The ClaudeLog sponsorship began between Jan 3 and Feb 2, 2026, and .dmg downloads went 2.2k → 3.3k → 5.5k a month over Jan–Mar (correlation, not proven cause). A permanent vendor page on the site Claude Code users already read is cheap, durable, high-intent placement.
8. **Re-launch on a real event, never on a repost.** The open-source change moved stars (79 → about 665 in about six weeks) while every post announcing it scored under 10. Repeated submissions of the same pitch (12 HN posts for Crystal, a 7-subreddit blast) produced nothing. Save launches for capability changes and announce each once per channel.

## X handles discovered

- [@nimbalyst](https://x.com/nimbalyst): company (site footer, `twitter:site`)
- [@wirthkarl](https://x.com/wirthkarl): Karl Wirth, CEO (blog author schema `sameAs`)
- [@StravuHQ](https://x.com/StravuHQ): legacy Stravu account (mentioned in Karl's Nov 2024 post)
- No X handles were found for Greg Hinkle or Jordan Bentley. Their other public handles: GitHub `ghinkle` and HN `ghinkle` (CTO); Reddit and HN `radial_symmetry` (Crystal author, **Inference** from "I built" Crystal posts); GitHub `jordan-BAIC` (second-largest committer). HN `wek` and Reddit u/StravuKarl are Karl Wirth.
