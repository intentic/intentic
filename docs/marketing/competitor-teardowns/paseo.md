# Paseo: marketing teardown

Snapshot: 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/paseo/` (star points, Wayback star counts, releases, HN items, Reddit archive pulls, npm/brew stats, stargazer location sample, Trendshift page). Every number below is measured unless a line is marked **Inference**.

Data caveats:
- GitHub's stargazer listing API returns 404 through the gateway and 401 without auth, so the star curve is rebuilt from 26 Wayback snapshots of the repo page (exact counts) plus the [star-history.com](https://api.star-history.com/svg?repos=getpaseo/paseo&type=Date) SVG (about 1% error).
- Daily spike detection uses GH Archive WatchEvents ([ClickHouse public dataset](https://play.clickhouse.com/)). It is undersampled after May 2026, so I normalized it by the global sampled-star volume per day.
- The Reddit archive (arctic-shift) was rate-limited by other agents. Reddit coverage is r/PaseoAI in full, the founder's full posting history (u/PiccoloCareful924), r/ClaudeCode, and r/codex. Other subreddits are not fully crawled.

## 1. What it is, who is behind it

- **Product:** "One interface for Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, and Muse Code agents" ([README](https://github.com/getpaseo/paseo)). A daemon runs on your machine. Desktop (Electron), native iOS/Android (Expo), web, and CLI clients connect to it over WebSocket, directly or through an optional E2E-encrypted relay on Cloudflare Durable Objects. It wraps first-party agent CLIs, so users bring their own Claude/Codex subscriptions. Site: [paseo.sh](https://paseo.sh). Current hero: "The agentic development environment / Run many coding agents at once, on any machine. From your desk and from your phone." (`packages/website/src/routes/index.tsx`, changed 2026-10-07 in commit 2d5587049).
- **Who:** one person, Mohamed Boudra ("Mo"): GitHub [boudra](https://github.com/boudra), X [@moboudra](https://x.com/moboudra), YouTube [@moboudra](https://www.youtube.com/@moboudra), Reddit u/PiccoloCareful924 (author of the launch posts and every r/PaseoAI announcement), HN `boudra`. He previously built [blank.page](https://blank.page) and [table.studio](https://table.studio) ([moboudra.com](https://moboudra.com)). On HN, 2026-06-03, he wrote: "team of one right now… the business, when it comes, will be around the convenience/team/enterprise layer" ([HN 48377250](https://news.ycombinator.com/item?id=48377250)). The [sponsor page](https://paseo.sh/sponsor) says: "maintained by one person, full time… no investors, no board and no company behind it. I have turned down funding offers."
- **Funding / YC:** none. Self-funded by sponsorship plus Paseo Hub ([paseo.sh/sponsor](https://paseo.sh/sponsor)).
- **Timeline:** repo created 2025-10-13 as "Realtime Voice Monorepo / Voice Dev", a push-to-talk voice interface for Claude Code (first README commits cd3413982, 205307da2). The `getpaseo` org was created 2026-02-05 and the first public GH Archive event is 2026-02-16, so it went public in mid-February 2026. First stable tag v0.1.2 is dated 2026-02-11 and the iOS app was released 2026-02-20 ([iTunes lookup](https://itunes.apple.com/lookup?id=6758887924)).
- **Business model:** free OSS core. [Paseo Hub](https://paseo.sh/hub) (page added 2026-08-03) adds GitHub/Slack/Discord bot triggers that run agents on your own daemons. Free tier: 50 agent runs/month, 1 seat. Pro: $15/seat/month (`hub-plans.fixture.json`, unitAmount 1500, while the live page loads prices dynamically). Hub can also be self-hosted. Company sponsorship: 4 homepage/README logo spots at $500/month each (`data/sponsors.ts`, page reworked 2026-09-22). First paying sponsor: Hoplite, 2026-10-15. Individuals sponsor through GitHub Sponsors, Open Collective, or Buy Me a Coffee.
- **License churn:** MIT (2026-02-05, ea5c94a51), then AGPL-3.0 (by 2026-02-25, c4523c70b), then Apache-2.0 (2026-08-27, a8734a972). GitHub's API still reports `NOASSERTION` because of the custom preamble in LICENSE.
- **Scale claims on the sponsor page:** "used by tens of thousands of developers daily", "around 70,000 visitors a month" to paseo.sh, "around 30,000" README visitors a month, "around 2,000" Discord members.

## 2. Growth curve

### Stars by month (end of month, interpolated between Wayback snapshots)

| Month | Stars at month end | Gained |
|---|---|---|
| 2026-02 | 128 | +124 (public mid-Feb) |
| 2026-03 | 526 | +398 |
| 2026-04 | 5,006 | **+4,480** |
| 2026-05 | 7,065 | +2,059 |
| 2026-06 | 9,404 | +2,339 |
| 2026-07 | 11,957 | +2,553 |
| 2026-08 | 15,651 | +3,694 |
| 2026-09 | 19,101 | +3,450 |
| 2026-10 (to 19th) | 21,410 | +2,309 |

Sources: `wayback-stars.json` (for example 808 on 2026-04-10 and 2,307 on 2026-04-13) and `stars-monthly.json`. [Trendshift](https://trendshift.io/repositories/23675) daily data for Aug 20–Oct 19: +7,065 stars in 61 days, typically +90 to +180 a day, peak +263 on Sep 24. Forks: 2,557.

### Other adoption metrics

- **npm `@getpaseo/cli`** monthly downloads ([npm API](https://api.npmjs.org/downloads/range/last-year/@getpaseo/cli)): Feb 1.6k, Mar 3.2k, Apr 10.3k, May 12.3k, Jun 16.8k, Jul 24.3k, Aug 36.4k, Sep 51.1k, Oct 1–18 48.8k. Downloads keep rising every month while star growth holds near 100/day (downloads include repeat installs and updates). `@getpaseo/client` (SDK) has 244k downloads in the year.
- **Homebrew cask `paseo`** (in homebrew-cask since 2026-04-01): installs 1,309 (30d), 3,032 (90d), 4,841 (365d) ([formulae.brew.sh](https://formulae.brew.sh/api/cask/paseo.json)). Small. **Inference:** most desktop users download from paseo.sh instead.
- **GitHub release assets:** first-time installers include arm64 DMG 132.6k, Windows Setup exe 190.3k, .deb 38.0k, Android APK 35.4k, and AppImage 22.4k. Auto-update manifests (`latest-mac.yml` 7.1M, `latest.yml` 4.3M) count update checks, not users.
- **iOS app:** 4.91★ from 104 US ratings ([App Store](https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924)). Google Play `sh.paseo` shows about 4.9★ from about 240 reviews (search snippet, not verified directly). The app is also on F-Droid.
- **Contributors:** 201 on GitHub, with 1,883 merged PRs. Since Feb 2026, 203 distinct commit authors (git log, bots included).

### Biggest jumps and what lines up with them

| # | Window | Stars | Event(s) on those dates | How matched |
|---|---|---|---|---|
| 1 | 2026-04-10 → 04-18 | 808 → 3,939 (+3,131 in 8 days, previous rate about 30/day) | Trendshift "#13 repository of the day, all languages" and "#4 TypeScript" on Apr 11, plus TS trending Apr 10–14 ([Trendshift](https://trendshift.io/repositories/23675)). No HN or YouTube post that week. The founder's per-agent Reddit posts in the days before (r/opencodeCLI 101↑ on Apr 1, r/GithubCopilot 27↑ on Apr 6) only lifted the rate to about 30/day. The location sample of stargazers in that window is **about 63% CJK** (12 of 19 located users, mostly mainland China), against 11% before it. The spike started about 23:00 UTC Apr 10 and peaked 03:00–08:00 UTC Apr 11, Saturday afternoon in Beijing. | Wayback snapshots on Apr 10, 13, and 18, normalized GH Archive peak on Apr 11, `stargazer-geo-sample.json` |
| 2 | 2026-08-04 → 08-24 | about 11.9k → 14.9k (+2.7k in 20 days, about 140/day vs 85/day in July) | TS trending Aug 5, 6, 7, 10. v0.3.0 shipped Aug 8 (new mobile terminal, redesigned sidebar). Korean README Aug 7. Hub page Aug 3. | Wayback snapshots on Aug 7, 11, and 24, plus Trendshift ranks. **No single trigger found outside X** |
| 3 | 2026-06-02 → 06-05 | 7,209 → 7,810 (+601 in about 2.5 days vs about 80/day baseline) | Third-party "Show HN: Paseo – Beautiful open-source coding agent interface", 92 points and 54 comments, 2026-06-02 22:34 UTC ([HN](https://news.ycombinator.com/item?id=48377250)). Trendshift #20 all languages on Jun 3. Founder YouTube video Jun 1 (5.0k views). | Wayback snapshots on Jun 3 and Jun 5 |
| 4 | 2026-02-19 → 03-06 | about 0 → 164 | Founder's r/ClaudeCode launch "I built a fully self-hosted and open-source Claude Code UI for desktop and mobile", 217 upvotes and 62 comments ([Reddit](https://reddit.com/r/ClaudeCode/comments/1r8rqnv/)) | Wayback Mar 6 |
| 5 | 2026-10-06 → 10-07 | +182, +206 per day (baseline about 110) | Repositioned as "agentic development environment" on Oct 7. Chinese X recommendations Oct 5–7 (@lxfater, @byCanen, @Juansgmt, listed on Trendshift). HN endorsements by tptacek on Oct 6 ("having something like Paseo is a pretty big power-up"). | Trendshift daily table, HN comment search |

**Inference on jump 1:** the April spike was a Chinese-language social wave (probably X or WeChat, and the X agent should look for an Apr 10–11 post) that pushed Paseo onto GitHub Trending. Trending then kept it visible for about 5 days. The founder's own launches that spring (four Show HNs) produced almost nothing by comparison.

### Did the CJK localization drive growth?

- **Measured:** the Simplified Chinese README and the first UI locales (zh-CN, es, fr, ru, ar, from a contributor) landed 2026-06-11. Japanese followed 2026-06-24 (README and UI, from community contributor sysCat64), Brazilian Portuguese UI 2026-06-25, Korean UI 2026-08-05, and Korean README 2026-08-07 (community, Yoonho Son).
- **Measured:** no star acceleration follows any of those dates. May 20–Jun 8 averaged 82/day and Jun 8–27 averaged 69/day. Korean landed during the August bump (jump 2) but alongside other events.
- **Measured:** the CJK wave came first, in April, two months before any translation. CJK share of located stargazers in the GH Archive sample was 11% before April, 63% in the April spike, 21% from Apr 17 to Jun 10, 47% from Jun 11 to Aug, and 33% in Sep–Oct (each window has only 14–19 located users, so ±20pp).
- **Measured:** Chinese and Japanese organic content exists. On V2EX there are several threads where Paseo is the recommended tool ([v2ex.com/t/1218284](https://v2ex.com/t/1218284), [t/1250009](https://www.v2ex.com/t/1250009), [t/1248774](https://www.v2ex.com/t/1248774)). Users note you can self-host the relay inside China, and there are at least three Chinese self-hosted relay forks on GitHub (zenghongtu, keepmind9, and xixu-me `paseo-relay`). Japanese posts include a [Qiita setup guide](https://qiita.com/YushiYamamoto/items/f8ec57a44967005afb11) (Aug 2026) and a [Zenn "2 months with Paseo"](https://zenn.dev/ik11235/articles/paseo-remote-coding-agents) review. 6 of the last 10 social mentions on Trendshift are Chinese-language X posts.
- **Inference:** localization followed demand rather than creating it. Translations were mostly contributed by users from the CJK wave. They probably helped retention in that audience (CJK share stayed high after June) but produced no visible jump.

## 3. Channel inventory

| Channel | What / evidence | Cadence and status now |
|---|---|---|
| Website paseo.sh | Landing, docs, [changelog](https://paseo.sh/changelog) (since 2026-02-19), downloads, 44 per-agent SEO landing pages ("Open source app for Claude Code" and so on, most added 2026-05-07 and rewritten "for SEO" 2026-05-20), 8 `/alternatives/*` comparison pages (2026-06-12: Claude Desktop, Codex app, Conductor, Happy Coder, OpenChamber, OpenCode Desktop, Orca, Superset), `llms.txt` (2026-05-24), [plugin registry](https://paseo.sh/plugins) (2026-10-03), [Hub](https://paseo.sh/hub), [sponsor](https://paseo.sh/sponsor) | Very active: web routes added in Jan 3, Feb 10, Mar 7, Apr 3, May 37, Jun 9, Aug 2, Sep 4, Oct 6 |
| Blog paseo.sh/blog | 1 real post ("I was wrong about Electron", 2026-05-28) plus "Hello World" | Effectively abandoned (see §7) |
| Changelog / GitHub releases | 207 releases (130+ stable). Notes credit contributors "by @user" | 7–24 stable releases a month |
| X | Founder only: [@moboudra](https://x.com/moboudra). No company account found. The sponsor page offers "an announcement from me on X". Landing page shows 9 X testimonials (Apr 6–May 30 2026) | X agent to measure |
| Discord | [discord.gg/jz8T2uahpH](https://discord.gg/jz8T2uahpH): 2,291 members, 395 online (2026-10-19). Created 2026-03-11. README note (2026-06-09): "Discord is the fastest place to reach me" | Active support channel |
| Reddit | Founder u/PiccoloCareful924: 35 posts since Feb 2026, launching once per agent subreddit (r/ClaudeCode, r/ClaudeAI, r/opencodeCLI, r/GithubCopilot, r/codex, r/cursor, r/DeepSeek, r/kimi, r/PiCodingAgent, see §4). Own sub r/PaseoAI: created about 2026-05-22, 52 posts, mostly 1–6 upvotes, top post 42↑ | Highest-yield founder channel. r/PaseoAI gets feature clips about weekly, plus community plugin posts since Sep |
| Hacker News | 5 founder submissions (5, 5, 14, 6, and 6 points), 1 third-party hit (92), 2 third-party flops | Founder stopped submitting after May 29. Founder's comment-marketing in competitor threads, e.g. 2026-06-30 "For folks looking for an open source alternative that respects your privacy, see Paseo (disclaimer: I am the maintainer)" |
| YouTube | Founder channel @moboudra (64 subscribers). The only founder video found is "I built a desktop and mobile app for coding agents" (2026-06-01, 5.0k views). Third party: Brandon Melville 14.2k, Kuro 6.4k, Parasocial Fix "paseo vs t3 code" 3.8k, Fluid Coding 3.4k, TomaMango 0.6k | Weak channel, about 33k total views found |
| Product Hunt | [Product page](https://www.producthunt.com/products/paseo) with old tagline "Claude Code and Codex from your desk and phone", 1 follower, "This product has no launches" | Never launched |
| App stores | iOS (since 2026-02-20), Google Play, F-Droid. App Store title "Paseo - Remote Coding Agents" targets "Claude Code"/"Codex" search terms | Continuous releases |
| Newsletter / email capture | None in site source | None |
| LinkedIn, podcasts, talks | None found | None |
| Awesome lists / directories | In awesome-agent-orchestrators, awesome-cli-coding-agents, awesome-agent-harness, awesome-claude-code, awesome-typescript, Awesome-AITools, awesome-ai-agents, TopDeepLearning, StarryDivineSky (CN) (GitHub code search, 254 README hits). Also on opensourcedex, agentlist.top, skillsllm, vibecodinghub | Passive, community-driven |
| Agent skills | `npx skills add getpaseo/paseo` ships `/paseo-handoff`, `/paseo-advisor`, `/paseo-committee` (README) | Distribution inside other agents |
| Localization | README in 4 languages, app UI in 10 locales (§2) | Community-maintained |

## 4. Launch history

Founder Reddit account: u/PiccoloCareful924. Full posting history is in `reddit.json` (arctic-shift `author=` query). r/PaseoAI announcement posts (1–6↑ each) are left out.

| Date (UTC) | Day, hour | Where | Title (exact) | Result | Outcome |
|---|---|---|---|---|---|
| 2026-02-19 06:22 | Thu 06h | r/ClaudeCode (founder) | "I built a fully self-hosted and open-source Claude Code UI for desktop and mobile" | **217↑, 62 comments** | Best founder launch, first ~150 stars |
| 2026-03-16 09:56 | Mon 09h | r/ClaudeCode (founder) | "orchestrate agents in parallel from your phone and desk (FOSS)" | 2↑, 0 | Flop |
| 2026-03-16 10:29 | Mon 10h | HN (founder) | "Show HN: Paseo – Run coding agents from your phone, desktop, or terminal (FOSS)" | 5 pts, 2 | Flop |
| 2026-03-26 13:06 | Thu 13h | HN (founder) | "Show HN: Paseo – Open-source coding agent interface (desktop, mobile, CLI)" (no URL) | 5 pts, 1 | Flop, resubmitted 5 min later |
| 2026-03-26 13:11 | Thu 13h | HN (founder) | same title, with GitHub URL | 14 pts, 0 | Flop |
| 2026-03-27 03:27 | Fri 03h | r/ClaudeAI (founder) | "Paseo is like Claude Remote Control, but with better UX" | 1↑, 2 | Flop (a second post 26 min later was removed by moderators) |
| 2026-03-27 03:57 | Fri 03h | r/ClaudeCode (founder) | "I built a super polished mobile app for Claude Code and Codex" | 4↑, 2 | Flop |
| 2026-03-27 07:20 | Fri 07h | r/ClaudeAI (founder) | "I built an open-source app for Claude Code" | 30↑, 26 | Moderate |
| 2026-03-30 15:51 | Mon 15h | HN (founder) | "Show HN: Paseo, an open source environment for coding agents" | 6 pts, 1 | Flop (4th Show HN in 15 days) |
| 2026-04-01 07:03 | Wed 07h | r/opencodeCLI (founder) | "I built an open source mobile and desktop app for OpenCode" | **101↑, 42** | Hit |
| 2026-04-04 03:36 | Sat 03h | r/ClaudeCode (founder) | "Plan with Claude and hand off to Codex to implement in a worktree" | 5↑, 6 | Flop |
| 2026-04-06 12:58 | Mon 12h | r/GithubCopilot (founder) | "I built an open source mobile and desktop app for Copilot" | 27↑, 19 | Moderate |
| 2026-04-09 07:37 | Thu 07h | r/OpenAI (founder) | "I built an open-source mobile app for Codex and Claude Code" | 1↑, 1 | Flop |
| 2026-05-23 10:39 | Sat 10h | r/DeepSeek (founder) | "Using DeepSeek V4 Pro in Paseo" | 35↑, 17 | Moderate (newsjack) |
| 2026-05-27 06:52 | Wed 06h | r/codex (founder) | "Open source Codex App alternative for Linux" | 10↑, 27 | Discussion, few votes |
| 2026-05-27 16:20 | Wed 16h | r/coolgithubprojects (founder) | "Open source Codex App alternative for Linux" | 1↑, 1 | Flop |
| 2026-05-28 16:41 | Thu 16h | r/opencodeCLI (founder) | "OpenCode inside worktrees with auto setup scripts" | 14↑, 1 | Small |
| 2026-05-29 11:54 | Fri 11h | HN (founder) | "I was wrong about Electron" | 6 pts, 3 | Flop |
| 2026-06-02 11:14 | Tue 11h | r/cursor (founder) | "I built a native mobile app for Cursor" | 1↑, 1 | Flop |
| 2026-06-02 22:34 | Tue 22h | HN (third party, timhigins, "just a big fan") | "Show HN: Paseo – Beautiful open-source coding agent interface" | **92 pts, 54** | Front page, +600 stars in 2.5 days |
| 2026-06-09 04:42 | Tue 04h | r/kimi (founder) | "Use the new Kimi Code on mobile with Paseo" | 0↑, 0 | Flop (newsjack) |
| 2026-07-08 03:16 | Wed 03h | HN (third party) | "Paseo: Orchestrate coding agents from your desk and your phone" | 2 pts | Flop |
| 2026-07-27 12:30 | Mon 12h | r/PiCodingAgent (founder) | "use pi on mobile with paseo (self-hosted, free and open source)" | 16↑, 1 | Small |
| 2026-07-29 05:28 | Wed 05h | HN (third party) | "Paseo: Open-source desktop and mobile app for TUI coding agents (Codex, CC)" | 3 pts, 2 ("Is this a Cursor clone?") | Flop |
| 2026-10-01 | Thu | r/PaseoAI (user) | "Paseo is the only multi harnass tenant that actually works for me!" | 42↑, 13 | Best post in own sub |
| n/a | n/a | Product Hunt | n/a | no launch | n/a |

What the titles show:
- The founder's Show HN titles listed surfaces and features ("desktop, mobile, CLI", "phone, desktop, or terminal", "environment for coding agents"). None got traction.
- The only hit had an evaluative word ("Beautiful") and a non-founder poster, 2.5 months later, when the product was more mature. The thread spent its first comments attacking "beautiful" (top comment: "what makes this 'beautiful'? … it's basic tailwind"). Then it turned into substantive use-case discussion (walks, kids, bike rides), questions about the business model, and Claude billing.
- The founder's working pattern on Reddit is "I built an open source mobile and desktop app for <Agent>", posted into each agent's own subreddit. It scored 217 (r/ClaudeCode), 101 (r/opencodeCLI), 30 (r/ClaudeAI), and 27 (r/GithubCopilot), against 0–1 in r/OpenAI, r/cursor, and r/kimi. **Inference:** the template works where the agent has no first-party mobile client (OpenCode, Copilot) and fails where the vendor already ships one (Cursor, OpenAI).
- Comparative or abstract titles ("Paseo is like Claude Remote Control, but with better UX", "orchestrate agents in parallel…", "Plan with Claude and hand off to Codex…") all flopped.

## 5. Content patterns

- **Founder story as the pitch.** Every Show HN opens "Hey HN, I'm Mo" and tells the origin story: "I kept SSHing into tmux from my phone to check on agents while on walks… I started building a voice-only app". "The name means 'stroll' in Spanish, which is basically the use case." ([HN 47397226](https://news.ycombinator.com/item?id=47397226)).
- **Trust and anti-lock-in copy, repeated everywhere:** "No accounts, no tracking", "your code never leaves your machine", "does not call inference APIs directly or extract your OAuth tokens. It wraps your first-party agent CLIs" ([HN 47530027](https://news.ycombinator.com/item?id=47530027)), and in the README "Privacy-first: Paseo doesn't have any telemetry, tracking, or forced log-ins."
- **SEO landing pages per agent** (44) and per competitor (8 "Open Source X Alternative With …" pages). The comparison pages are factual and name competitor weaknesses: "Conductor raised a $22 million Series A and is proprietary. Paseo is independent, Apache 2.0 licensed…" ([conductor page source](https://paseo.sh/alternatives/conductor)).
- **Newsjacking feature clips** on r/PaseoAI and in release notes, timed to model and agent launches: "Using DeepSeek V4 Pro in Paseo", "Use the new Kimi Code on mobile with Paseo", "Open source Codex App alternative for Linux", "use Cursor on mobile today".
- **Social proof:** 9 X testimonials on the landing page (e.g. "without a doubt the most slept on orchestrator right now", from @ceeebeeebeee).
- **Release notes** are dense, user-facing, and credit contributors. The website changelog mirrors them.
- **Tagline evolution** (landing `<h1>`, git history): "Your dev environment, in your pocket" (2026-01-14), "Manage coding agents from your phone and desktop" (02-05), "Run Codex and Claude Code locally from your phone and desktop" (02-06), "Orchestrate coding agents from anywhere" (02-25), "One interface for all your coding agents" (03-09), then "The agentic development environment" (10-07). GitHub description: "Orchestrate multiple coding agents from desktop and mobile". The pitch moved from **mobile remote** to **multi-provider** to **full ADE** as competitors (Codex app, Claude remote control) commoditized the phone use case.
- **Formats missing:** benchmarks, memes, long-form tutorials, a launch video (the hero uses static mockups).

## 6. What resonated (top content by engagement)

| # | Content | Engagement | Why it worked (inference) |
|---|---|---|---|
| 1 | r/ClaudeCode launch "I built a fully self-hosted and open-source Claude Code UI for desktop and mobile" (2026-02-19) | 217↑, 62 comments | Posted where Claude Code users already are, before the "remote agent" space got crowded. Three concrete promises in one line: self-hosted, open source, desktop plus mobile |
| 2 | Third-party Show HN "Paseo – Beautiful open-source coding agent interface" (2026-06-02) | 92 pts, 54 comments, +600 stars | A fan posted it after 4 months of polish. The founder answered about a dozen comments within 8 hours, including the Claude billing change and the business-model question |
| 3 | April Chinese-language wave and GitHub Trending (Apr 10–14) | +3.1k stars in 8 days, Trendshift #13 overall | Phone control of a home machine plus self-hostable relay fits developers behind the GFW and without Claude/Codex mobile apps (V2EX threads stress self-hosting the relay in China) |
| 4 | r/opencodeCLI "I built an open source mobile and desktop app for OpenCode" (2026-04-01) | 101↑, 42 comments | Probably filled a gap: OpenCode users had no vendor mobile app to compare it with. The same template got 27↑ in r/GithubCopilot |
| 5 | Third-party YouTube "Run Every AI Agent from Your Phone (Pi Agent, OpenCode, Cursor)" by Brandon Melville (2026-06-08) | 14.2k views | Phone demo, multi-agent, QR pairing: the product's visual moment |

Runner-up: r/PaseoAI user post "Paseo is the only multi harnass tenant that actually works for me!" (2026-10-01, 42↑, 13 comments). It is a peer testimonial, and reliability is the differentiator users talk about. Similar HN word-of-mouth appeared in October (tptacek, and dizhn's "Paseo <3").

## 7. What did not work

- **Repeated founder Show HNs:** 4 Show HNs in 15 days (Mar 16–30), peak 14 points. One was resubmitted 5 minutes later because the URL was missing. Resubmitting under slightly different titles did not change the result.
- **Reddit posts in subs where the vendor already ships a mobile client, or with no agent focus:** r/OpenAI (1↑), r/cursor (1↑), r/kimi (0↑), r/coolgithubprojects (1↑). In r/ClaudeAI one founder post was removed by moderators and a comparison title ("Paseo is like Claude Remote Control, but with better UX") got 1↑.
- **The blog:** 2 drafts written 2026-03-29. "Why agent chat rooms beat agent-to-agent prompting" stayed `draft: "true"` and was deleted 2026-08-10, together with the chat-rooms and loops features it promoted (commit 94bda1f92, "Remove chat rooms and agent loops before storage migration"). The founder dropped a whole thought-leadership line ("teams of agents collaborating in shared contexts that humans can also inhabit") along with the product bet. "Why I migrated from Tauri to Electron" was rewritten as "I was wrong about Electron" and published 2026-05-28. It got 6 points on HN (the founder submitted it), and no post has followed in 5 months.
- **Product Hunt:** product page created with the old tagline, never launched (1 follower).
- **YouTube:** the one founder video found has 5.0k views, and total third-party reach is about 33k views, against about 700k for Herdr.
- **r/PaseoAI as a broadcast channel:** founder announcements average about 2 upvotes. The sub works as a support and plugin board and adds little reach.
- **Negative threads and objections:** "beautiful" ridiculed on HN ("When I see 'Beautiful', I automatically ignore it"). Phone coding called unhealthy ("Shipping code from your phone, whhhyy… it's depression", keyle). "Is this a Cursor clone?" (HN 49093727). Confusion with OpenChamber ("looks like a literal clone of OpenChamber", Oct 15). V2EX complaint that "paseo is very slow and its UI/UX doesn't feel right". App Store review asking for session persistence. Claude subscription policy risk: Oct 7 HN comments "I'm using Paseo to run Claude Code; I guess that just got a whole lot more complicated."
- **Messaging pivots:** six hero taglines in nine months. License changed twice (MIT → AGPL → Apache). The early-development warning was removed by 2026-03-15.
- **Abandoned or removed features with marketing attached:** chat rooms and `paseo loop` were removed in v0.4.0 (2026-08-13, "Breaking: Removed `paseo chat` and `paseo loop`").

## 8. Timing

- **Launch hours:** founder HN posts went out Mon/Thu 10:00–16:00 UTC (EU daytime, with commits from +0700 and +0200 time zones). All flopped. The hit was Tue 22:34 UTC by a US poster. Founder Reddit posts mostly went out 03:00–07:30 UTC on weekdays (US night, Asia morning). The two hits (217↑ Thu 06:22, 101↑ Wed 07:03) and the flops share that window. **Inference:** with this few data points, hour cannot be separated from subreddit fit and title, and the subreddit choice explains most of the variance.
- **Release cadence:** stable releases per month: Feb 13, Mar 19, Apr 24, May 23, Jun 16, Jul 14, Aug 9, Sep 9, Oct 7 (to the 19th), plus 4–22 prereleases a month. Weekday spread of all 207 releases: Thu 40, Wed 37, Tue 33, Fri 32, Mon 26, Sun 21, Sat 18. The project ships every day, weekends included. Since August, releases are fewer and larger (0.2 to 0.12, with a written intro per minor version).
- **Commit volume:** 4,194 of the commits since Feb are by the founder, at 580–915 commits a month.
- **Correlation:** stars do not respond to releases. The April and August bumps line up with trending and social waves, not with ship dates. Steady growth (+100/day) persists without launches, which points to word of mouth plus search pages (inference).

## 9. Community and distribution mechanics

- **Open contribution funnel:** 201 contributors and 1,883 merged PRs. Release notes credit "by @user", and translations and providers (Antigravity, Muse Code) came from the community. This is the opposite of Herdr's closed-PR policy.
- **Plugin registry** (Oct 2026). Vercel Labs published a "Vercel Sandbox" plugin, and community-built [awesome-paseo-plugins](https://github.com/omercnet/awesome-paseo-plugins) and alternative clients (Amble) appeared. A plugin SDK and `@getpaseo/client` (244k npm downloads/year) make Paseo a platform.
- **BYO subscription, positioned as compliance:** "does not… extract your OAuth tokens". The founder answered Claude billing questions publicly. This trust message gets re-tested every time Anthropic changes its policy (Jun and Oct threads).
- **SEO surface:** 44 agent pages, 8 alternative pages, `llms.txt`, and 15 GitHub topics including competitor and agent names (claude-code, codex, copilot, opencode, hermes, pi).
- **Sponsorship as monetization and marketing:** the logo shows on the homepage and in all 4 READMEs, and a test enforces README/site parity (`sponsors.test.ts`).
- **Free everything:** no login, no telemetry. Hub's free tier (50 runs/month) is the only metered thing.
- **Ecosystem integrations:** Home Assistant add-on, Chinese relay forks, a macOS menu-bar app (gpambrozio/paseo-menubar), and the `skills` package for agents.
- **Being compared by competitors:** Cosyra and CodeAgentSwarm publish "X vs Paseo" pages. Paseo is now a reference point.

## 10. Lessons for intentic

1. **Launch once per agent community, with an "I built an open source app for <agent>" post.** Paseo's founder-run hits were r/ClaudeCode (217↑) and r/opencodeCLI (101↑). Four Show HNs did nothing. Do the same for intentic in r/ClaudeCode, r/codex, r/opencodeCLI, r/GithubCopilot, and the Grok community, leading with what that vendor's own app lacks (persistent sandbox, phone access, BYO subscription). Skip subs where the vendor already covers the use case, and spend HN only once there is something a fan would post for us.
2. **A Chinese-language wave can be bigger than any English launch.** About 63% of the located stargazers in Paseo's biggest spike were CJK. Phone access to your own always-on machine, plus a self-hostable relay, is what V2EX users ask for. Intentic's "sandbox on your machine, reached from any browser or phone" maps onto the same need. Seed CN/JP posts (V2EX, Qiita/Zenn, Chinese dev X accounts) and make sure the relay story works inside China. Localize after the wave, from contributors, as Paseo did.
3. **Comparison and per-agent pages earn steady traffic.** Paseo has 44 "Open source app for <agent>" pages and 8 "<competitor> alternative" pages, and keeps growing about 100 stars/day with no launches (the sponsor page claims 70k visitors/month). Intentic should ship "intentic for Claude Code / Codex / Grok" and "alternative to Conductor / Paseo / Orca" pages early.
4. **Don't promise something you can't measure.** "Beautiful" got Paseo's only HN front page and also its harshest criticism. Lead with the verifiable claim: "MIT, BYO subscription, no telemetry, persistent sandbox on your machine."
5. **Answer the subscription-policy question before it is asked.** Every Paseo thread raises Claude billing and ToS. A short public page ("how intentic uses your Claude/Codex/Grok subscription, and what changes if the provider changes rules") turns a risk into a trust signal.
6. **Keep the hero tagline stable.** Paseo's moved from mobile remote to ADE across six taglines as platform vendors copied the phone use case. Intentic's "persistent sandbox per agent, on your machine or hosted" is harder for platform vendors to copy. Pick it and keep it.
7. **Open contribution plus a plugin registry turns users into marketers.** Translations, providers, plugins, relay forks, and Home Assistant add-ons all came from the community and each produced its own posts. Most r/PaseoAI posts in Sep–Oct are community plugins and integrations, and the top post of that period is a user testimonial (42↑).
8. **Don't build a blog you won't feed.** Paseo's blog has 1 real post, and its best essay died with the feature it promoted. Tie essays to durable product truths (persistence, sandboxes, BYO models), not to experimental features.

## X handles found

- [@moboudra](https://x.com/moboudra): founder (README badge and landing page)
- Third-party advocates in the landing testimonials and Trendshift mentions (for the X agent): @ceeebeeebeee, @erikksherman, @amankumarjagdev, @tietougongshiba, @jasontorres, @aadtyn, @bevstratov, @arnoldgamboa, @dongnaebi. Chinese-language posters @jaywcjlove, @lxfater, @byCanen, @Juansgmt, @_rainbowatcher, @YuAmeowA, @niuniu_8964. Others: @axatbhardwaj, @the_osps
