# How ten agent workspaces market themselves (October 2026)

What Paseo, bb, Hermes Agent, Usemono (MonoCode), Herdr, Orca, Nimbalyst, Conductor, Superset and
Synara did to get noticed: where they post, when, what earned attention, what fell flat, and what
it means for intentic. Researched 2026-10-19 by seven agents reading GitHub, Hacker News (Algolia),
Reddit (archive API), Product Hunt, YouTube, Discord invite counts, package registries, Wayback
snapshots of repos and homepages, the cloned repos in `/work/refs/`, and 21 X accounts through a
signed-in session (read-only).

Every number here comes from a teardown in [competitor-teardowns/](competitor-teardowns), which
cites its sources. Where a line says *inference*, it is interpretation of dated coincidences, not
proof of cause. Raw captures are in `/work/.intentic/local/tmp/mkt-research/`.

| Teardown | Covers |
| - | - |
| [conductor.md](competitor-teardowns/conductor.md) · [superset.md](competitor-teardowns/superset.md) · [orca.md](competitor-teardowns/orca.md) · [synara.md](competitor-teardowns/synara.md) | parallel-agent desktop apps |
| [paseo.md](competitor-teardowns/paseo.md) · [herdr.md](competitor-teardowns/herdr.md) · [bb.md](competitor-teardowns/bb.md) · [usemono.md](competitor-teardowns/usemono.md) | remote/terminal/mobile agent UIs |
| [hermes-agent.md](competitor-teardowns/hermes-agent.md) · [nimbalyst.md](competitor-teardowns/nimbalyst.md) | a model lab's agent; a visual workspace |
| [x-twitter.md](competitor-teardowns/x-twitter.md) | X for all ten: cadence, timing, formats, replies, word of mouth |

## The scoreboard

| Product | Stars (Oct 19) | Age | What made the big jumps | What their own channels did |
| - | - | - | - | - |
| Hermes Agent | 255,184 | 8 months | Competitor's crisis (Anthropic cut OpenClaw off subscriptions 04-04; Nous tweeted a one-command migration 04-07: +66k stars in 10 days); creator videos (NetworkChuck 1.82M views) | 30 HN submissions, median 2–3 points; first PH launch 9 points; own YouTube dormant |
| Orca | 97,829 | 7 months | In-app star prompt moved to "onboarding completed" plus zh/ja/ko UI and a conversion-focused README (Jun 9–11), then 58 straight days on GitHub Trending; homelab and Chinese creators | Show HN 21, PH invisible; X brand account 20K followers, median 85 likes |
| Herdr | 44,767 | 7 months | Third-party YouTube (13 videos, ~700k views; Hal Shin's "the Tmux for AI Agents" took it from 541 stars to Rust Trending); third-party HN posts (404, 281, 166 points) | Founder never posted to HN; his own 4 Reddit launches got 0–2 upvotes |
| Paseo | 21,410 | 8 months | A Chinese-language X wave that put it on GitHub Trending (Apr 10–18: 808 → 3,939, 63% CJK stargazers); founder's "I built…" post in r/ClaudeCode (217↑) | 4 founder Show HNs in 15 days, peak 14 points; blog has 1 post |
| Superset | 15,367 | 11 months | Product Hunt #1 ("Run an army of Claude Code, Codex, etc. on your machine", 521 votes) + launch video + YC; PH #1 again for Mobile; README in 16 languages | First Show HN 24 points; product-tour videos 191–1,245 views; renaming after 15k stars (Apache Superset collision) |
| bb | 4,473 | 8 months | An X Article by its founder ("my new daily driver", ~543K views; 256 → 1,942 stars in 10 days); a David Ondrej video (168K views); PH hunted by Chris Messina (#6) | HN titles with "IDE" or "loop driven" 1–2 points; blog mirrors X Articles |
| Usemono (MonoCode) | 3,158 | 2 months | Release cadence: 75 releases in 61 days, one tweet each; v0.6.0 put it on GitHub Trending (#13 overall, +548 stars that day) | No Discord, PH, Reddit, YouTube or blog; HN 3 and 11 points |
| Synara | 2,126 | 7 months | The founder's audience from his previous app (Remodex launch: 401K views); a third-party "6 tools worth trying" list (407 likes, 714 bookmarks; +191 stars in 12 days); the rename month with TypeScript Trending #9 (+442); an overnight model audit of its own repo (628 bookmarks, its best star day) | Founder posts ~400 times a week on X (89% replies); brand one-liners 6–11 likes; its most-viewed story is a licence incident (136K views); 41% of its installs are Windows |
| Nimbalyst | 1,935 | 11 months | Open-sourcing (79 → ~665 stars in 6 weeks); two "I built…" Reddit posts with demo videos for its predecessor Crystal (125↑, 68↑) | 25 HN submissions, none above 29; a 7-subreddit cross-post blast at 0–2 each; Teams launch 3 PH votes; ten homepage headlines in a year |
| Conductor | closed source | 15 months | Show HN (228 points, the real run came 3 days later); borrowed distribution: Garry Tan's gstack README, two YC videos (308K views), podcasts | Own YouTube abandoned (15 clips, ~1K views); brand X account earns 2% of the company's likes |

For scale, intentic on the same day: 84 stars, 10 Discord members, 121 site visitors in 7 days (93
direct, 21 Google, 6 X, 3 Reddit), 27 installs started, 1 sandbox connected (`marketing/bin/mkt.mjs snapshot`).

## Twelve findings

### 1. Other people's audiences make the jumps; your own channels only hold the floor

Not one of the ten got its biggest month from its own posts. The step changes came from creator
videos (Herdr, Hermes, bb, Orca), a single post by someone with an audience (bb's X Article, Garry
Tan's README line for Conductor, DHH on Herdr at 7,760 likes), a third-party HN submission (Herdr,
Paseo), a non-English wave that tipped GitHub Trending (Paseo, Orca), or a partner (NVIDIA, xAI and
YC for Hermes, Herdr and Conductor). Big creators came *after* early traction, not before (DHH and
@tobi on Herdr at tens of thousands of stars; YC's Conductor episode after its Series A).

Own channels mattered in a different way: a steady floor of 100+ stars a day for Paseo with no
launches at all, from per-agent and "alternative" pages and an open contributor funnel.

### 2. GitHub Trending is the flywheel, and four things tipped repos onto it

Once a repo trends, the trending page feeds itself for days (Paseo 5 days, Orca 58 days). What
tipped them on:

- an in-product star prompt fired at a value moment (Orca, the week its curve bent);
- a release with a visible new capability (MonoCode +548 on v0.6.0 day; Herdr 0.9 +544);
- a non-English social wave (Paseo, Orca);
- one creator video (Herdr, 541 stars → Rust #1).

Bug-fix releases did nothing (MonoCode, Paseo, Herdr all show it).

### 3. On Hacker News the title is the product, and the founder should not be the submitter

The same product scored 5, 166 and 404 points depending on title (Herdr). "The IDE that builds
itself" got 23 twice where "can control itself" and "open source Codex app" got 1–2 (bb). Funding
headlines flop ("Raised a $6M Seed" 7; Conductor Series A 3), concept and promise headlines work
("The runtime stays open" 281). Founder self-submissions flop in bulk: Paseo 4 Show HNs in 15 days
(peak 14), Nimbalyst 25 submissions (none above 29), Hermes 30 (median 2–3). The hits were posted by
fans, or resurfaced days later through HN's second-chance queue (Conductor's real run came 3 days
after submission; Superset's Show HN 6 days later). A "Migrate from <competitor>" docs page was
Hermes's only HN success (122 points).

Launch threads are dominated by trust questions: GitHub permissions and a missing privacy policy
(Conductor), "isn't it just a wrapper?", licence wording (Superset's ELv2 called "open source"),
"just use tmux" (every Herdr thread), unsafe defaults (Orca launching Claude with
`--dangerously-skip-permissions`).

### 4. On Reddit, one first-person "I built…" post with a demo video, in the agent's own subreddit, once

Paseo's founder: "I built an open source mobile and desktop app for <agent>" got 217↑ in
r/ClaudeCode and 101↑ in r/opencodeCLI, and 0–1 in r/OpenAI, r/cursor and r/kimi. Crystal (now
Nimbalyst): 125↑ and 68↑, both Thursdays, both with video. Asking a real question in a role community
beat product posts 10–40× (Nimbalyst's CEO in r/ProductManagement, 43/32 and 39/30). What failed: the
7-subreddit blast in 3 minutes (0–2 each), four near-identical posts on one day, owned subreddits as
broadcast channels (r/Nimbalyst 1.3 points on average, r/PaseoAI ~2), founder launches outside the
agent's own community (Herdr 0–2). An AMA was Nous's best owned Reddit result (316 points / 374
comments in r/LocalLLaMA).

### 5. Product Hunt rewards a concrete tagline that names the agents, and a known hunter

Superset reached #1 twice: "Run an army of Claude Code, Codex, etc. on your machine" (521 votes) and
the Mobile launch; its abstract 2.0 tagline came #3. bb, hunted by Chris Messina, came #6. Cold
launches flop: Hermes 9 points, Nimbalyst Teams 3, Conductor #7 and never reused, Paseo never
launched. Hermes Desktop came #6 when launched the day after an NVIDIA keynote demo.

### 6. X: founder-led, video, between 12:00 and 21:00 UTC, and mostly replies

Across 1,096 originals from 17 accounts ([x-twitter.md §3](competitor-teardowns/x-twitter.md)),
normalised to each account's own median:

| What | Relative likes |
| - | - |
| Release / "Introducing" posts | **1.78×** |
| Milestone posts (stars, downloads, rankings) | 1.59× |
| Native video | **1.55×** |
| Image / screenshot | 1.29× |
| Text only | 0.65× |
| Quote posts (mostly one-liners and emoji) | **0.64×** |
| Questions to the audience | 0.65× |

- Founders earn 75–100% of original-post likes at Conductor, Superset, Orca, Synara, bb and MonoCode.
  Brand-only accounts with no personal voice stalled (Paseo 572 followers, Nimbalyst 407). Herdr's
  brand account works because it is written in its founder's first person.
- Best slots 12–14 UTC (1.14×), 15–17 (1.08), 18–20 (1.06); worst 06–08 (0.68). Monday strongest
  (1.31×), Friday weakest (0.89). Format matters more than the clock (2.4× spread vs 1.7×).
- 65–94% of every active founder's posts are replies, mostly to users. The two who work large
  accounts target the people around launches (@thsottiaux, @ClaudeDevs, @claudeai, @theo,
  @alexandr_wang), not @AnthropicAI or @OpenAI themselves.
- Opinions on a new model within a day ("My impressions of Opus 5.5 after 1 day", 2,910 likes) beat
  "X is now supported" posts, which sit at or below the median. Subscription and usage-limit news is
  the most reliable hook in the category (Conductor's "you can continue to use your Claude Code plan"
  525 likes / 99K views; Hermes "Welcome back… Claude" 3,889).
- Bookmarks mark reusable artifacts: prompt recipes (3,342 bookmarks), CLAUDE.md breakdowns.
- Access beats discounts (Orca's free-model posts are its best; Nous's 20% off among its worst).
  Promoted posts bought views and no followers.

**The theme with the most third-party energy in the window is the always-on agent machine**: DHH's
"AI shed" (7,760 likes), Herdr's multi-machine 0.9 (4,411), @theo's "control my agents from my phone"
(1,673), a "$1k linux mini pc" for agents (1,637), Conductor Cloud (1,000) and Mobile (761). That is
intentic's core claim.

### 7. Video reach belongs to creators; company YouTube channels die

Conductor's own channel: 15 clips at 0.5–1.6K views, abandoned. Hermes's: dormant since December.
Superset's product tours: 191–1,245 views. Paseo: 1 video. Against that: Herdr ~700K views across 13
creator videos (two from channels under 10K subscribers that still did 106K and 160K), Hermes 1.8M,
708K and 539K, bb 168K, Orca's homelab YouTuber 112K. Creators repeat an analogy the product gives
them: "the Tmux for AI Agents" explained Herdr in four words.

### 8. The biggest windows open when a competitor or a platform stumbles

Anthropic's subscription and terms changes (Feb 19, May 13, the OpenClaw cutoff on Apr 4) were the
single largest source of movement in the category: Hermes's +66K stars came from a joking tweet with
a ready migration command, three days after the cutoff. Conductor's subscription posts were its most
viewed. Users moved between tools in public when one lagged ("Switched over to Paseo from
conductor.build then superset.sh. The mobile app…"). Those who had a migration path and an honest
"how we use your subscription" page ready were the ones who caught the wave.

### 9. Comparison, "alternative" and per-agent pages are the quiet floor

Paseo: 44 "open source app for <agent>" pages and 8 "<competitor> alternative" pages, ~100 stars a day
without launches. Superset: 131 "vs" pages written as sourced tables. Nimbalyst: an agent-written
pipeline of 146 posts and 300+ landing pages, including pages against Conductor and Paseo. bb added
5 comparisons, 7 "switch from X" guides and Google Ads in October. In X word of mouth, tier lists and
"my stack" posts are the main format: being one of the names on them is how small tools get seen.

### 10. Ecosystems post for you

Herdr's API and plugin marketplace: 1,789 plugins and ~15 community HN posts with Herdr in the title.
bb: 410 marketplace plugins and ~80 community repos. Paseo: translations, providers, relays and Home
Assistant add-ons, each with its own posts. Orca and Nimbalyst also prompt users into Discord at a
success moment (Nimbalyst: after 3 successful sessions, 923 members on 1.9K stars).

### 11. Non-English audiences are larger than any English launch

63% of Paseo's biggest spike was CJK. Orca shipped zh/ja/ko UI and a WeChat group in June (nine full
groups, bilibili videos at 28K plays) right before its hockey stick. Superset's star rate doubled
after a 16-language README (correlated with a campaign the same week). Several of the largest
third-party X posts were Spanish (@midudev), Chinese, Japanese or French. Herdr's community Chinese
README, by contrast, changed nothing measurable: localization helps when someone in that language is
already talking about you.

### 12. Messaging churn costs; one repeatable phrase pays

Nimbalyst: ten homepage headlines in twelve months, with falling monthly stars. Paseo: six taglines
in nine months and three licences. Orca: seven README tagline edits in two months. Conductor: three
headline changes and a cloud pivot. Herdr kept "tmux for agents" until it had 40K stars. Claims that
cannot be verified backfire: "Beautiful" got Paseo its only HN front page and its harshest mockery.

## What did not work, in one list

- Founder self-submitted HN posts, repeated with new titles (Paseo, Nimbalyst, Hermes, Conductor post-launch).
- Funding headlines as launches (Herdr seed 7, Conductor Series A 3).
- Cross-posting the same announcement to many subreddits; owned subreddits as broadcast channels.
- Cold Product Hunt launches without a hunter, an audience or an event (Hermes 9, Nimbalyst 3).
- Company YouTube channels (every one studied).
- Blogs nobody feeds (Paseo 1 post, Herdr's technical posts never reached HN, Hermes 2 posts).
- One-word and emoji quote posts on X (the bottom quartile at six of ten companies).
- Promoted X posts (views without likes or followers).
- Percentage discounts.
- Fighting critics ("Delete your account" became the top critical link about Hermes).
- Stunts that read as fake (Nous's satirical TIME post was reported as real).
- Taglines and audiences that keep moving (Nimbalyst, Paseo, Orca).
- A name somebody else owns (Superset renaming after 15K stars; Conductor living on its domain).
- Licence and attribution slips: Synara overwrote T3 Code's MIT copyright line in its clone, and the apology (136K
  views) became its most-viewed story; an analytics key inherited from upstream followed.
- Defining yourself against a bigger project (Synara's replies under T3 Code's posts, then a public feud with
  its founder) keeps you a footnote in that project's lists.
- Selling reach before there is an audience (Synara's sponsorship tiers up to €2,000 a month: $0 three weeks in).

## Timing, collected

| Channel | What the data says |
| - | - |
| X | 12:00–21:00 UTC, best 12–14; Monday best, Friday worst; big launches Mon–Thu |
| Hacker News | Hour did not explain outcomes in any teardown; title and submitter did. Hits landed at 04:30, 16:43–19:14 and 22:34 UTC. Expect the real run hours to days later via the second-chance queue, and stay to answer for days |
| Reddit | Both Crystal hits on Thursdays, 12:36 and 14:55 UTC; Paseo's hits 06:22–07:03 UTC. Format decides, not hour |
| Product Hunt | 00:01 PT fixed; Superset's #1s on a Friday and a Monday |
| Releases | Ship continuously, announce in trains: bb's Friday train, Superset's Sunday weekly changelog, Herdr's milestone release + blog post. Stars follow capability releases, never fix releases |
| Events | Partner and platform dates set the best days: a model launch, a keynote, a competitor's terms change. Within 24 hours or not at all |

## What this means for intentic

1. **Lead with the always-on machine, literally.** It is the hottest theme in the category and
   intentic's actual architecture. Show it: close the laptop on camera, open a phone, the fleet is
   still working. Find the four-word analogy creators will repeat, and test candidates in post hooks
   before committing.
2. **Spend effort on borrowed audiences.** Creator seeding (YouTube and X), "my stack" and tier-list
   inclusion, workflow repos and READMEs, an AMA, partner co-announcements. These made every big jump.
3. **Build the Trending tippers into the product and the release train**: a star prompt at a value
   moment (first landed change), one capability release a week with a clip, localized README and UI.
4. **Be the one with the migration path when the next subscription or pricing shock lands**:
   "Move from Conductor / Superset / Orca / Paseo / Hermes to intentic" guides, an importer, and a plain
   page on how intentic uses your Claude, Codex and Grok subscriptions.
5. **On X, one founder voice plus the brand account**, 1–2 originals a day built on clips and real
   runs, a daily reply block aimed at users and the people around model launches, 12–21 UTC.
6. **On Reddit, comment daily and launch once per capability** with an "I built…" post and a video,
   in r/ClaudeCode, r/codex, r/selfhosted.
7. **Hacker News and Product Hunt are one-shot tools**: a concept title, a fan or a hunter, a day of
   answering. Not a channel to post to.
8. **Keep the floor rising without launches**: per-agent pages, "alternative to" pages, comparison
   tables with sources, listings, a changelog people can follow.
9. **Keep the message still.** intentic's site already has a stable hero ("More work. Less AI waste.
   Same subscriptions."); social copy should repeat it, not reinvent it weekly.
10. **Audit trust before any launch.** Third-party notices, every analytics key, and a plain page on what
    intentic collects and what its relay sees. Synara's licence slip outran every post it made, and HN
    launch threads in this category are trust interrogations.
11. **Count installs and say Windows.** Synara has about 10 downloads per star and 41% of them are Windows;
    stars undercount a desktop tool. Post install milestones too.

The plan that puts this into practice, and runs it without the owner, is
[`/work/marketing/STRATEGY.md`](../../../marketing/STRATEGY.md).
