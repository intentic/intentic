# Orca (Stably AI): marketing teardown

Researched 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/orca/` (star curves, daily
trending snapshots, releases, HN/Reddit/YouTube/bilibili pulls). Every number below is measured and
linked unless it carries the label **[inference]**. X/Twitter was not browsed (another researcher
covers it); X posts are cited only where they appear on Orca's own site or in search results.

## 1. What it is and who is behind it

- **Product.** "The AI Orchestrator for 100x builders": an Electron desktop app (macOS, Windows,
  Linux) that runs any CLI coding agent side by side, each in its own git worktree, with terminals,
  diff review, an embedded browser with "Design Mode", SSH worktrees, a scriptable `orca` CLI, a
  headless `orca serve` runtime and an iOS/Android companion app
  ([README](https://github.com/stablyai/orca), [onorca.dev](https://www.onorca.dev/)). The site calls
  the category an **ADE** ("agent development environment"). Current GitHub description: "Orca is the
  place for working with a fleet of agents (e.g. Grok Bot, Claude Code). Run any coding agent with
  your own subscription. Available on desktop, mobile and remote runtime." Very close to intentic's own
  pitch (BYO subscription, many agents, phone access, remote runtime).
- **Company.** Stably AI, YC **W22**, San Francisco, a pivot from its AI testing product (stably.ai).
  Founders: **Jinjing Liang** (CEO, ex-Google Chrome release infra) and **Neil Parker** (CTO, ex-Uber
  TL), both Cornell ([YC page](https://www.ycombinator.com/companies/stably-ai-orca)). Team size is
  inconsistent across sources: YC company page says 25, YC jobs page and
  [AgentConn](https://agentconn.com/blog/orca-ade-agent-fleet-parallel-coding-agents-2026/) say 4.
  Commit authorship (clone, through 2026-09-20) is dominated by four people: Neil 11.3k commits,
  Brennan Benson 9.9k, Jinjing 5.2k, Jinwoo Hong 6.9k.
- **Funding.** Nothing beyond YC found; Tracxn lists one undisclosed round
  ([Tracxn](https://tracxn.com/d/companies/stably-ai/__HFFiWGpdnAf8DOQtka9J9Lh_xabl5RjHIkXSDSXy2v4)).
- **Launch.** Repo created 2026-03-17 03:28 UTC; first commit 2026-03-16 20:29 PT; first published
  release v1.0.12 on 2026-03-21; Show HN 2026-03-27; Product Hunt 2026-04-09; iOS app 2026-05-07
  ([App Store lookup](https://itunes.apple.com/lookup?id=6766130217): 39 ratings, 4.6).
- **Pricing.** Free, MIT, no paid tier. The site's JSON-LD declares price 0; an
  [Enterprise page](https://www.onorca.dev/enterprise) sells "rollout guidance", self-hosting and
  security answers (SOC 2 is an FAQ heading), with no price.
- **Scale today (2026-10-19, GitHub API).** 97,829 stars, 6,236 forks, 151 watchers, 449
  contributors, 22,106 PRs (14,098 merged), 8,435 issues, 978 releases. Discord 6,076 members
  (1,458 online). The README badge claims 70m downloads (see section 7 for why that number is not
  human installs).

## 2. Growth curve

Stars by month (star-history.com SVG decoded, plus daily snapshots of GitHub Trending from the
[SnailDev/github-hot-hub](https://github.com/SnailDev/github-hot-hub) archive; files
`stars-by-month.csv`, `daily-stars-from-trending-snapshots.csv`):

| Month end | Stars | Gained in month |
|---|---:|---:|
| 2026-03-31 | ~104 | 104 |
| 2026-04-30 | ~1,704 | 1,600 |
| 2026-05-31 | ~3,670 | 1,966 |
| 2026-06-30 | 9,480 | 5,810 |
| 2026-07-31 | 34,379 | 24,899 |
| 2026-08-31 | ~56,900 | 22,549 |
| 2026-09-30 | 82,113 | 25,185 |
| 2026-10-19 | 97,829 | ~15,700 (19 days) |

Shape: 3 months of slow growth (~50 stars/day), a hockey stick from late June, then a **flat
plateau of 750-1,100 stars/day for four months** that is still rising (1,137 and 1,426 on Oct 18-19).
Orca sat on the GitHub Trending weekly or monthly list every day from 2026-06-23 to 2026-08-19 (58
consecutive archive days), again 2026-09-17 to 2026-10-01 and 2026-10-17 to 2026-10-19
([archive hits](https://github.com/SnailDev/github-hot-hub/tree/main/archives)); weekly rank peaked at
**#4 on 2026-07-14**, daily rank #4 on 2026-08-12. OpenGithubs weekly rank lists it five weeks
running (weeks of Jul 6 to Aug 3).

Release-asset downloads (sum over all releases, from the badge history in the README's git log):
1.0m on 2026-06-16, 10m on 2026-07-26, 70m on 2026-09-20. Homebrew analytics are unavailable
(Orca ships through its own tap `stablyai/orca`).

Biggest jumps and the events that line up with them (matched by date; daily deltas are
noon-to-noon UTC from the trending snapshots):

1. **Jun 17 to Jul 3: from ~120/day to 300-785/day.** In the two weeks before the knee the team
   shipped a growth package: app UI localized to zh/ja/ko (2026-06-09), README "Redesign for clarity
   and conversion" putting the mobile companion first plus a downloads badge (2026-06-11, commit
   `0310b032bb`), and the **in-app GitHub-star prompt** reworked to fire at onboarding completion and
   after an agent finishes (2026-06-16/17, `fa557a0cd9`, `fd9e79a77a`). Then: entry to GitHub
   Trending weekly (Jun 23, rank 20), WeChat group and TestFlight links in the README (Jun 25, the
   729-star day), first bilibili videos (Jul 1: 8,278 plays; Jul 2: 5,845) and the "Free Cursor
   Killer" YouTube video (Jul 3, 4,955 views). **[inference]** The star prompt is the largest single
   cause: it converts existing users, its reset on every app version re-arms it with each daily
   release, and the series has a weekday shape (section 8) that bot traffic would not have.
2. **Jul 9-14: 834 → 962 → 1,087 → 1,125/day.** X threads by Vaibhav Sisinty ("Most people run one
   AI agent at a time. Orca runs multiple in parallel", 2026-07-12 07:58 UTC,
   [post](https://x.com/VaibhavSisinty/status/2076214668952220055)) and Jason Zhou ("I tried almost
   every parallel ADE. So far loving Orca the most", 2026-07-12 10:46 UTC,
   [post](https://x.com/jasonzhou1993/status/2076256816934392155)); plugin marketplace and official
   theme/language packs (repos created 2026-07-13); weekly trending rank 4 on Jul 14.
3. **Jul 20-24: 961 → 1,416 → 1,243 → 1,234 → 1,061/day (best week).** Christian Lempa's YouTube
   review "My NEW AI Terminal and Code Editor // Orca Review" (2026-07-21, **112,669 views, 1,485
   likes**, [video](https://www.youtube.com/watch?v=tzDDNWU21uQ); the video is sponsored by Morph, not
   by Orca), Eric Tech's "Control Any Coding Agent From Your Phone (Orca)" (2026-07-22, 20,148 views),
   and bilibili "Orca ADE彻底改变AI编程方式" by AI超元域 (2026-07-20, 27,935 plays,
   [video](https://www.bilibili.com/video/BV1jDKH6gE3b)).
4. **Aug 12-13: 1,189 and 1,126/day, daily trending #4.** xAI launched Grok Bot on 2026-08-11
   ([Vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown)); Orca's description and topics now
   lead with "Grok Bot" and include `grok-bot`, `openclaw`, `hermes-agent`, `muse`. **[inference]**
   Keyword-riding on the agent of the week; the date the description changed is not recoverable.
5. **Sep 17 to Oct 1 and Oct 17-19 (~750-1,400/day).** Julian Goldie SEO YouTube (2026-09-16, 17,261
   views), bilibili "介绍 herdr 后，评论区为什么都在推荐 Orca？" (2026-09-14, 22,929 plays), Syntax.fm
   #1042 segment "Orca: A GUI for Wrangling Your Fleet of Agents" (2026-09-28,
   [show notes](https://github.com/syntaxfm/website/blob/main/shows/1042%20-%20Is%20the%20Jev%20Hype%20Overblown.md)).

Method notes: GitHub's stargazer listing returns 404 through this sandbox's token, and the
ClickHouse GH Archive mirror undercounts 2026 WatchEvents by more than 10x after May, so neither was
used for counts.

## 3. Channel inventory

| Channel | What exists | Cadence / activity now |
|---|---|---|
| Website | [onorca.dev](https://www.onorca.dev/) (orca.dev redirects to it): home, download, changelog, enterprise, docs. 61 sitemap URLs, no blog | Home rewritten around "Ship 100x with the agent IDE"; X testimonial wall; comparison table |
| Changelog | [onorca.dev/changelog](https://www.onorca.dev/changelog), one entry per stable release, 3 bullets each | Every 1-3 days (Oct 2, 4, 5, 8, 10, 14, 15, 17) |
| GitHub releases | 978 releases; long notes opening "Thank you so much for using Orca... ❤️" and "The short version" | 9 stable in Oct 1-19; 83 stable in April at the peak |
| Docs | [onorca.dev/docs](https://www.onorca.dev/docs), Next.js docs app open-sourced in the repo on 2026-08-30 | Updated with releases |
| X | [@orca_build](https://x.com/orca_build); founders @nwparker_, @JinjingLiang; team @brennankb5, @jinwoohong_ | Not measured here (X researcher) |
| Discord | [discord.gg/fzjDKHxv8Q](https://discord.gg/fzjDKHxv8Q), added 2026-04-10 | 6,076 members, 1,458 online on 2026-10-19 |
| WeChat | QR codes in every README since 2026-06-25 | Rotated to group 3 (Jul 18), 5 (Jul 23), 6 (Jul 28), 7 (Aug 2), 8 (Aug 19), 9 (Sep 4). **[inference]** WeChat groups cap at 500, so up to ~4,500 Chinese users |
| YouTube | No official channel found. 15 third-party videos found, 231 to 112,669 views (`youtube-videos.txt`) | Third-party videos monthly since June; newest 2026-10-09 |
| bilibili | Third-party only; ≥11 relevant videos, largest 27,935 plays (`bilibili-videos.json`) | Ongoing; competitors now title videos "超越Orca" (beyond Orca) |
| Hacker News | 1 Show HN + 1 Ask HN by Neil (March-April) | Abandoned as an owned channel after 2026-04-14; organic mentions in ≥15 comment threads |
| Reddit | No team posts found | Organic only (section 6) |
| Product Hunt | [One launch](https://www.producthunt.com/products/orca-5), 2026-04-09, 76 followers, 1 review | Dormant |
| Mobile stores | iOS App Store "Orca IDE" (2026-05-07); Android APK on GitHub (not on Google Play) | Mobile releases about weekly (0.0.57 on 2026-10-17) |
| Package managers | Homebrew tap auto-bumped every stable release, AUR `stably-orca-bin`, Scoop Extras `orca-ide`, numtide `llm-agents.nix` | Automated |
| Lists and directories | awesome-mac (jaywcjlove, en/zh/ja/ko), Awesome-AITools, awesome-ai-coding-tools, awesome-agent-harness, Awesome-IDEs, FMHY, opensourcealternatives.to; GitHub code search finds 11,680 files naming `stablyai/orca` | Organic |
| Press / podcasts | Syntax.fm #1042 (Sep 28); YC-life interview with Jinjing Liang on Mayank Gupta's channel (2026-08-29, 1,865 views) | Rare |
| Newsletter, LinkedIn | None found | - |
| Localization | README in 7 languages (zh-CN and ja 2026-04-13, es 04-25, ko 05-15, pt 07-04, fr 07-20; a uk version was added and reverted 09-03); app UI en/es/fr/ja/ko/zh | Maintained |

## 4. Launch history

| Where | Title (exact) | Date | Weekday, hour UTC | Result | Outcome |
|---|---|---|---|---|---|
| HN (prior project) | "Show HN: Slack CLI for Agents" ([46905745](https://news.ycombinator.com/item?id=46905745)) | 2026-02-05 | Thu 21:38 | 99 pts, 35 comments | The team's best HN result; that repo's homepage now points to onOrca.dev |
| HN | "Show HN: Open Source 'Conductor + Ghostty'" ([47549197](https://news.ycombinator.com/item?id=47549197)) | 2026-03-27 | Fri 22:26 | 21 pts, 10 comments | Polite thread (cmux comparison, missing LICENSE file). No visible star effect: ~100 stars by month end |
| Product Hunt | "Orca: Your control center for parallel AI agents" | 2026-04-09 | Thu | Not in the top ~20 of the [daily leaderboard](https://www.producthunt.com/leaderboard/daily/2026/4/9/all); 76 followers today | Flop |
| HN | "Ask HN: GUI or TUI for Coding Harness?" ([47771230](https://news.ycombinator.com/item?id=47771230)) | 2026-04-14 | Tue 20:42 | 3 pts, 2 comments | Soft promotion ("FWIW this is why we built Orca"); flop |
| HN (third party) | "StockCoaster (Made by Orca)" ([49248825](https://news.ycombinator.com/item?id=49248825)) | 2026-08-10 | Mon 19:53 | 2 pts | Demo app from the team, posted by a fan |
| HN (third party) | "Orca – The Agent Development Environment" ([49663543](https://news.ycombinator.com/item?id=49663543)) | 2026-09-11 | Fri 18:59 | 1 pt | Flop |
| HN (third party) | "Orca – Agent Development Environment (ADE) for shipping with coding agents" ([49855391](https://news.ycombinator.com/item?id=49855391)) | 2026-09-26 | Sat 11:09 | 3 pts, 1 comment | Blog review |
| HN (third party) | "I tried Orca and VSCode Agents window: I went back to tmux shortly after" ([49904766](https://news.ycombinator.com/item?id=49904766)) | 2026-09-30 | Wed 05:37 | 2 pts | Negative review |
| HN (third party) | "Current Agentic Development Environment: Orca and Oh My Pi" ([49916232](https://news.ycombinator.com/item?id=49916232)) | 2026-10-01 | Thu 00:27 | 6 pts, 2 comments | Setup post |
| Reddit (organic) | "Orca ADE is incredible" ([r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1vwjgyv/orca_ade_is_incredible/)) | 2026-08-23 | Sun 21:24 | 142 pts, 74 comments | Best Reddit post about Orca; user, not team |

Title vs result: the Show HN borrowed two known names ("Conductor + Ghostty") instead of naming
the product, and got 21 points. Every formal launch the team ran underperformed; all of the
growth came after April from in-product loops, GitHub Trending and creators.

## 5. Content patterns

- **README as the landing page.** A nine-row feature wall where every row is a GIF plus a "Docs →" link,
  a hero image with the phone in the corner, a logo wall of 29 agents ("Works with any CLI agent —
  if it runs in a terminal, it runs in Orca"), a star-history chart, the contributors grid, the
  WeChat QR codes and a downloads badge. 155 README commits in 7 months.
- **"We ship daily" as the message.** "And many, many more — we ship daily, so this list is
  perpetually behind. The changelog is the real feature list." / "Star this repo to follow along
  with our daily ships." / site: "Free and open source. New features shipped daily."
- **Hyperbole plus a category word.** Tagline history from README git log: "Orca is an AI
  Orchestrator for nerds." (03-17) → "A cross-platform AI Orchestrator for nerds." (03-23) → "...for
  100x engineers." (03-29) → "The cross-platform AI Orchestrator for 100x builders." (04-03) → "The AI
  Orchestrator for 100x builders. Run Claude Code, Codex, or OpenCode side-by-side across repos —
  each in its own worktree, tracked in one place." (04-10; the agent list was edited seven more
  times) → site H1 "Ship 100x with the agent IDE" and "ADE" as the category ("IDEs were built for
  you. An ADE is built for you and your agents").
- **Social proof as a product section.** Home page wall of eight X posts ("Every quote below is a
  public post on X. Click one to read the original"), with name and title (ex-Head of Engineering
  Coinbase, PayPal developer advocate, founders).
- **Comparison table** "Orca vs IDEs and wrappers" (macOS-only, "One or two" agents vs 27, MIT).
- **SEO through FAQ structured data**, not a blog: JSON-LD answers for "Is Orca a Cursor
  alternative?", "Can I use Orca as a Ghostty for Windows or Linux?" ("developers searching for
  'Ghostty for Windows'..."), "How do I run Claude Code on Windows or Linux?".
- **Release notes** with a gratitude opener, "The short version" bullets, then PR lists with author
  handles (credits contributors publicly).
- **Demo artifacts.** StockCoaster, a toy app "one-shot with Fable" and published as "Made by Orca"
  ([repo](https://github.com/stablyai/stockcoaster)); official theme and language-pack repos.
- No founder story, benchmarks, memes or long-form posts from the team found.

## 6. What resonated (top content by engagement)

| # | Content | Date | Engagement | Why it worked [inference] |
|---|---|---|---|---|
| 1 | Christian Lempa, ["My NEW AI Terminal and Code Editor // Orca Review"](https://www.youtube.com/watch?v=tzDDNWU21uQ) (YouTube) | 2026-07-21 | 112,669 views, 1,485 likes | Trusted homelab/devops creator, "new terminal + editor" framing, coincides with the best star week (1,416 on Jul 21) |
| 2 | Reddit ["Orca ADE is incredible"](https://www.reddit.com/r/ClaudeCode/comments/1vwjgyv/orca_ade_is_incredible/) (r/ClaudeCode) | 2026-08-23 | 142 pts, 74 comments | Switcher story from a user ("previously using cmux... Orca is 100x better"), names the remote-server feature |
| 3 | bilibili AI超元域, ["Orca ADE彻底改变AI编程方式！..."](https://www.bilibili.com/video/BV1jDKH6gE3b) | 2026-07-20 | 27,935 plays | Chinese wave: localized UI, WeChat groups, free and BYO subscription suits Chinese model plans (Qwen, Kimi, MiMo, GLM are in the agent list) |
| 4 | bilibili 大力Thinking, "介绍 herdr 后，评论区为什么都在推荐 Orca？" | 2026-09-14 | 22,929 plays | Orca became the default recommendation in competitors' comment sections |
| 5 | YouTube: Joe Maddalone (21,761), Eric Tech mobile-control video (20,148), Julian Goldie SEO (17,261), AI Stack Engineer (17,161) | Jul-Sep | 76k views combined | "Run 5 agents at once", "free Cursor killer", "control from your phone": a concrete, visual claim each |
| - | Prior: "Show HN: Slack CLI for Agents" | 2026-02-05 | 99 pts | Small sharp agent utility; seeded the team's HN reputation |

Repeated phrasing in creator titles: a number of agents ("5 agents", "10 AI coding agents"),
"FREE", "Cursor killer", "from your phone". Organic HN comments recommend Orca unprompted in
threads about tmux, Pi, JetBrains and "what's your AI coding setup" (e.g. "I used herdr before now
Orca has fully replaced it", [Pi 1.0 thread](https://news.ycombinator.com/item?id=49926533)).
CodeRabbit reported stablyai/orca as the #1 public repo by AI code reviews in September 2026
(5.6k reviews; [HN comment](https://news.ycombinator.com/item?id=50007033)), a side effect of its PR volume.

## 7. What did not work

- **Formal launches.** Show HN 21 points, Ask HN 3, Product Hunt invisible. No relaunch on either.
- **Weight and clutter.** "not bloated electron like orca. God. I uninstalled it in 2 hours" (in a
  78-point r/ClaudeCode post praising herdr,
  [thread](https://www.reddit.com/r/ClaudeCode/comments/1x18t52/just_fucking_love_herdr/)); "I found
  orca way to cluttered and overkill. Cmux feels very lightweight." ([HN](https://news.ycombinator.com/item?id=50151465), 2026-10-19); a blog titled
  "I went back to tmux shortly after"; one hands-on review measured ~2 GB RAM for one agent and ~6 GB
  for three and ~10 GB for five, agents included
  ([Margrop](https://blog.margrop.net/en/post/orca-parallel-ai-agent-ide-review/)).
- **Mobile UX.** "Orca is great, but phone experience is BAD" (r/ClaudeCode, 2026-09-08): the phone
  app mirrors a terminal; typing lags. Paseo is named as the better phone experience on Reddit and
  [HN](https://news.ycombinator.com/item?id=49943943).
- **Unsafe default.** A Product Hunt reviewer notes Orca "launches every session with `claude
  --dangerously-skip-permissions`. That's the default (!)" (he liked it, but this is a security
  story waiting to happen).
- **Messaging churn.** Seven agent-list edits to the README tagline in two months, a GitHub
  description that now leads with "Grok Bot", and topics stuffed with other agents' names. A
  Ukrainian README was added and reverted the same day (2026-09-03).
- **The downloads badge is not human installs [inference from measured data].** Computed from the
  release API: 116.9M asset downloads in total, of which only 42.9M are installers and the rest are
  update manifests (`latest-mac.yml` alone has 2.5M downloads on one release). From June on, Intel
  and Apple Silicon DMGs are downloaded in equal numbers (Sep: 6.33M arm64 vs 6.20M x64; April was
  3,741 vs 374), and `.deb`/`.AppImage`/`.rpm` move in lockstep. Real users do not split 50/50 across
  architectures, so mirrors or crawlers are pulling every asset. The "70m downloads" badge should not
  be read as reach. Stars do look human (weekday pattern, section 8).

## 8. Timing

- Launches: Show HN on a **Friday at 22:26 UTC** (Friday afternoon in California), the weakest HN
  slot of the week; Ask HN Tuesday 20:42 UTC; PH on a Thursday. Their one HN success (Slack CLI) was
  a Thursday 21:38 UTC.
- Releases: 978 total. Stable releases per month: Mar 56, Apr 83, May 63, Jun 58, Jul 45, Aug 27,
  Sep 22, Oct 9 (to the 19th). Since September, PRs ship as release trains ("It usually takes 48–72
  hours for a landed PR to be released", v1.4.201 notes). Stable releases are spread evenly over all
  seven weekdays (40-58 each) and cluster between 18:00 and 09:00 UTC (US Pacific afternoon to
  midnight).
- Stars by weekday (mean 1-day gain, Jun 24 to Oct 19): Tue 930, Mon 892, Thu 891, Wed 831, Fri 768,
  Sat 596, Sun 577. Developer-workday traffic.
- **[inference]** Timing matters less than loops for Orca: each daily release resets the star
  prompt's countdown for every user who has not starred, and GitHub Trending then compounds the
  steady inflow. No launch-day spike exists anywhere in the curve.

## 9. Community and distribution mechanics

- **In-app star prompt** (`src/main/star-nag/`). A card: "Enjoying Orca? Orca is open source. If it
  helped today, a GitHub star helps other developers find it." [Star on GitHub] [Later]. Fires after
  35 agents spawned (threshold doubles on "Later"), at onboarding completion, and after an agent
  finishes (once per app version); stars directly through the user's `gh` CLI with no browser
  round-trip; the baseline resets on every new version. Instrumented with "effectiveness telemetry
  for in-app GitHub stars" (2026-06-12). Timeline: landing-page star button 04-06, card 04-18,
  app-origin star tracking 05-29, onboarding and agent-win triggers 06-17.
- **Share to X.** Usage panes have a share button that opens a prefilled post: "My last 30 days
  Claude usage via @orca_build / 1.2M tokens · $X est. cost / github.com/stablyai/orca" (since
  2026-04-20).
- **Communities.** Discord (6,076), nine WeChat groups, GitHub Issues as the feature-request channel
  ("We ship fast. Missing something? Request a new feature", 8,435 issues), 449 contributors and
  contributor credit in every release note.
- **Integrations as reach.** 29 named agents plus "any CLI agent", including Chinese vendors (Qwen
  Code, Kimi, MiMo, Qoder CLI China, GLM Coding Plan); GitHub, Linear and Jira; Claude/Codex usage and
  rate-limit tracking with account hot-swap (a direct hook for heavy subscription users).
- **Packaging everywhere.** Signed builds (Windows signing via SignPath Foundation), Homebrew tap,
  AUR, Scoop, Nix, App Store, APK, hourly and daily dev-build repos.
- **SEO.** FAQ structured data for "Cursor alternative" and "Ghostty for Windows/Linux"; no
  comparison pages of their own, but competitors write them: Superset published "Superset vs Orca"
  on 2026-07-13 ([source](https://github.com/superset-sh/superset/blob/main/apps/marketing/content/compare/superset-vs-orca.mdx)).
- **Free as marketing.** Everything is free and MIT; the only commercial surface is the Enterprise
  page. Cross-platform (Windows and Linux on day one) is the wedge against macOS-only rivals
  (Conductor, cmux, Superset), and their own comparison table leads with it.
- **Plugin marketplace** (2026-07-13): official themes, a Brazilian Portuguese language pack (14
  stars) and workflow skills, each a separate repo.

## 10. Lessons for intentic

1. **Ask for the star inside the product, at a value moment, with one click.** Orca's curve bends
   the same week it moved its star prompt to "onboarding completed" and "agent finished", and it
   stars through `gh` without leaving the app. intentic's sandbox already has GitHub as a capability:
   a "your agent just landed a change; star intentic?" card is cheap, and re-arming it per release
   turns shipping cadence into acquisition. Instrument it from day one.
2. **Ship visibly and say so.** A changelog entry every 1-3 days, release notes that thank users
   and credit contributors, and "the changelog is the real feature list" in the README. intentic
   ships daily too; make that public on a changelog page and in release notes.
3. **Win creators, not launch days.** Orca's HN and PH launches flopped; one homelab YouTuber (112k
   views) and a handful of AI channels moved more stars than any launch. Seed self-hosting and
   homelab creators (Christian Lempa's audience is exactly "agents on my own machine") with a
   10-minute demo script: N agents in parallel, phone access, nothing lost when the laptop closes.
4. **Localize early for China and run a WeChat group.** zh/ja/ko UI on Jun 9, WeChat on Jun 25,
   then bilibili videos with 28k plays and nine full WeChat groups. Support for Chinese model plans
   (Qwen, Kimi, GLM, DeepSeek) is part of the same move.
5. **Make Windows/Linux and "any agent" the comparison table.** Orca's table leads with the gaps
   of macOS-only competitors. intentic's equivalent is "runs on a machine you own, reachable from
   any browser or phone, survives a closed laptop": put it in a table against desktop-only ADEs.
6. **Use FAQ structured data for the searches people actually type** ("Conductor alternative",
   "Claude Code on Windows", "run Claude Code from my phone", "Orca alternative"), before writing a
   blog.
7. **Avoid Orca's weak spots in messaging.** Users call it heavy Electron, cluttered, with a laggy
   phone terminal and a skip-permissions default. intentic should say "lightweight browser window,
   persistent sandbox, approvals by default" and show it. And do not inflate download badges: a
   number a reader can check (stars, active sandboxes) is worth more.
8. **Keep the tagline stable.** Orca rewrote its one-liner and agent list a dozen times; its
   durable assets are the category word "ADE" and "100x builders". Pick intentic's phrase once and
   repeat it everywhere.
