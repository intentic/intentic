# Hermes Agent (Nous Research): marketing teardown

Researched 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/hermes-agent/` (Wayback star series, releases, HN, Product Hunt, YouTube, Discord, PyPI, Docker Hub, user-stories dataset). Local clone: `/work/refs/hermes-agent`.

"Measured" means read from an API, the repo or a dated page. "Inference" is labelled as such.

## 1. What it is and who is behind it

**Product.** An open-source, self-hosted "personal agent" harness: a persistent process with memory, self-written skills, cron automations and a gateway to Telegram, Discord, Slack, WhatsApp, Signal, email and about 20 more platforms. It ships as a CLI/TUI, a desktop app (Hermes Desktop, public preview 2026-06-02), a Docker image, a PyPI package and a hosted option (Hermes Cloud). It is not a coding agent in the IDE sense, but it competes for the same "always-on agent on a box" budget: OpenRouter files it as #1 in Coding Agents, CLI Agents, Personal Agents and Productivity ([openrouter.ai/apps/hermes-agent](https://openrouter.ai/apps/hermes-agent)).

**Company.** Nous Research, founded 2023 as a Discord/Twitter collective of open-model researchers, best known for the Hermes model series (Hermes 2/3/4), YaRN and the Psyche/DisTrO distributed-training work. Founders usually listed: Jeffrey Quesnelle, Karan Malhotra, Ryan "Teknium" and Shivani Mitra ([TechCrunch](https://techcrunch.com/2026/10/07/nous-research-confirms-it-hit-1-5b-valuation-launches-ai-agents-for-business-users/), [dealroom](https://app.dealroom.co/news/note/nous-research-raises-90m-at-1-5b-valuation-for-open-source-ai)). The October 2026 fundraise note is signed by CEO Dillon Rolnick ([nousresearch.com/a-note-on-our-fundraise](https://nousresearch.com/a-note-on-our-fundraise)). Teknium is the main committer and public voice for the agent: 14,677 commits as "Teknium" plus 5,810 as "teknium1" in the clone (`git shortlog -sn`).

**Funding.** About $70M raised before 2026 (Paradigm, Robot Ventures, North Island, OSS Capital and others). Series B of $90M announced 2026-10-07, led by Robot Ventures with NVIDIA, M12 (Microsoft), Samsung, USV, Y Combinator, Menlo and 1789 Capital; $1.5B valuation per WSJ/TechCrunch, total raised about $158M ([TechCrunch](https://techcrunch.com/2026/10/07/nous-research-confirms-it-hit-1-5b-valuation-launches-ai-agents-for-business-users/)). WSJ reported about $36M annualized revenue by mid-September 2026 (via TechCrunch).

**Launch date.** The repo was created 2025-07-22 and sat almost unstarred until launch (star-history shows under 5 stars before February 2026). Public launch was a tweet on **Wed 2026-02-25 20:39 UTC**: "Meet Hermes Agent, the open source agent that grows with you…" ([x.com/NousResearch/status/2026758996107898954](https://x.com/NousResearch/status/2026758996107898954)), which drew 557 likes according to [Hermes Atlas](https://hermesatlas.com/reports/state-of-hermes-april-2026). The first tagged release, v0.2.0, followed on 2026-03-12.

**Business model.** The agent is free, MIT-licensed, and works with any provider. Revenue comes from around it:
- **Nous Portal** subscriptions bundle model and tool credits: Free $0, "Release Hermes" $20/mo, "Liberate Hermes" $100/mo, "Unleash Hermes" $200/mo, each with a 10% credit bonus ([hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/)).
- **Tool Gateway** (v0.10, 2026-04-16): web search, image generation, TTS and browser automation for Portal subscribers.
- **Hermes Cloud**: hosted always-on agents billed daily from credit, compute per second of uptime plus storage, storage-only when stopped, $2 minimum to deploy ([portal.nousresearch.com/cloud](https://portal.nousresearch.com/cloud)). Third parties quote $0.56/day Standard, $1.09/day Pro and $0.03/day stopped ([betterclaw](https://www.betterclaw.io/blog/hermes-cloud-vs-betterclaw)).
- **Hermes Business** (shared balance with per-member caps, isolated tenant) and **Hermes Enterprise** (your infrastructure, SSO, SLAs), added in September 2026 with no public price ([portal.nousresearch.com/business](https://portal.nousresearch.com/business)).

**Open source.** MIT. 255,184 stars, 55,522 forks and 983 watchers on 2026-10-19 (GitHub API, `repo.json`). The `open_issues_count` of 49,990 includes PRs; an HN post on 2026-08-24 counted "23000 open PRs and climbing" ([HN 49424643](https://news.ycombinator.com/item?id=49424643)).

**Claimed adoption** (company figures, not verified): "cloned over 24 million times", "approximately 2.5% of all global token usage" ([fundraise note](https://nousresearch.com/a-note-on-our-fundraise)). Measured proxies:

| Source | Figure |
|---|---|
| Docker Hub `nousresearch/hermes-agent` | 14,449,138 pulls (registered 2026-03-29) |
| PyPI `hermes-agent` | 198k (May, from 05-14), 394k (Jun), 555k (Jul), 321k (Aug), 153k (Sep), 287k (Oct 1–18) |
| Homebrew formula | 14,862 installs/365d |

PyPI arrived late (v0.14, 2026-05-16) and is not the main install path. The curl installer and the desktop app are not measurable.

## 2. Growth curve

Method: GitHub's stargazer listing is blocked from this sandbox (REST 404; GraphQL returns no edges), so the series uses 162 daily Wayback Machine snapshots of the repo page (`wayback-stars.csv`). It is cross-checked against the star-history.com SVG (`starhistory-points.json`; e.g. 03-13: 6,533 vs 6,428 Wayback; 05-01: 125,527 vs 127,554) and against Hermes Atlas figures (57,200 on 04-11, 165,033 on 05-24). OSSInsight's monthly series flags its own data as degraded lower bounds and was not used.

**Stars by month (measured, last snapshot of each month)**

| Month end | Stars | Gained in month |
|---|---|---|
| 2026-02-28 | 1,077 | +940 (from 137 on 02-25) |
| 2026-03-31 | 19,261 | +18,184 |
| 2026-04-30 | 126,145 | +106,884 |
| 2026-05-30 | 173,299 | +47,154 |
| 2026-06-30 | 205,778 | +32,479 |
| 2026-07-31 | 223,241 | +17,463 |
| 2026-08-31 | 238,679 | +15,438 |
| 2026-09-28 | 249,689 | +11,010 |
| 2026-10-19 | 255,184 (API) | +5,495 since 09-28 |

Decay is steady: about 11,800/day at the peak (04-09 to 04-10), about 1,800/day through May, 400–700/day in July and August, about 270/day in October.

**Biggest jumps and what lines up with them.** Matching is by date. Causation is inference.

| # | Window | Measured gain | Events in the window |
|---|---|---|---|
| 1 | 04-07 → 04-17 | 29,258 → 95,639 (+66k in 10 days; peak +11,758 on 04-09/10) | Anthropic stopped Claude subscriptions covering OpenClaw on 04-04 ([HN 1,099 pts](https://news.ycombinator.com/item?id=47633396)). On **Tue 04-07 22:25 UTC** Nous tweeted "If you're having trouble with your lobster-themed agent since the recent update, try downloading Hermes Agent, then running 'hermes claw migrate'…" ([x.com](https://x.com/NousResearch/status/2041643678796570657)). v0.8.0 shipped 04-08. Teknium's "ranked #1 on OpenRouter" tweet went out 04-12 00:22 UTC ([HN mirror](https://news.ycombinator.com/item?id=47754556)), WorldofAI's video on 04-07 (47k views), Better Stack's on 04-15 (21k). Daily rate was about 1,400 in 04-01..04-07 and about 2,700 in 04-17..04-24. |
| 2 | 03-23 → 04-01 | 10,687 → 20,623 (+9.9k, about 1.1k/day) | v0.4.0 "platform expansion" (03-23, 300 PRs in five days per Hermes Atlas), v0.5/v0.6 (03-28, 03-30), multi-agent launch tweet (03-30), OpenClaw migration guide (03-29), Docker Hub image (03-29), Railway deploy template (03-31). |
| 3 | 03-10 → 03-13 | 3,079 → 6,428 (+3.3k in 3 days) | First hackathon announced 03-05 ($7,500 / $2,000 / $500; entries were tweets tagging @NousResearch with a video demo) ([x.com](https://x.com/NousResearch/status/2029607069934866507)); README repositioned to "The self-improving AI agent" on 03-06; v0.2.0 with `hermes claw migrate` on 03-12. |
| 4 | 05-08 → 05-28 | 135,927 → 171,389 (about 1.8k/day sustained, days up to 2,826) | v0.13 "Tenacity" (05-07), Hermes passes OpenClaw on the OpenRouter daily ranking (05-10, [MarkTechPost](https://www.marktechpost.com/2026/05/10/openclaw-vs-hermes-agent-why-nous-researchs-self-improving-agent-now-leads-openrouters-global-rankings/)), NVIDIA RTX AI Garage blog (05-13), xAI "use your Grok subscription in Hermes" (05-15, [x.ai/news/grok-hermes](https://x.ai/news/grok-hermes)), PyPI package (05-14/16), Nate Herk's 1-hour course (05-09, 399k views), **NetworkChuck "you need to use Hermes RIGHT NOW!! (goodbye OpenClaw!!)" on 05-20 (1.82M views)**, the day with the highest May rate (05-19→05-20 +2,826), CodeHead (05-23, 384k), Alex Finn (05-22 and 05-26, 236k and 177k). |
| 5 | 06-02 → 06-06 | 175,959 → 184,124 (about 2k/day vs about 1k/day either side) | Hermes Desktop public preview (**Tue 06-02 16:12 UTC**, "First demoed in Jensen's GTC keynote", i.e. GTC Taipei on 06-01, where Huang named "OpenClaw, Hermes" as harnesses ([transcript](https://singjupost.com/nvidia-gtc-taipei-2026-keynote-w-ceo-jensen-huang-transcript/))), Product Hunt #6 of the day (06-03), HN "Hermes Desktop" 27 pts, v0.16 (06-05), Greg Isenberg desktop video (06-06, 199k). |

Events that did **not** move stars visibly: the $90M Series B (10-07; about 270/day before and after), the TIME post (10-16; see section 7), and the RTX Spark / Windows launch-partner news (10-16). Inference: by autumn, mainstream press and enterprise news no longer reached the GitHub-starring audience. What reached it was creator video and the moments when a competitor was in crisis.

**Discord growth (Nous Research server, Wayback og:description + live invite API):** 10,130 (2024-09) → 13,265 (2025-01) → 74,040 (2025-06) → 76,124 (2025-09) → 82,814 (2026-04-08) → 96,986 (05-01) → 112,116 (06-01) → 131,760 (08-14) → **145,846 members, 17,651 online (2026-10-19)**. Between 2025-09-28 and 2026-04-08 (a window that already includes six launch weeks) the server added 6.7k members. From 04-08 to 10-19 it added 63k (+76%).

## 3. Channel inventory

| Channel | What they do | Cadence / status (measured) |
|---|---|---|
| X @NousResearch | Main launch and announcement channel: product drops, partner retweets, memes, merch ("Let's see your Nous fit pics"), hackathons. The nousresearch.com homepage embeds the feed. | About 10 posts in 10-14..10-18 per the homepage feed, so roughly 2/day. Very active. Follower and engagement data come from the separate X research. |
| X @Teknium (co-founder) | Personal posts: rankings ("#1 on OpenRouter"), defences (Polymarket skill), architecture updates. | Active; three HN submissions link his tweets. |
| Discord discord.gg/NousResearch | Shared lab-wide server (models plus agent). Hackathon submissions and "Hermes Agent Jam" live sessions run there ([x.com](https://x.com/NousResearch/status/2029633915804139608)). | 145,846 members. The user-stories dataset cites Discord more than any other source (116 of 371 stories). |
| Docs site hermes-agent.nousresearch.com/docs | Docusaurus. Guides for every provider and platform, migration guides, plugin and skill catalog pages, a "User Stories" collage, `llms.txt`/`llms-full.txt` (since 2026-04-30). | Commits on 25–31 days of every month since March. Effectively daily. |
| Landing page | "The Agent That Grows With You": install one-liner, desktop downloads, six features, FAQ, Portal pricing. | Live. |
| GitHub releases | 41 releases 2026-03-12..10-15. Long notes (up to 118k characters) with a mythological name ("The Threshold Release. Hermes was the god of thresholds…"), a stats line ("~24,200 commits · ~6,080 merged PRs · … ~2,520 contributors") and per-PR contributor credits. | 2 to 8 per month (section 8). |
| Company blog nousresearch.com | Mostly research posts. Hermes-specific posts: "Refactoring Hermes with 1393 Agents" (2026-09-17) and the fundraise note. | Rare: 2 agent posts in 8 months. Not a real channel for the agent. |
| YouTube (official) | @NousResearch: 3.04K subscribers, 17 videos, last upload "Nous Office Hours – December 2025". **No Hermes Agent video on the official channel.** | Dormant. |
| YouTube (creators) | NetworkChuck, Tina Huang, Metics Media, Nate Herk, CodeHead, Alex Finn, Greg Isenberg, Better Stack, WorldofAI, zSecurity, plus German (c't 3003), Chinese (PAPAYA 電腦教室, 零度解说) and others. | 27 of the top 30 results for "hermes agent" sorted by views are third-party videos of 199k–1.82M views (`youtube-search.json`). This is the main reach channel, and Nous does not own it. |
| Reddit | u/NousResearch exists but posts in bursts: 23 posts in total, adopting the community-made r/hermesagent (created 2026-03-14 by u/smolpotat0_x) as "New Hermes Agent subreddit!" on 2026-04-08, then an AMA, release posts and a "Vent Here" bug thread. u/emozilla (very likely Quesnelle) ran a mod-arranged r/LocalLLaMA AMA on 04-29. r/hermesagent holds 8,918 posts and 115,517 comments in the archive. | Two bursts (04-08..04-12, 06-20..06-27). **No official post since 2026-06-27** in the archive. The community forum stays busy. |
| Hacker News | Only third parties submit. 30 submissions of official URLs, median 2–3 points (section 4). | Not a growth channel. |
| Product Hunt | Three launches under the "Nous Research" product (377 followers). | Feb and Jun 2026 (section 4). |
| Partner channels | NVIDIA blog and GTC Taipei keynote, AMD blog (04-21), xAI news post (05-15), OpenRouter cookbook and app leaderboard, Railway deploy template (03-31), Windows built-in agent setup flow with RTX Spark (10-16, [x.com](https://x.com/NousResearch/status/2111130297907470840)), Kimi/Moonshot and Stripe hackathon co-sponsors, Firecrawl and Vectorize LinkedIn posts. | Recurring; the strongest owned-adjacent channel. |
| Newsletter | None official. The community Hermes Atlas newsletter had 1,300+ subscribers by May 2026 ([report](https://hermesatlas.com/reports/state-of-hermes-may-2026/)). | Third-party. |
| Podcasts / talks | TWiT interview with Quesnelle ([twit.tv](https://twit.tv/posts/tech/what-makes-hermes-agent-stand-out-open-source-innovation-nous-researchs-jeffrey)), Greg Isenberg's Startup Ideas Podcast, Tool Use ("Hermes Agent has won. Here's why."), GTC Taipei keynote mention. | Occasional. Mostly earned, not booked. |
| Awesome lists and directories | awesome-hermes-agent (5,866 stars), Hermes Atlas (ksimback/hermes-ecosystem, 1,322 stars, tracks 250 ecosystem projects by 09-18), OpenRouter app rankings, Docker Hub, Homebrew, PyPI, Microsoft Store/MSIX, Termux APT, Nix flake, Wikipedia article ([Hermes_Agent](https://en.wikipedia.org/wiki/Hermes_Agent)). | All third-party-run except the package channels. |
| Localization | README in 中文 (2026-04-21), اردو (06-08) and Español (06-15); docs in zh-Hans (04-18); app UI in 16 languages (v0.22). | Expanding. Chinese-language creators are among the top YouTube results. |
| Merch | shop.nousresearch.com ("Hermes Agent shirt"). | Used in X posts. |
| LinkedIn | No Nous-run LinkedIn activity surfaced in this research. Partner and fan posts appear in the user-stories dataset. | Not examined further. |

## 4. Launch history

**Product Hunt** (raw Apollo state of the PH page, `producthunt.json`; PH posts at 00:01 Pacific)

| Title (tagline, exact) | Date | Weekday, hour UTC | Launch-day score / total / comments | Outcome |
|---|---|---|---|---|
| "Hermes Agent: An open source terminal agent that builds its own skills" | 2026-02-26 | Thu 08 | 9 / 24 / 2 | Not featured. #38 of the day, #245 of the week. A flop. |
| "Hermes Desktop: The agent that grows with you" | 2026-06-03 | Wed 07 | 186 / 210 / 13 | Featured. #6 of the day, #35 of the week. |
| (model) "Hermes 4: Powerful reasoning model that's aligned to you" | 2025-08-29 | Fri 07 | n/a | #22 of the day. |

**Hacker News: every submission of an official Hermes URL** (Algolia; `hn/official-url-submissions.tsv`). None were submitted by identifiable Nous staff.

| Title (exact) | Date | Day, hour UTC | Points | Comments |
|---|---|---|---|---|
| "Hermes Agent" (launch tweet) | 2026-02-26 | Thu 09 | 2 | 0 |
| "Hermes Agent" (nousresearch.com/hermes-agent) | 2026-03-03 | Tue 16 | 1 | 0 |
| "NousResearch/hermes-agent: The agent that grows with you" | 2026-03-05 | Thu 17 | 4 | 3 |
| "Hermes Agent" (GitHub) | 2026-03-09 | Mon 10 | 1 | 0 |
| "Hermes Agent: The self-improving AI agent" | 2026-03-11 | Wed 21 | 3 | 1 |
| "Nous Research Hermes Agent launches Multi-agent" | 2026-03-30 | Mon 22 | 2 | 0 |
| "Hermes Agent by Nous Research" | 2026-04-03 | Fri 19 | 5 | 0 |
| "Self-Improving AI Agent" | 2026-04-13 | Mon 04 | 1 | 0 |
| "Hermes Agent (by Nous Hermes) quickly ranked #1 on OpenRouter" | 2026-04-13 | Mon 16 | 3 | 1 |
| "The agent that grows with you" | 2026-04-18 | Sat 07 | 2 | 0 |
| "Hermes Agent by Nous Research" | 2026-04-19 | Sun 02 | 3 | 0 |
| "Hermes Agent – A self-improving AI agent" | 2026-04-23 | Thu 01 | 1 | 0 |
| "Hermes Agent Background Computer Use on macOS via SkyLight Private SPIs" | 2026-05-11 | Mon 23 | 3 | 0 |
| "Nous Research edits GitHub issue to remove plagiarism claims about Hermes Agent" | 2026-05-19 | Tue 00 | 8 | 1 |
| "Hermes: The Agent That Grows with You" | 2026-05-22 | Fri 02 | 2 | 1 |
| "Hermes Agent co-founder defends Polymarket skill coming pre-installed" | 2026-06-01 | Mon 02 | 4 | 0 |
| "Hermes Agent is now natively supported on Windows" | 2026-06-01 | Mon 04 | 5 | 1 |
| **"Hermes Desktop"** | 2026-06-02 | Tue 18 | **27** | 6 |
| **"Migrate from OpenClaw"** | 2026-06-18 | Thu 14 | **122** | **105** |
| "Hermes Agent can now /learn from anything" | 2026-06-24 | Wed 00 | 6 | 1 |
| "Hermes MoA virtual models:8% higher than Opus 4.8, 11% higher than GPT 5.5" | 2026-06-28 | Sun 08 | 4 | 0 |
| "Hermes Agent v0.20.0" | 2026-08-03 | Mon 17 | 2 | 0 |
| "Asking "Was EvoMap's Evolver a reference" for Hermes gets deleted and blocked" | 2026-08-07 | Fri 10 | 2 | 0 |
| "Hermes Agent has 23000 open PRs and climbing" | 2026-08-24 | Mon 19 | 3 | 1 |
| "Hermes Agent – Open-Source AI Agent That Grows with You" | 2026-08-25 | Tue 23 | 4 | 0 |
| "Hermes Kanban – Multi-Agent Profile Collaboration" | 2026-09-07 | Mon 23 | 1 | 1 |
| "Refactoring Hermes with 1393 Agents" | 2026-09-17 | Thu 17 | 2 | 0 |
| "Teknium update on dropped an Hermes' architecture" | 2026-09-18 | Fri 12 | 2 | 0 |
| "Hermes Agent now supports Claude Pro/Max subscriptions" | 2026-09-21 | Mon 18 | 2 | 0 |
| "Nous Research raises $90M in new funding" | 2026-10-07 | Wed 16 | 3 | 0 |

Other HN stories worth knowing: "Hermes Agent – Open-source AI agent with persistent memory" pointing at the **unaffiliated** hermes-agent.org (2026-06-05 Fri 22 UTC, 52 pts, 42 comments; a commenter flagged "This submission's reference URL is not affiliated with Nous Research"); "Show HN: Grafana agent observability for Hermes Agent" (28 pts); "HERMES.md in commit messages causes requests to route to extra usage billing" (2026-04-29, 1,251 pts, 531 comments, [HN](https://news.ycombinator.com/item?id=47952722)): Claude Code's billing routed any session whose git history contained the string "HERMES.md" to paid extra usage, i.e. Anthropic was fingerprinting Hermes as a third-party harness. The anger was aimed at Anthropic, and the thread put Hermes's name in front of a 1,251-point audience; "We were building infra for OpenClaw, and today I just tried Hermes and holy shit" (7 pts). Of 142 HN stories with "Hermes" in the title since February, only the agent-related ones listed here cleared 20 points. HN comments mentioning "hermes agent" number 188 in total, peaking at 41 in June.

Title wording vs result (inference): titles naming the product ("Hermes Agent", "The agent that grows with you") scored 1–5 every time. The one winner was a **competitor-switching** page ("Migrate from OpenClaw"). It worked because HN wanted to argue about the OpenClaw vs Hermes question: the comments are a debate about the category, the plagiarism story and a pre-installed Polymarket skill, not praise.

**Reddit** (arctic-shift archive, `reddit/*.json`; per-subreddit title searches were partly blocked by archive rate limits, so this covers r/LocalLLaMA Feb 20–May 31, r/openclaw, r/AI_Agents and r/NousResearch since February, the first 100 r/hermesagent posts and every u/NousResearch post)

| Title (exact) | Sub | Author | Date, day, hour UTC | Score / comments | Note |
|---|---|---|---|---|---|
| "Hermes Agent with MIT license" | r/LocalLLaMA | user | 2026-02-26 Thu 07 | 36 / 25 | Launch-day pickup by a user, not Nous |
| "Hermesagent vs openclaw comparison" | r/hermesagent | user | 2026-03-29 Sun 14 | 97 / 10 | Top early post in the new sub |
| "I tried Hermes so you don't have to." | r/openclaw | user | 2026-04-06 Mon 17 | 104 / 80 | Two days after Anthropic's OpenClaw cutoff |
| "Greetings from the Nous Research team! AMA?" | r/hermesagent | u/NousResearch | 2026-04-08 Wed 20 | 161 / 115 | First official Reddit act, the day after the lobster tweet |
| "Hermes Agent v0.8.0 is here." | r/hermesagent | u/NousResearch | 2026-04-09 Thu 01 | 26 / 8 | Cross-posted to r/nousresearch (2 / 0) |
| "Frustrations? Pesky Bugs? Vent Here!" | r/hermesagent | u/NousResearch | 2026-04-09 Thu 17 | 12 / 67 | Feedback sink during the surge |
| "Hermes just mass emailed a bunch of accounts from 2020 with pairing requests." | r/LocalLLaMA | user | 2026-04-20 Mon 14 | 121 / 56 | Top r/LocalLLaMA Hermes post in the window, and negative |
| "OpenClaw vs Hermes" | r/openclaw | user | 2026-04-26 Sun 16 | 101 / 130 | |
| **"AMA with Nous Research -- Ask Us Anything!"** | r/LocalLLaMA | u/emozilla | 2026-04-29 Wed 15 (8 AM PDT) | **316 / 374** | Announced by a mod on 04-24 (85 / 9) |
| "Yet Another Openclaw vs Hermes experience sharing" | r/openclaw | user | 2026-05-03 Sun 13 | 149 / 59 | |
| "Great, go use hermes if you want, but stfu in this subreddit" | r/openclaw | user | 2026-05-06 Wed 17 | 67 / 68 | The competitor's community pushing back on Hermes talk |
| "Hermes Agent v0.17.0 - The Reach Release" | r/hermesagent | u/NousResearch | 2026-06-20 Sat 06 | 113 / 28 | |
| "Hermes Agent now supports computer use" | r/hermesagent | u/NousResearch | 2026-06-22 Mon 19 | 106 / 20 | |
| **"Hermes Agent can now /learn from anything"** | r/hermesagent | u/NousResearch | 2026-06-24 Wed 08 | **233 / 40** | Best official post |
| "Introducing MoA" | r/hermesagent | u/NousResearch | 2026-06-27 Sat 14 | 34 / 8 | Last official post found |
| "Hermes vs OpenClaw: I benchmarked both on real work.  I left the one that learns." | r/openclaw | user | 2026-09-09 Wed 14 | 95 / 33 | |

Pattern: the top threads in the period are comparisons with OpenClaw, many in OpenClaw's own subreddit. Nous's cross-posts to its old r/nousresearch got 1–6 points each, while the same posts in r/hermesagent got 26–233. The docs' user-stories page cites 79 Reddit posts, 61 of them from r/hermesagent (`userStories.json`).

## 5. Content patterns

- **Tagline evolution** (README history, `git log --follow -p README.md`):
  - 2025-09: "An AI agent with advanced tool-calling capabilities…" (a research-tool description)
  - 2026-02-23: "**An open-source AI agent you can actually live with.**"
  - 2026-02-25 (launch): "**An open-source AI agent that grows with you**", the same day changed to "The fully open-source AI agent that grows with you"
  - 2026-03-06: "**The self-improving AI agent built by Nous Research.** It's the only agent with a built-in learning loop…" (current)

  The GitHub description stays "The agent that grows with you". The pitch moved from features to a single claimed category ("self-improving", "only agent with a built-in learning loop") with the lab's name attached.
- **Release notes as marketing.** Every major release gets a name and a myth-flavoured paragraph ("The Threshold Release", "Quicksilver", "Judgment", "Surface", "Velocity", "Tenacity"), an aggregate stats line, a Highlights list written for users, and @-credits for each contributor. Third parties (Hermes Atlas, gradually.ai, MarkTechPost, tao.media) rewrite these notes into articles.
- **Competitor-capture copy.** "lobster-themed agent" (OpenClaw's mascot), the `hermes claw migrate` command (shipped 2026-03-12, weeks before the OpenClaw crisis), a "Migrate from OpenClaw" guide (2026-03-29), and `hermes import-agent claude-code|codex` (2026-07-26) that imports CLAUDE.md, allowlists, MCP servers and skills.
- **Benchmarks and big numbers.** "Hermes MoA virtual models: 8% higher than Opus 4.8, 11% higher than GPT 5.5"; "Refactoring Hermes with 1393 agents… $19,300 in model spend vs an estimated $150k–$1.8M by hand"; "4,500× faster session_search"; "2.5% of all global token usage".
- **Social proof page.** The docs' "User Stories & Use Cases" collage holds 371 stories "scraped from X, GitHub, Reddit, Hacker News, YouTube, blogs, and podcasts" (116 Discord, 79 Reddit, 72 X, 39 GitHub, 27 blogs, 19 YouTube, 9 HN), tagged by category (dev-workflow 80, personal-assistant 49, business-ops 48, enterprise 21…) with headline and quote, for example "Razorpay gives 220+ employees their own isolated, always-on Hermes agent".
- **Hackathons as a content engine.** Every entry is a public demo video tagging @NousResearch: March ($10k), April–May Creative with Kimi ($25k), June Accelerated Business with NVIDIA × Stripe ($17.5k cash plus three DGX Sparks and Stripe credits) ([sources](https://x.com/NousResearch/status/2066921443548348436)). DEV.to ran its own $1k Hermes challenge in May.
- **Memes and voice.** Irreverent lab persona: the "lobster" dig, "Elevate your soul.md", fit pics, a satirical TIME post later walked back by an "Editor's Note… intended as satire by our social intern". The Portal tiers are named "Release / Liberate / Unleash Hermes".
- **What they do not make:** no official demo videos, no "vs" pages on their own site (third parties wrote dozens: pickaxe, kanaries, thenewstack, innfactory, openclawvps, and OpenClaw's own docs page), and no founder-story long-form.

## 6. What resonated (top content by measured engagement)

| # | Content | Owner | Engagement (measured) | Why it worked (inference) |
|---|---|---|---|---|
| 1 | NetworkChuck, "you need to use Hermes RIGHT NOW!! (goodbye OpenClaw!!)", 2026-05-20 ([video](https://www.youtube.com/watch?v=QQEgIo4Juxg)) | Creator | 1,817,494 views | Framed as a switch from the incumbent everyone had just set up. It coincides with the fastest late-May intervals (05-19→20 +2,826, 05-21→22 +2,240), though snapshot times within a day are uncertain. |
| 2 | Tina Huang, "Hermes Agent Fundamentals In 29 Minutes", 2026-07-20 ([video](https://www.youtube.com/watch?v=5_N84t1rUU0)) | Creator | 708,220 views | Course-style, evergreen, from a creator who had already done "Local AI Agents" (778k) and an OpenClaw setup (397k). |
| 3 | Metics Media, "Hermes Agent - Full Tutorial & Setup Guide (For Beginners)", 2026-08-31 ([video](https://www.youtube.com/watch?v=DYdvJCxWd6M)) | Creator | 538,763 views | Beginner setup demand stayed high late in the cycle; the same channel's "OpenClaw vs Hermes Agent (Don't choose WRONG!)" drew 247k. |
| 4 | "Migrate from OpenClaw" docs page on HN, 2026-06-18 ([HN](https://news.ycombinator.com/item?id=48586005)) | Nous docs (third-party submitter) | 122 points, 105 comments; best HN result for any official URL | A switching guide is useful on its own and invites comparison debate. |
| 5 | The "lobster-themed agent" tweet, 2026-04-07 ([x.com](https://x.com/NousResearch/status/2041643678796570657)) | Nous | Engagement not measured here (X covered separately). The star rate went from about 3.5k/day (04-07/08) to 11.8k/day (04-09/10). | Timed to the competitor's crisis (Anthropic's cutoff three days earlier), joking, with a one-command remedy. |
| – | Hermes Desktop on Product Hunt, 2026-06-03 | Nous | #6 of the day, 210 points | Launched the day after an NVIDIA keynote demo, with a new form factor (GUI) aimed at a broader audience. |
| – | r/LocalLLaMA "AMA with Nous Research -- Ask Us Anything!", 2026-04-29 ([reddit](https://www.reddit.com/r/LocalLLaMA/comments/1sz2y76/)) | Nous (u/emozilla, very likely Quesnelle) | 316 points, 374 comments | Run with the sub's mods, at the peak of the April surge, in the sub where Nous's models already had credibility. |

Runners-up: Nate Herk's 1-hour course (399k), CodeHead's 5-minute explainer (384k), Samin Yasar "HERMES AGENT FULL COURSE 3 HOURS: Build & Sell" (361k), c't 3003 in German (307k), PAPAYA 電腦教室 in Chinese (290k, title claims a mass exodus from OpenClaw), zSecurity "AI Hacking Team" (282k), Alex Finn (236k, 177k), Greg Isenberg (199k). All are creator-owned (`youtube-search.json`, `youtube-top-dated.tsv`).

## 7. What did not work

- **The first Product Hunt launch flopped:** 9 points on launch day, not featured, #38 (2026-02-26), despite the parent brand's 377 PH followers and the Hermes 4 launch on the same product page. Desktop did much better four months later, once there was demand and a keynote behind it.
- **HN never adopted it.** Thirty official-URL submissions with a median of 2–3 points. Even the launch tweet scored 2. Inference: HN distrusts the "personal agent" category ("I still don't really get the case for OpenClaw/NanoClaw/Hermes Agent", "why not put codex/claude code/opencode in a docker container and be done with it?", [thread](https://news.ycombinator.com/item?id=48586005)).
- **The plagiarism response.** EvoMap accused Hermes of copying its Evolver architecture (04-14). The official account replied "…Delete your account" (later deleted), and issue #10232 had its title and body overwritten to "." with commenters blocked ([HN 48187581](https://news.ycombinator.com/item?id=48187581); measured: the issue now shows title ".", body ".", 21 reactions). It ran in Chinese and crypto media ([36kr](https://eu.36kr.com/en/p/3767967755371011), [KuCoin](https://www.kucoin.com/news/flash/evomap-accuses-hermes-agent-of-architectural-copying-nous-research-responds-with-delete-your-account)) and resurfaced on HN in August. No visible star dip (April was the peak), but it is the first thing critics link.
- **Default choices that read as off-brand for professionals:** a Polymarket skill enabled by default (co-founder defended it, [HN](https://news.ycombinator.com/item?id=48352073)) and an "anime girl" default personality ([HN comment](https://news.ycombinator.com/item?id=48373851)).
- **Quality and bloat complaints as the contributor firehose grew:** "Realising that Hermes is useless bloat" ([r/hermesagent](https://www.reddit.com/r/hermesagent/s/rLWoBEtg7W), mirrored on HN 07-23), "I advise against using Hermes Agent" ([bednars.me](https://bednars.me/blog/why-i-advise-against-using-hermes-agent), 07-12), "23000 open PRs and climbing" (08-24), "Hermes just mass emailed a bunch of accounts from 2020 with pairing requests." (r/LocalLLaMA 04-20, 121 points / 56 comments, the top Hermes post there in the surge window), CVEs in v0.8.0 webhooks (April), "Hermes AI agent used to automate attack on Thai Finance Ministry" ([BleepingComputer](https://www.bleepingcomputer.com/news/security/hermes-ai-agent-used-to-automate-attack-on-thai-finance-ministry/), 07-24). v0.22 answered with "stable release channels" and signed packages, a messaging shift from velocity to trust.
- **The TIME stunt.** On 10-16 @NousResearch posted "Thank you @TIME" with a Best Inventions listing. An "Editor's Note" the same day said it "was intended as satire by our social intern… Hermes was not selected for the list as we do not do paid PR placements" (both on the [nousresearch.com](https://nousresearch.com/) announcements feed). Outlets had already reported it as real ([runtimewire](https://runtimewire.com/article/nous-research-hermes-agent-time-best-inventions-2026)). It caused confusion and no star movement.
- **Abandoned or never-used channels:** the official YouTube (dormant since December 2025), the company blog (2 agent posts), and the official Reddit account (silent since 2026-06-27, even though its posts did well: 106–233 points in June). Cross-posting to the dormant r/nousresearch got 1–6 points.
- **Domain leakage.** Unaffiliated sites (hermes-agent.org, hermesagents.net, hermes-agent.us, hermesagent.best, ai-hermes-agent.com) rank for the name. One collected the second-best HN result (52 pts) for a page Nous does not own.

## 8. Timing

- **Announcements on X** cluster in US afternoon hours (snowflake-decoded): launch Wed 20:39 UTC; hackathon #1 Thu 17:16; multi-agent Mon 18:43; lobster Tue 22:25; creative hackathon Fri 19:38; NVIDIA Wed 23:22; Desktop Tue 16:12; business hackathon Tue 16:30; /learn Tue 21:01; RTX Spark/Windows Fri 16:21. Weekdays, 16–23 UTC, most often Tuesday (4 of 10).
- **Reddit:** official posts cluster around releases (04-08/09, 06-20..06-27), at mixed hours (01, 06, 08, 14, 19, 20 UTC). The r/LocalLLaMA AMA ran Wed 15 UTC (8 AM PDT), five days after a mod announcement.
- **Releases:** 41 in 7.5 months, about 5.5/month (Mar 5, Apr 6, May 5, Jun 2, Jul 5, Aug 8, Sep 5, Oct 5 so far). Weekday mix: Thu 12, Mon 10, Wed 6, Fri 6, Tue 3, Sat 3, Sun 1. The most common hours are 18–20 UTC (13 of 41). Version scheme changed from CalVer tags (v2026.4.8) to SemVer tags (v0.21.6+) in October with the "stable release channels" push.
- **Correlation with outcome:** timing explains little. The biggest jump came from reacting within 3–4 days of a competitor's crisis (04-04 → 04-07), not from a slot. The best HN result came Thu 14 UTC, but 29 other submissions spread across all days and hours did nothing. Product Hunt's 00:01 PT slot is fixed. The meaningful timing pattern (inference) is that **partner events set the dates**: Desktop shipped the day after GTC Taipei, the NVIDIA blog on the RTX AI Garage cadence, the Windows/RTX Spark post on the hardware's ship week.

## 9. Community and distribution mechanics

- **Lab brand as default trust.** The README badge "Built by Nous Research", "The self-improving AI agent built by Nous Research", and a Discord that already had 76k members five months before launch. The launch tweet did only 557 likes (Hermes Atlas). The brand did not make the launch viral; it made people try it once the category caught fire.
- **Ride the leader, then pass it.** Built-in migration from the incumbent (`hermes claw migrate`, later `import-agent claude-code|codex`), cheeky positioning in the incumbent's worst week, and a measurable leaderboard to claim (OpenRouter app rankings). "#1 on OpenRouter" became a recurring line in third-party articles.
- **BYO subscriptions as a growth wedge.** OAuth sign-in for SuperGrok (xAI co-announced, 05-15), Claude Pro/Max (09-21 docs), ChatGPT/Codex, plus `hermes proxy`, a local OpenAI-compatible endpoint backed by your subscriptions (v0.14). Hermes Atlas called this the "subscription bus" and "the killer-app feature… mostly being slept on." It also carries ToS risk: the Claude route rewrites identifiers ([vincentvandeth.nl](https://vincentvandeth.nl/blog/hermes-agent-claude-subscription-oauth)).
- **Free model promos through its own portal:** free Xiaomi MiMo v2 Pro for two weeks, promo code AGENTHERMES01, a "Run Nemotron 3 Ultra free" guide, a free trial model in the v0.22 first-run setup chat.
- **Hardware and model partners as distribution:** NVIDIA (keynote demo, blogs, DGX Spark prizes, RTX Spark launch partner, "Hermes Bench" score quoted for Nemotron 3.5), Microsoft (Windows agent setup flow), AMD, xAI, Kimi/Moonshot, MiniMax, Xiaomi, Stripe, OpenRouter (cookbook), Railway (template).
- **OSS contribution funnel at scale.** Per-PR @-credits in release notes; a `contributors/` directory of 1,863 email→login mappings and "salvage PRs" so community work gets credited even when re-landed by maintainers; 4,174 distinct commit author names; "~2,520 contributors" in the v0.22 cycle alone. Downside: tens of thousands of open PRs.
- **Plugin and skill marketplace as SEO and ecosystem.** A 600-entry reviewed plugin catalog with a page per plugin and per author ranked by stars, a skills hub on the agentskills.io standard, pluggable memory providers (mem0, Honcho, Hindsight… which promote Hermes support themselves). Hermes Atlas counted 250 ecosystem projects with 1.41M combined stars by 2026-09-18 ([report](https://hermesatlas.com/reports/state-of-hermes-september-2026)). The biggest third-party GUI, nesquena/hermes-webui ("The best way to use Hermes Agent from the web or from your phone!"), has 19,035 stars.
- **Community-run media layer.** Hermes Atlas (reports, newsletter, MCP server, GEO pages "vs-claude-code"), awesome-hermes-agent, gradually.ai statistics, a Wikipedia article. Nous retweets rather than produces this.
- **Docs built for agents and search:** llms.txt / llms-full.txt, provider-by-provider guides (AWS Bedrock, Azure Foundry, Vertex, Gemini, Ollama, MiniMax…), one page per messaging platform.
- **Free tier:** the software is entirely free; payment is only for models, tools or hosting.

## 10. Lessons for intentic

1. **Be ready to catch a competitor's bad week, with a one-command migration path.** Hermes shipped `hermes claw migrate` on 03-12. When Anthropic cut OpenClaw off on 04-04, Nous needed one joking tweet on 04-07 and got its largest growth in ten days (+66k stars). intentic's version: an importer that brings an existing Claude Code / Codex / Conductor-style setup (CLAUDE.md/AGENTS.md, MCP servers, worktrees) into an intentic sandbox, a "Migrate from X" page per competitor, and a short reply template for the day a rival changes pricing or terms.
2. **Recruit creators instead of making videos.** Nous's own YouTube is dead. The 1.8M, 708k and 539k-view videos were all made by creators. For intentic, a setup that installs in one command and looks good on camera (phone controlling parallel agents on your own box) is the asset. Seed it with the creator tiers that covered Hermes and OpenClaw (NetworkChuck, Alex Finn, Greg Isenberg, Nate Herk, Better Stack, WorldofAI).
3. **Make BYO subscriptions the headline, and be careful with ToS.** Hermes' OAuth and "subscription bus" story (Grok co-announced by xAI, Claude Pro/Max, Codex) is the same promise as intentic's "bring your Claude/Codex/Grok subscription". Co-announce with a model lab where possible, as xAI did for Hermes. Do not copy Hermes's identifier rewriting.
4. **Publish one measurable claim a leaderboard can confirm.** "#1 on OpenRouter" got repeated by press and creators. intentic needs its own checkable number (agents running in parallel per user, sandbox uptime, sessions reached from phones) or a public leaderboard placement.
5. **Turn the community's posts into owned social proof.** Copy the 371-entry "User Stories" collage, built by scraping X, Reddit, HN, YouTube and Discord and tagging by use case. It costs little, and it answers HN's standing objection ("I still don't get the case for these agents").
6. **Run small hackathons whose entries are public demo videos tagging you.** $10k in prizes (first place $7.5k) bought a burst of tagged demos in launch week two. Later rounds were co-funded by Kimi, NVIDIA and Stripe. A $2–5k "build something with parallel agents from your phone" contest fits intentic's budget.
7. **Don't count on HN or Product Hunt for a personal or agent-workspace product, put founders in Reddit AMAs, and don't fight critics.** Hermes's 30 HN submissions went nowhere except a "migrate from" page, and the cold PH launch scored 9. The mod-arranged r/LocalLLaMA AMA (316 points, 374 comments) and the r/hermesagent AMA (161 / 115) were the best owned results on any forum. The "Delete your account" reply became the top critical link. Launch on HN with a concrete, debate-worthy artifact (a migration guide, a cost or benchmark write-up), book AMAs in r/ClaudeAI / r/ClaudeCode / r/LocalLLaMA through their mods, and answer criticism in public with sources.
8. **Plug into the Hermes ecosystem directly.** intentic hosts agents in persistent sandboxes reachable from a browser or phone, the exact gap filled by hermes-webui (19k stars) and the "Workspaces & GUIs" category on Hermes Atlas. Supporting Hermes as a runnable harness and getting listed in awesome-hermes-agent and Hermes Atlas puts intentic in front of a 255k-star audience at near-zero cost. (Inference; check that the integration is real before pitching it.)

## X handles discovered

- [@NousResearch](https://x.com/NousResearch): company. The launch, hackathon, lobster, Desktop and RTX Spark posts are cited above.
- [@Teknium](https://x.com/Teknium): co-founder, main committer, posts the rankings and the defences ([status](https://x.com/Teknium/status/2043122514986139763)).
- [@theemozilla](https://x.com/theemozilla) (Jeffrey Quesnelle; Reddit u/emozilla and git author "emozilla" are very likely him, an inference from the handle), [@karan4d](https://x.com/karan4d) (Karan Malhotra), [@shivani_3000](https://x.com/shivani_3000) (Shivani Mitra), [@dillonrolnick](https://x.com/dillonrolnick) (Dillon Rolnick, CEO) and [@JSupa15](https://x.com/JSupa15) (Jai). These handles come from a single source, an IOSG Ventures post ([x.com/IOSGVC](https://x.com/IOSGVC/status/2087835208263623060)); confirm them on X.
- Community: [@ksimback](https://x.com/ksimback) (Kevin, Hermes Atlas reports and newsletter).
- Partner accounts tagged in Nous's own posts: @NVIDIAAI, @nvidia, @Windows, @Kimi_Moonshot, @stripe, @xai.
