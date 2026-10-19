# Synara (trysynara.com): marketing teardown

Researched 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/synara/` (written `synara/` below: repo, releases, star-history points, release downloads, HN, Reddit attempts, founder YouTube feed, sitemap, the Trendshift page `trendshift.md`, and Wayback plus live site captures `site-snapshots.txt`) and the X captures in `/work/.intentic/local/tmp/mkt-research/x/` (written `x/`; the cross-account analysis is [x-twitter.md](x-twitter.md), whose figures are reused here). Local clone: `/work/refs/synara` (read-only; its history stops at 2026-08-09, so later facts come from the GitHub API and `synara/releases.json`). "Inference" marks anything not directly measured.

**Identity.** Synara is the renamed DP Code. [Emanuele-web04/synara](https://github.com/Emanuele-web04/synara) was created 2026-03-27 (`synara/repo.json`). It shipped as "DP Code" from v0.0.16 (Apr 11) to v0.0.50 (May 28) and as "Synara" from v0.0.51 (Jun 1) (`synara/releases.json`; commit 17d5614f "Rename DP Code branding to Synara", May 30). The old domain dpcode.cc now serves the Synara page. **Remodex** (`synara/remodex-starhistory-points.json`) is the founder's earlier product, and he still runs it: [Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex), "Remote Control for Codex". It is a paid, open-source iOS app (Swift, Apache-2.0) that steers Codex on a Mac from an iPhone, and it has 3,345★ (GitHub API, Oct 19). Its audience seeded DP Code.

## 1. What it is and who is behind it

- **Product.** "A focused workspace for coding agents. Projects, provider sessions, execution surfaces, and review tools in one local-first desktop application" (`synara/README.current.md`). It is an Electron app for macOS, Windows x64 and Linux x64 that wraps agent CLIs that are already installed and logged in: Codex, Claude Code, Cursor, Antigravity, Grok Build, Factory Droid, OpenCode, Pi, Devin and Oh My Pi ([trysynara.com](https://www.trysynara.com/)). Other features: worktrees, terminals, an in-app browser, diffs and PR review, same-chat handoffs between providers, Hubs (a coordinator plus up to 8 parallel workers), automations, MCP, iOS Simulator control (v0.7.2, Aug 14) and a Computer Use beta on macOS (v0.9.0, Sep 21) (`synara/releases.json`).
- **Remote and phone are new.** `REMOTE.md` documents a headless server reached over LAN or Tailscale with an auth token. "Synara Remote" went to early access through 17 prerelease builds on Oct 16–18. It pairs computers with an iPhone or iPad app, and sign-in goes through GitHub via WorkOS (`synara/releases.json`, v1.0.6-remote.8 to .26). Inference: Synara is moving onto intentic's ground.
- **Origin: a clone of T3 Code.** T3 Code is [pingdotgg/t3code](https://github.com/pingdotgg/t3code), with 28,570★. The clone carries T3 Code's history: its first commits date from 2026-02-07, and the founder's first is 2026-03-27 (`git log`). GitHub does not mark Synara as a fork (`"fork": false`, API). The DP Code README said "This project started as a clone of T3Code" (commit 91512f6a), and the dpcode.cc footer read "DP Code: clone from T3 Code" ([Wayback, Apr 11](https://web.archive.org/web/20260411005935/https://dpcode.cc/)).
- **Founder.** Emanuele Di Pietro: GitHub [Emanuele-web04](https://github.com/Emanuele-web04), X [@emanueledpt](https://x.com/emanueledpt) (11,678 followers, 30,551 posts). His bio reads "Just an italian guy following his dreams / Road to $10k/mo | iOS & Web dev | 22 … Founder of Remodex & Synara" (`x/raw/emanueledpt.profile.json`). He built small iOS apps and SaaS projects before this. He has been "Codex Ambassador in Italy" since May 6 (394 likes) and joined the Claude Startup program on Oct 9 (71 likes). He applied to YC Summer with "Remodex + DPCode" (YouTube, Jun 1, `synara/founder-youtube-feed.xml`) and resubmitted on Oct 18: "round 2, and the last shot I'm gonna give at YC" (143 likes) (`x/raw/emanueledpt.*.json`).
- **Collaborators.** Marve10s has 62 post-fork commits (`git shortlog`). Kartik ([@1kartikkabadi1](https://x.com/1kartikkabadi1)) owns the Beta channel repo [kartikkabadi/synara-beta](https://github.com/kartikkabadi/synara-beta) (created Sep 6) and posts as part of the team ("We're working on bringing Computer Use to @trySynara", `x/raw/wom.synara2.json`).
- **Company, funding:** none. "Synara is funded entirely by sponsorship — there's no paid tier and no company behind it" ([/sponsors](https://www.trysynara.com/sponsors)).
- **Business model.** Free, MIT, no account. Donations go through GitHub Sponsors (five donors listed, all since Aug 2–4, [/donors](https://www.trysynara.com/donors)). Commercial sponsorships launched Sep 30 at €250, €500 and €2,000 a month; the top tier includes posts from both X accounts ([/sponsor](https://www.trysynara.com/sponsor)). On Oct 19 the homepage slot still reads "Your product here" (`synara/site-snapshots.txt`), and on Oct 8 the founder posted "$0 from sponsorships yet". Inference: Remodex pays his bills (he reported $553 MRR a day after launch and $4,000 MRR on Apr 23).
- **Size today:** 2,126★, 328 forks, 1,569 PRs (1,067 merged), 404 issues (135 open) (GitHub API, Oct 19). The site counter shows 22,045 downloads, and there are 122 releases (98 stable).

## 2. Growth curve

Month-end stars are interpolated from star-history.com points (`synara/starhistory-points.json`, `synara/stars-by-month.csv`). Exact anchors come from the site's star badge in Wayback captures (`synara/site-snapshots.txt`). Daily gains for Aug 20 to Oct 19 come from [Trendshift](https://trendshift.io/repositories/54384) (`synara/trendshift.md`: +557★ in 61 days, slightly under star-history's +569). The stargazer API returns 404 through the gateway.

| Month end | Stars | Gain | Anchor |
|---|---|---|---|
| 2026-03 | 2 | +2 | repo created Mar 27 |
| 2026-04 | 287 | +285 | badge 39 on Apr 11 |
| 2026-05 | 530 | +243 | badge 367 on May 1 |
| 2026-06 | 972 | **+442** | badge 656 on Jun 6; GitHub TypeScript trending #9 on Jun 15 (Trendshift) |
| 2026-07 | 1,359 | +387 | badge 1.2K on Jul 12 |
| 2026-08 | 1,600 | +241 | badge 1.5K on Aug 10 |
| 2026-09 | 1,937 | +337 | badge 1.9K on Sep 23; Trendshift +293 |
| 2026-10 (to 19th) | 2,126 | +189 | GitHub API; Trendshift +206 |

**Downloads run at about 10 per star.** The site counter read 3,238 on Jun 6, 8,351 on Jul 12, 12,996 on Aug 10, 17,809 on Sep 23 and 22,045 on Oct 19 (`synara/site-snapshots.txt`), a steady 110 to 170 a day. GitHub release assets hold 22,218 first-time installers (`synara/release-downloads-by-month.csv`): 41.2% Windows .exe, 40.9% macOS arm64, 14.9% Linux AppImage and 3.0% macOS Intel. Per-release counts mostly measure how long a build stayed "latest": the top one, v0.9.2 (1,813 installers), was current from Sep 25 to Oct 4.

**Remodex for comparison:** 151★ on Mar 10, two days after the founder's "I'm making this project open source" post (130 likes, 153K views). It had 1,328 by Mar 23, before its App Store launch, and 2,091 by Apr 18 (`synara/remodex-starhistory-points.json`). It passed Synara's current count in six weeks.

**Biggest jumps and what lines up with them:**

1. **Apr 6–18: 4 → 161★.** DP Code's first release (Apr 11) came two weeks after "Introducing Remodex" (Mar 26: 820 likes, 401K views). On Apr 15 the founder posted "@theo just talked about me inside his most recent video" (490 likes, 48K views). DP Code's own feature post on Apr 17 got 52 likes (`x/raw/emanueledpt.*.json`). Inference: the Remodex audience and Theo's mention produced the first stars, not a DP Code launch.
2. **Apr 29–May 11: 271 → 462★.** On May 3 @dhruvtwt_ posted "6 AI agent orchestration tools worth trying at least once: 1. Superset 2. DP Code…" (407 likes, 714 bookmarks, 50K views; `x/raw/paseo_sh.wr.json`). Matched by date.
3. **Jun 3–26: 543 → 901★, the best month.** The rename post went up Jun 1 ("Introducing Synara — former DP Code", 224 likes, 34K views). The repo hit TypeScript trending #9 on Jun 15, and Chinese creator @WWTLitee (67K followers) wrote it up on Jun 16 (82 likes). The founder also promoted it in replies under T3 Code's posts and apologised on Jun 25 for "the spam of Synara under T3Code's post". Inference: June's Anthropic subscription turmoil, which he posted about angrily (799 and 782 likes), helped multi-provider tools.
4. **Sep 5–10: +15, +19, +44, +15, +22, +14★.** Sep 7 is the best day in Trendshift's window. That week the brand posted a captionless image, its best post ever (496 likes, 58K views). The founder ran GPT-6 Astra overnight to audit the Synara repo (348 likes, 628 bookmarks, 87K views) and posted the result, "2,901 net fewer lines" (150 likes). The brand replied "This already exists. It's called Synara." to @forgebitz's 1,477-like "can someone build a cursor/codex alternative that just works with all models" (67 likes, 15K views). @object_nullll recommended it in Chinese (165 likes, 56K views), and @voidyaps listed it (372 likes). The GH Archive sample shows 7 and 9 watch events on Sep 5–6, against 0–3 on other days (`/work/.intentic/local/tmp/mkt-research/gharchive-daily-both.tsv`).
5. **Oct 2–6: +23, +32, +24, +21, +24★.** In that week: "We just crossed 18.5k downloads!" (109 likes), @Kappaemmedev's "I tried T3 Code, but I keep coming back to Synara" (143; it discloses "Yes, @emanueledpt is a friend"), the v1.0.0 Beta (169), "I made Synara free and open source. And I'm starting to regret it." (105 likes, 47 replies), v1.0.0 stable, and the 2K-star posts.

## 3. Channel inventory

| Channel | Evidence | Cadence and state now |
|---|---|---|
| Website trysynara.com (earlier dpcode.cc) | Hero "Run every coding agent in one workspace", download counter, star badge, 10 provider cards, 35 embedded X testimonials, sponsor slot. 73 sitemap URLs, 66 of them docs (10 provider pages, 21 feature pages, 14 workflow pages), plus `llms.txt`. No blog (`/blog` returns 404) and no comparison pages (`synara/sitemap.txt`) | dpcode.cc first captured Apr 11, trysynara.com Aug 10. The founder called the Sep 16 redesign "A true work of art" (234 likes) |
| GitHub releases and changelog | 122 releases (98 stable, 24 prerelease, 17 of them Synara Remote), long notes, `CHANGELOG.md`, Beta channel since Sep 6 | Every 1–2 days ("90 releases in 6 months", founder, Oct 5) |
| X brand [@trySynara](https://x.com/trySynara) | 3,089 followers, created May 30, follows 1 account. 12.6 originals and 12.6 reposts a week, 66% of posts are replies, median 32 likes (x-twitter.md). Of 109 reposts in the window, 46 are the founder's and 26 are Kartik's (`x/trySynara.json`) | Daily. Release template "Synara vX is out 🪽" |
| X founder [@emanueledpt](https://x.com/emanueledpt) | 31.8 originals a week, about 384 replies a week, median 40 likes (x-twitter.md). 62% of window originals went out at :00 or :01 UTC, so they are scheduled (`x/emanueledpt.json`) | A 456-day daily streak, ended on Oct 19 with "i'm deleting X for a couple days" |
| YouTube (founder) | 15 videos: Remodex intro 2,508 views, "I applied to YC Summer Batch with Remodex + DPCode" 143, Remotion promo tutorial 696 (`synara/founder-youtube-feed.xml`) | Monthly, small |
| Hacker News | No Synara or DP Code story. One third-party Remodex story (May 5, 1 point). One comment: "There's also Synara which started as a T3 Code fork" (Jul 30) (`synara/hn_stories.json`, `synara/hn_comments.json`, re-checked on [HN Algolia](https://hn.algolia.com/api/v1/search_by_date?query=synara&tags=comment)) | Absent |
| Reddit | Nothing found. Arctic Shift author queries (`emanueledpt`, `EmanueleDiPietro`) and "synara" searches in 8 subreddits returned 0. r/ClaudeCode, r/codex, r/LocalLLaMA and r/AI_Agents timed out (`synara/reddit_retry_raw.json`), and WebSearch found no threads | Absent (coverage partial) |
| Product Hunt | None. The `synara` slug is an unrelated calendar API, and `dp-code` and `remodex` return 404 | Absent |
| Discord or forum | None in the site, README or repo | Absent |
| Awesome lists and directories | 28 README hits for `Emanuele-web04/synara` in GitHub code search (awesome-agent-orchestrators, awesome-agent-clients, awesome-ranked-ai-orchestrators, awesome-software-factories and others), plus openalternative.co, LibHunt and Trendshift | Organic |
| Crypto coin | "Okay, I've launched a coin for Synara… I'll put the creator rewards towards development" (founder, Sep 17, in Trendshift social mentions; not in our X capture) | One-off |

## 4. Launch history

| # | Channel | Title (exact, truncated) | Date (UTC) | Day, hour | Engagement | Outcome |
|---|---|---|---|---|---|---|
| 0 | X founder | "I'm making this project open source / My first OSS project / Remodex…" | 2026-03-08 | Sun 17h | 130 likes, 153K views | Remodex 1,328★ by Mar 23 |
| 0b | X founder | "Introducing Remodex ✨ The first Codex Remote Control for iOS!" | 2026-03-26 | Thu 14h | 820 likes, 401K views | Founder-reported $553 MRR in 24 h |
| 1 | GitHub, dpcode.cc | DP Code v0.0.16, "The best way to code with your AI subscriptions" | 2026-04-11 | Sat 00h | 34 installers | 4 → 161★ by Apr 18 |
| 2 | X founder | "Introducing Handoff to Claude/Codex in DP Code! ✨" | 2026-04-17 | Fri 15h | 52 likes, 5.6K views | Small |
| 3 | X founder | "Introducing Synara — former DP Code. Synara is an Open-source GUI for Agentic Development…" | 2026-06-01 | Mon 21h | 224 likes, 34K views | Best month (+442★) |
| 4 | X brand | "Introducing Synara 0.5.0 — the new Synara 🪽 … No more legacy T3Code or t3tools references" | 2026-07-12 | Sun 13h | 107 likes, 28K views | Led into the license dispute |
| 5 | X founder | "I built an opensource ADE where you can use your existing Codex, Claude Code, Cursor subscriptions…" | 2026-08-19 | Wed 21h | 65 likes, 11.5K views | About 5★ a day |
| 6 | X brand, founder | "Synara v1.0.0 Beta is out 🪽 100+ PRs…" / "90 releases in 6 months… Synara v1 is finally here" | Oct 4 / 5 | Sun 19h / Mon 19h | 169 likes / 97 likes | Part of +124★ Oct 2–6 |
| 7 | X founder | "Introducing Synara Remote for iOS/iPadOS, in early access… 10 spots left" | 2026-10-17 | Sat 17h | 95 likes, 3.7K views | +1★ that day, +10 the next |
| — | HN, PH, Reddit | none | — | — | — | Never attempted |

Sources: `x/raw/emanueledpt.*.json`, `x/trySynara.json`, `synara/releases.json`, `synara/trendshift.md`. Every announcement went out on X, mostly from the founder's own account. Two names, two domains and a 1.0 in six months, and none of it went to HN, Product Hunt or Reddit.

## 5. Content patterns

- **Release posts from the brand:** "Synara v0.8.4 is out 🪽", a screenshot and an emoji bullet list. The 21 release posts in the window have a median of 45 likes against the brand's 32. Images get a median of 36 (59 posts), video 35.5 (18) and text 21 (30) (`x/trySynara.json`).
- **The product as test subject in model-launch posts:** "I'll be running a GPT-6 Astra Ultra thread overnight to audit the synara's repo… Full prompt:" (348 likes, 628 bookmarks), "GPT-6 Astra Pro made Synara's installed builds 11–30% smaller" (43). The model news brings the reach, and Synara rides along.
- **Building in public with numbers:** download milestones (18.5K, 19.5K, 20.5K, 21.5K), 2K stars with a Remotion-made video, "90 releases in 6 months", "$0 from sponsorships yet", "starting to regret it", and "I finally got my first Mac mini… run my agents remotely from anywhere" (93).
- **Codex-adjacent framing:** Codex Ambassador; "If you already use Codex, the UI will feel very familiar" (Aug 19); "Codex/ChatGPT sitting idle is using about 90% more RAM than Synara running 3 worktree threads" (40); a rebuilt Codex AppShot named "Synara AppSnap", tagging OpenAI's Codex lead (96). Some of his best-performing posts are attacks on Claude plans ("I'm cancelling my Claude 5x Max subscription", 1,756).
- **Riding other people's posts:** "This already exists. It's called Synara." under a 1,477-like request; "Would you look at that" quoting @thenanyu's 4,108-like layout post (167); "I caved / I added horizontal tabs… After @shadcn posted about it" (109).
- **Tagline drift:** dpcode.cc on Apr 11: "The best way to code with your AI subscriptions / Built to make you extraordinarily productive" (Inference: close to Cursor's homepage line). May 1: "the AI subscriptions you already pay for… No new bills, no walled gardens". Jun–Jul title: "Code with Claude Code, Codex, Gemini & Cursor". From Aug 10: "Run every coding agent in one workspace". The X bio says "Open-source GUI for Agentic Development", the repo "The best place to build with your AI sub", and the README "A focused workspace for coding agents" (`synara/site-snapshots.txt`, `synara/repo.json`).
- No comparison pages, benchmarks, blog or launch video.

## 6. What resonated (top moments by engagement)

| # | Moment | Date | Engagement | Why (inference) |
|---|---|---|---|---|
| 1 | Remodex launch (predecessor) | Mar 26 | 820 likes, 401K views, 513 bookmarks | It filled a gap: the founder worried on May 8 about "once OpenAI will release their app". It built the audience DP Code inherited |
| 2 | Overnight Astra audit of the repo, plus the brand's captionless image | Sep 5–7 | 348 likes, 628 bookmarks, 87K views; 496 likes, 58K views; +44★ on Sep 7 | A reusable prompt riding a model launch with Synara on screen, plus third-party lists the same week |
| 3 | DP Code in a third-party "6 tools worth trying" list | May 3 | 407 likes, 714 bookmarks; +191★ over Apr 29–May 11 | A slot in a bookmarkable list next to Superset and Conductor |
| 4 | Rename to Synara, then TS trending | Jun 1–16 | 224 likes, 34K views; +442★ in June | A new name and "works with every subscription" in the month Anthropic changed access |
| 5 | v1.0 week | Oct 2–6 | 169 / 109 / 105 likes; +124★ in 5 days | Big release, milestones, an emotional founder post and two friendly testimonials together |

Runner-up: brand "Synara v0.1.1 is out 🪽 🧩 OpenCode 2.0 is here" (Jun 4, 205 likes, 20K views). Support posts work best on the provider's own news day.

## 7. What did not work

- **The license incident, the most-viewed Synara story.** Commit 6d9a1af6 (Jul 9) replaced "Copyright (c) 2026 T3 Tools Inc." with the founder's name, and v0.5.0 (Jul 12) dropped all T3 references. On Aug 3 at 08:53 UTC @uwukko told @theo the founder had "overwrote it with his name in the fork, breaking the only license condition" (116 likes, 98K views). The apology came 35 minutes later ("I changed the MIT license without realising it", 410 likes, 136K views), and commit a654d257 restored the T3 line at 09:32 UTC. On Aug 5 v0.7.0 disclosed a PostHog configuration inherited from T3 Code: "we have no access to the PostHog project receiving the events" (`CHANGELOG.md`). The founder's video "The full story of the MIT License incident, T3 Code, Synara, fork vs clone, and the 'racism' accusations" (188 likes, 61K views) kept it alive, and @theo was still arguing on Aug 19 (`x/raw/wom.synara.json`). August was the weakest month (+241★; 1–11★ a day on Aug 20–31). On Oct 19 replies still bring it up.
- **Fighting the upstream.** In June he spammed Synara under T3 Code's posts. On Oct 18 he quoted @DavidOndrej1's claim that Theo paid for a tier list, adding "Nice to see @trySynara in S tier without paying or sponsoring anyone". Theo called the claim "Literally every single thing he said here is a lie" (706 likes), and a reply to Theo read "that's how Synara also got users". Inference: being defined against T3 Code keeps Synara in its shadow. The category's tier lists put T3 Code first (@Ga_Vasques, 1,875 likes; @zqkrq, 441).
- **Word of mouth is thin, and part of it comes from insiders.** x-twitter.md counts 14 third-party posts, 3 authors over 10K followers and none over 100K. The most frequent "user" voice, @1kartikkabadi1, runs the Beta repo, gets reposted by the brand (26 times in the window) and is embedded on the homepage. @Kappaemmedev discloses a friendship.
- **Brand one-liners:** "come to the bright side" (6 likes), "Split chats in Synara" (8), "Use your OpenCode subscription in Synara" (8), "Only one right answer: Synara" (11).
- **Monetisation.** Sponsor tiers up to €2,000 a month have found no commercial sponsor in three weeks, and there was a creator coin on Sep 17. Inference: both read as money pressure, and a coin is a reputational risk with developers.
- **User complaints:** "T3 Code put noticeably less load on the system overall" (@thegenioo, Aug 20) and "when remote gets as good as t3 codes, then I'll 95% switch to synara" (@017pixel, Oct 12).
- **Remote and iOS came late.** It was teased Sep 29 (12 likes), previewed Oct 8 (75) and opened Oct 17 to "10 spots" (95). Stars did not move.
- **Founder load:** a building break from Aug 22, the "regret" post on Oct 4, and the end of the posting streak on Oct 19. Inference: one person carries every channel.

## 8. Timing

- **Releases** (`synara/releases.json`): 26 in April, 9 in May, 25 in June, 15 in July, 8 in August, 9 in September and 30 in October (17 of those are Remote prereleases). By weekday: Sun 23, Sat 21, Fri 21, Tue 16, Thu 16, Mon 13, Wed 12, so 36% land on weekends. 43% ship between 22:00 and 02:00 UTC, which is midnight to 4 a.m. in Italy.
- **X:** the brand's best weekday is Friday and its best slot 00–02 UTC; the founder's best is Saturday, 12–14 UTC (x-twitter.md). His scheduled posts cluster at 10, 12, 14, 17 and 19 UTC (`x/emanueledpt.json`).
- **Stars by weekday** (Trendshift, Aug 20–Oct 19): Mon 93, Tue 89, Sun 89, Wed 83, Fri 73, Sat 71, Thu 59. There is no weekday effect.
- **Correlation:** star days follow X moments (lists, Chinese write-ups, model-launch posts), not ship dates. Sep 25, the day of the most-downloaded release, gained 7★.

## 9. Community and distribution mechanics

- **"Bring your own subscription" is the pitch,** and each provider becomes a post: "OpenAI Daybreak Blue is now supported" (56), "SWE-2 … through your Devin subscription" (64), multiple accounts per provider (98), usage limits in the sidebar (73) (`x/trySynara.json`).
- **Windows parity:** 41% of installers are Windows. Inference: Windows users of agent CLIs are underserved.
- **The testimonial wall grew from 15 to 35 embedded X posts** between Aug 10 and Sep 23, and the brand reposts users, so each positive mention is reused.
- **Reply-gated early access:** 40 replies on 72 likes (x-twitter.md).
- **Grok Bot support triage:** X feedback threads become structured GitHub issues ([#1880](https://github.com/Emanuele-web04/synara/issues/1880), "First-run feedback from @ThatRandomNerd1… - Grok Bot").
- **Fast-ring beta:** "new updates (usually) every 6 hours" (@1kartikkabadi1, Sep 25); Hubs reached Stable on Oct 11 after Beta.
- **Chinese creators found it unprompted** (@WWTLitee, @object_nullll, @jaywcjlove), with no localisation.
- **Vendor programmes as credibility:** Codex Ambassador, Claude Startup program and YC, each turned into a post.
- **Contribution:** 1,067 merged PRs, 677 in the last 61 days (Trendshift), behind a `vouch:*` gate inherited from T3 Code (`CONTRIBUTING.md`). There are 45 post-fork author names (bots included), and the founder has 1,329 of those commits up to Aug 9.
- No SEO comparison pages, Discord, referrals or ads.

## 10. Lessons for intentic

1. **Build the founder audience before the product needs it.** DP Code's first 160★ came from Remodex's 400K-view launch, not its own. intentic's founder account should earn reach with useful artifacts (prompt recipes, overnight-run results) before asking for stars.
2. **Treat licenses, attribution and inherited telemetry as launch blockers.** Synara's most-viewed product story is the MIT incident (136K views), plus an upstream PostHog key, and August was its weakest month. Audit notices and every analytics key before launch, and publish what intentic collects.
3. **Don't define the product against a bigger one.** The T3 Code feud keeps Synara one name in T3 Code's lists. intentic's frame (a machine of your own, reachable from any browser) needs no rival in the headline.
4. **Report usage, not only stars.** Synara has about 10 downloads per star and posts every thousand. intentic should count sandboxes started and agent-hours and post the milestones (x-twitter.md: milestone posts score 1.59x).
5. **Make your own repo the overnight test subject when a model launches.** "Ran Astra overnight on my repo" lines up with Synara's best star day. intentic can show it literally: one sandbox per model, overnight, results in the morning.
6. **Answer "can someone build X" posts with a 15-second clip.** A text reply reached 15K views, and video does 1.55x (x-twitter.md).
7. **Lead with remote and phone, which Synara's users are asking for.** Its remote and iOS work is two days old, gated to "10 spots", and compared unfavourably to T3 Code's. That is intentic's core: target Synara and T3 Code users with "the agents keep running when the laptop closes".
8. **Name Windows on the landing page.** 41% of Synara's installers are Windows, and intentic runs in any browser.
9. **Keep word of mouth at arm's length and disclosed.** Synara's most visible "users" are a collaborator and a friend. Ask real users for "my stack" posts and label team posts.
10. **Pick one money model and state it on day one.** Free, then donations, then €2,000 sponsorships, then a coin, then "starting to regret" making it free: each step reads as pressure. intentic's model (free on your own machine, a hosted sandbox from $20 a month, [positioning.md](../positioning.md)) should be on the site from launch and stay put.
