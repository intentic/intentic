# Superset (superset.sh): marketing teardown

Research date: 19 October 2026. Raw data: `/work/.intentic/local/tmp/mkt-research/superset/` (star anchors, OSSInsight daily series, Wayback snapshots, releases, HN threads, Product Hunt leaderboards, sitemap, YouTube feed, Discord). Local clone used for history: `/work/refs/superset` (last commit 8 Aug 2026, later changes read through the GitHub API). X/Twitter was covered by a separate researcher. This file only lists the handles found.

Conventions: numbers come from the linked source on the research date. Lines starting **Inference:** are my reading of the evidence, not measurements.

## 1. What it is and who is behind it

| Item | Fact | Source |
| --- | --- | --- |
| Product | Electron desktop app (macOS, Linux AppImage "experimental", no Windows) that runs any CLI coding agent (Claude Code, Codex, OpenCode, Cursor Agent, Gemini, Copilot, Grok, Kimi and custom agents) in its own git worktree, with terminals, diff review, PR pane, in-app browser, automations, remote hosts and cloud workspaces, a CLI/SDK/MCP server, an iPhone/iPad app (Sep 2026) and "Pages". | [README](https://github.com/superset-sh/superset#readme), [homepage](https://superset.sh/) |
| Current pitch | Homepage: "Bring Any Agent Orchestrate Them All. One workspace for Claude Code, Codex, and any coding agent." Repo description: "agentic IDE to orchestrate 100+ coding agents in parallel. Run any agent with your own subscription." | [homepage](https://superset.sh/), [repo](https://github.com/superset-sh/superset) |
| Company | Superset Inc., San Francisco. GitHub org created 7 Nov 2025. Repo created 21 Oct 2025. First stars in Nov 2025 (star-history). | [org API](https://api.github.com/orgs/superset-sh), [team page](https://superset.sh/team) |
| Founders | Kiet Ho (CEO, ex-CTO and cofounder of Onlook, YC W25, Amazon, ServiceNow), Satya Patel (CTO, ex-CTO Untether Labs, YC W23, Google, Scribe), Avi Peltz (CPO, ex-CTO Adam, YC W25). Founding engineer Harshith Mullapudi (ex-CEO Core, YC S23). | [team page](https://superset.sh/team), [YC profile](https://www.ycombinator.com/companies/superset) |
| Origin | Built at the Vibecon hackathon at YC HQ, Nov 2025 (Kiet's tweet 14 Nov 2025). | [team page timeline](https://superset.sh/team) |
| YC | Spring 2026 batch ("P26"). In via YC's "Open Batch" in Mar 2026 (Kiet's tweet 5 Mar 2026). Demo Day Jun 2026. TechCrunch listed it among "11 standout startups". | [YC profile](https://www.ycombinator.com/companies/superset), [TechCrunch](https://techcrunch.com/2026/06/18/the-11-standout-startups-from-ycs-demo-day-according-to-vcs/) |
| Funding | $11.5M seed led by Union Square Ventures (Nick Grossman) with YC, Paul Graham, BoxGroup, Pioneer Fund, Liquid 2 and angels including Siqi Chen (Runway), Abhi Aiyer (Mastra CTO) and a Browser Use cofounder. Dated Jul 2026 on the team page. Caplight lists "$12M seed, 14 Aug 2026". | [team page](https://superset.sh/team), [Caplight](https://www.caplight.com/company/superset-sh) |
| Launch | First release v0.0.1 on 1 Dec 2025. Show HN the same day. | [releases](https://github.com/superset-sh/superset/releases), [HN 46109015](https://news.ycombinator.com/item?id=46109015) |
| License | Apache 2.0 until 4 Feb 2026, then Elastic License 2.0 ([PR #1181](https://github.com/superset-sh/superset/pull/1181), "elv2 license change"). README copy aligned on 17 Mar 2026. README now says "source available". The Launch HN post (May 2026) and YC profile still say "open-source". | `git log -- LICENSE.md` in the clone |
| Pricing | Free (1 user, local workspaces, desktop app), Pro $20/user/month or $15 billed yearly (remote workspaces, Linear, Slack, team collaboration, mobile), Enterprise custom. Pricing page added 21 Apr 2026. README (5 Aug 2026): "The desktop app is free forever." Mobile launch promo: "First month free with code MOBILELAUNCH". | [pricing](https://superset.sh/pricing), commit `38a080cf4`, [LinkedIn](https://www.linkedin.com/company/superset-sh) |
| Name change | "Superset will have a new name later this month" (blog, 12 Oct 2026): "There are many companies and projects with the same name." | [blog](https://superset.sh/blog/a-new-name) |
| Claims | "tens of thousands of engineers run Superset as their primary IDE, at companies like Wix, DoorDash, and Netflix". "1 of every 8 Fortune 500 companies use Superset" (founder post, Oct 2026). | [team page](https://superset.sh/team), [LinkedIn](https://www.linkedin.com/company/superset-sh) |

## 2. Growth curve

GitHub's stargazer listing is blocked from this sandbox, so the curve below is built from 26 Wayback captures of the repo page (exact counts), the star-history.com SVG (about 20 dated points) and the current API count. OSSInsight's daily series is used only for the timing of spikes: it captured ~25–45% of stars until March 2026 and almost none from June to August 2026, so its absolute numbers are not used.

| Month end | Stars (est.) | Gain in month | Anchors |
| --- | --- | --- | --- |
| Nov 2025 | 9 | 9 | star-history 30 Nov = 9 |
| Dec 2025 | ~230 | ~220 | Wayback 29 Dec = 218 |
| Jan 2026 | ~1,050 | ~820 | Wayback 28 Jan = 991 |
| Feb 2026 | ~2,550 | ~1,500 | Wayback 25 Feb = 1,941. 1 Mar = 2,817 |
| Mar 2026 | 8,321 | ~5,770 | Wayback 31 Mar = 8,321 (4 Mar = 4,460, 5 Mar = 4,874) |
| Apr 2026 | ~10,100 | ~1,780 | star-history 20 Apr = 9,468. Wayback 4 May = 10,300 |
| May 2026 | ~11,400 | ~1,300 | Wayback 22 May = 10,872. 24 May = 11,084. 2 Jun = 11,506 |
| Jun 2026 | ~12,150 | ~750 | Wayback 25 Jun = 12,089 |
| Jul 2026 | ~12,480 | ~330 | star-history 30 Jul = 12,477 |
| Aug 2026 | ~13,450 | ~970 | star-history 19 Aug = 12,918. 8 Sep = 13,785 |
| Sep 2026 | ~14,700 | ~1,250 | Wayback 25 Sep = 14,640 |
| 19 Oct 2026 | 15,367 | ~670 (partial) | GitHub API (1,361 forks) |

Other growth measures:

| Metric | Value | Source |
| --- | --- | --- |
| Releases | 184 desktop + 61 CLI tags + 3 other (248 total), 1 Dec 2025 – 19 Oct 2026 | [releases API](https://github.com/superset-sh/superset/releases) |
| DMG downloads (fresh installs, by month the release was published) | Dec 779, Jan 3,143, Feb 8,347, Mar 18,109, Apr 30,463, May 28,914, Jun 20,269, Jul 21,973, Aug 21,663, Sep 19,947, Oct (to 19th) 10,325 | release asset counts (`releases.json`) |
| Auto-update ZIP downloads per release | 22,051 for v1.29.0 (13–19 Sep 2026). 13,559 for v1.37.0 (8–14 Oct) | same |
| Homebrew cask `superset` | 2,759 (365 d), 639 (90 d), 258 (30 d) | [formulae.brew.sh](https://formulae.brew.sh/api/cask/superset.json) |
| Contributors | ~134 (contributors API incl. anonymous). Top three are the founders (2,466 / 1,606 / 479 commits) | GitHub API |
| Stargazer countries (OSSInsight sample with location) | US 20%, China 16%, India 5%, Brazil 5%, France 4%, UK 4%, Korea 4% | [OSSInsight](https://ossinsight.io/analyze/superset-sh/superset) |

**Inference:** DMG downloads stopped growing after April (~20–30k a month). Each new release is downloaded 10–20k times by the auto-updater within a week, which fits the "tens of thousands" of active installs claim. The app's active base is far larger than Homebrew suggests.

### Biggest jumps and the events behind them

| # | Window | Stars | Event | How matched |
| --- | --- | --- | --- | --- |
| 1 | 27 Feb – 9 Mar 2026 | 1,941 (25 Feb) → 4,874 (5 Mar) → ~8,300 (31 Mar) | Product Hunt #1 on Fri 27 Feb ("Run an army of Claude Code, Codex, etc. on your machine", 521 upvotes) plus the "Introducing Superset" video the same day ([12,388 views](https://www.youtube.com/watch?v=mk02bSQmEKY)). YC acceptance tweet Thu 5 Mar. | OSSInsight daily stars jump from 24 (27 Feb) to 105 (28 Feb), 142–155/day (1–4 Mar), then a second peak 91–126/day (7–9 Mar) after the YC tweet. **Inference:** the size of the March gain (~5.8k) is more than a PH day usually gives, so GitHub Trending likely amplified it. No trending archive was reachable to confirm. |
| 2 | 29 Dec 2025 – Jan 2026 | 218 → ~1,050 | Show HN "Terminal to run 10 parallel coding agents", submitted Tue 23 Dec, reached the front page only on Mon 29 Dec (first comment 19:00 UTC, 55 comments that day). Then a wave of testimonial tweets from known founders 11–21 Jan (Mastra CTO, Browser Use cofounder and others, now on the site's wall of love). | Comment timestamps in `hn_item_46368739.json`. OSSInsight 25 and 36 stars on 29–30 Dec vs 1–7/day before. Tweet IDs decoded to 11–21 Jan. |
| 3 | Apr 2026 | ~8,300 → ~10,100 | Superset 2.0 beta and "10,000 GitHub stars" (team timeline, Apr 2026). A third-party tracker shows the repo trending on 25 Apr 2026. Japanese guide on note.com (7 Apr 2026). | [team page](https://superset.sh/team), [Nemati AI](https://nemati.ai/en/blog/github/superset-sh/superset), [note.com](https://note.com/masa_wunder/n/n562b695ead6a) |
| 4 | Sep 2026 | ~22/day in Aug → ~42/day in Sep | Superset Mobile (#1 on PH, Mon 21 Sep). README translated into 16 languages (29 Aug) and the app into 17 (changelog 30 Aug). "The Production Run" campaign launched 27 Aug for September. | star-history slope 30 Jul→19 Aug (22/day) vs 19 Aug→28 Sep (42/day). OSSInsight shows the rise starting 2 Sep, before the mobile launch. **Inference:** the step up began with the localized README and the leaderboard campaign, and the mobile launch held it. |
| 5 | 22–24 May 2026 | 10,872 → 11,084 | Launch HN (YC) "Superset (YC P26) – IDE for the agents era", 108 points / 135 comments. | Wayback captures on 22, 23 and 24 May: only ~210 stars over two days. |

## 3. Channel inventory

| Channel | Where | Measured activity | Status now |
| --- | --- | --- | --- |
| GitHub repo + README | [superset-sh/superset](https://github.com/superset-sh/superset) | 41 README revisions in the clone to Aug 2026. README in 16 languages since 29 Aug 2026. Star/release badges. "Documentation for agents" (llms.txt) section. | Main landing page for developers. |
| Releases / changelog | [GitHub releases](https://github.com/superset-sh/superset/releases), [superset.sh/changelog](https://superset.sh/changelog) | 248 releases. 35 weekly changelog posts: Dec 3, Jan 4, Feb 4, Mar 5, Apr 2, May 1, Jun 0, Jul 3, Aug 6, Sep 4, Oct 3. | Weekly again since July. |
| Blog | [superset.sh/blog](https://superset.sh/blog) | 17 posts: engineering deep dives (Jan), roadmap and guides (Feb), then a gap until Aug. Aug–Oct: Production Run, mobile, leaderboard, name change, how-to guides. | Active. |
| Comparison / SEO pages | [superset.sh/compare](https://superset.sh/compare) | First four on 2 Feb 2026 (vs Conductor, Cursor, OpenCode, Warp). 66 files by 8 Aug. 131 compare URLs in the sitemap on 19 Oct (vs/alternative pages for ~45 tools, "best IDE for X CLI", "X vs Y" between other tools). | Heavy investment since Jul 2026. |
| Programmatic pages | sitemap | 3,508 URLs: 2,383 public user profiles (leaderboard), 459 marketplace pages (themes, agents), 17 locales × ~55 core pages. | Growing with users. |
| Docs | [docs.superset.sh](https://docs.superset.sh) | llms.txt and llms-full.txt for agents. Site also serves `/.well-known/agent-card.json`, MCP and agent-skills endpoints. | Active. |
| X | @superset_sh and founders | YC launch post (May 2026) cites "5K+ followers on X". Covered by the X researcher. Weekly "What we shipped" threads are drafted in the repo (`content/changelog/*-tweet.md`), "drafted by an agent running in Superset". | Primary social channel. |
| Discord | [discord.gg/cZeD9WYcV7](https://discord.gg/cZeD9WYcV7) | 1,285 members, 182 online. Created 6 Dec 2025. A bot files every support message as a Linear issue and has Claude rewrite it ([apps/discord-triage](https://github.com/superset-sh/superset/tree/main/apps/discord-triage)). | Active. |
| YouTube | [@superset-sh](https://www.youtube.com/@superset-sh) | 15 latest videos (RSS), 29 Jan – 21 Sep 2026. Top: "Introducing Superset" 12,388, "What the heck is Superset 2.0?" 5,989, "Advanced Superset usage" 3,849. Recent ones 191–1,036 views. | Irregular, ~1–2/month. |
| LinkedIn | [company page](https://www.linkedin.com/company/superset-sh) | 2,366 followers. Reposts founder posts (leaderboard stats, Fortune 500 claim, mobile launch, hackathon). | Active. |
| Hacker News | founders | 3 launches (table below). Founders replied 6–20 times each per thread. Kiet posts in "Who is hiring?" (Oct 2026). | Used for launches only. |
| Product Hunt | [product page](https://www.producthunt.com/products/superset-5) | 3 launches, two #1s. 1.9K followers, 8 reviews. | Used for every major release. |
| Reddit | n/a | No owned subreddit found. Archive title search (arctic-shift, partial because the API was rate-limited: r/ClaudeCode and r/ClaudeAI for Dec 2025 – Jan 2026, 20 Feb – 31 Mar and Apr – mid-Jun 2026) found 5 posts with "superset" in the title, none by the team: "My thoughts on Conductor vs Superset vs cmux vs vanilla Claude Code" (19 Mar 2026, 4 upvotes, 5 comments, [post](https://www.reddit.com/r/ClaudeCode/comments/1rxwkoz/)), two requests for a Windows alternative (Mar 2026, one in Portuguese), a Portuguese question about workspace tools (Apr 2026) and the lanes.sh billing workaround cross-post (15 May, 0 upvotes). | Not a launch channel for the team. |
| Talks / podcasts | Mastra | "How to run 100 Agents in Parallel - Superset at Mastra's TSAI Demo Day" (14 Apr 2026, [1,106 views](https://www.youtube.com/watch?v=8AfjxJu_ViI)). Hackathon booth and the YC "Own Your Intelligence" hackathon (Sep 2026, LinkedIn). | Occasional. |
| App Store | [Superset: 100+ Coding Agents](https://apps.apple.com/us/app/superset-100-coding-agents/id6788926383) | 25 US ratings, 5.0. Released 9 Sep 2026. Store name packed with keywords. | New. |
| Homebrew | cask `superset`, tap `superset-sh/homebrew-tap` (CLI) | see §2 | Maintained. |
| Awesome lists / directories | n/a | 151 GitHub READMEs reference `superset-sh/superset`, incl. [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators), awesome-vibe-coding, awesome-cli-coding-agents, awesome-claude-code. | Broad organic coverage. |
| Partner docs | Vercel | Vercel AI Gateway "Configure Superset" page ([docs](https://vercel.com/docs/ai-gateway/coding-agents/superset)). | Present. |
| Agent distribution | [superset-sh/skills](https://github.com/superset-sh/skills) | `npx skills add superset-sh/skills` turns Claude Code or Codex into an orchestrator of Superset workspaces (Aug 2026). | New. |
| Newsletter | none found | n/a | n/a |

## 4. Launch history

| Title (exact) | Date (UTC) | Weekday, hour UTC | Score / comments | Outcome |
| --- | --- | --- | --- | --- |
| HN: "Show HN: Superset – Run 10 parallel coding agents on your machine" (by Kiet, link to GitHub) | 2025-12-01 | Mon 16:06 | 24 / 3 | Flop. |
| HN: "Show HN: Superset – Terminal to run 10 parallel coding agents" (by Avi, link to superset.sh + demo video) | 2025-12-23 | Tue 19:52 submitted. Front page Mon 29 Dec from ~19:00 | 96 / 90 | Front page. Jan stars ~4× Dec. |
| PH: "Superset: Run an army of Claude Code, Codex, etc. on your machine" | 2026-02-27 | Fri | #1 of the day. 64 comments / 521 upvotes (leaderboard "64521", Launch Llama reports 512) | Launch of the Day and of the Week. Biggest star month. |
| PH: "Superset 2.0: Run 100s of coding agents on any machine from anywhere" | 2026-05-06 | Wed | #3. Leaderboard "47395", most likely 47 comments / 395 upvotes (inference) | Launch of the Day badge. |
| HN: "Launch HN: Superset (YC P26) – IDE for the agents era" | 2026-05-22 | Fri 14:53 | 108 / 135 | Front page. Small star effect (~210 in two days). |
| PH: "Superset Mobile: Your coding agents, now in your pocket" | 2026-09-21 | Mon | #1. Leaderboard "56355", most likely 56 comments / 355 upvotes (inference) | Launch of the Day and of the Week. |
| Reddit: no launch post by the team found in r/ClaudeCode or r/ClaudeAI (partial archive coverage, see §3) | n/a | n/a | n/a | No Reddit launch. |
| Blog + hero pill: "Superset will have a new name later this month" | 2026-10-12 | Mon | n/a | Reveal pending. |

**Title signal:** the same Show HN failed with "Run 10 parallel coding agents on your machine" + a GitHub link and worked three weeks later as "Terminal to run 10 parallel coding agents" + website + demo video, posted by a different founder. **Inference:** the category noun ("Terminal", later "IDE") and the demo video did more than the wording change itself. The resurfacing a week later is what put it on the front page. On Product Hunt the playful, concrete "Run an army of Claude Code, Codex, etc." beat the abstract "100s of coding agents on any machine from anywhere" (#1 vs #3).

## 5. Content patterns and voice

- **Number escalation as positioning:** README "Run 10+ parallel coding agents on your machine" (Nov 2025) → "run 100 CLI coding agents on your machine without losing your mind" → "Run 100s of coding agents" (PH, May 2026) → "orchestrate 100+ coding agents" (repo description, App Store name).
- **Tagline churn** (README history): "The last developer tool you'll ever need" (23 Nov 2025) → "A Terminal Built for Coding Agents" (30 Nov) → "The Terminal for Coding Agents" (28 Jan 2026) → "The Code Editor for AI Agents" + "Orchestrate swarms of Claude Code, Codex, and more in parallel" (21 Mar) → hero "Bring Any Agent Orchestrate Them All" (13 Aug, "reposition hero around parallel-agents value prop") → plain README line "Run Claude Code, Codex, or another CLI agent with terminals, code review, and browser previews in one workspace" (Oct). Company line: "Building the last piece of software."
- **Hooks:** "Wait less, ship more.", "Code 10x Faster With No Switching Cost", "What do you do when your coding agent is running? Our answer is to start another coding task in parallel… With Superset, you can run 100." (README, Nov 2025).
- **Comparison pages at scale:** factual tables with competitor doc links, a "Try it in your repository" trial protocol and an FAQ, plus a disclaimer ("This comparison is published by Superset") ([example](https://superset.sh/compare/superset-vs-conductor)). Also "X vs Y" pages about other tools (claude-code-vs-codex, cursor-vs-windsurf, conductor-vs-cursor) that catch searches where Superset is not the subject.
- **Weekly changelog + launch thread**, written by an automation and labelled as such ("This changelog draft was created by an automation").
- **Founder engineering deep dives:** "Keeping Terminal Sessions Alive Across Electron App Restarts", "Git Worktrees: The Feature That Waited a Decade for Its Moment" (Jan 2026). One personality post ("How to get hit (probably in the face but anywhere else works too)", Kiet).
- **Manifesto + public metric campaign:** "Factory 2026" levels, "Our plan for running 100 Parallel Coding Agents", and "The Production Run" (27 Aug 2026): a dated prediction graded on the public leaderboard ("Predictions that can't be checked are marketing").
- **Gamification:** public token leaderboard and profiles ("$24.6M worth of AI tokens… 2,053 developers who opted in", LinkedIn), "Super Fights" turning two profiles into pixel monsters.
- **Social proof:** wall of love built from 11 X posts (Jan–Mar 2026) by founders such as Mastra's CTO and Browser Use's cofounder. Logo strip (Microsoft, OpenAI, Salesforce, Datadog, Vercel, Cloudflare…).
- **Demo videos:** "Introducing Superset" on Product Hunt day, "What the heck is Superset 2.0?", short feature videos ("Superset Pages", "Lesson 1: Automations").

## 6. What resonated (top content by engagement)

| # | Piece | Numbers | Why it probably worked (inference) |
| --- | --- | --- | --- |
| 1 | PH launch "Run an army of Claude Code, Codex, etc. on your machine" + "Introducing Superset" video (27 Feb 2026) | #1 of day, 521 upvotes, 64 comments. Video 12,388 views. ~5,800 stars in March | Concrete, slightly cheeky tagline naming the agents people already use. Beat Claude Code Remote Control (#2) on the same day. Open source + free gave a reason to star. |
| 2 | Launch HN (22 May 2026) | 108 points, 135 comments | YC Launch HN placement. Founders answered 45 comments. Switching stories from Conductor users in the thread. |
| 3 | Show HN, second attempt (front page 29 Dec 2025) | 96 points, 90 comments | Website + demo video instead of a bare repo. Front page in the week between Christmas and New Year, when fewer launches compete. |
| 4 | Superset Mobile PH (21 Sep 2026) | #1 of day. ~355 upvotes, 56 comments (inference) | Mobile filled a gap that had cost users (some left for Paseo while waiting, see §7). |
| 5 | Leaderboard stats post on LinkedIn ("$24.6M worth of AI tokens", Oct 2026) and the 2,383 public profiles | 2,053 opted-in developers | Gives users a rank to share. Each profile is an indexable page. |

## 7. What did not work

- **First Show HN flopped** (24 points, 3 comments, Mon 1 Dec 2025), as a bare GitHub link from the CEO's account.
- **Name collision with Apache Superset** came up in both front-page HN threads: "Not to be confused with Apache Superset" (Dec 2025), "Confusing name. Superset is already an established analytics tool.", "We live in this era when folks can vibecode entire startups without ever making a simple Google Search" (May 2026, [thread](https://news.ycombinator.com/item?id=48236770)). Result: rename announced 12 Oct 2026, after 15k stars and three PH launches under the old name.
- **Category fatigue:** "How many 'IDEs for the agentic era' do we need?", "zed, orca, /.+mux.*/ … they all look incredibly / increasingly the same?", "These whack-a-mole tools are pointless.", "Is anyone actually using agent swarms for anything real?" (Launch HN).
- **Pricing and business model doubts:** "No linear integration in free version and taxing it 20$/m is a bit steep", "I will buy it for onetime payment rather than 20 dollars monthly", "How do you plan to sustain the business, given that your product here is open source & already has many competitors" (Launch HN).
- **"Open source" vs ELv2:** relicensed to ELv2 in Feb 2026 but still marketed as "open-source" in May. A commenter quoted the FAQ's ELv2 self-hosting line back at them.
- **Platform gaps as top GitHub requests:** "[feat] use in ssh server" (34 reactions), "Linux support" (23), "[feat] Make login non-required" (22), Windows (14 and 12). Community Windows forks exist (e.g. [Ashesh3/superset-windows](https://github.com/Ashesh3/superset-windows), 25 stars).
- **Stability churn:** "There were some annoying issues, with freezing and terminal not being rendered… I moved on. I installed Zellij" (Launch HN). "Performance regression: periodic input lag" issue (18 reactions).
- **Lost users to a faster mobile competitor:** "+1 for Paseo. Switched over to it a few weeks ago from conductor.build then superset.sh. The mobile app…" and "I've been waiting on superset.sh's mobile app for a while, which is what made me look around and find Paseo" (Aug 2026, HN [1](https://news.ycombinator.com/item?id=49237141), [2](https://news.ycombinator.com/item?id=49260865)).
- **Weak demo:** "I found the demo video a bit disappointing. A bit too slow, a bit too choppy, a bit hand wavy." (Launch HN). Product tour videos published after the launch got 191–1,245 views.
- **Sloppy proof:** a commenter noticed a homepage testimonial referencing a date that had not happened yet (Launch HN, sebmellen).
- **Quiet stretch during YC:** one changelog post in May and none in June 2026. June releases fell to 7 (from 31 in May). July stars (~330) were the lowest since December.
- **Launch HN barely moved stars** (~210 in two days) despite 108 points.

## 8. Timing

| Launch | Day / time | Result |
| --- | --- | --- |
| Show HN #1 | Mon 16:06 UTC | 24 pts |
| Show HN #2 | submitted Tue 19:52 UTC. Front page Mon 29 Dec ~19:00 UTC (11:00 PT), holiday week | 96 pts |
| PH #1 | Fri 27 Feb | #1 |
| PH 2.0 | Wed 6 May | #3 |
| Launch HN | Fri 14:53 UTC (07:53 PT) | 108 pts |
| PH Mobile | Mon 21 Sep | #1 |
| Post announcing the new name | Mon 12 Oct | n/a |

- **Release cadence:** 248 releases. Per month Dec 38, Jan 19, Feb 26, Mar 26, Apr 22, May 31, Jun 7, Jul 24, Aug 24, Sep 19, Oct 12 (to 19th). By weekday: Mon 45, Fri 43, Tue 42, Thu 42, Wed 37, Sat 22, Sun 17. Desktop minor versions ship every 1–6 days (v1.32 → v1.38 between 29 Sep and 14 Oct).
- **Changelog posts:** Monday from Dec to Mar, Sunday since Aug ("weekly changelog 2026-10-18").
- **Inference:** the Friday PH launch won #1, the Wednesday one came #3, the Monday one won again. Product and tagline explain more than weekday. On HN both front-page runs happened on a second showing (re-surfaced post, then a YC Launch HN slot), not at first submission.

## 9. Community and distribution mechanics

- **OSS funnel:** ~134 contributors, community Windows forks, 151 READMEs and awesome lists linking the repo. YC launch post leads with "11K+ Github stars and 75+ contributors".
- **Free forever desktop + BYO subscriptions:** "Running agents in parallel on your own machine will never require payment" (README). Paid tier only for remote, team and mobile features. The repo description sells "Run any agent with your own subscription".
- **SEO at scale:** 131 comparison URLs, 17 locales of the core site, 2,383 profile pages, 459 marketplace pages, plus llms.txt and `.well-known` agent files so assistants can read and recommend it.
- **Advocates who became investors:** early testimonials came from founders who later appear as investors or partners (Mastra's CTO, Browser Use's cofounder). Mastra hosted the TSAI Demo Day talk. Superset ships an agent built on Mastra.
- **Partner listings:** Vercel AI Gateway docs page. Agents added as first-class integrations quickly (Grok, Kimi, Hermes, Kiro, Antigravity CLI, Vercel's fx, Devin CLI), each a reason for that vendor's users to try it.
- **Distribution through other agents:** skills repo (`npx skills add superset-sh/skills`), CLI, SDK and MCP so other agents can drive Superset.
- **Support loop in public:** Discord messages become Linear issues automatically, which keeps the community channel responsive with a small team.
- **Gamified usage data:** leaderboard, Super Fights, Production Run. Usage stats then reused as marketing claims.
- **Promotions:** launch codes (MOBILELAUNCH), SOC 2 Type II announcement (27 Aug 2026), hackathon booths.
- **Absent:** referral or affiliate programme, newsletter, owned subreddit.

## 10. Lessons for intentic

1. **Launch on Product Hunt with a concrete, playful tagline that names the agents.** "Run an army of Claude Code, Codex, etc. on your machine" took #1 and drove Superset's biggest month. The abstract 2.0 tagline came #3. Intentic's first PH line should name Claude Code, Codex and Grok and the "from your phone" benefit.
2. **Treat HN as two shots, and make the second one count.** Superset's Show HN that linked only the repo flopped. The version with the website and a demo video worked when it resurfaced. Prepare the website, a 60–90 s demo and a founder who can answer comments for a full day, and expect the run to come days after submission.
3. **Pick a name nobody else owns.** Superset is renaming after 15k stars because of Apache Superset. Conductor lives on its domain name. Check intentic's name against search results and package registries before spending on launches.
4. **Build comparison pages early, with honest tables.** Superset started with four "vs" pages two months in and now has 131, written as tables with sources, a trial protocol and an FAQ. Intentic already has compare pages. Extend them to "X vs Y" pages between other tools and "best IDE for <CLI>" pages, where buyers search before they know intentic exists.
5. **Localize the README.** Superset's star rate roughly doubled in the weeks after its README went out in 16 languages (a correlation, the leaderboard campaign started the same week), and China was already 16% of located stargazers. A translated README is cheap for an MIT repo.
6. **Lead with mobile access, where intentic is already ahead.** Superset lost users to Paseo while its mobile app was missing, then won PH #1 with it. Intentic's "reach any sandbox from any browser or phone" already exists: lead with it in launches and comparison pages.
7. **Make usage shareable.** A public leaderboard, profiles and a dated, measurable campaign gave Superset recurring posts and 2,383 indexable pages. An opt-in "agent hours / parallel sessions" profile would do the same for intentic.
8. **Keep the license story consistent.** Superset's "open-source" claims after moving to ELv2 drew pointed comments. Intentic's MIT license is a clean differentiator against both ELv2 Superset and closed-source Conductor. Say "MIT" in every launch title or first line.

## X handles found

- Company: [@superset_sh](https://x.com/superset_sh)
- Kiet Ho (CEO): [@kietho_](https://x.com/kietho_) (team profile and `content/people/kiet.mdx`). The timeline on the team page links tweets from [@FlyaKiet](https://x.com/FlyaKiet) (README also lists @flyakiet), likely the same person under an older handle (not verified)
- Avi Peltz (CPO): [@avimakesrobots](https://x.com/avimakesrobots)
- Satya Patel (CTO): [@saddle_paddle](https://x.com/saddle_paddle)
- Harshith Mullapudi (founding engineer): [@itsmeharshithm](https://x.com/itsmeharshithm)
- Advocates quoted on the wall of love: [@abhiaiyer](https://x.com/abhiaiyer/status/2013782002332283180) (Mastra CTO, investor), [@gregpr07](https://x.com/gregpr07/status/2013038355630432742) (Browser Use), [@fcoury](https://x.com/fcoury/status/2010477904472281220), [@ChaseMcDou](https://x.com/ChaseMcDou/status/2013458004977373643), [@LeosReal](https://x.com/LeosReal/status/2027306293858586745), [@ivenvd](https://x.com/ivenvd/status/2011738469610242559), [@vladzima](https://x.com/vladzima/status/2032306550073610246), [@eliasstravik](https://x.com/eliasstravik/status/2020580091449708978)
