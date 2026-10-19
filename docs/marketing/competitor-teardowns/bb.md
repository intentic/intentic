# bb (getbb.app): marketing teardown

Researched 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/bb/` (stars, npm, releases, HN, Product Hunt, Trendshift, YouTube, Discord). Local clone: `/work/refs/bb` (read-only). "Inference" marks anything not directly measured.

## 1. What it is and who is behind it

- **Product.** "The IDE that builds itself": an agent orchestrator (desktop app on macOS arm64, Windows and Linux in alpha, web app via `npx bb-app`, CLI, HTTP API, mobile app) that runs Claude Code, Codex, Cursor, Pi, OpenCode, Grok, omp and Hermes on the user's own subscriptions. The pitch is that bb can change itself: ask for a feature and an agent builds it as a plugin ([README](https://github.com/get-bb/bb), [site](https://getbb.app)). Overlap with intentic is large: parallel agents, threads you can steer from any browser or phone through "bb Connect" (`<handle>.getbb.app` tunnel), and a Modal cloud-sandbox environment plugin (added 2026-09-11, `plugins/environment-modal-sandbox`).
- **Company.** Terragon Labs, Inc. The name only appeared on the site on 2026-10-12, after Google twice denied getbb.app's "free desktop software" certification (needed for Google Ads) partly because no publisher was named (commit `cc1251062`, "Name Terragon Labs, disclose usage data…").
- **People.** Made by Michael Yong ([ymichael](https://github.com/ymichael), San Francisco; first commit 2026-02-11, original author), Sawyer Hood ([Sawyer Hood](https://github.com/Sawyer Hood), "Prev: @figma, @facebook") and Bersabel Tadesse ([brsbl](https://github.com/brsbl)). All three are listed as makers on [Product Hunt](https://www.producthunt.com/products/bb). The comparison-page FAQ says: "A small, venture-backed team that most recently worked together at Figma, building Figma's plugin platform. The team also includes alumni of Meta, Quora, and Mapbox" (`apps/web/src/compare/pages/superset.tsx`).
- **Funding.** Described as "venture-backed", but no round, amount or investor is public. Not a YC company (PH `wasInYCombinator:false`).
- **History (the context that matters).** The same team built **Terragon** ("Run Claude Code as a Background Agent", a cloud product with paid subscriptions). It launched on HN on 2025-09-04 (2 points) and was shut down on 2026-02-09, with the code released as [terragon-oss](https://github.com/terragon-labs/terragon-oss) (261★) and users pointed to Claude Code Web and Codex Web ([terragonlabs.com](https://www.terragonlabs.com/)). A user retrospective: "their moat was thin, and … the model providers themselves would soon cannibalize their UX" ([jmduke](https://www.jmduke.com/posts/failed-experiments.html)). bb's first commit came two days after the shutdown, under the internal name "Beanbag". **They pivoted from a hosted, paid cloud-agent product to a free, MIT, local-first one.**
- **Dates.** Repo created 2026-02-24 under `ymichael/bb`. First npm publish 2026-05-15. First desktop release 2026-05-21. Moved to the `get-bb` org around 2026-08-04 (org created that day). Public "launch" 2026-08-05 (X Article), Product Hunt 2026-08-11.
- **Pricing.** Free, MIT end to end, with a "Run more agents, $0 more" message. A free bb account adds cloud features: thread titles, commit messages and voice transcription through bb's OpenRouter gateway with daily limits (`plugins/bb-ai`), plus Connect remote access. No paid tier exists yet. Comparison pages price the competition against bb's $0 (for example, "Superset charges $15 per user a month… Elastic License 2.0 … isn't an open-source license").
- **Size today.** 4,473★, 665 forks, about 100 contributors, 4,279 PRs (3,263 merged), 1,305 issues (GitHub API, 2026-10-19). About 2,800 of roughly 6,900 commits are authored by "OpenAI Codex", and a `bb-slop-cop[bot]` reviews PRs, so the "builds itself" claim holds up literally.

## 2. Growth curve

Star counts are reconciled from the star-history SVG, Wayback snapshots of the repo page and Trendshift daily gains ([trendshift.io/repositories/42471](https://trendshift.io/repositories/42471)). The GitHub stargazer listing returns 404 through the gateway. OSS Insight undercounts this repo by about 60% because of the repo transfer. See `stars_monthly.csv` and `trendshift_daily.csv`.

| Month end | Stars | Gain | npm `bb-app` downloads in month |
|---|---|---|---|
| 2026-05 | ~21 | +21 | 2,674 |
| 2026-06 | 86 | +65 | 2,338 |
| 2026-07 | ~380 (Wayback: 132 on Jul 10, 257 on Jul 25) | +~294 | 2,465 |
| 2026-08 | ~2,819 (Wayback: 473 and 565 on Aug 6, 1,867 on Aug 14, 2,355 on Aug 19) | **+~2,439** | 15,781 |
| 2026-09 | ~4,033 | +1,214 | **41,633** |
| 2026-10 (to 19th) | 4,473 | +440 | 22,700 (to Oct 18) |

Other adoption figures:

- **Homebrew:** cask `bb` added 2026-08-18. 149 installs in the last 30 days, 301 in 90 ([formulae.brew.sh](https://formulae.brew.sh/api/cask/bb.json)).
- **GitHub installers:** 7,910 downloads counted. This is a floor: the rolling `desktop-latest` tag resets its counts every release, and since 2026-10-09 the installers are served from getbb.app (#5277).
- **Discord:** 819 members, 147 online.
- **Product Hunt:** 223 followers.

**Biggest jumps and what caused them:**

1. **Aug 5–15: 256 → about 1,942 (+1,700 in 10 days).** Sawyer Hood published an X Article, "my new daily driver for building software" (2026-08-05 16:27 UTC; [x.com/Sawyer Hood/status/2085039905529597982](https://x.com/Sawyer Hood/status/2085039905529597982)). Search indexing shows about 542.8K views; this needs confirming by the X researcher. Wayback shows the repo going from 257 (Jul 25) to 473 (Aug 6 02:28 UTC) to 565 two hours later, about +90 per hour on the morning after the article. Three posts followed: the blog version on HN (Aug 6, 23 points), Product Hunt (Aug 11, #6 of the day) and a third-party HN post (Aug 12, 23 points). The match is by timestamps. The X Article was the ignition; HN and PH added to it rather than starting it.
2. **Sep 2–4: +397 in 3 days, the top three days in Trendshift's 61-day window, with GitHub Trending #16 in TypeScript on Sep 2.** David Ondrej's video "My Agentic Engineering Workflow (after 6,775 sessions)" went up on 2026-09-02 at 10:11 UTC (421K subscribers, 167,888 views). His clip channel later cut bb's segment as "BB is my free open-source interface for every AI agent", covering 0:18 to 1:46 of the full video ([video](https://www.youtube.com/watch?v=c9nRxEy1kUY), [clip](https://www.youtube.com/watch?v=Y9KeEL6VUUI)). npm downloads hit their all-time daily peak of **11,495 on Sep 4**. This is the clearest single cause-and-effect in the data, and it was unpaid.
3. **Aug 15–25: +650.** This is the PH and HN tail, plus the 0.38.0 plugin marketplace release (Aug 15) and the Homebrew cask (Aug 18). Trendshift shows +80 and +60 on Aug 20–21. Inference: momentum, no single event.
4. **Sep 19–Oct 13: a second wave of small YouTube coverage, all organic and mostly non-English.** It includes a Russian 2-hour stream (6,301 views), two more Russian reviews (3,179 and 906 views) and a Turkish one (398 views) (`youtube.csv`). It adds no visible spike: stars ran at a steady 20–35 per day.
5. **Oct 14–17: +35, +22, +51, +36.** This followed 0.46.1 (MCP server, CLI install; Oct 15) and a 7-part X digest by @unnamedteam (Oct 16). It is small, but it is the only October bump.

**Trend:** stars average about 23 per day in October against about 40 per day in September, and npm downloads are flat at about 1.7–2.5K per day. The growth is from distribution events, not compounding. Inference: the October SEO and ads work (section 3) is the attempt to replace event-driven growth.

## 3. Channel inventory

| Channel | Evidence | Cadence and state now |
|---|---|---|
| Website getbb.app | TanStack Start on Cloudflare Workers, in-repo at `apps/web`. Hero changelog pill, interactive app mock, "Used by builders at" logo marquee, email capture through Resend ("Product updates… No spam") | 53 commits to the site in Oct 1–19 alone (26 in Jul, 39 in Aug, 29 in Sep). Very active |
| Changelog | `/changelog`, rendered from `CHANGELOG.md`, with a headline per release in `changelog-metadata.ts` | Weekly (19 versioned entries since 2026-07-09) |
| Blog | `/blog`: 2 posts, both mirrors of X Articles: "An Agentic IDE That Builds Itself" (Aug 5) and "Building a (Restrained) Software Factory" (Sep 17) | About one a month. X is the primary channel and the blog is the archive |
| SEO pages | 5 "alternative" pages (Superset, Conductor, Vibe Kanban, T3 Code, Cursor; Oct 6) with FAQ schema and a cost calculator. 3 intent landing pages ("Claude Code on your phone", "parallel agents", "Claude Code and Codex"; Oct 8). 14 guides, 7 of them "Switch from X to bb" (Oct 9). Plugin marketplace pages at `/marketplace` (Sep 2) | Built in one burst, Oct 6–9 |
| Paid search | Google Ads. Click ids (`gclid`/`gbraid`/`wbraid`) are carried to downloads for PostHog offline-conversion import (#5256, Oct 9). Ads land on `/marketplace?utm_source=google` (#5200, Oct 8) | Started about early October. Inference: small budget, early test |
| X | @get_bb_app (release posts with video, such as the Sep 30 headless-browser preview and the Oct 2 0.45.0 post). Founders @Sawyer Hood, @_ymichael, @brsabel | Per release, plus founder long-form X Articles. X is the main channel (details belong to the X researcher) |
| Discord | [discord.gg/kvBU6tJhcJ](https://discord.gg/kvBU6tJhcJ), added to README 2026-07-02, site footer 2026-08-10 | 819 members, 147 online |
| GitHub | Weekly releases, nightly channel, public issue and PR flow, `get-bb/marketplace` registry (410 plugin entries), `get-bb/reports` | Daily |
| Product Hunt | One launch, 2026-08-11 | Single shot |
| Hacker News | 7 submissions (4 by founders), section 4 | None since Aug 12 by the team |
| YouTube | No own channel. Organic: David Ondrej plus RU/TR creators | Not owned |
| Reddit | Nothing found from the team or users. The only hit is the r/hypeurls bot repost (Aug 12, 1 point). Arctic Shift was heavily rate-limited, so coverage is partial | Absent |
| Newsletter | Resend audience "bb users" through `/api/subscribe`. No archive is public | Unknown |
| Podcasts and talks | None found | — |
| Awesome lists and directories | andyrewlee/awesome-agent-orchestrators (2,234★), jellydn/awesome-ai-agent-orchestrators, arach/awesome-agent-clients, nowork-studio/awesome-ai-startups, MGrin/awesome-bb-plugins (55★, 268 entries), numtide/llm-agents.nix, Homebrew, deepwiki, daily.dev, starlog.is, skillsllm, a SourceForge mirror, an Obsidian community plugin | Mostly third-party |
| Localization | No i18n README or site. Non-English YouTube coverage came on its own | None |
| LinkedIn | None found | — |

## 4. Launch history

| # | Channel | Title (exact) | Date (UTC) | Weekday, hour UTC | Points / votes | Comments | Submitter | Outcome |
|---|---|---|---|---|---|---|---|---|
| 0 | HN | "Show HN: Terragon – Run Claude Code as a Background Agent" (predecessor) | 2025-09-04 | Thu 14:36 | 2 | 0 | sawyerjhood | flop |
| 1 | HN | "Show HN: bb, an agentic IDE that can control itself" | 2026-06-17 | Wed 18:01 | 2 | 0 | sawyerjhood | flop |
| 2 | HN | "Bb: The IDE for loop driven development" | 2026-06-30 | Tue 21:05 | 2 | 0 | handfuloflight (3rd party) | flop |
| 3 | HN | "Show HN: An Open Source Codex App that works across provider" | 2026-07-01 | Wed 20:42 | 1 | 0 | sawyerjhood | flop |
| 4 | HN | "The IDE Bottleneck" (founder essay) | 2026-07-10 | Fri 15:45 | 2 | 0 | ymichael | flop |
| 5 | X | X Article "An Agentic IDE that builds itself" / "my new daily driver for building software" | 2026-08-05 | Wed 16:27 | ~542.8K views (unverified) | — | @Sawyer Hood | **breakout** |
| 6 | HN | "An Agentic IDE That Builds Itself" (blog) | 2026-08-06 | Thu 22:59 | 23 | 6 | sawyerjhood | modest, not front page |
| 7 | HN | "Bb Agent IDE" | 2026-08-07 | Fri 14:38 | 2 | 1 | dfaiv (3rd party) | flop |
| 8 | PH | "bb — The IDE that builds itself" | 2026-08-11 | Tue 07:01 (00:01 PT) | 184 launch-day score (203 now) | 13 | hunted by Chris Messina | **#6 of the day, #34 of the week** |
| 9 | HN | "Bb: The IDE that builds itself" | 2026-08-12 | Wed 13:23 | 23 | 10 | williswee (3rd party) | modest |
| 10 | HN | "I Tried to Leave the Terminal Eight Times. The Ninth Stuck" (3rd-party review) | 2026-09-18 | Fri 13:04 | 2 | 0 | joozio | flop |

Sources: HN Algolia (`hn_*.json`), PH page JSON (`ph_product.html`: `dailyRank:"6"`, `weeklyRank:"34"`, `launchDayScore:184`, `latestScore:203`, `commentsCount:13`).

**Title wording against result:** every "control itself", "loop driven development" and "open source Codex app across providers" title scored 1–2 points. Every "IDE that builds itself" title scored 23 points on HN, won #6 on PH and drove the viral X Article. The same product failed four times on HN before the framing changed. Part of the difference is distribution, since the winning versions rode the founder's X reach, but the framing is the variable they changed. For contrast, both founders' earlier essays did well on HN: ymichael's "Claude Code Unleashed" (2025-07-15, 158 points, 114 comments) and Sawyer's "The Bitter Lesson of LLM Extensions" (2025-11-24, 144 points, 79 comments). **On HN, essays outperform product links for this team.**

## 5. Content patterns

- **Founder long-form on X, mirrored to the blog.** These are opinionated essays with screenshots of the author's own customized bb ("Here is bb the first time you open it… Here is my bb"), embedded endorsement tweets (Brian Lovin: "Did I cook??") and level-based tutorials ("Level 1: Cross-Provider Sub-Threads, Level 2: Long-Lived Managers…").
- **Hooks and taglines:** "The IDE that builds itself". "Nothing is stopping you from building your ideal workbench." "Fork it. Make it your own." "Run more agents, $0 more." "Claude Code builds, Codex reviews, and Cursor writes the release notes." "I'm not going to tell you how to tokenmaxx and endlessly fire off your slop cannon" (Sep 17 post). The voice is self-aware and anti-hype, with builder humour.
- **Release notes as marketing:** each weekly release gets a one-line headline ("Native Windows support, service tiers, and faster conversations") shown as the "New" pill in the site hero, a structured changelog with Highlights, Improvements, Fixes, Plugins and **Thanks** (contributors named by handle), and an @get_bb_app post with video.
- **Interactive product mock** on the homepage instead of a static screenshot: agent threads, a "subagent" demo, a Telegram bot spawning a thread ("Anything can kick off work").
- **Comparison and "switch from" pages** (Oct 2026): a feature table, a 21-question FAQ with FAQPage schema and a cost calculator.
- **Social proof by derivation:** the "Used by builders at" marquee (Adobe, Meta, Figma, Linear, Vercel, Microsoft…). Each logo is backed by a GitHub issue or PR author whose profile chain shows they work there, and the commit notes it "deliberately does not claim that any listed company uses, endorses, or is a customer" (#1468).
- **Demo GIF or video** in the README and PH. An HN commenter: "the GIF just looks like a chat interface".

## 6. What resonated (top content by engagement)

| # | Content | Date | Engagement | Why it worked (inference) |
|---|---|---|---|---|
| 1 | Sawyer's X Article, "my new daily driver for building software" | 2026-08-05 | ~542.8K views (search-indexed, unverified); about +1,700★ in 10 days | First-person "I switched" story from a known builder (Figma, Terragon, a 144-point HN essay). It showed a personalized product ("No two installs look alike") rather than a feature list, and the concept was novel ("IDE that builds itself") |
| 2 | David Ondrej, "My Agentic Engineering Workflow (after 6,775 sessions)" | 2026-09-02 | 167,888 views; +397★ in 3 days; 11,495 npm downloads on Sep 4 | A big AI YouTuber's real workflow, with bb opening the video as his "free open-source interface for every AI agent". It was free and multi-provider, a set of words his audience searches for |
| 3 | Product Hunt launch | 2026-08-11 | #6 of the day, 184 points, 13 comments, 223 followers | Hunted by Chris Messina. The site hero showed "[Today] Vote for bb on Product Hunt" on launch day (#1308). Timed 6 days after the X Article, so there was warm traffic to convert |
| 4 | HN posts "An Agentic IDE That Builds Itself" / "Bb: The IDE that builds itself" | Aug 6 and Aug 12 | 23 points / 6 comments; 23 points / 10 comments | Same hook. Comments split between "Cute and clever gimmick" and "This isn't an IDE" |
| 5 | Russian-language stream "Getbb – идеальный харнесс для бизнес-пользователей?" | 2026-09-21 | 6,301 views, 99 likes | Non-English creators adopt "free + any agent" tools without being asked; the angle was business users automating document workflows |

**The plugin ecosystem is the compounding asset.** It has 410 entries in the `get-bb/marketplace` registry (created Aug 14), about 80 or more `bb-plugin-*` repos linking to getbb.app, and a community awesome list with 268 entries. Each plugin repo is a backlink, a tweet and a reason to stay. The 0.38.0 "Extensions Page and Plugin Marketplaces" release (Aug 15) landed right after launch. @unnamedteam publishes unsolicited weekly X digests of bb proposals.

## 7. What did not work

- **Four HN flops before the reframe** (section 4), and two dropped taglines. "The First LDE* (Loop Development Environment)" was the site hero from 2026-07-06 to 08-04 (`git show 222a95fbf:apps/web/src/routes/index.tsx`). "An open source Codex app that works across providers" scored 1 point. The README pitch went through five versions: "Beanbag is a local-first coding-agent workspace" (Feb) → "A programmable workspace for coding agents" (Mar 16) → "a programmable IDE that lets you run your favorite coding agents" (May 19) → "an agentic IDE that can control itself" (May 19) → "an agentic IDE that builds itself" (Aug 11).
- **The "IDE" word draws fire on HN:** "This isn't an IDE, words do mean things", "What does IDE mean here… Does it have LSP support", "Thanks, I already have Emacs", "i wish there was a documentation or a list of supported features… does it support vim bindings? terminal emulators?" ([HN 49272048](https://news.ycombinator.com/item?id=49272048)). The October guides and comparison pages answer the "what does it actually do" question two months late.
- **The predecessor failed:** Terragon (hosted, paid cloud agents) was shut down after about 6 months. The lesson they took is visible in bb's copy: "local-first", "on the provider subscriptions you already pay for", "billed by them, not bb".
- **Growth is decaying:** about 40★ per day in September and about 23 per day in October. Each spike came from someone else's audience (X Article, YouTube). Nothing the team owns compounds at that scale yet.
- **Owned channels are thin:** 2 blog posts in 10 weeks, both cross-posts. No Reddit, no own YouTube. The PH launch was a one-off.
- **Site churn and QA reverts:** the company-logo marquee was added, reverted and restored on the same day (Aug 12; #1468, #1482, #1485). The Guides menu was "taken down until they pass QA" (Oct 6, #5058) and relaunched Oct 9. Google denied the free-software certification twice before the company was named (#5384).
- **`plugins/drafts` is not unpublished marketing.** It is a composer feature ("Save a message without sending it"). Its history shows product churn: added Sep 14, made native and the plugin removed on Sep 25 (#4337), restored and native autosave reverted on Sep 28 (#4455). No unpublished blog or launch drafts were found in the repo.
- **Third-party submissions without the team fizzle:** "Bb Agent IDE" (2 points) and the jock.pl review (2 points).

## 8. Timing

- **Launch timing:** the winning X Article went out Wed 16:27 UTC (09:27 PT). PH launched Tue 00:01 PT, the standard PH slot. The HN posts that worked went out Thu 22:59 and Wed 13:23 UTC. The flops were Wed 18:01, Tue 21:05, Wed 20:42 and Fri 15:45. The hour does not explain the outcome; framing plus a pre-warmed audience does.
- **Release cadence:** 46 desktop releases since 2026-05-21: 7 in May, 13 in June, 9 in July, 6 in August, 8 in September, 3 in October so far. Since July it has been a weekly train shipped late afternoon Pacific (published 18:00–02:00 UTC). From mid-September it settled on Fridays: 0.43.0, 0.44.0, 0.45.0 and 0.46.0 all went out Friday 20:00–23:00 UTC. Nightly builds ship daily alongside. Releases do not produce star spikes (Trendshift shows release days at baseline), but they feed X posts and the "New" pill.
- **Stars by weekday** (Trendshift, Aug 20–Oct 19): Wed 45, Thu 43, Fri 43, Mon 33, Tue 32, Sat 26, Sun 20 per day. Weekday developer traffic.

## 9. Community and distribution mechanics

- **The extensibility flywheel** is the core mechanic. Users build plugins by prompting bb, publish them to the `bb-community` marketplace (410 entries) and announce them. bb's own features (GitHub, memory, automations, remote access) ship as plugins to prove the system. Telemetry counts plugin installs by public name (README).
- **OSS contribution funnel:** about 100 contributors, a "Thanks" section with handles in every release note, `CONTRIBUTING.md`, issue-based social proof, a forkability pitch ("Fork the repo… deploy your own build across your whole organization").
- **Riding provider launches:** the "Works with" chips list 8 agents (Claude Code, Codex, Cursor, Pi, OpenCode, Grok, omp, Hermes). Each new provider gets a release line. No spike in the data is tied to a provider launch.
- **Distribution partners:** Homebrew cask, numtide/llm-agents.nix (`nix run …#bb-app`), npm (`npx bb-app@latest`, the zero-install trial path, the biggest adoption funnel at about 87K downloads a year), Obsidian community plugin (third-party), awesome lists.
- **SEO and comparison pages** target competitors by name ("superset-alternative", "switch-from-conductor"…) and intents ("claude-code-mobile"). These are new in October, with no measurable effect yet.
- **Paid acquisition:** Google Ads, attributed through PostHog offline conversions with no Google tag on the site.
- **The free tier is the marketing:** "Free, open source, and local-first. Install in under a minute." The free bb account (AI titles, voice, Connect) creates sign-ups without a paywall.
- **Mobile and remote:** "check in from your phone", "answer your agents" (Connect plus mobile app). This is the claim intentic also makes, and bb already uses it on a landing page ("Claude Code on your phone").

## 10. Lessons for intentic

1. **Find one sentence that is a concept, not a category.** bb's product barely changed between June and August, but "agentic IDE that can control itself", "LDE" and "Codex app across providers" all scored 1–2 HN points, while "The IDE that builds itself" took PH #6 and two 23-point HN posts. intentic should test hooks in founder posts before a launch, rather than launching on "workspace for parallel agents" (category language that bb, MonoCode, Superset and others already own).
2. **The launch vehicle is a founder X Article in first person ("my new daily driver"), with the product shown customized.** Do PH about 6 days later, with a launch-day vote banner in the site hero, and post the essay (not the product link) to HN. bb's essays on HN reach 140–160 points; its product links reach 1–23.
3. **Get the product into one big creator's real workflow.** One David Ondrej video (168K views) moved stars more over 3 days than anything the team posted after launch, and npm downloads hit their all-time peak. Prioritise outreach to workflow YouTubers who already run several agents, and expect non-English creators (RU, TR) to follow without being asked.
4. **Make extension the growth loop.** A user-built plugin is a backlink, a tweet and lock-in. For intentic, the equivalent is shareable sandbox templates or "operator panels" with a public registry and one-command install.
5. **Answer "what does it actually do" before launch.** HN's objections ("isn't an IDE", "looks like a chat", "list the features") came two months before bb's guides and comparison pages. Ship docs, a feature table and 3–5 "switch from X" pages before the first HN post.
6. **Hosted is the trap bb walked away from.** Terragon died with "thin moat" and labs-cannibalization verdicts. intentic's hosted option needs a reason the labs won't copy (the persistent sandbox on your own machine, many providers, phone access) and should lead with the BYO-subscription, MIT, own-machine story bb now uses.
7. **Use contributor credit and evidence-backed logos as social proof.** Thank contributors by handle in release notes. Derive "used by builders at" from public issue and PR authors, with careful wording.
8. **Weekly release train plus "New" pill plus one X post per release keeps a base rate of about 20–40★ per day.** It does not create spikes. Plan distinct events (essays, creators, PH) for those.
