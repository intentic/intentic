# Conductor (conductor.build): marketing teardown

Research date: 19 October 2026. Raw data: `/work/.intentic/local/tmp/mkt-research/conductor/` (HN JSON, changelog sitemap, Wayback homepage and pricing snapshots, Discord, Homebrew, YouTube feed, blog copies). X/Twitter was covered by a separate researcher. This file only lists the handles found.

Conventions: numbers come from the linked source on the research date. Lines starting **Inference:** are my reading of the evidence, not measurements.

## 1. What it is and who is behind it

| Item | Fact | Source |
| --- | --- | --- |
| Product | Mac app that runs Claude Code, Codex, Cursor and OpenCode agents in parallel, each in an isolated git worktree, with diff review, PRs and merge. Since 30 Jul 2026 also Conductor Cloud (Firecracker microVM sandboxes), multiplayer workspaces, an API and an MCP server. IOS app since 2 Oct 2026. | [homepage](https://www.conductor.build/), [0.78.0 Introducing Conductor Cloud](https://www.conductor.build/changelog/0.78.0-introducing-conductor-cloud), [0.90.0 Conductor for iOS](https://www.conductor.build/changelog/0.90.0-conductor-for-ios) |
| Current headline | "Run a team of coding agents in the cloud." / "Trusted by 100k+ builders" | [homepage](https://www.conductor.build/) |
| Company | Melty Labs (App Store seller "Melty, Inc."), San Francisco | [footer © 2026 Melty Labs](https://www.conductor.build/join-us), [App Store](https://apps.apple.com/us/app/conductor-build/id6791228564) |
| Founders | Charlie Holtz (CEO, led growth at Replicate, before that quant dev at Point72) and Jackson de Campos (CTO, ML infrastructure at Netflix). Met at Brown. Team page lists 7 people. | [YC profile](https://www.ycombinator.com/companies/conductor), [join-us/team](https://www.conductor.build/join-us#our-team) |
| YC batch | Summer 2024 (S24). Same company previously launched Melty (open-source AI editor) on YC Launches. | [YC profile](https://www.ycombinator.com/companies/conductor) |
| Funding | Seed led by Ilya Sukhar (Matrix). $22M Series A from Spark (Nabeel Hyatt) and Matrix, announced 30–31 Mar 2026, with YC and "founders of Notion and Linear". Hiring page says "$24M" raised in total. | [Series A post](https://www.conductor.build/blog/series-a), [Charlie's tweet](https://x.com/charlieholtz/status/2039027121901957349), [join-us](https://www.conductor.build/join-us) |
| Acquisition | "cmd joins Conductor" (2 Apr 2026): Guillaume Sabran, ex-Airbnb staff iOS engineer, found via their feedback portal as an early power user. | [blog](https://www.conductor.build/blog/cmd-joins-conductor) |
| Launch date | 17 Jul 2025 (launch tweet 15:36 UTC, Show HN 15:43 UTC). First changelog entry 0.0.16 on 18 Jul 2025. | [HN 44594584](https://news.ycombinator.com/item?id=44594584), [changelog sitemap](https://www.conductor.build/sitemap.xml) |
| Earlier products by the same team | Melty, open-source AI code editor (repo created 2 Sep 2024, 5,462 stars). Bartleby (Dec 2024, 1 HN point). Chorus, "a Mac app that lets you chat with a bunch of AIs at once" (Show HN 29 Dec 2024, 139 points, open-sourced Dec 2025, 776 stars). | [meltylabs/melty](https://github.com/meltylabs/melty), [Chorus Show HN](https://news.ycombinator.com/item?id=42543601), [meltylabs/chorus](https://github.com/meltylabs/chorus) |
| Open source | Closed source. Public repos are only `conductor-releases` (issues), `homebrew-tap`, `conductor-tutorial` and `Starter-Project`. AlternativeTo lists it as proprietary. | [github.com/meltylabs](https://github.com/meltylabs), [AlternativeTo](https://alternativeto.net/software/conductor/about) |
| How it calls Claude | Through the Claude Agent SDK, which is why Anthropic's 2026 subscription policy applied to it. | [Claude subscription update](https://www.conductor.build/blog/claude-subscription-update) |

### Pricing history

| Period | Model | Source |
| --- | --- | --- |
| Jul 2025 – Jul 2026 | Free. "It's free—we use your existing Claude Code login." BYO Claude Pro/Max or API key. | [YC launch post](https://www.ycombinator.com/launches/OHk-conductor-run-a-bunch-of-claude-codes-in-parallel), [Wayback homepage 17 Jul 2025](http://web.archive.org/web/20250717184421/https://conductor.build/) |
| 30 Jul 2026 → | Free (local Mac workspaces, BYO subscriptions and keys), Pro $50/mo (Conductor Cloud "and a bunch of cloud workspace hours", multiplayer, API, mobile), Teams $60/user/mo, Enterprise custom. First Wayback capture of /pricing is 31 Jul 2026. Unchanged on 25 Sep 2026 apart from "Collab with up to 5 Pro users". | [pricing](https://www.conductor.build/pricing), [Wayback 31 Jul 2026](http://web.archive.org/web/20260731062823/https://conductor.build/pricing) |

**Inference:** the business model is "local orchestration free forever, charge for cloud compute and collaboration". The free local app brought in users for 12 months before anything was sold.

## 2. Growth curve

Conductor has no public repo, so there is no star curve. The proxies below are all that is measurable from outside.

| Metric | Value | Date / window | Source |
| --- | --- | --- | --- |
| Homebrew cask `conductor` installs | 5,832 (365 d), 1,030 (90 d), 317 (30 d) | to 19 Oct 2026 | [formulae.brew.sh](https://formulae.brew.sh/api/cask/conductor.json) |
| Discord members | 2,054 (299 online). Server created 10 Jun 2026 | 19 Oct 2026 | invite `RSrYmstWzy` API |
| LinkedIn followers | 4,149 | 19 Oct 2026 | [LinkedIn](https://www.linkedin.com/company/conductor-build) |
| Product Hunt | 394 followers, 23 reviews | 19 Oct 2026 | [PH](https://www.producthunt.com/products/conductor-aa77ddef-e6d3-4805-a179-7b2e17b6e22e) |
| iOS app | 10 US ratings, 4.8. Released 14 Sep 2026 | 19 Oct 2026 | iTunes Search API |
| Self-reported growth | "enormous user growth (10x since January)" | 30 Mar 2026 | [Series A post](https://www.conductor.build/blog/series-a) |
| Self-reported users | "Trusted by 100k+ builders" (first seen on homepage capture of 7 Aug 2026) | Aug 2026 → | [Wayback 7 Aug 2026](http://web.archive.org/web/20260807003430/https://conductor.build/) |
| HN comments linking conductor.build | 49 comments. Most in Feb 2026 (8), Apr 2026 (6), Jun 2026 (5), Aug 2025 (5) | Jul 2025 – Oct 2026 | Algolia `query=conductor.build&tags=comment` (`hn_comments_domain.json`) |

**Inference on Homebrew:** 5,832 installs over 365 days averages ~485/month, while the last 90 days average ~343/month and the last 30 days 317. Either growth has moved to the DMG and the cloud product, or new installs of the local app have flattened since the summer. Homebrew users are a small and mostly technical subset, so treat it as a trend line only.

### Biggest growth events (dated, with how each was matched)

| # | Window | Event | Evidence and matching |
| --- | --- | --- | --- |
| 1 | 17–21 Jul 2025 | Launch: tweet + Show HN | HN 228 points / 115 comments. Only 10 comments on launch day. 88 comments on 20–21 Jul, starting Sun 20 Jul 18:00 UTC, so the thread reached the front page a second time three days later (comment timestamps in `hn_item_44594584.json`). |
| 2 | 26–27 Aug 2025 | Launch video + Product Hunt | "Introducing Conductor" on Charlie's personal YouTube, 26 Aug 2025, [62,183 views](https://www.youtube.com/watch?v=VsWWy2kVpa8). PH launch next day, #7 of the day. |
| 3 | Oct–Nov 2025 | Codex support and the Simon Willison mention | 0.18.0 "Codex" shipped 31 Oct 2025 ([changelog](https://www.conductor.build/changelog/0.18.0-codex)). The homepage headline changed from "Run a bunch of Claude Codes in parallel" to "Run a team of coding agents on your Mac… parallel Codex + Claude Code agents" in the first Wayback capture after that release (4 Nov 2025). Simon Willison wrote on HN on 9 Oct 2025: "I'm trying out Conductor right now… a pretty slick macOS desktop app" ([comment](https://news.ycombinator.com/item?id=45531558)). |
| 4 | Jan–Mar 2026 | "10x since January" | Coincides with Garry Tan's gstack README recommending Conductor from 13 Mar 2026 (first README commit with "Conductor" is `f7b95329`, 13 Mar, the repo has 136,914 stars) ([gstack README](https://github.com/garrytan/gstack#readme)). The Mastra "Agents Hour" episode of 16 Feb 2026 ([4,079 views](https://www.youtube.com/watch?v=tSoHkOzI4To)). And the peak month of HN word-of-mouth (Feb 2026). Matched by date only. |
| 5 | May–Jun 2026 | YC video distribution | "Conductor is The Tool the Best Engineers Are Using Right Now" (YC Root Access, 8 May 2026, [13,849 views](https://www.youtube.com/watch?v=u2z44EkIEHE)). "Conductor CEO Charlie Holtz Walks Us Through His AI Coding Setup", first episode of YC's *Full Stack* with Garry Tan (4 Jun 2026, [308,761 views](https://www.youtube.com/watch?v=fQmlML9Lay4)). |
| 6 | 30 Jul 2026 → | Cloud + pricing launch | "100k+ builders" appears on the homepage in the first capture after the Cloud launch (7 Aug 2026). Third-party press: [RuntimeWire](https://runtimewire.com/article/conductor-launches-multiplayer-cloud-workspaces-coding-agents). |

**Inference:** Conductor's step changes line up with borrowed distribution (YC, Garry Tan, Simon Willison, podcasts) and with expanding agent support, not with its own posting. Its own channels after launch week were small.

## 3. Channel inventory

| Channel | Where | Measured activity | Status now |
| --- | --- | --- | --- |
| Changelog | [conductor.build/changelog](https://www.conductor.build/changelog) | 207 entries, 18 Jul 2025 – 15 Oct 2026 (≈13.8/month). Per month: Jul 9, Aug 12, Sep 17, Oct 19, Nov 17, Dec 26, Jan 20, Feb 17, Mar 12, Apr 6, May 10, Jun 10, Jul 11, Aug 6, Sep 13, Oct 2 (to 15 Oct). Each entry has its own URL in the sitemap. | Active. The main owned channel. |
| Blog | [conductor.build/blog](https://www.conductor.build/blog) | 4 posts in 2026: Series A (30 Mar), cmd (2 Apr), Claude subscription update (15 Jun), Sign in with ChatGPT (29 Sep). Earlier posts lived on blog.conductor.build ("How to Checkpoint", Dec 2025), which no longer resolves. | Low cadence. Announcements only. |
| Docs | [conductor.build/docs](https://www.conductor.build/docs) | 68 doc URLs, including guides titled like search queries: "Run Claude Code with Git worktrees", "Run multiple Claude Code / Codex / Cursor sessions", "Migrate from Cursor". | Active. Also the main SEO pages. |
| X | @conductor_build, @charlieholtz, @jacksondecampos | Covered by the X researcher. Launch, Series A and policy news broke on X first (tweet IDs decoded: launch 17 Jul 2025 15:36 UTC, Series A 31 Mar 2026 17:08 UTC, Anthropic delay 15 Jun 2026 23:04 UTC). | Primary channel (per timing of announcements). |
| YouTube (own) | [@conductor_build](https://www.youtube.com/@conductor_build) | 15 short feature clips, 6 Jul – 31 Aug 2026, 518–1,642 views each (RSS feed). | Dormant since 31 Aug 2026. |
| YouTube (founder) | Charlie Holtz's channel | "Introducing Conductor", 26 Aug 2025, 62,183 views. | Single upload. |
| Third-party video/podcasts | YC, Mastra, others | YC *Full Stack* 308,761 views. YC Root Access 13,849. *Show Me Your Stack* ep. 5 [9,481](https://www.youtube.com/watch?v=KS4OlSyfGDU). Mastra Agents Hour Feb 2026 4,079 and Sep 2026 [1,077](https://www.youtube.com/watch?v=KHSrSzZs7ng). AI Engineer podcast ([BigGo summary](https://finance.biggo.com/news/0ee50e95347f903d)). | The strongest reach channel. |
| Discord | [discord.gg/RSrYmstWzy](https://discord.gg/RSrYmstWzy) | 2,054 members, 299 online. Created 10 Jun 2026 (snowflake). | Started late (11 months after launch). |
| Reddit | [r/conductorbuild](https://www.reddit.com/r/conductorbuild) (linked in site footer) | Archive (arctic-shift) shows 100 posts from 18 Jun to 15 Oct 2026 (Jun 18, Jul 27, Aug 30, Sep 17, Oct 8 to date). Top post 16 upvotes / 15 comments. Mostly user support and feature requests. The most active posters are users, not the team. Mentions in big subs (r/ClaudeCode, r/ClaudeAI) could not be measured: the archive API was rate-limited during this research. | Small. Posting has slowed since Aug. |
| LinkedIn | [company page](https://www.linkedin.com/company/conductor-build) | 4,149 followers. Recent updates are reposts of founder posts. | Passive. |
| Hacker News | founders' accounts | 1 Show HN success. 7 later founder submissions scored 1–12. Jackson posted in six monthly "Who is hiring?" threads between Mar and Sep 2026. Charlie answered 20 comments in the launch thread and replies in competitor threads ("Conductor founder here", [Zed thread](https://news.ycombinator.com/item?id=47871018)). | Used for launch and hiring. |
| Product Hunt | [product page](https://www.producthunt.com/products/conductor-aa77ddef-e6d3-4805-a179-7b2e17b6e22e) | One launch, 27 Aug 2025, #7, no badge. | Not reused for Cloud or iOS. |
| Newsletter | none found | n/a | n/a |
| App Store | [Conductor.build](https://apps.apple.com/us/app/conductor-build/id6791228564) | 10 ratings. | New. |
| Homebrew | cask `conductor`, tap `meltylabs/homebrew-tap` | see §2 | Maintained. |
| Awesome lists | n/a | 429 GitHub READMEs mention "conductor.build" (code search), but it is absent from [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) (2,234 stars), which lists Superset and intentic. | Closed source keeps it off OSS lists. |
| Partner docs | Vercel, OpenAI | Vercel AI Gateway has a "Configure Conductor" page ([docs](https://vercel.com/docs/ai-gateway/coding-agents/conductor)). "Sign in with ChatGPT" partnership with OpenAI (29 Sep 2026, [blog](https://www.conductor.build/blog/sign-in-with-chatgpt)). | Active. |
| Localization | none | Sitemap has no locale paths. | n/a |
| Trust/brand pages | [brandkit](https://www.conductor.build/brandkit), [SOC 2 Type II trust center](https://trust.conductor.build/), [enterprise](https://www.conductor.build/enterprise) | n/a | Present. |

## 4. Launch history

| Title (exact) | Date (UTC) | Weekday, hour UTC | Score / comments | Outcome |
| --- | --- | --- | --- | --- |
| HN: "Show HN: Conductor, a Mac app that lets you run a bunch of Claude Codes at once" | 2025-07-17 | Thu 15:43 (7 min after launch tweet). Real discussion Sun 20 Jul 18:00 → Mon | 228 / 115 | Front page. The only HN hit. |
| PH: "Conductor: Run a bunch of Claude Codes in parallel" | 2025-08-27 | Wed | #7 of the day. Leaderboard shows "53304", most likely 53 comments / 304 upvotes (digits run together, inference) | No badge. |
| HN: "What It's Like Working at Conductor" | 2025-11-18 | Tue 00:58 | 4 / 0 | Flop (recruiting). |
| HN: "How to Checkpoint" | 2025-12-04 | Thu 16:09 | 1 / 0 | Flop. |
| HN: "Show HN: Chorus is now open source" (sister app) | 2025-12-13 | Sat 19:04 | 1 / 0 | Flop. |
| HN: "Run a team of coding agents on your Mac" (third party) | 2026-01-16 | Fri 15:09 | 2 / 0 | Flop. |
| HN: "Conductor removing support for Claude subscription authentication" (third party, links tweet) | 2026-02-19 | Thu 21:17 | 1 / 0 | n/a |
| HN: "Conductor raises $22M Series A" | 2026-03-31 | Tue 17:12 | 3 / 1 | Flop. |
| HN: "Cmd Joins Conductor" | 2026-04-02 | Thu 20:47 | 1 / 0 | Flop. |
| HN: "Ask HN: Conductor vs. native Claude Code. Same single-agent performance?" (third party) | 2026-05-15 | Fri 21:52 | 2 / 0 | n/a |
| HN: "We've re-built Conductor from scratch to make it twice as fast" | 2026-06-02 | Tue 18:15 | 1 / 0 | Flop. |
| HN: "The Conductor Rewrite: What They Changed to Make It Fast" (same URL, a week later) | 2026-06-09 | Tue 15:01 | 12 / 6 | Small. |
| HN: "Claude subscription changes for Conductor delayed indefinitely" (third party) | 2026-06-16 | Tue 00:54 | 3 / 0 | n/a |
| HN: "Conductor Cloud" (third party, docs link) | 2026-06-25 | Thu 07:06 | 2 / 0 | Beta docs posted by a user before the launch. |
| HN: "Conductor launches multiplayer cloud workspaces that keep coding agents running" (press) | 2026-07-31 | Fri 02:12 | 4 / 0 | n/a |
| X + changelog: Conductor Allegro (rewrite), Conductor Cloud, Conductor for iOS | 2026-04-22, 2026-07-30, 2026-10-02 | Wed, Thu, Fri | see X teardown | No HN/PH launch for any of them. |

**Title signal:** the one hit reused the team's earlier winning title shape word for word: "Show HN: Chorus, a Mac app that lets you chat with a bunch of AIs at once" (139 points, Dec 2024) became "a Mac app that lets you run a bunch of Claude Codes at once" (228 points). Funding, acquisition and engineering-blog titles all scored ≤3. Only a third-party write-up of the rewrite reached 12.

## 5. Content patterns and voice

- **The changelog is the main content.** Every release gets a named, dated page. 31 of 207 entry slugs name a model (Opus, Sonnet, Haiku, GPT, Grok, Fable), and the ones checked against public release dates landed the same day, e.g. "Opus 4.1" (5 Aug 2025), "GPT-5" (7 Aug 2025), "Sonnet 4.5" (29 Sep 2025), "Opus 4.5 and better scrolling" (24 Nov 2025), up to "GPT-6.1 Sol" (29 Sep 2026) and "Claude Haiku 5.5" (15 Oct 2026). Each model launch is a reason to post.
- **Playful, plain voice.** "Conduct." (2025 homepage), "We no longer burn your CPU (hopefully)" (0.7.0), "A (mostly) boring update" (0.91.0), "Bug squashathon" (0.76.0), "Choo choo!" (Series A sign-off), "Be like this guy. Try Conductor." and "Ludwig has entered the chat" (current homepage, with composers as fake teammates). Homepage quote: "feels like going from typing with two fingers to having eight arms".
- **Testimonial wall** of named X users with employer (Stripe, Notion, Supermemory, Sesame, Life360, Tigris) plus logo strip. Series A post names Google, Meta, HubSpot, Datadog, Amazon, Spotify and others.
- **Founder workflow demos**: "We built Conductor using Conductor" (2025 homepage). YC *Full Stack* episode built around Charlie's own setup ("code is almost like sawdust now").
- **Delight features that are also shareable:** workspaces named after cities, a "Passport" with "Legendary Cities" tiers (0.28.2, 24 Dec 2025), "Conductor Wrapped" year summary (0.25.1, 4 Dec 2025), shareable model "loadouts" (0.86.0, 16 Sep 2026).
- **Short feature clips** on YouTube (Jul–Aug 2026), e.g. "Mouseless Joy", "Ports That Forward", "Tiny Detail But It's Awesome".
- **Absent formats:** no comparison/"vs" pages, no SEO blog, no benchmarks, no localized pages.

### Tagline history (Wayback homepage captures)

| Captures | Headline / description |
| --- | --- |
| Jul – Oct 2025 | "Run a bunch of Claude Codes in parallel." / "Each Claude gets an isolated workspace. See who's working, see who's stuck, and what's changed." |
| Nov 2025 – May 2026 | "Run a team of coding agents on your Mac." / "Create parallel Codex + Claude Code agents in isolated workspaces." (changed right after Codex support on 31 Oct 2025) |
| Jun – Jul 2026 | "Run parallel coding agents on your Mac." (Cursor added) |
| Aug 2026 → | "Run a team of coding agents in the cloud." / "Trusted by 100k+ builders" |

## 6. What resonated (top content by engagement)

| # | Piece | Numbers | Why it probably worked (inference) |
| --- | --- | --- | --- |
| 1 | YC *Full Stack*: "Conductor CEO Charlie Holtz Walks Us Through His AI Coding Setup" (4 Jun 2026) | 308,761 views | YC's audience and Garry Tan as host. A personal "how I work" format rather than a product pitch. Quotable lines ("code is sawdust"). |
| 2 | Garry Tan's gstack README: "Conductor runs multiple Claude Code sessions in parallel… I regularly run 10-15 parallel sprints" (since 13 Mar 2026) | repo at 136,914 stars | Recommendation inside a workflow people copy, where installing Conductor is one of the steps. |
| 3 | Show HN (17 Jul 2025) | 228 points, 115 comments | First of its kind, a concrete title that names the job, design praised in the thread ("Who does your design? I absolutely love this aesthetic"). |
| 4 | "Introducing Conductor" video (26 Aug 2025) | 62,183 views | Short demo by the founder, timed the day before Product Hunt. |
| 5 | Word of mouth on HN | 49 unsolicited comments, e.g. "We were a cursor company before conductor" ([Apr 2026](https://news.ycombinator.com/item?id=47621884)), Simon Willison's "pretty slick macOS desktop app" (Oct 2025) | Product quality and polish turn users into recommenders inside other launch threads. |

## 7. What did not work

- **Objections in the launch thread (measured).** The largest sub-thread (27 replies) was a user who expected a worktree manager for an existing checkout and found it cloned from GitHub instead. Others: "Full read-write access required to all your Github account's repos… Not a privacy policy in sight… You are INSANE to authorize this app" ([thread](https://news.ycombinator.com/item?id=44594584)), Apple silicon only, "isn't it just an API wrapper?", "Crystal can do all of this and more, and unlike Conductor is open source". The team shipped "fine-grained GitHub permissions" (0.0.21, 22 Jul 2025) and "local repositories" (0.2.0, 29 Jul 2025) within 5–12 days of launch.
- **Self-submitted HN posts after launch flopped:** Series A 3 points, cmd 1, checkpointing 1, rewrite 1 (then 12 on a repost a week later).
- **Product Hunt underperformed:** #7 with no badge, 394 followers, never reused (Superset reached #1 twice with 1.9K followers).
- **Own YouTube abandoned:** 15 clips in 8 weeks at ~0.5–1.6k views, nothing since 31 Aug 2026.
- **Anthropic's policy changes hit the core promise ("use your Claude subscription") three times:** on 19 Feb 2026 an HN submission titled "Conductor removing support for Claude subscription authentication" linked a tweet by Charlie posted at 20:44 UTC that day ([HN](https://news.ycombinator.com/item?id=47079531)), the same day as Anthropic's [19 Feb terms change](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/). 13 May 2026 Anthropic announced Agent SDK billing changes (Max users get $200 credit, then API rates, "Big Terminal Mode" users unaffected, per [Charlie](https://x.com/charlieholtz/status/2054695769916264638)). 15 Jun 2026 the change was "delayed indefinitely" ([blog](https://www.conductor.build/blog/claude-subscription-update)). A competitor wrote it up as "Workaround for Anthropic's June 15 billing change (impacted Conductor/Superset)" ([lanes.sh](https://lanes.sh/blog/claude-billing-split)).
- **Switching stories against it:** "I switched over to Superset from Conductor… nice to be able to use the native Codex/Claude Code TUIs without any of the bloat" and "Just switched from Conductor to Superset… the text rendering always drove me nuts" ([Superset Launch HN](https://news.ycombinator.com/item?id=48236770)). "Switched over to [Paseo] from conductor.build then superset.sh. The mobile app plus Hetzner VPS…" ([HN](https://news.ycombinator.com/item?id=49237141)).
- **Pricing and quality complaints after the paid tiers launched (r/conductorbuild, archive data):** "The “FREE” label in Conductor looks terrible. Please remove it." (1 Aug 2026, 14 upvotes, [post](https://www.reddit.com/r/conductorbuild/comments/1vcckih/)). "Love Conductor, but not sure Pro is worth it right now" (22 Aug, 11 upvotes / 21 comments, [post](https://www.reddit.com/r/conductorbuild/comments/1vvbak0/)). "Conductor regressions are making it harder to justify the price" (11 Sep, [post](https://www.reddit.com/r/conductorbuild/comments/1wdm8hc/)). "If conductor is the best app to build apps. why is it taking years to get the mobile app." (30 Sep, 16 upvotes, the subreddit's top post, [post](https://www.reddit.com/r/conductorbuild/comments/1wukc9w/)). "Why use conductor over Claude code on web or codex cloud?" (18 Aug, [post](https://www.reddit.com/r/conductorbuild/comments/1vrktve/)). "Feature Request: Support remote SSH execution for self-hosted dev machines" (11 Jul, [post](https://www.reddit.com/r/conductorbuild/comments/1ut5sd8/)). "Paranoid it takes more tokens to run in Conductor" (17 Jul, [post](https://www.reddit.com/r/conductorbuild/comments/1uzen85/)).
- **Hesitation about closed source:** "I like conductor.build… but I don't want to give up my freedom and get heavily reliant on closed source" (Feb 2026, [HN](https://news.ycombinator.com/item?id=46936390)). Open-source clones position against it ("Open-source Conductor.build alternative", [termic](https://github.com/simion/termic), 310 stars).
- **Generic name:** GitHub search for "conductor claude" returns Gemini CLI's Conductor extension (3,770 stars), Netflix Conductor, conductor-oss (32,336 stars) and Microsoft's conductor. The team leans on the domain ("conductor.build") as the brand.
- **Messaging pivots:** three headline changes in 15 months, ending in a cloud pivot and a $50/month Pro tier after a year of "it's free".

## 8. Timing

- **Launch choreography:** launch tweet Thu 17 Jul 2025 15:36 UTC (08:36 PT), Show HN 7 minutes later. The front-page run happened on Sun 20 Jul from 18:00 UTC, three days after submission (second-chance re-surfacing). Video on Tue 26 Aug (PT), Product Hunt on Wed 27 Aug.
- **Announcements:** Series A blog dated Mon 30 Mar, tweet Tue 31 Mar 17:08 UTC, HN 17:12 UTC. Cloud on Thu 30 Jul 2026. IOS on Fri 2 Oct 2026.
- **Release cadence:** 207 changelog entries. By weekday Tue 53, Thu 38, Fri 37, Mon 32, Wed 31, Sat 15, Sun 1. Busiest month Dec 2025 (26 entries, including Wrapped). Cadence fell to 6/month in Apr and Aug 2026 (rewrite and Cloud build months).
- **Releases on model launch days:** entries match public model release dates (GPT-5 on 7 Aug 2025, Opus 4.5 on 24 Nov 2025, Sonnet 4.5 on 29 Sep 2025), so support ships the same day.

**Inference:** weekday timing does not explain outcomes here. The one HN success came from the re-surfaced Sunday run. The big reach came from videos YC published on its own schedule.

## 9. Community and distribution mechanics

- **Free local app + BYO subscriptions** as the acquisition model. No markup on inference. Monetization arrived with hosted cloud sandboxes and collaboration (Pro $50, Teams $60/user).
- **YC network as a distribution channel:** YC videos (322k combined views on two YC uploads), Garry Tan's gstack, "YC startups are writing 100% of their code in Conductor" (Series A post).
- **Integrations and partner listings:** OpenAI "Sign in with ChatGPT", Vercel AI Gateway docs, Linear (0.8.0, Aug 2025), Graphite stacks, GitHub Enterprise, Bedrock/Vertex providers.
- **Config files in other people's repos:** `conductor.json` (0.11.0, Sep 2025) and run/setup scripts committed to repos, plus gstack's own "Running gstack in Conductor?" section. **Inference:** files in other people's repos act as passive advertising and lock-in.
- **Ecosystem built by users:** npm packages `conductor-setup`, `conductor-remote` ("Phone control panel for local Conductor agents"), `conductor-telegram`.
- **Feedback portal → hire:** cmd's founder was recruited from the feedback portal.
- **Hiring posts as awareness:** HN "Who is hiring?" entries (six between Mar and Sep 2026) that restates growth ("We've grown 10x since January").
- **Shareables:** Wrapped, Passport cities, loadouts, workspace share links (⌘⇧C).
- **Absent:** referral or affiliate programme, comparison pages, localization, OSS contribution funnel.

## 10. Lessons for intentic

1. **Borrow audiences instead of building them first.** Conductor's biggest numbers were YC's videos and a line in Garry Tan's README, not its own channels. Intentic should target workflow repos and "how I work" creators with a paragraph they can paste and a working setup snippet, and pitch episodes about the founders' own workflow to podcasts like Mastra's Agents Hour.
2. **Make every model launch a post.** Ship support the day a model drops (Claude, Codex, Grok) and publish a dated, named changelog entry the same day.
3. **Answer the trust questions in the launch post itself.** Conductor's launch thread was dominated by GitHub permissions, cloning and the missing privacy policy. Intentic's pitch (sandboxes on your own machine, outbound-only tunnel, MIT) answers these, but only if the launch text and a security page say so up front.
4. **Use a concrete "a ___ that lets you ___ at once" title, and expect the second chance.** Conductor's hit reused a proven title shape. The real discussion started three days later. Be ready to answer comments for several days.
5. **Say plainly how subscriptions are used.** Conductor's Agent SDK route put its core promise at the mercy of Anthropic's terms three times in four months. If intentic runs the vendors' own CLIs, explain that in an FAQ, with dates and links to the vendor terms.
6. **Keep local free and price the hosted part, and court the users the cloud pivot left behind.** Conductor charges $50/month for hosted sandboxes and collaboration. Its own subreddit then asked whether Pro is worth it, why not use Claude Code on the web or Codex cloud, and for remote execution on self-hosted dev machines. Intentic's "sandbox on your own machine, reachable from any browser or phone" is a direct answer to that last request, and its hosted option can be priced against the $50 anchor.
7. **Small shareable features earn posts.** A Wrapped page, a city "Passport" or shareable loadouts cost little and give users something to screenshot.
8. **Open source gives intentic a channel Conductor lacks.** It is missing from OSS awesome lists and open-source clones market themselves against it. Intentic, being MIT, should keep "open-source alternative to Conductor" pages and list entries current.

## X handles found

- Company: [@conductor_build](https://x.com/conductor_build)
- Charlie Holtz (CEO): [@charlieholtz](https://x.com/charlieholtz). 2025 launch tweets were posted as [@charliebholtz](https://x.com/charliebholtz/status/1945870105109246401) (probably the same account before a rename, not verified)
- Jackson de Campos (CTO): [@jacksondecampos](https://x.com/jacksondecampos)
- Advocates quoted on the site: [@kennyliu](https://x.com/kennyliu/status/1950364590841483673) (homepage changelog quote), @nexxel (testimonial)
