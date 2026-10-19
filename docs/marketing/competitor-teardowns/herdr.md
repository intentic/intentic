# Herdr: marketing teardown

Snapshot: 2026-10-19. Raw data: `/work/.intentic/local/tmp/mkt-research/herdr/` (star points, Wayback star counts, releases, HN items, Trendshift ranks and daily table, Reddit archive pulls, brew and crates stats, stargazer location sample). Numbers are measured unless a line is marked **Inference**.

Data caveats:
- The star curve is rebuilt from 33 Wayback snapshots of the repo page (exact counts) and star-history.com (about 1% error), because GitHub's stargazer listing is blocked from this sandbox.
- [Trendshift](https://trendshift.io/repositories/32084) supplies exact daily stars for Aug 20–Oct 19 and trending ranks since April.
- Reddit coverage comes from the arctic-shift archive under heavy rate limiting: r/herdr (first 100 posts), r/ClaudeAI, r/ClaudeCode, and the founder's full posting history (u/arzamar). Other subs are not fully crawled.
- The local clone `/work/refs/herdr` stops at 2026-08-09, so later facts come from the live site.

## 1. What it is, who is behind it

- **Product:** "the runtime your coding agents live on" ([README](https://github.com/herdrdev/herdr), [herdr.dev](https://herdr.dev)). A single Rust binary: a background server owns the terminals, and a TUI client runs inside your existing terminal. It has workspaces, tabs, and panes, and marks every agent pane "working, blocked, or idle". Sessions persist across lid-close, network loss, and reboot. It offers detach/reattach and SSH (`herdr --remote user@host` installs itself on the remote). A CLI and socket API let agents drive it. There is a plugin marketplace and, since 0.9 (2026-09-07), several machines in one client (`herdr machine add`). It detects 22 agent CLIs (Claude Code, Codex, Cursor, opencode, Grok, Pi, and others), and users bring their own subscriptions. "One rust binary, no electron."
- **Who:** Ogulcan "Can" Celik: GitHub [ogulcancelik](https://github.com/ogulcancelik), X [@cancelik](https://x.com/cancelik) (blog author card), company X [@herdrdev](https://x.com/herdrdev), personal lab [oddbit.ai](https://oddbit.ai) (LLM experiments), Reddit u/arzamar. His previous Show HN, "Peer Arena", got 5 points in Dec 2025. The Reddit account is matched by its herdr launch posts and the oddbit "LLM jukebox" posts, and its history (Turkish-language posts, an Istanbul photo) points to Turkey. Before Herdr his best Reddit posts were AI experiments: "I asked 53 AI models to make playlists based on how they feel" (r/singularity, 65↑, 2026-01-22) and a Unity AI-bridge post (r/aigamedev, 39↑, 2026-03-07). Commits are in UTC+3. He was solo until YC ("Hey everyone, it's Can, the only person behind Herdr", [YC post](https://herdr.dev/blog/herdr-is-joining-y-combinator/)). The repo moved from `ogulcancelik/herdr` to the `herdrdev` org on 2026-07-29 (GH Archive, commit 3563f5c5).
- **Funding:** Y Combinator **F26** batch, announced 2026-08-06. **$6M seed** led by Bessemer Venture Partners, with YC, e2vc, Tobi Lütke (Shopify), Dane Knecht (Cloudflare), and Görkem Yurtseven (fal), announced 2026-09-08 ([seed post](https://herdr.dev/blog/herdr-raised-a-seed/)). The team hired "through the terminal, over SSH". Hiring is now closed.
- **Launch date:** first commit and v0.1.0 on 2026-03-27 (git log, releases API).
- **Business model:** the runtime is free under Apache-2.0. The paid layer will be **Herdr Cloud**, which is on a waitlist: "link your machines with a single command… Terminal traffic would be end-to-end encrypted… You still bring your own machines. Cloud connects them; it doesn't host the agents for you" ([Connecting the machines](https://herdr.dev/blog/connecting-the-machines/)). Enterprise and partnership go through email. Before YC there was GitHub Sponsors (button added 2026-04-12) with company tiers of Platinum $2,500/mo and Lead $5,000/mo (SPONSORS.md, 2026-06-24). Terminal Trove became Gold sponsor on 2026-07-08, and the program is now "closed and no longer accepts new sponsors".
- **License:** AGPL-3.0 at launch, then dual AGPL plus commercial license (2026-05-26, cfffe659), then Apache-2.0 (2026-07-22, cd5ea1be), two weeks before the YC announcement.

## 2. Growth curve

### Stars by month (end of month)

| Month | Stars at month end | Gained |
|---|---|---|
| 2026-03 | 65 | +65 (from Mar 27) |
| 2026-04 | 401 | +336 |
| 2026-05 | 3,409 | +3,008 |
| 2026-06 | 9,022 | +5,613 |
| 2026-07 | 23,031 | **+14,009** |
| 2026-08 | 33,818 | +10,787 |
| 2026-09 | 41,602 | +7,784 |
| 2026-10 (to 19th) | 44,767 | +3,165 |

Sources: `wayback-stars.json` (e.g. 541 on 2026-05-07, 7,975 on 06-29, 13,995 on 07-08, 22,327 on 07-29, 36,586 on 09-08) and `stars-monthly.json`. Trendshift daily: +14,113 stars in the 61 days to Oct 19. That is +200 to +376/day in late August, +127 to +250/day in October, with a peak of **+544 on Sep 8**. Herdr fell off the Trendshift Rust top 25 on most days after Oct 6. Forks: 3,566.

**Inference:** growth peaked in July and has decayed steadily since. October's daily rate is about 40% of late August's.

### Downloads

- **Installs counter on herdr.dev:** "1,644,092 installs to date" (homepage, 2026-10-19). GitHub release assets sum to 1,586,353: linux-x86_64 880.9k, macos-aarch64 375.1k, windows zip 175.7k, and linux-aarch64 103.2k. Self-reported milestones: "25k stars and 340k downloads" on Aug 6 and "more than 700,000 downloads and close to 1,000 plugins" on Sep 7. Downloads therefore more than doubled from Sep 7 to Oct 19 even while star growth slowed. `herdr update` re-downloads count here, so this is not a user count.
- **Homebrew formula** (in homebrew-core since 2026-05-25): 28,232 installs (30d), 62,455 (90d), 80,485 (365d), about 940/day now ([formulae.brew.sh](https://formulae.brew.sh/api/formula/herdr.json)). That is about 20x Paseo's cask.
- **crates.io:** 1,455 downloads, too few to count as a channel.
- **Plugins:** "1,789 community plugins" (homepage counter), against "more than 500… one month after the marketplace" (Aug 6).
- **Contributors:** 89, with 585 merged PRs and **521 closed-unmerged PRs** (GitHub search).

### Biggest jumps and the events behind them

| # | Window | Stars | Events | How matched |
|---|---|---|---|---|
| 1 | 2026-06-29 → 07-08 | 7,975 → 13,995 (+6,020 in 9 days, about 670/day) | Third-party HN "Herdr: Agent multiplexer that lives in your terminal", **166 pts / 110 comments**, Mon Jun 29 04:27 UTC ([HN](https://news.ycombinator.com/item?id=48714802)). YouTube "Herdr in about 6 minutes" by Jilles (6k subscribers), Jun 29, **160k views** ([video](https://www.youtube.com/watch?v=qnIu-Xu64H0)). Third-party HN "Herdr: One terminal to rule them all", **404 pts / 178 comments**, Thu Jul 2 04:28 UTC ([HN](https://news.ycombinator.com/item?id=48756578)). GitHub Trending: Rust #1 Jun 29, Jul 1, and Jul 8, and all-languages #16–25 on 9 of the 10 days Jun 29–Jul 8 (Trendshift). | Wayback Jun 29, Jul 1, Jul 8, plus Trendshift ranks |
| 2 | 2026-07-08 → 07-29 | 13,995 → 22,327 (+8,332 in 21 days, about 400/day) | YouTube: Owain Lewis Jul 9 (27.6k views), **Academind "herdr is a must use" Jul 16 (200k views, from a channel with 925k subscribers)** ([video](https://www.youtube.com/watch?v=2CR9tDNAzB0)), Tonbi's AI Garage Jul 24 (24.2k). Rust trending #1–3 on Jul 8, 16–18, and 27–28. Apache relicense Jul 22. | Wayback Jul 8, 18, 25, 29, plus YouTube publish dates |
| 3 | 2026-05-17 → 06-07 | 541 (May 7) → 1,192 (May 17 23:34) → 4,783 (Jun 7) | YouTube "Herdr: the Tmux for AI Agents" by Hal Shin, May 17 04:58 UTC, **106k views** ([video](https://www.youtube.com/watch?v=XoitaexiCi0)). Its title echoes the site title "herdr — tmux for agents" (Apr 21). Rust trending #7 on May 17–18. A second wave May 28–Jun 1 (Rust #7–8, normalized GH Archive peak May 30–31) after v0.6.3, two blog posts (May 27), and the brew formula (May 25). Better Stack video Jun 5 (58k). A third-party HN post May 23 flopped (5 pts). | Wayback May 7, 17, 29, Jun 7, normalized GH Archive, Trendshift |
| 4 | 2026-08-06 → 08-12 | 25,254 (Aug 7) → 27,975 (Aug 12), about 550/day vs about 380/day before | HN "Herdr is joining Y Combinator. The runtime stays open", **281 pts / 189 comments**, Thu Aug 6 19:14 UTC ([HN](https://news.ycombinator.com/item?id=49201003)). Rust #1 Aug 9–11, all-languages #21/#24 Aug 10–11. | Wayback, Trendshift, normalized GH Archive peak Aug 7 |
| 5 | 2026-09-07 → 09-09 | +364, **+544**, +411/day (baseline about 250) | v0.9 and blog post "Connecting the machines" (Sep 7, with HN 93 pts / 35 comments on Sep 8 [HN](https://news.ycombinator.com/item?id=49612818)). $6M seed post Sep 8 (HN 7 pts). Rust #2 and #3 on Sep 8–9. | Trendshift daily table |

### Did the CJK localization matter?

- **Measured:** the Simplified Chinese README landed 2026-07-29 from a community contributor (Patrick Xin, #1990). Star rate was 385/day from Jul 15–27 and 379/day from Jul 27–Aug 8, so no change.
- **Measured:** the CJK share of located stargazers in the GH Archive sample is flat at 15–27% across all windows (n=13–24 per window). That compares with Paseo's 63% during its April spike.
- **Measured:** Chinese content exists but follows growth. A Zhihu explainer cites "GitHub 9K 人收藏" (9K stars, so about late June) ([Zhihu](https://zhuanlan.zhihu.com/p/2055627650740359366)). There are CSDN reposts (e.g. "GitHub Daily #081"), a [moewah.com review](https://blog.moewah.com/posts/herdr-agent-multiplexer-review/), a Chinese fork [zarttic/herdr-zh](https://github.com/zarttic/herdr-zh), and Chinese X posts in October ("Herdr 火了，4 万多星的 Agent 运行时" by @xiaomovps, plus @Gablego and @laogeai) listed on Trendshift.
- **Inference:** Herdr's audience is mostly English-speaking terminal and YouTube developers. Localization was a community gesture and did not change growth.

## 3. Channel inventory

| Channel | Evidence | Cadence / status |
|---|---|---|
| Website herdr.dev | Homepage with live counters (stars, installs, plugins, agents) and a clickable TUI hero ("Click the sidebar, it's a real layout"). [Docs](https://herdr.dev/docs/). [Compare](https://herdr.dev/compare/) (since 2026-05-19). [Plugin marketplace](https://herdr.dev/plugins/) (2026-06-21), with "Trending this week" and "New to the herd". [Cloud waitlist](https://herdr.dev/cloud/). Rebuilt on a "new brand chassis" 2026-08-03 | Active |
| Blog [herdr.dev/blog](https://herdr.dev/blog/) | 7 posts: May 27 (×2), Jun 10, Aug 3, Aug 6, Sep 7, Sep 8 | About 1–2/month, tied to releases and company news, none since Sep 8 |
| X | Company [@herdrdev](https://x.com/herdrdev) (README badge, site nav), founder [@cancelik](https://x.com/cancelik). The YC post links community X posts (Raycast extension by @vladscale, Stream Deck by @timvdhoorn, iOS app by @imnotchalk) | X agent to measure |
| Discord | [discord.gg/PsgRfzmUDg](https://discord.gg/PsgRfzmUDg): 668 members, 147 online. **Created 2026-08-04**, 4 months after launch and 2 days before YC | Young, small relative to 44k stars |
| GitHub Discussions | Feature requests (e.g. [#515](https://github.com/herdrdev/herdr/discussions/515) multi-server, cited in the 0.9 post) | Used as the roadmap input channel |
| Reddit | Founder posted Herdr 4 times, all flops (§4), and stopped after May 13. r/herdr: first post about 2026-07-18, 100+ posts, mostly community plugin showcases, top 19↑. 72 r/ClaudeCode posts mention Herdr, including the user post "Just fucking love herdr!!" (78↑/71, Oct 9) and the skeptical "Herdr, cmux, tmux... are they really that helpful?" (13↑/26, Jul 28). 16 r/ClaudeAI posts mention it | Community-run, word of mouth inside "how do you run parallel agents?" threads |
| Hacker News | Founder never submitted Herdr (his HN account has 7 items: the Dec 2025 Peer Arena Show HN and comments, none a Herdr submission). 6 third-party posts ≥45 pts (§4), and about 15 third-party HN posts for Herdr plugins and clients with Herdr in the title | Earned only |
| YouTube | No own channel found. 13 third-party videos, about 700k views total (§6) | Creator-driven |
| Product Hunt | No listing found ([PH search](https://www.producthunt.com/search?q=herdr) shows none) | None |
| Newsletter | None. The Cloud waitlist is the only email capture | n/a |
| Directories / lists | [Terminal Trove](https://terminaltrove.com/herdr/) (listing and gold sponsor). awesome-agent-orchestrators, awesome-cli-coding-agents, awesome-agent-harness, awesome-claude-code, awesometui, awesome-agent-clients, awesome-ai-dev-tools, awesome-opensource-ai, awesome-ai-agents. GitHub-trending archives (aneasystone, araguaci). Trendshift badge in README (2026-07-02) | Passive |
| Package managers | curl installer, `brew install herdr`, `mise`, nix, termux-packages, a Debian repo (dariogriffo), Windows PowerShell installer | Distribution as marketing |
| Developer dotfiles | Herdr configs appear in public dotfiles (TechDufus, khuedoan, citypaul, joegoldin, edmundmiller, and others) and in plugins by known devs (johnlindquist/herdr-pane-status, joelhooks/herdr-pings) | Word-of-mouth through configs |
| Localization | README in English and 简体中文 only | Static |

## 4. Launch history

All HN submissions are by third parties. The founder's only launches were 4 Reddit posts.

| Date (UTC) | Day, hour | Where | Title (exact) | Result | Outcome |
|---|---|---|---|---|---|
| 2026-03-30 19:26 | Mon 19h | r/rust (founder u/arzamar) | "herdr - a terminal-native agent multiplexer built with rust & ratatui" | 0↑, 1 | Flop |
| 2026-03-30 19:38 | Mon 19h | r/ClaudeCode (founder) | "herdr - a terminal-native agent multiplexer" | 1↑, 0 | Flop |
| 2026-03-30 19:39 | Mon 19h | r/codex (founder) | "herdr - a terminal-native agent multiplexer" | 2↑, 0 | Flop |
| 2026-05-13 19:41 | Wed 19h | r/theprimeagen (founder) | "I built a tmux-style terminal manager for running multiple coding agents" | 0↑, 7 | Flop, last founder post |
| 2026-05-23 12:53 | Sat 12h | HN (yigitkonur35) | "Herdr: A tmux-like terminal multiplexer for AI coding agents" | 5 pts, 0 | Flop |
| 2026-06-11 18:03 | Thu 18h | HN (cloudmanic) | "A Plugin to Supercharge Herdr" (herdrplus.com, a commercial add-on) | 2 pts, 1 | Flop |
| 2026-06-29 04:27 | Mon 04h | HN (mzehrer), GitHub URL | "Herdr: Agent multiplexer that lives in your terminal" | **166 pts, 110** | Front page |
| 2026-06-30 11:12 | Tue 11h | HN (rldjbpin) | "Herdr: One terminal for he whole herd" [sic] | 3 pts | Dupe flop |
| 2026-07-02 04:28 | Thu 04h | HN (handfuloflight), herdr.dev URL | "Herdr: One terminal to rule them all" | **404 pts, 178** | Biggest launch |
| 2026-08-06 19:14 | Thu 19h | HN (collinmanderson) | "Herdr is joining Y Combinator. The runtime stays open" | **281 pts, 189** | Front page |
| 2026-09-07 19:57 | Mon 19h | HN (pstadler) | "Herdr now connects to multiple servers with a single client" | 4 pts, 3 | Flop |
| 2026-09-07 20:41 | Mon 20h | HN (Bluestein) | "Support multiple remote Herdr servers" | 3 pts | Flop |
| 2026-09-08 16:11 | Tue 16h | HN (kandros) | "Herdr Raised a $6M Seed" | 7 pts, 0 | Flop |
| 2026-09-08 16:43 | Tue 16h | HN (collinmanderson) | "Connecting the machines" | **93 pts, 35** | Front page |
| 2026-09-11 00:54 | Fri 00h | HN | "Herdr Studio" (community GUI using Herdr's name and logo) | 45 pts, 20 | Confusion ("Feels wildly misleading") |
| 2026-10-09 01:41 | Fri 01h | r/ClaudeCode (user) | "Just fucking love herdr!!" | 78↑, 71 | Best Reddit thread |
| 2026-10-10 06:46 | Sat 06h | HN (figmert) | "Herdr does not accept unsolicited pull requests" | 2 pts | Policy noticed, no pile-on |
| n/a | n/a | Product Hunt | n/a | no launch | n/a |

What the titles show:
- The founder's own titles were literal category labels ("herdr - a terminal-native agent multiplexer") posted cross-sub within 13 minutes at 3 days old. They got 0–2 upvotes, the same fate as the literal third-party HN title on May 23.
- The same product scored 5 → 166 → 404 points as the title moved from category description ("A tmux-like terminal multiplexer for AI coding agents") to positioning line ("Agent multiplexer that lives in your terminal") to a playful, grand claim pointing at the polished homepage ("One terminal to rule them all").
- For company news, "The runtime stays open" (an open-source promise) got 281 points, while "Raised a $6M Seed" got 7. The same news week, "Connecting the machines" got 93 while "Herdr now connects to multiple servers…" got 4. **Inference:** on HN, abstract essay titles beat literal feature titles when the link is a well-written post.

## 5. Content patterns

- **Founder voice, lowercase and playful.** The README voice is "herdr is a terminal workspace manager… you keep your terminal. herdr keeps track of your agents." It is full of sheep puns: "thank you 🐑", "Give them somewhere to live.", "A ram, asleep above the clouds. Or working, hard to tell." Posts open in first person ("Hey everyone, it's Can").
- **Category ladder in the tagline** (site `<title>`, git history): "herd your agents" (Apr 7), "supervise multiple coding agents in one terminal" (Apr 9), "**tmux for agents**" (Apr 21), "terminal multiplexer for AI agents" / "One terminal. The whole herd." (May 18), then "**the runtime coding agents run on**" (Aug 3, with the YC rebrand). README: "terminal workspace manager for AI coding agents" (Mar 27), "agent multiplexer that lives in your terminal" (Apr 21), "the runtime your coding agents live on" (Aug). "Tmux for agents" gave creators a ready explanation (Hal Shin's video title copied it). "Runtime" then sized it up for investors.
- **Engineering deep-dives with numbers:** "Ten agents, three clients, 95% less CPU" (Aug 3), "Live updates without killing your terminal processes" (May 27). Essay: "Coding agents are becoming runtimes" (Jun 10).
- **Comparison page as a category map:** "The columns are categories, not enemies… The row that sorts the field is the second one: what happens to the agents when the thing you're looking at goes away." Conductor, Emdash, and Superset are framed as "clients without a runtime: quit the app and the herd goes with it" ([compare](https://herdr.dev/compare/)).
- **Social proof on the homepage:** counters for stars, installs, and plugins. A "Popular with engineers from…" logo row drew "Bold haha… feels like lawyer-bait" on HN.
- **Product demo:** an MP4 in the README and a fake-but-clickable TUI on the homepage.
- **Release notes** with "(#PR, thanks @user)" credits.
- **Stunts:** hiring "through the terminal, over SSH" (seed post).

## 6. What resonated (top content by engagement)

| # | Content | Engagement | Why it worked (inference) |
|---|---|---|---|
| 1 | HN "Herdr: One terminal to rule them all" (Jul 2) | 404 pts, 178 comments | Arrived 3 days after a 166-pt thread and a viral video, so many commenters had tried it ("I now run over 10 agents… Tmux was not making this particularly easy"). Playful title, polished homepage, and a "why not tmux?" debate that kept comments coming |
| 2 | YouTube Academind "herdr is a must use" (Jul 16) | 200k views | A 925k-subscriber channel with an endorsement-style title. Herdr is easy to demo in one terminal, under 6 minutes |
| 3 | YouTube Jilles "Herdr in about 6 minutes" (Jun 29) | 160k views from a 6k-subscriber channel | A short format, same day as HN #1, with chapters that walk through install, agent skill, workspaces, and agent states |
| 4 | HN "Herdr is joining Y Combinator. The runtime stays open" (Aug 6) | 281 pts, 189 comments | Personal founder story ("Four months ago I was looking for another job") plus an open-source pledge and the AGPL→Apache switch. The comments became a debate on YC and enshittification, which kept it ranked |
| 5 | YouTube Hal Shin "Herdr: the Tmux for AI Agents" (May 17) | 106k views | First creator to pick it up. It turned a 541-star project into a trending repo, and the "tmux for agents" frame did the explaining |

Runners-up: HN "Herdr: Agent multiplexer that lives in your terminal" (166 pts), Alejandro AO / Hugging Face "Herdr Crash Course" (96.9k views, Aug 27), Better Stack (58.4k, Jun 5), HN "Connecting the machines" (93 pts).

## 7. What did not work

- **Founder self-launches:** 3 Reddit posts within 13 minutes on launch-plus-3-days (r/rust, r/ClaudeCode, r/codex: 0–2↑) and one in r/theprimeagen (0↑) went nowhere. He stopped self-promoting after May 13. Every later wave came from creators and third-party HN posters.
- **Literal titles and funding headlines on HN:** "A tmux-like terminal multiplexer for AI coding agents" got 5 points. "Herdr Raised a $6M Seed" got 7. "Herdr now connects to multiple servers with a single client" got 4.
- **Technical blog posts never reached HN:** "95% less CPU", "Coding agents are becoming runtimes", and "Live updates…" have no HN submission in Algolia. **Inference:** they work as credibility and SEO content and have not produced launches.
- **Recurring skepticism:** in every big thread the top comment is a variant of "Just use tmux no?" (166-pt thread). Others: "I read the website and still don't understand what this solves", "Vibecoded. Nope.", "wtf is 'runtime'", "Okay, back to tmux it is then" (on YC), and "YC means VC means commercialization means enshitification". The seed and Cloud post drew "Why would I want a service for this when I could easily run such a discovery service myself?… this is how we monetize in 2026."
- **Performance and reliability complaints:** "with work done on 5 remote machines herdr just gets laggy after couple of hours". Session auto-naming is missing ("considering moving on"). The multi-server feature arrived after "months" of asks.
- **Monetization experiments abandoned:** the AGPL+commercial dual license lasted 2026-05-26 to 07-22. Sponsorship tiers ($2.5k/$5k a month, launched 2026-06-24) closed after YC.
- **Contribution gate:** CONTRIBUTING.md now says "Herdr does not accept unsolicited pull requests", with 521 closed-unmerged PRs. An HN post about it got 2 points, so it hasn't become a scandal, but it limits the contributor funnel that Paseo uses.
- **Brand confusion:** the community "Herdr Studio" (45 HN pts) used Herdr's name, logo, and CSS. Commenters called it "wildly misleading".
- **Late community channel:** Discord was opened Aug 4 and has 668 members, against Paseo's 2,291 at half the stars.
- **Momentum decay:** daily stars fell from 300–376 (late Aug) to 125–170 (mid-Oct), and Herdr is no longer on Rust trending on most October days. Since Sep 8 there has been no blog post or big launch moment.

## 8. Timing

- **HN:** all the hits were third-party posts. Two were at about 04:30 UTC (Mon and Thu, US late evening and Europe/Turkey morning), and two at 16:43–19:14 UTC (Tue and Thu). The Saturday-noon post flopped. **Inference:** the poster and title mattered more than the hour, and HN's late-night US slot was no handicap.
- **YouTube after HN:** big creator videos landed 0–14 days after each HN spike (Jilles same day, Owain Lewis +7d, Academind +14d). Each kept the 400–670/day rate going for weeks.
- **Releases** (stable): Mar 8, Apr 19, May 16, Jun 6, Jul 4, Aug 2, Sep 4, Oct 2. Prereleases appeared from June on (16, 7, 5, 7, 2). Weekdays of all 98 releases: Tue 25, Wed 24, Mon 15, Fri 11, Sun 9, Thu 8, Sat 6. The early project shipped almost daily (19 stable releases in April). After June, releases slowed to milestone versions paired with a blog post (0.6.3 on May 27, 0.9 on Sep 7).
- **Correlation:** stars track creator and HN moments, not releases. The 0.9 release plus seed (Sep 7–8) was the only release-linked spike, and it peaked at +544/day.

## 9. Community and distribution mechanics

- **An API that agents can drive turned users into builders.** The socket API and CLI ("the same surface agents drive"), plus an agent skill (`npx skills add ogulcancelik/herdr --skill herdr -g`), led to third-party clients. Examples include iOS (Heeler, and @imnotchalk's app), Android (droidtty), web/PWA (Shepherdr, ColliePWA, herdr-web-ui), Vision Pro/iPad (Multiplex), Raycast, Stream Deck, a macOS notch app, Neovim integration, a 3D "office", and Telegram control. About 15 of these got their own HN post with Herdr in the title.
- **Plugin marketplace with a "Trending this week" section** gives plugin authors visibility and a reason to post. 1,789 plugins exist, many showcased on r/herdr.
- **Install friction close to zero:** a one-line curl, brew, mise, nix, termux, Debian, a Windows installer, and self-install over SSH. The README sells "One command, and nothing else about your setup changes."
- **Distribution inside other tools' configs:** dotfiles and plugins by well-known devs (John Lindquist, Joel Hooks) spread Herdr person to person. **Inference:** this is how Herdr reached 44k stars without a Product Hunt launch or a founder HN post.
- **Partnerships:** Terminal Trove (directory plus sponsor) and Moshi (iOS SSH app, Gold sponsor). The YC post showcases community integrations rather than features.
- **Free and no login.** The paid layer (Cloud) is a waitlist, and the pitch is explicitly "doesn't host the agents for you".
- **OSS stance as marketing:** "The runtime stays open", the Apache switch, and the "core stays small, everything else through extensions" line all play to developers' fear of VC lock-in.

## 10. Lessons for intentic

1. **Earn third-party YouTube coverage. It was Herdr's biggest channel.** 13 videos, about 700k views, and a big video lines up with three of the five jumps. Two came from small channels: Hal Shin turned 541 stars into Rust trending, and Jilles (6k subscribers) got 160k views. Give creators a 6-minute demo path: one install command, one "persistent sandbox per agent" moment, one phone check-in.
2. **Find an analogy creators can repeat.** "tmux for agents" explained Herdr in three words before "runtime" sized it up for investors. Intentic needs its equivalent ("a persistent dev box per agent, in your browser and on your phone"), tested on titles before launch.
3. **Title wording decides HN.** The same product scored 5, 166, and 404 points depending on the title. Funding headlines got 7, and "The runtime stays open" got 281. For intentic news, lead with the open-source/MIT promise or a sharp concept, and keep the funding amount out of the title.
4. **Make intentic drivable by agents and by other people's clients, and showcase what they build.** Herdr's API and skill produced about 15 community HN posts with Herdr in the title. Intentic's sandbox API plus a "built on intentic" gallery and plugin index can do the same.
5. **Herdr Cloud is about to compete head-on.** It promises to "connect any machine, anywhere, through one Herdr account", with "end-to-end encrypted" terminal traffic, and "doesn't host the agents for you". Intentic already does persistent sandboxes on your own machine *or* hosted, reached from any browser or phone without SSH. Position against it now: "no SSH, no terminal required, works from a phone browser today, MIT."
6. **Answer "why not tmux / why not just X" before you're asked.** Herdr's compare page frames competitors as "categories, not enemies" and names the one row that sorts the field (whether agents survive when the UI closes). Intentic should pick its sorting row (an agent keeps its own persistent sandbox and survives your laptop) and build the comparison page around it.
7. **Keep the contributor funnel open, and plan recurring moments to counter decay.** Herdr's closed-PR gate and late Discord left it with 668 Discord members at 44k stars. Its daily stars halved within two months of the last big moment. A monthly cadence of one HN-worthy concept post plus one creator video beats sporadic big launches.
8. **Ship the boring distribution channels early.** Herdr's brew formula does about 940 installs/day, plus curl, mise, nix, termux, and Debian. Intentic's install paths (Docker, brew, one-liner) are themselves listings that bring people in.

## X handles found

- [@herdrdev](https://x.com/herdrdev): company (README badge, site nav, GitHub org)
- [@cancelik](https://x.com/cancelik): founder Can Celik (site author card `AuthorCard.astro`)
- Community builders cited by Herdr: @vladscale (Raycast extension), @timvdhoorn (Stream Deck), @imnotchalk (iOS app)
- Chinese-language amplifiers on Trendshift: @Gablego, @xiaomovps, @laogeai, @Error403point9, @zmx, @kuntaykunt
