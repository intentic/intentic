# X/Twitter teardown: 10 workspaces for coding agents

How ten tools in intentic's category market themselves on X: who posts, how often, what earns
engagement, who talks about them, and what intentic should copy or skip. Data was read on
2026-10-19 (UTC) from a signed-in X session, read-only. Every number below comes from that
extraction; statements marked **(inference)** are interpretation, not measurement.

Products and accounts studied (21 accounts):

| Product | Brand account | Founder accounts studied | GitHub stars (Oct 19) |
|---|---|---|---|
| Conductor (conductor.build) | @conductor_build | @charlieholtz, @jacksondecampos | no public repo |
| Superset (superset.sh) | @superset_sh | @FlyaKiet, @avimakesrobots, @saddle_paddle | 15.4K |
| Orca (orca.dev, Stably AI) | @orca_build | @JinjingLiang | 97.8K |
| Synara (trysynara.com) | @trySynara | @emanueledpt | 2.1K |
| Paseo (paseo.sh) | @paseo_sh | @moboudra | 21.4K |
| Herdr (herdr.dev) | @herdrdev (written in the solo founder's first person) | none found | 44.8K |
| BB (getbb.app) | @get_bb_app | @sawyerhood | 4.5K |
| Usemono / MonoCode (usemono.dev) | none (the handle @usemono belongs to someone else) | @nikolay_dp | 3.2K |
| Hermes Agent (Nous Research) | @NousResearch | @Teknium (@Teknium1 no longer exists) | 255K |
| Nimbalyst (nimbalyst.com) | @nimbalyst | @wirthkarl | 1.9K |

Hermes Agent is a different kind of company (a model lab with a 284K-follower account and a
general-purpose agent). It is in the tables as a scale reference, not as a peer.

## How the numbers were made

- **Source.** X's own GraphQL responses, captured in the browser while scrolling, so counts are
  exact (likes, reposts, replies, quotes, bookmarks, views), not the rounded "1.2K" on screen.
  For each account: the Posts tab (originals and quotes), the Replies tab, the Reposts tab,
  `from:<handle> since:` live search where the rate limit allowed, and `from:<handle>
  min_faves:N` top search for the all-time best posts. Word of mouth came from Top-tab searches
  for each product's name, domain and handle, filtered to posts that actually name the product
  in a coding context.
- **Window.** 2026-08-20 to 2026-10-19 (8.7 weeks). For @emanueledpt and @Teknium, who post
  hundreds of times a week, the window is 2026-09-19 to 2026-10-19.
- **Definitions.** *Originals* = original posts plus quote posts (what an account publishes
  itself). *Posts/wk excl. reposts* also counts replies and self-replies (thread continuations).
  *Likes/views median and p90* are over originals in the window. *Best weekday / 3-hour slot*
  is the UTC bucket with the highest median likes among buckets with at least 3 originals.
  *rel* (used in the cross-product section) = a post's likes divided by its own account's
  median likes, so a 284K-follower account and a 1.5K-follower account can be compared.
- **Where the sample is partial.** X allows roughly 50 timeline or search requests per endpoint
  per 15 minutes. Four accounts reply so often that their Replies tab could not be read back the
  full window; their reply volume is measured on a fully read sub-window and marked `*`:
  @emanueledpt (Oct 2 to 7, 5.5 days), @nikolay_dp (Oct 8 to 19), @NousResearch (Oct 2 to 19),
  @Teknium (Oct 2 to 19). A `+` on reposts means the Reposts tab did not reach back the whole
  window, so the figure is a floor. Originals were read for the full window for every account.
- **Freshness.** Posts from Oct 17 to 19 were still collecting likes when read.
- **Raw data.** One JSON array per handle (url, datetime, text, kind, media, replies, reposts,
  quotes, likes, bookmarks, views, in-window flag) in
  `/work/.intentic/local/tmp/mkt-research/x/<handle>.json`; computed stats in `stats.json`,
  cross-product aggregates in `cross.json`, word of mouth in `wom.json`, every capture in `raw/`,
  scripts in `scripts/`.

## 1. Account tables

Window 2026-08-20 to 2026-10-19 unless noted. `*` = reply volume measured on a fully read sub-window (see above); `+` = repost count is a floor.

**Conductor**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @conductor_build (brand) | 27K | Sep 2024 | 1 | 0.6 | 1.3 | 44% | 0 / 0 / 100 / 0 (n=5) | 37 / 78 | 8.4K / 22K | n/a (<3 posts per slot) | n/a (<3 posts per slot) |
| @charlieholtz (founder) | 37K | Mar 2020 | 16.6 | 4.4 | 1.7 | 71% | 13 / 42 / 45 / 0 (n=38) | 73.5 / 243 | 8.2K / 38K | Mon (n=8, med 211.5) | 00-02 (n=3, med 97) |
| @jacksondecampos (founder) | 2.2K | Feb 2013 | 3.3 | 2.1 | 0 | 34% | 6 / 17 / 72 / 6 (n=18) | 5.5 / 31 | 704 / 1.9K | Thu (n=3, med 9) | 21-23 (n=3, med 9) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **98%** (@conductor_build 188, @charlieholtz 5K, @jacksondecampos 2.6K).

**Superset**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @superset_sh (brand) | 7.3K | Nov 2025 | 14.1 | 1.8 | 4.6+ | 84% | 19 / 13 / 69 / 0 (n=16) | 8 / 52 | 2.6K / 8.5K | Tue (n=4, med 28) | 15-17 (n=9, med 9) |
| @FlyaKiet (founder) | 3.7K | Jul 2017 | 76.8 | 13.4 | 5.7 | 79% | 15 / 39 / 45 / 2 (n=116) | 17 / 56 | 1.3K / 5.8K | Sat (n=9, med 29) | 15-17 (n=34, med 25) |
| @avimakesrobots (founder) | 1.8K | Mar 2023 | 15.8 | 3 | 4.8 | 80% | 8 / 23 / 65 / 4 (n=26) | 12 / 38 | 971 / 8.5K | Mon (n=5, med 23) | 15-17 (n=4, med 22) |
| @saddle_paddle (founder) | 834 | Jul 2025 | 1.6 | 1 | 0.5 | 36% | 0 / 22 / 67 / 11 (n=9) | 8 / 18 | 853 / 2.5K | n/a (<3 posts per slot) | 21-23 (n=5, med 13) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **84%** (@superset_sh 711, @FlyaKiet 3.1K, @avimakesrobots 511, @saddle_paddle 93).

**Orca**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @orca_build (brand) | 20K | Mar 2026 | 56.6 | 7 | 12 | 85% | 26 / 18 / 54 / 2 (n=61) | 85 / 253 | 10K / 20K | Thu (n=10, med 120.5) | 15-17 (n=9, med 119) |
| @JinjingLiang (founder) | 11K | May 2021 | 85.1 | 13.4 | 4.6 | 82% | 7 / 47 / 41 / 4 (n=116) | 87 / 624 | 7.2K / 52K | Mon (n=6, med 187) | 03-05 (n=10, med 155) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **86%** (@orca_build 7.4K, @JinjingLiang 45K).

**Synara**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @trySynara (brand) | 3.1K | May 2026 | 42.8 | 12.6 | 12.6 | 66% | 17 / 54 / 28 / 2 (n=109) | 32 / 74 | 2.6K / 10K | Fri (n=14, med 40) | 00-02 (n=4, med 69.5) |
| @emanueledpt (founder) | 12K | Jun 2024 | 434* | 31.8 | 20.1 | 89%* | 18 / 50 / 30 / 2 (n=139) | 40 / 91 | 2.6K / 6.9K | Sat (n=17, med 46) | 12-14 (n=31, med 50) |

Share of likes on original posts since 2026-09-19 earned by founder accounts: **75%** (@trySynara 3K, @emanueledpt 9K).

**Paseo**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @paseo_sh (brand) | 572 | Apr 2026 | 0.1 | 0.1 | 0.2 | 0% | 0 / 0 / 100 / 0 (n=1) | 0 / 0 | 141 / 141 | n/a (<3 posts per slot) | n/a (<3 posts per slot) |
| @moboudra (founder) | 1.5K | Sep 2013 | 2.1 | 1.2 | 0.1 | 11% | 0 / 40 / 60 / 0 (n=10) | 24.5 / 58 | 1.9K / 4.8K | Thu (n=4, med 42) | 12-14 (n=7, med 23) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **100%** (@paseo_sh 0, @moboudra 282).

**Herdr**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @herdrdev (brand) | 29K | May 2026 | 2.7 | 1.4 | 0.8 | 35% | 17 / 42 / 33 / 8 (n=12) | 821.5 / 3.1K | 59K / 303K | Mon (n=3, med 961) | 15-17 (n=6, med 788) |

No separate founder account: @herdrdev itself is written by the solo founder (15K likes on originals since 2026-08-20).

**BB**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @get_bb_app (brand) | 1.5K | Aug 2026 | 5.1 | 3.2 | 2.2 | 14% | 18 / 14 / 29 / 39 (n=28) | 52 / 105 | 4.6K / 9.2K | Tue (n=3, med 71) | 18-20 (n=7, med 72) |
| @sawyerhood (founder) | 19K | Aug 2009 | 26.7 | 7.4 | 1.2 | 65% | 17 / 33 / 48 / 2 (n=64) | 59 / 462 | 5.3K / 110K | Sun (n=3, med 262) | 15-17 (n=15, med 89) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **88%** (@get_bb_app 1.6K, @sawyerhood 12K).

**Usemono**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @nikolay_dp (founder) | 2.4K | Nov 2012 | 242.6* | 21.9 | 0.3 | 94%* | 22 / 42 / 36 / 0 (n=190) | 27.5 / 155 | 3.1K / 13K | Mon (n=24, med 45) | 15-17 (n=41, med 48) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **100%** (@nikolay_dp 14K).

**Hermes Agent**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @NousResearch (brand) | 284K | Oct 2020 | 97.6* | 7.5 | 8.3 | 81%* | 42 / 22 / 32 / 5 (n=65) | 1.6K / 4.3K | 140K / 712K | Tue (n=10, med 2.8K) | 21-23 (n=15, med 1.9K) |
| @Teknium (founder) | 134K | Feb 2021 | 278.8* | 18.1 | 18.1 | 89%* | 0 / 23 / 70 / 8 (n=79) | 477 / 1.3K | 32K / 87K | Sat (n=8, med 692) | 12-14 (n=3, med 791) |

Share of likes on original posts since 2026-09-19 earned by founder accounts: **46%** (@NousResearch 65K, @Teknium 56K).

**Nimbalyst**

| Account | Followers | Joined X | Posts/wk excl. reposts | Originals+quotes/wk | Reposts/wk | % replies | Video / image / text / link % (originals) | Likes med / p90 | Views med / p90 | Best weekday UTC (median likes) | Best 3-h slot UTC (median likes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| @nimbalyst (brand) | 407 | Oct 2025 | 0.5 | 0.1 | 1.3 | 50% | 100 / 0 / 0 / 0 (n=1) | 11 / 11 | 51K / 51K | n/a (<3 posts per slot) | n/a (<3 posts per slot) |
| @wirthkarl (founder) | 872 | May 2010 | 1 | 0.6 | 0.5 | 11% | 20 / 80 / 0 / 0 (n=5) | 1 / 2 | 73 / 197 | n/a (<3 posts per slot) | n/a (<3 posts per slot) |

Share of likes on original posts since 2026-08-20 earned by founder accounts: **35%** (@nimbalyst 11, @wirthkarl 6).

**Who carries the marketing.** Founder-led everywhere except Herdr and Hermes. Herdr's only
account is a brand handle that writes as the solo founder ("herdr has been a solo project from
day one"), so in practice it is founder-led too. Nous Research is a lab whose brand account is the
largest in the set, and even there the co-founder earns 46% of original-post likes in the last
30 days. Conductor's and Paseo's brand accounts are almost silent (0.6 and 0.1 originals a week);
the founder does the work.

## 2. Product by product

### Conductor

**Launch.** @charlieholtz, 2025-07-17, video: "We made a Mac app that lets you run a bunch of
Claude Codes in parallel. Introducing Conductor!" 3,584 likes, 3,611 bookmarks, 596K views
([post](https://x.com/charlieholtz/status/1945870105109246401)). Still his pinned post. The launch
ran on his account; the brand account, created ten months earlier, was not the vehicle.

**Top posts (all-time, founder).**

| Date | Format | Likes / views | Hook | Link |
|---|---|---|---|---|
| 2026-08-03 | image | 2,250 / 285K | "Added this to CLAUDE md today:" | [post](https://x.com/charlieholtz/status/2084407468843770176) |
| 2026-04-23 | video | 1,945 / 232K | "We've re-built Conductor from scratch to make it twice as fast." | [post](https://x.com/charlieholtz/status/2047351098634338610) |
| 2026-05-12 | image | 1,014 / 294K | "For the first time in Conductor history, we have a new default coding harness! Codex with GPT-5.5" | [post](https://x.com/charlieholtz/status/2054345027082657957) |
| 2026-07-30 | video | 1,000 / 246K | "Introducing Conductor Cloud! Out with worktrees, in with multiplayer cloud workspaces." | [post](https://x.com/charlieholtz/status/2082974209438044211) |
| 2026-10-01 | video | 761 / 71K | "Introducing Conductor Mobile! Run a team of cloud agents from your iPhone" | [post](https://x.com/charlieholtz/status/2105769644498002130) |
| 2026-06-12 | quote+image | 642 / 102K | "our first paid advertising!" (a billboard) | [post](https://x.com/charlieholtz/status/2065266030235258883) |

His two biggest posts ever predate Conductor: "this is my best productivity tip `sudo vim
etc/hosts`" (6,631 likes, 2024) and an AI clone that skips stand-ups (3,885 likes, 2024). The
audience was built on playful hacks first and then pointed at the product **(inference)**.

**Brand account best posts:** the Series A article, pinned (594 likes / 122K views); "Anthropic
has pushed back its subscription changes. You can continue to use your Claude Code plan with
Conductor." (525 / 99K, 2026-06-15); numbered changelog posts such as "Conductor 0.36 is live! -
Sonnet 4.6 - ..." (273).

**Why they worked.** Every top product post is a single "Introducing X" with a short screen
recording of a big capability (speed rewrite, cloud, mobile). The CLAUDE.md screenshot is a
reusable artifact people bookmark. The Codex-as-default post rides a model shift with a strong
opinion rather than a "now supported" line.

**In the window:** 4.4 originals a week, median 74 likes. His best: Conductor Mobile (761),
Cloud Desktop video (445), first impressions of Meta's new model quoting @alexandr_wang (342 /
74K), a product screenshot captioned only "Conductor conductor" (330). Work-in-progress
screenshots ("experimenting with an Artifacts tab...", 200; "Experimenting with a new workspace
status indicator", 193) beat his median.

**Flops.** His bottom quartile is 8 text posts out of 9, 6 of them quote posts, median length 23
characters: "is it time to do this?!" (13 likes), "agreed" (18), "I liked this" (24). The top
quartile is 4 videos and 4 images with a median 186 characters.

**Replies.** 102 replies in 60 days (11.8 a week, 71% of everything he posts). Of the 40 reply
targets whose size was captured, 12 have over 100K followers: @alexandr_wang (2), @brian_lovin
(2), @garrytan, @Suhail, @blader, @signulll, @venturetwins, @jsngr, @aaron_epstein.

**Word of mouth** (47 third-party posts from 44 authors; 26 with over 10K followers, 13 with
over 100K): @linear's integration video naming Conductor (1,674 likes), YC's "Full Stack" episode
with Charlie (793), @theo asking who still uses CLIs instead of "desktop apps like Codex App,
Conductor" (841), @zeroxtlt "Anthropic should definitely acquire @conductor_build" (450),
@euboid "The best agentic development environment is @conductor_build and it's not even close"
(185).

### Superset

**Launch.** Founder @avimakesrobots, 2026-02-27, video: "3 months ago we started building an IDE
for the AI agents era..." (216 likes / 60K, pinned). The brand's own launch post on 2026-04-07,
"introducing superset the IDE for the AI agent era stop waiting on coding agents run them in
parallel", video, is the account's best post: 1,042 likes, 910 bookmarks, 748K views
([post](https://x.com/superset_sh/status/2041549058012058043)). Second: "Introducing Superset for
iPhone" (477 / 291K, 2026-09-21), paired with a Product Hunt day (@avimakesrobots: "Superset
Mobile is #1 on Product hunt right now", 38 likes) and @FlyaKiet's "1 day after launch, @superset_sh
mobile is now #38 Devtools in the @AppStore" (80).

**Founder top posts (@FlyaKiet, all-time):** "wdym sold out 😭" with an image (2,621 / 273K),
"We're going vertical!" (546), "Introducing: Our users @superset_sh" (video, 367 / 387K, pinned),
the YC announcement (234). In the window his best are feature demos with a pain-point hook:
"Introducing: Usage Tracking" (121), "Introducing: Design Mode" (111), "Running out of Fable usage
limit is the worst feeling. I either have to downgrade to Opus, or move over to Codex and restart
the whole session..." (100 / 21.7K), and the quote "I'm already out of usage limit" (131).

**Flops.** Brand: emoji-only quote posts, "🫡🥋" (0 likes), "🥋" (3), "🔥🔥🔥" (4); its bottom
quartile is 4 of 4 quotes with a median length of 3 characters, its top quartile 3 videos and an
image at 291 characters. @FlyaKiet: "❤️" (2), "🦾" (2); 20 of his 29 bottom-quartile posts are
quotes, median 16 characters.

**Replies.** The Superset team replies constantly: @FlyaKiet 524 replies in 60 days (60 a week,
79% of his posts), @avimakesrobots 110, the brand 102 (84% of its posts). Almost none go to large accounts (2 of 513 for @FlyaKiet): this is
user-by-user support and community talk, not reply-guy reach.

**Other tactics.** A founding-engineer welcome post (49), SOC 2 ("I turned 28 and Superset is
officially SOC 2 compliant today", 58), "1 of every 8 Fortune 500 companies use @superset_sh" (48),
a public token-spend leaderboard ("$24.6M of tokens spent across 2,053 developers", 28), a launch
discount code (MOBILELAUNCH). On 2026-10-13 the brand announced a rename "later this month"
because "many companies and projects" share the name (52 likes).

**Word of mouth** is thin and list-shaped: Superset appears in roundups (@wesbos: "Herdr,
conductor, solo, warp, tmux, superset, emdash...", 535 likes). The standalone posts from large
accounts look bought: on 2026-04-07, 2.5 hours after the brand's launch post, @marcusyul (553K
followers) and @zentalksai (117K) posted ad-style copy ("This solves a huge pain point. Stop
waiting on coding agents one by one. Superset lets you run them all at once. Worth checking out
👀") two minutes apart, for 39 and 41 likes; on 2026-05-26, 2.5 hours after @FlyaKiet's
"Introducing: Our users", @saidstetic (155K), @marcusyul and @kari_ok6 (533K) posted within 20
minutes of each other, for 27, 62 and 19 likes. **(Inference: paid creator placements; the
engagement is a fraction of what those follower counts normally earn.)**

### Orca

**Launch.** Founder @JinjingLiang, 2026-04-02, video: "Seriously—stop using Cursor / Conductor /
Cmux. Orca does it all: - Ghostty terminal - File editor - Worktree management..." 687 likes /
325K views, pinned ([post](https://x.com/JinjingLiang/status/2039775250133709047)). The next day
@orca_build posted "Orca now has Notion-style markdown editing" (video, 787 / 278K, pinned) and
she quoted it with "Obsidian was a phase. Orca is where I work now" (429 / 86K). The launch hook
names the competitors outright.

**Brand top posts (window):**

| Date | Format | Likes / views | Hook |
|---|---|---|---|
| 2026-10-15 | video | 514 / 35K | "🔥 Use DeepSeek-v4.1-flash for free in Orca Here's how: 1. ..." |
| 2026-09-02 | video | 432 / 56K | "Gemini 3.8 Flash now ranks ahead of Opus 5 on DeepSWE-bench." |
| 2026-09-03 | quote+image | 408 / 55K | "What's better than free tokens? Use OpenCode inside Orca for free Muse Spark 1.3 🎉" |
| 2026-09-10 | video | 381 / 47K | "New in Orca — Agent Activity View 🔔 See what agents need you, without opening a single one." |
| 2026-07-23 | video | 362 / 56K | "Hit your usage limit in Codex/Claude Code mid-task? Orca now lets you resume the exact same session in a different agent" |

Free model access and benchmark news beat feature announcements. The brand posts 7 originals a
week, 26% of them video, and its top quartile is 11 videos out of 15 at a median 274 characters.

**Founder.** @JinjingLiang (10.7K followers) is the reach engine, mostly with posts that are not
about Orca: a meme captioned "Jev" (17,850 likes / 700K views, 2026-09-20), "Claude team
panicking right now. I wonder why" (5,386 / 2.2M), "My impressions of Opus 5.5 after 1 day of
use:" (2,910), "🧠💰GPT-6 Astra Money Tip: 'Medium Effort' 1% less intelligence for 25% cost
savings" (2,195 / 272K), "We applied for GPT-5.6 preview but got rejected" (2,076). In 59 days
she earned 45K likes on originals versus the brand's 7.4K.

**Replies.** The heaviest reply-guy in the set: 603 replies in 59 days (72 a week, 82% of her
posts), 61 of them to accounts above 100K followers: @eddiejaoude (12), OpenAI's @thsottiaux
(10), @petergyang (5), @ClaudeDevs (3), @theo (3), @thdxr (3), @OpenAINewsroom (2),
@alexandr_wang (2). The brand adds 415 replies (85% of its posts), mostly support.

**Flops.** Brand: "👀" (17 likes), a question, "Anyone else having the same issue of configuring
remote agents? 🤔" (17); its four question posts have a median of 38 likes against 91 for the rest.

**Word of mouth** (75 posts, 68 authors, 24 over 10K followers): @midudev (343K) in Spanish,
"¡Orca es una pasada para orquestar agentes de IA!" (video, 1,124 likes); a Chinese guide to
keeping a Claude Code subscription safe using a server, Orca and Tailscale (@fiapp_pro, 1,417 /
254K) plus a second Chinese post on the same idea (753); @shannholmberg's "summary of my AI stack:
1. @orca_build - main ADE" (1,747 / 204K); @RoundtableSpace's "7 GitHub repos that turn Claude
Code into a full engineering team: 1. Orca" (401). Much of Orca's word of mouth is
non-English **(inference: localized creators drive it)**.

### Synara

**Launch.** @emanueledpt, 2026-06-01, image: "Introducing Synara — former DP Code. Synara is an
Open-source GUI for Agentic Development." 224 likes / 34K. The brand account opened 2026-05-30.
In August a licensing dispute with T3 Code ("I want to apologize for my ignorance. I changed the
MIT license without realising it", 410 / 136K, and a video "The full story of the MIT License
incident, T3 Code, Synara, fork vs clone...", 188 / 61K) drew more attention than the launch.

**Brand (@trySynara, 3.1K followers, follows 1 account).** 12.6 originals a week, more than
half screenshots. Best: an image-only post with no caption (496 / 58K, 2026-09-05), "Synara
v1.0.0 Beta is out 🪽 100+ PRs led to the greatest and biggest update..." (169), "Would you look
at that" (167), "We just crossed 18.5k downloads!" (109). The brand reposts 12.6 times a week,
46 of them the founder's posts. Its pinned post gates early access behind replies ("If you're a
power use [sic] of Synara leave a reply to get access", 72 likes, 40 replies).

**Founder (@emanueledpt, 11.7K).** Building in public as an indie hacker ("Road to $10k/mo" in
the bio) with a posting streak he says ran 456 days. Volume is extreme: 340 posts in a fully read
5.5-day stretch (Oct 2 to 7), 89% replies, about 62 a day, plus 32 originals a week. All-time best
are long-form X articles (2,297 likes / 1.2M views; 1,479), "I'm cancelling my Claude 5x Max
subscription" (1,756) and stack/lesson lists ("I built 9 iOS apps in 2 years Here's what I'd do
differently", 1,167). In the window, prompt recipes win on bookmarks: "Paste this into Claude
Code if you want to make your app faster. Opus 5.5 on Extra High ran it on my app for 3 hours..."
(1,088 likes, 3,342 bookmarks, 185K views) and "Paste this into Codex with GPT-6.1 Sol Ultra if
you want to delete all the dead code and bloated tests in your repo" (862 likes, 1,852 bookmarks).

**Flops.** Brand one-line feature quotes: "Split chats in Synara" (8), "Use your OpenCode
subscription in Synara" (8), "come to the bright side" (6).

**Word of mouth** is small (14 posts): @voidyaps (74K) listing it among "more killers in the
opensource agentic coding space" (372), @Kappaemmedev "I tried T3 Code, but I keep coming back to
Synara" (143). It is usually one name in a list next to T3 Code.

### Paseo

**Accounts.** @paseo_sh (572 followers) posted once in 60 days ("paseo 🤝 hoplite", 0 likes).
Founder @moboudra (1.5K) posts about 2 times a week, rarely replies (11%), median 24.5 likes.
Best ever: a Chinese-language post thanking Chinese developers for Paseo's localization (video,
112 likes / 21K), then short feature clips ("did you know paseo shows you subagents for claude,
codex and opencode", 78; "new plugins gallery", 69). He announced a company sponsorship program
(first sponsor Hoplite, 58).

**Word of mouth outruns its own posting** (47 third-party posts, 14 authors over 10K):
@intellectronica "Paseo is wow. OSS control surface for all agents everywhere" (367),
@GithubProjects (342K) "We moved from coding to supervising agents that code. Paseo makes that
practical" (223), @michlbrmly "Paseo is my new favourite agent orchestration tool. I moved away
from Conductor because it lacked some features I wanted" (176), a Chinese post on controlling
Claude from the phone (377). Paseo also surfaced in replies under @theo's "I want to control my
agents from my phone... What workflows do you want?" (1,673 likes, 517 replies) **(inference: the
search matched a reply naming Paseo inside that thread)**. With 21.4K GitHub stars and almost no
X effort, its growth looks repo- and community-driven **(inference)**.

### Herdr

**One account, solo founder voice.** @herdrdev joined X on 2026-05-18, about two months after
the repo, and has 29.4K followers on 229 posts. It posts little (1.4 originals a week) and earns
the highest median of any non-lab account: 822 likes and 59K views per original.

| Date | Format | Likes / views | Hook |
|---|---|---|---|
| 2026-09-07 | video | 4,411 / 854K | "0.9.0 is here, and it brings the most wanted herdr feature: all your machines running herdr, in a single client 🎉" |
| 2026-09-08 | image | 3,103 / 303K | "Herdr has raised a $6M seed round led by @BessemerVP, with @ycombinator..." |
| 2026-08-07 | quote+video | 2,586 / 287K | "this is great! but don't leave claudes alone :( in herdr any agent can talk to any agent. no protocol, no MCP, no setup. it's just terminals." |
| 2026-08-06 | image | 2,063 / 226K | "big update: herdr is joining Y Combinator, F26 batch. herdr has been a solo project from day one." |
| 2026-09-06 | image | 1,788 / 115K | "⌛" (teaser, no text) |
| 2026-07-27 | video | 1,659 / 149K | "people kept asking for a browser in herdr. but herdr lives in your terminal so it's not possib... INTRODUCING THE HERDR-BROWSER PLUGIN" |

The September run was sequenced: teaser on the 6th, the 0.9.0 release on the 7th, the funding
round on the 8th, a hiring post on the 14th (961), then "herdr passed 1m cumulative downloads,
40k stars and 1,200 community plugins" on the 22nd (900). Milestones are counted in public from
the start ("herdr is 105 days old. i started writing a 10,000 github stars celebration post.
before i finished it, we passed 12,500!", 1,099). The account quotes community plugins and
integrations (Prime Intellect, Cursor CLI, Kimi), invites builders to share plugins under a post,
and asked users for feedback because "herdr has no usage telemetry" (379).

**Flops** are relative: quote posts of community items, the lowest being "we got herdr xbox
controller support before gta 6" (231 likes).

**Word of mouth is the strongest in the set** (50 posts, 20 authors over 10K, 6 over 100K):
@dhh "Every developer needs an AI shed: An always-on machine running on their tailscale network
where the majority of their herdr agents..." (7,760 likes / 654K), @tobi (Shopify; also an angel
in the round) explaining herdr (3,368 / 513K), @oliverjumpertz "My current setup: - Herdr..."
(2,292), @FaztTech in Spanish (1,511), @maxktz's zed + herdr fork (1,501), @MejiasDev "I completely
stopped using Codex app. Pi + Herdr + Collie + Executor is unbeaten" (1,303), and
@danielbergholz "Can someone explain to me why everyone seems to be using Herdr?" (332 likes, 191
replies, 209K views). Third parties build their own clients on it (Herdr UI, herdrup mobile,
herdr-projects), and each release of those becomes another post about herdr.

### BB

**Launch.** Founder @sawyerhood (18.8K followers), 2026-08-05, an X article titled "my new daily
driver for building software": 1,159 likes, 2,326 bookmarks, 543K views. The brand account
opened a week later. His audience comes from developer-tool hits that predate bb ("wtf chrome has
vertical tabs now. finally", 4,932 / 2.0M; "Introducing the new dev-browser cli", 2,983 / 871K /
5,112 bookmarks).

**Brand (@get_bb_app, 1.5K).** 3.2 originals a week, 39% of them link cards (release notes), only
14% replies. Best: a "New plugin alert" video series: "Make your sidebar behave like Cursor's"
(152), "The Kernel Browser plugin lets your agents create and control remote browsers" (127),
"watch all of your agents work inside of a pixel art office!" (118); releases ("bb 0.37.0 is out.
Big one for mobile", 110). Flops are one-line plugin quotes: "Plug-in alert: Use Factory Droid
inside of bb" (9), "use devin in bb!" (14).

**Founder in the window:** 26.7 posts a week, 65% replies, median 59 likes, p90 462. Best are
opinions and setup posts, not bb posts: "i moved from a $3k macbook pro to a $1k linux mini pc for
development and it eliminated all bottlenecks in my agents" (1,637 / 110K), "this is your sign to
slop your own version of muse/dots/grok-bot using pi-durable" (855). Replies to @bentossell (4),
@trq212 (2), @theo (2), @steipete.

**Word of mouth** (96 posts, 52 authors): users build odd things in it and post them.
@kevin_t_ngo "I asked Claude to build me a custom IDE in the style of Paper Mario Made with Fable
5.1 and @get_bb_app" (438) drew a reply from Claude Code's @bcherny (606K): "This is actually
pretty cool" (52). @bentossell (202K) ships a bb plugin and routes his agents' coding threads into
bb. "Malleable software" is the shareable idea **(inference)**.

### Usemono (MonoCode)

**Launch.** @nikolay_dp (2.4K followers), 2026-08-21, video: "Just open sourced Monocode - a
desktop UI for your coding agents. Works with your existing Claude Code, Codex, Cursor, and
OpenCode" (370 / 64K, pinned). No brand account.

**Screenshot-first posting.** 21.9 originals a week, median 27.5 likes, p90 155. Images earn a
median 77 likes, text posts 6. His best posts are UI screenshots with almost no caption: "👀"
(1,014 / 146K), "ORCHESTRATION :)" (729), "getting in on the trend :)" (659), "WELCOME TO THE AGI
ERA" (550), and model-love clips "i don't want to use opus 5.5 any other way" (video, 610) and
"opus 5.5 please never change 🥹" (586). Release notes do fine ("Monocode v0.15.0 is out", 477).

**Flops.** 91 of his 190 originals are quote posts, 45 of them quoting one contributor (@pdp);
quotes have a median of 6 likes against 69 for originals. In an 11-day sample he replied 361 times
(94% of posts), almost never to large accounts (1 of 355).

**Word of mouth.** A French post by a 2.3K-follower account, "On m'a fait découvrir Monocode
aujourd'hui... leur UI/UX est impeccable" (1,034 likes, 2,433 bookmarks, 276K views), outperformed
everything the founder posted. Also @thegenioo "T3 Code was the most visually beautiful app I'd
used until I tried MonoCode" (76), a placement in @zqkrq's ADE tier list (441), and a Chinese
@GitHub_Daily writeup.

### Hermes Agent (scale reference)

**Brand (@NousResearch, 284K).** 7.5 originals a week, 42% video, median 1,559 likes / 140K
views. All-time best are product launches with video: "Introducing Hermes Desktop" (12,657 /
5.9M), "Introducing Bot Mode for Hermes Desktop" (9,380 / 2.6M), "Meet Hermes Agent, the open
source agent that grows with you" (7,225 / 4.0M), "Hermes Agent is now #1 on the Global
@OpenRouter token rankings" (7,093 / 3.0M). In the window: real-profile browsing (5,485 / 909K),
"Hermes is for the wizards" (4,890), a jab at a $200/month competitor ("Hermes Agent has its own
remote computer too, you just aren't locked in", 4,657 / 485K), and a blog post on cleaning up a
million lines of Python with 1,393 subagents (4,531 / 1.5M). One of its weakest originals: "Try Fable
5.1 in Hermes Agent today for 20% off through Nous Portal!" (446 likes, under a third of its median).

**Founder (@Teknium, 134K).** Ships and argues in public: "We are going to lean into making Hermes
more like Pi, and less like OpenClaw" (7,827), "Friendly reminder that Hermes was never built or
intended to be exclusively for the 'personal assistant' agent" (5,228), "Welcome back to Hermes
Agent, Claude" announcing a Claude-subscription plugin (3,889 likes, 2,896 bookmarks). He replied
612 times in 17 days (89% of his posts). His flops are 1 to 3 word quotes ("Impressive!", 131;
"🫡🫡🫡", 130).

**Word of mouth** is an ecosystem: @SpaceXSI announcing X Premium inside Hermes (7,914 / 4.7M), a
fan account @HermesWatcher (18.8K followers; "Top 15 Skills for Hermes Agent", 2,404), integrators
announcing plugins (@browser_use 1,890, @Tiny_Fish 1,043, @composio's benchmark 2,340).

### Nimbalyst

**Accounts.** @nimbalyst (407 followers) and co-founder @wirthkarl (872) post once or twice a
week between them with medians of 11 and 1 likes. The launch, "Today we're open sourcing Nimbalyst, the
visual workspace for building with Codex, Claude Code, and more" (video, 2026-04-30), has 22
likes and 699K views: 31,772 views per like, where every other account in this study sits between
75 and 415 views per like (median per account). @wirthkarl's companion quote has 55 likes and
673K views. **(Inference: these views were bought as promoted posts; they produced no follower
base.)** Other content: podcast clips with @shanselman on running 3 to 10 parallel agents (20 to
27 likes).

**Word of mouth** is small and mostly Japanese ("Orcaもいいけど、わたしは完全にNimbalyst派", 32
likes), plus a team member replying under large threads with a link (@jbentley under @gregpr07's
"Anyone who says they can effectively code with 10+ Claude Code windows in parallel is capping"
and @justalexoki's posts).

## 3. Cross-product patterns

The figures in this section pool 1,096 originals from the 17 accounts with at least 8 originals in
the window, each normalised by its own account's median likes (rel = 1.00 is a typical post for
that account). Source: `cross.json`.

### Formats

| Format | Posts | Accounts | Median rel likes | Median rel views |
|---|---|---|---|---|
| Native video | 182 | 14 | **1.55** | 1.53 |
| Image / screenshot | 413 | 17 | 1.29 | 1.19 |
| Link card | 36 | 12 | 1.25 | 1.10 |
| Text only | 463 | 17 | **0.65** | 0.77 |
| Original post | 620 | 17 | 1.33 | 1.23 |
| Quote post | 476 | 17 | **0.64** | 0.81 |
| 200+ characters | 335 | 16 | 1.30 | 1.33 |
| Under 60 characters | 356 | 17 | 0.65 | 0.75 |

| Content type (keyword-tagged) | Posts | Median rel likes (vs rest) |
|---|---|---|
| Release / "Introducing" / "is out" | 125 | **1.78** (0.95) |
| Milestone (stars, downloads, rankings, funding) | 40 | 1.59 (1.00) |
| Free access / discount / promo code | 6 | 2.88 (1.00), small sample |
| Model-launch tie-in ("X is live", "now supports") | 101 | 1.20 (1.00) |
| Question to the audience | 29 | **0.65** (1.00) |

- **Short demo video of one capability is the winning unit.** The top product post of nearly
  every company is an "Introducing X" clip: Conductor's launch, rebuild, Cloud and Mobile;
  Superset's relaunch and iPhone; Orca's markdown editing; Herdr 0.9.0; Hermes Desktop.
- **Screenshots win for solo founders** who post daily (MonoCode images 77 median likes vs 6
  for text; Synara's top quartile is 22 images of 27).
- **The flops are the same everywhere:** quote posts of a few characters or an emoji, with no
  media. They make up most of the bottom quartile at Conductor, Superset, Orca, MonoCode, BB
  and Hermes. They look like engagement upkeep, not marketing.
- **No visible link penalty in this sample** (link-out originals 1.28 rel, n=82), but most are
  release notes with a changelog link, so release content explains it **(inference)**.
- **Bookmarks mark reusable artifacts:** prompt recipes ("Paste this into Claude Code...", 3,342
  bookmarks), CLAUDE.md breakdowns (@jacksondecampos, 2,762 bookmarks on 991 likes), setup guides.

### Timing (UTC)

| 3-hour slot | Posts | Median rel likes | | Weekday | Posts | Median rel likes |
|---|---|---|---|---|---|---|
| 12–14 | 126 | **1.14** | | Mon | 121 | **1.31** |
| 15–17 | 234 | 1.08 | | Thu | 213 | 1.06 |
| 18–20 | 239 | 1.06 | | Sat | 119 | 1.02 |
| 21–23 | 194 | 1.00 | | Tue | 190 | 1.00 |
| 09–11 | 85 | 0.93 | | Wed | 158 | 0.95 |
| 00–02 | 84 | 0.81 | | Sun | 109 | 0.95 |
| 03–05 | 62 | 0.73 | | Fri | 186 | **0.89** |
| 06–08 | 72 | **0.68** | | | | |

12:00 to 21:00 UTC (8 am to 5 pm US Eastern, European afternoon) is where posts do best and where
most of these teams already post. Monday is the strongest day and Friday the weakest. Herdr
shipped its biggest release on a Monday (Sep 7) and its funding on a Tuesday. The spread between
best and worst slot is about 1.7x, smaller than the 2.4x spread between video posts and quote posts:
format matters more than the clock.

### Replies and reply-guy behaviour

| Account | Replies/wk | % of posts that are replies | Replies to 100K+ accounts (of captured) | Typical large targets |
|---|---|---|---|---|
| @Teknium | ~247* | 89%* | 19 / 584 | @theo, @thsottiaux, @swyx, @Scobleizer |
| @nikolay_dp | ~229* | 94%* | 1 / 355 | users |
| @emanueledpt | ~384* | 89%* | 10 / 117 | @claudeai, @grok, @theo, @thsottiaux, @sama |
| @JinjingLiang | 72 | 82% | 61 / 594 | @eddiejaoude, @thsottiaux, @petergyang, @ClaudeDevs, @theo, @thdxr |
| @FlyaKiet | 60 | 79% | 2 / 513 | users |
| @orca_build | 48 | 85% | 5 / 408 | users |
| @trySynara | 29 | 66% | 5 / 234 | users |
| @sawyerhood | 17 | 65% | 10 / 151 | @bentossell, @trq212, @theo, @steipete |
| @avimakesrobots | 13 | 80% | 2 / 110 | users |
| @charlieholtz | 12 | 71% | 12 / 40 | @alexandr_wang, @garrytan, @brian_lovin, @Suhail |
| @superset_sh | 12 | 84% | 5 / 101 | users |
| @herdrdev, @moboudra, @get_bb_app | under 1 | 11–35% | – | – |

- Replying is the bulk of what these accounts do: 65 to 94% of posts for every active founder.
- Most replies go to users: support, thanks, banter. Only @JinjingLiang (10% of replies) and
  @charlieholtz (30% of captured targets) work large accounts systematically. Their targets are
  the people who run model and tool launches (OpenAI's Codex lead @thsottiaux, @ClaudeDevs,
  @claudeai, @alexandr_wang) and the developer-tool commentators (@theo, @eddiejaoude).
- None of the founders appear under @AnthropicAI, @OpenAI or @karpathy in the captured replies;
  they reply to the individuals and dev-rel accounts around those companies instead.
- Herdr and Paseo barely reply and still get word of mouth; replies are not required to grow,
  but every fast-growing founder account here does it **(inference)**.

### Riding model and tool launches

- **Opinions beat "now supported".** "My impressions of Opus 5.5 after 1 day of use" (Jinjing,
  2,910), "Meta is now at the frontier! Wonder is really really good. Quick impressions:"
  (Charlie, 342), "opus 5.5 please never change" (MonoCode, 586) all beat their author's median
  several times over. Plain "X is live in Conductor!" posts sit at or below Charlie's median
  (Fable 5.1: 71; GPT-6 Sol + Luna: 49; Astra: 106).
- **Subscription and usage-limit pain is a reliable hook.** Conductor's "Anthropic has pushed back
  its subscription changes. You can continue to use your Claude Code plan with Conductor" (525 /
  99K), "We've partnered with OpenAI to bring Sign in with ChatGPT to Conductor" (243), Orca's
  "Hit your usage limit in Codex/Claude Code mid-task?" (362), Hermes' "Welcome back to Hermes
  Agent, Claude" (3,889), Superset's usage tracking and "Running out of Fable usage limit is the
  worst feeling" (100 to 131).
- **Free tokens are Orca's best brand content:** free DeepSeek (514) and free Muse Spark (408).
- **Speed matters:** the impressions posts land within a day of the model release.

### Giveaways and promotions

No classic follow-and-repost giveaways appear in any account. What exists: free model access
inside the product (Orca, best brand posts), a launch discount code (Superset, MOBILELAUNCH),
early access gated on a reply (Synara's pinned post: 40 replies on 72 likes), and a percentage
discount (Nous, 20% off: one of the brand's weakest originals). Access beats discounts.

### Building in public and milestones

- Herdr turns every count into a post: GitHub trending, 12.5K stars at 105 days, 670 then 1,200
  plugins, 1M downloads and 40K stars. Milestone posts average 1.59x a typical post across accounts.
- Charlie posts "Experimenting with..." screenshots of unshipped UI (193 to 200 likes, above his
  median) and asks "Should we make this the default?" (Jackson).
- @emanueledpt's whole account is a public journey (streak, revenue goal, YC application, "I'm
  deleting X for a couple days"); his engagement per post is modest (median 40) but volume is
  enormous.
- Funding and accelerator news performs: Herdr's YC (2,063) and seed (3,103), Conductor's Series A
  article (594, pinned), Superset's YC (234).

### Word of mouth

| Product | Third-party posts found | Authors with 10K+ / 100K+ followers | Biggest third-party post |
|---|---|---|---|
| Herdr | 50 | 20 / 6 | @dhh, 7,760 likes |
| Hermes Agent | 25 (searched at 500+ and 3K+ likes only) | 21 / 4 | @SpaceXSI, 7,914 |
| Orca | 75 | 24 / 3 | @shannholmberg, 1,747 (stack list); @fiapp_pro, 1,417 |
| Conductor | 47 | 26 / 13 | @linear, 1,674 |
| Monocode | 26 | 5 / 0 | @elikemmedehou (2.3K followers), 1,034 |
| Superset | 45 | 20 / 6 | @laogui list (Chinese), 559; @wesbos list, 535 |
| BB | 96 | 7 / 3 | @kevin_t_ngo, 438 |
| Paseo | 47 | 14 / 1 | @BTCqzy1, 377; @intellectronica, 367 |
| Synara | 14 | 3 / 0 | @voidyaps list, 372 |
| Nimbalyst | 44 | 6 / 3 | @matcha_500ml, 62 |

- **Comparison lists and tier lists are the main word-of-mouth format** in this category: "ADE
  tier list" posts (@Ga_Vasques, 1,875 likes, ranking T3 Code first; @zqkrq, 441), "my stack" posts
  (@shannholmberg, @oliverjumpertz), "which one do you use?" threads (@T_Zahil, @wesbos, @theo).
  Being one of the names is how small tools get seen.
- **Large creators came after traction, not before.** DHH and @tobi posted about Herdr once it
  had tens of thousands of stars; YC produced Conductor's episode after Series A. **(inference)**
- **Non-English creators produce outsized posts:** Spanish (@midudev on Orca, @FaztTech on Herdr),
  Chinese (Orca, Paseo, MonoCode), French (MonoCode), Japanese (Nimbalyst, Orca).
- **The theme with the most third-party energy in the window is the always-on agent machine:**
  @dhh's "AI shed" (7,760), Herdr's multi-machine 0.9.0 (4,411), @theo's "control my agents from
  my phone" (1,673), @sawyerhood's "$1k linux mini pc" (1,637), Conductor Cloud (1,000) and Mobile
  (761), Superset for iPhone (477).

### Paid reach

Charlie celebrated Conductor's "first paid advertising" (a billboard, 642 likes). On X itself,
Nimbalyst's launch (31,772 views per like) and @wirthkarl's posts (12K to 27K views per like) are
the only clear outliers; @FlyaKiet's "Introducing Pages on @superset_sh mobile" (40 likes, 86K
views, 2,150 per like) and one @NousResearch post (2,387 per like) are milder. **(Inference:
promoted posts.)** Superset's two launch days were also followed within hours by clustered
ad-style posts from 117K to 553K-follower accounts that earned 19 to 62 likes each (see
Superset). None of this bought reach shows engagement or follower growth to match the views.

## 4. Lessons for intentic

1. **Run it from a founder account, with a quiet brand account beside it.** Founders earn 75 to
   100% of original-post likes at Conductor, Superset, Orca, Synara, BB and MonoCode. Brand-only
   accounts with no personal voice stalled (Paseo 572 followers, Nimbalyst 407). The one brand
   account that works on its own, Herdr, writes in the first person as its founder. Use the brand
   handle for release notes, support replies and reposting the founder's launches (what
   @conductor_build and @trySynara do).
2. **Cadence: 1 to 2 originals a day from the founder, 1 to 2 releases a week from the brand, and a
   daily reply block.** Comparable founders publish 4 to 32 originals a week; Herdr shows that 1 to
   2 strong posts a week are enough once there is something to show. Replies are 65 to 94% of
   every active founder's output; budget 10 to 70 a week, split between users (support, thanks)
   and the accounts that run launches (@thsottiaux, @ClaudeDevs, @claudeai, @theo,
   @alexandr_wang).
3. **Post 12:00 to 21:00 UTC, lead with Monday and Thursday, keep big launches off Friday.** Avoid
   00:00 to 09:00 UTC for anything that matters.
4. **Make the unit a 20 to 60 second screen recording of one capability, under an "Introducing X"
   hook of 200+ characters.** Video is 1.55x, release posts 1.78x, text quotes 0.64x. Between
   launches, post screenshots of real runs and unshipped UI ("Experimenting with...").
5. **Stop posting bare quote-tweets.** Emoji and one-word quotes are the flops at six of the ten
   companies. If quoting, add a screenshot or a real sentence.
6. **Own the always-on machine story.** The most-shared theme in the window is agents that keep
   running on a machine you do not have to babysit: DHH's AI shed, Herdr multi-machine, Conductor
   Cloud and Mobile, Superset for iPhone. That is intentic's core claim (a machine of their own;
   close the laptop and the runs keep going; any browser is a window). Show it literally: close the
   laptop on camera, open a phone, the fleet is still working.
7. **Ride model launches with an opinion inside 24 hours,** using a real run in intentic
   ("I ran Opus X on 6 sandboxes overnight, here is what came back") rather than "X is now
   supported". Post subscription and usage-limit news the same day it breaks; "bring your own
   Claude/Codex/Grok subscription" is the hook that keeps working.
8. **Publish reusable artifacts people bookmark:** prompt recipes, agent setup files, a
   specialized-agent template per job. Bookmarks run 2 to 3x likes on these posts.
9. **Count in public.** Stars, sandboxes run, agent-hours, plugins or templates published, each
   milestone a post (1.59x). Turn funding or accelerator news into a launch-sized moment, and
   sequence big weeks like Herdr: teaser, release, news, hiring.
10. **Seed the lists and the non-English creators.** Ask users for "my stack" and comparison posts,
    get onto tier lists, and give Spanish, Chinese, Japanese and French dev creators a reason to
    post (localized UI notes, a short guide). These produced several of the largest third-party
    posts here.
11. **Give access, not discounts.** Free model credits inside the product (Orca) and reply-gated
    early access (Synara) outperformed percentage discounts (Nous' 20% off was among its weakest posts).
12. **Do not buy views.** Promoted posts (Nimbalyst) produced hundreds of thousands of views,
    almost no likes and no follower base; apparent paid creator posts for Superset earned 19 to 62
    likes from accounts with 117K to 553K followers. Organic posts from real users (a 2.3K-follower
    account's 1,034-like MonoCode post) did more.
13. **Make it easy for others to build on and post about it.** Herdr's plugin marketplace and bb's
    plugin series turned users' work into a steady stream of third-party posts; intentic's
    capabilities and specialized-agent templates can play the same role.
