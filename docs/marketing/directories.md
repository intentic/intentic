# Directories and listings: where intentic.dev gets posted

The non-GitHub half of the listing surface. [awesome-lists.md](awesome-lists.md) covers curated GitHub lists,
[article-mentions.md](article-mentions.md) covers the editorial articles answer engines quote; this page
covers product directories, launch platforms, company profiles and the one-shot community posts.
First researched 2026-08-10. Every target below re-verified against the live sites on **2026-09-16**.

**The fact that orders everything below.** As of 2026-08-10 the domain had no third-party presence at all,
and a differently named product ("Intent", intentapp.dev) already answered to the same shape of query. That
is half fixed: SaaSHub and LibHunt both carry a page now. Every listing here is still doing two jobs, earning
a link and making the name resolvable.

## The URL we submit

**`https://intentic.dev/` for developer-tool listings; `https://intentic.dev/desk/` for anything aimed at people
who do not write code.** Decided 2026-09-16 for `/`, revised 2026-09-19 when `/desk/` became a page of its own.

Until then `/desk` was the light skin's front door: the home page word for word, `noindex`, the worst available
target for an inbound link (it could not rank, and the equity did not reach `/` either). It is now the product
page of **intentic desk** (`_site/site/src/pages/desk.astro`, `DeskLanding.astro`): its own title, description,
copy, screenshots, FAQ and `SoftwareApplication`, indexed, in the sitemap, canonical to itself. The two pages
share the shell and nothing search would read as a duplicate. Every directory in this file is a developer-tool
directory, so the URL for all of them stays `/`; a general-software or productivity listing, if one is ever worth
having, takes `/desk/` and the desk copy, not this file's.

`https://intentic.dev/?variant=desk` still works (the pre-paint script honours `?variant=`), but it now only
changes the skin: the words on `/` are the developer's whichever way it is lit. Do not hand it out.

## Canonical listing copy

Reuse verbatim; do not re-invent per site. Voice rules are in [messaging.md](messaging.md): lowercase
`intentic` always, no em-dashes, no adjective a screenshot cannot back.

| Field | Value |
| --- | --- |
| Name | `intentic` (always lowercase, including at the start of a sentence) |
| Website | https://intentic.dev/ |
| Source | https://github.com/intentic/intentic (MIT) |
| Demo | https://intentic.dev/demo/ |
| Docs | https://intentic.dev/docs |
| Discord | https://discord.gg/3veuzYp32T |
| Founder | Artur Kurowski ([GitHub](https://github.com/radarsu), [LinkedIn](https://www.linkedin.com/in/radarsu/)) |
| Pricing field | Free. MIT. No paid tier, no card, no trial. |
| License | MIT |
| Platforms | Web (any browser), self-hosted via Docker on Linux/Windows/macOS, desktop app for Windows and Linux |

### The length ladder

Directories ask for the same sentence at a dozen different caps. Pick the longest one that fits; never write
a new one. Character counts are exact.

| Cap | Copy | Len |
| --- | --- | --- |
| Brand line / 40 | More work. Less AI waste. Same subscriptions. | 45 |
| 30 | A workspace for coding agents. | 30 |
| 50 | A workspace for coding agents. Free, MIT. | 41 |
| 60 | A workspace for coding agents. Free and open source. | 52 |
| 80 | A workspace for coding agents. They keep running when you close the browser. | 76 |
| 100 | A workspace for coding agents. They keep running when you close the browser. Free. | 82 |
| 140 | A workspace for coding agents. Each one works in a sandbox, in its own git worktree, and keeps running when you close the browser. Free. | 136 |
| 160 (meta) | A workspace for coding agents. They keep running when you close the browser. Reopen anywhere and review every change. Free. | 123 |
| 200 | A workspace for coding agents. Each works in a sandbox on your machine, in its own git worktree. Runs continue when you close the browser. Reopen from any device and read every diff before it lands. | 198 |
| 300 | A workspace for coding agents. Each agent works in a sandbox on your laptop, desktop or VPS, in a git worktree of its own. Runs continue after you close the browser, and you reopen from any device to steer the same fleet. Every change waits on its branch until you have read the diff. MIT and free. | 298 |
| 10 words | A workspace for coding agents that keeps running without you. | 10w |

Long description, for the sites that give you a paragraph (675 chars):

> intentic gives every coding agent a machine of its own: a sandbox on your laptop, desktop or VPS, with a
> git worktree of its own. Runs continue after you close the browser, and you reopen from any device, phone
> included, onto the same fleet, sorted by which agent needs you. Plan mode by default, per-hunk diff review,
> an environment Dockerfile the agent proposes for your approval, credentials held inside the sandbox and
> injected per turn, and automations that wake an agent on a schedule, a webhook or a live event. Works with
> Claude Code, Codex, Grok, Kimi Code and Gemini on your own subscriptions. MIT licensed and free: no
> per-token metering, no markup on model usage.

### Categories, tags, competitors

Categories, in order of preference where a site offers them: **AI developer tools**, **AI coding**,
**AI agents**, **developer tools**, **self-hosted**. Never "productivity", never "code autocomplete": both
misdescribe the product and land it beside things it is not.

Tags, where a site takes a free list: `coding agent`, `AI agents`, `developer tools`, `self-hosted`,
`open source`, `git`, `Docker`, `code review`, `Claude Code`, `Codex`, `agent orchestration`.

Competitors to name where a site asks, each with a matching `/compare/` page on the site: **Cursor**,
**Claude Code**, **Codex**, **Conductor**, **Superset**, **Vibe Kanban**, **Devin**.

## Assets

Pre-sized for upload forms, in [`press-kit/`](press-kit/). Every file is the app in its **Light** look, so the
kit, the card and the listing page all read as one product.

| File | Size | For |
| --- | --- | --- |
| `logo-512.png` | 512×512 | the square logo/icon field every directory has |
| `cover-1200x630.png` | 1200×628 | OG card, cover image, "featured image" |
| `screenshot-1-fleet-board.png` | 1500×940 | the fleet board: lead with this one |
| `screenshot-2-review-a-diff.png` | 1500×940 | the Changes panel and a side-by-side diff |
| `screenshot-3-capabilities.png` | 1500×940 | the capability catalogue |
| `screenshot-4-phone.png` | 430×932 | the fleet board on a phone |

**Light, not the dark skin the site defaults to.** A directory listing and a social feed are both mostly white
paper, and the dark app reads there as a hole rather than a product. Owner's call, 2026-09-17.

To recapture: `pnpm -C _site/demo dev --port 47148`, then in the browser set `ui-color-scheme=light` and
`ui-skin=none` in `localStorage` and reload (see the `seeing-the-app` skill). Two things have to be out of any
shot: the demo's own mode switcher (`#demo-switcher`) and the rail tooltip, which is
`.ui-tooltip-body` and survives moving the pointer, so hide it with a stylesheet rule rather than chasing it.
The dark originals are still in `_site/site/src/assets/product/` at 2604px, for the site's own dark pages.

## Ranked targets

Ordered by what a listing is worth, not by how easy it is. Every row re-checked 2026-09-16. The budget for
this round is **free tiers only**, so Dev Hunt ($49/launch), OpenSourceAlternative.to's $29 expedited review
and Microlaunch (its `/submit` now redirects straight to `/premium#pricing`) are out of scope rather than
blocked.

### Tier A: authority and entity

| Target | Why it ranks here | What it needs | State 2026-09-16 |
| --- | --- | --- | --- |
| [SaaSHub](https://www.saashub.com/intentic) | Already live and already ranking, and claiming it unlocks a free console that posts to 110 more directories | `hello@intentic.dev` for domain verification, then an account | **Live, unclaimed.** See the two notes below: this is the highest-value row on the page |
| [AlternativeTo](https://alternativeto.net) | DS 86. Owns the "alternative to Cursor / Claude Code" result outright | Account, and a real browser: returns 403 to anything automated | Blocked on sign-in |
| [SourceForge](https://sourceforge.net/create/) | DS 92, and a free open-source project listing that mirrors from GitHub. Feeds Slashdot's software section too | Account, real browser (403 to automation) | Blocked on sign-in |
| [OpenAlternative](https://openalternative.co/submit) | Exact-fit taxonomy: it already has an "AI Agent Platforms" category and Claude Code, Codex and Cursor alternative pages | Sign in with Google or GitHub | Blocked on sign-in |
| [Crunchbase](https://www.crunchbase.com) | The entity record that disambiguates the name from "Intent"/intentapp.dev, and a source answer engines quote | Account, real browser (403) | Blocked on sign-in |
| [LinkedIn company page](https://www.linkedin.com/company/setup/new/) | Free entity record. Not in the old list, and the one profile every "is this real" check looks for | LinkedIn account | Blocked on sign-in |

### Tier B: developer-relevant, free

| Target | Why | What it needs | State |
| --- | --- | --- | --- |
| [LibHunt](https://www.libhunt.com/r/intentic/intentic) | **Already exists**, auto-indexed from GitHub, and SaaSHub links to it | Claim it to control the copy | Live, unclaimed |
| [StackShare](https://stackshare.io) | Tool profile developers cite in stack decisions | Account; rate-limits automation (429 on a plain fetch) | Blocked on sign-in |
| [Indie Hackers](https://www.indiehackers.com/products/new) | Product page plus a community that reads it | Account | Blocked on sign-in |
| [Peerlist](https://peerlist.io/launchpad) | Launch platform with real developer traffic | Account, real browser (Cloudflare challenge) | Blocked on sign-in |
| [Uneed](https://www.uneed.best/submit-a-tool) | Free tier; scrapes the page for you, then asks for an account to save | Account | Blocked on sign-in |
| [opensource.builders](https://github.com/junaid33/opensource.builders) | Open-source alternatives directory that takes GitHub issues, not a form: the only target here needing no sign-in | A GitHub issue in `CONTRIBUTING_TO_OSB.md`'s template | **Drafted below**, awaiting a go-ahead to post as `radarsu` |
| [Fazier](https://fazier.com/submit) | Launch platform, DR 82 on the paid tier | Free tier buys the link with a link: a Fazier badge in intentic's footer | **Approved 2026-09-16.** Needs the listing first, then the footer change |
| [TinyLaunch](https://www.tinylaunch.com) | Same trade as Fazier: dofollow backlink granted when you embed their badge with a dofollow link | Account, plus the badge in the footer | Same decision as Fazier, not yet taken |
| [OpenHunts](https://openhunts.com) · [BetaList](https://betalist.com) · [Launching Next](https://www.launchingnext.com/submit/) | Small, cumulative, free | Account each | Blocked on sign-in |

### Tier C: the AI-tool long tail

SaaSHub publishes a free, actively maintained [list of 110 directories](https://www.saashub.com/submit/list)
with Domain Strength and traffic for each, and a console that posts to them from the product's management
page. Most of that list is DS under 25 with four-figure traffic: hand-filing them one at a time is not worth
an afternoon, and a burst of identical listings on DS-10 sites is the shape of link building Google discounts
on purpose. Do them in one pass from the SaaSHub console once the listing is claimed, pick the rows that are
actually about developer tools or AI agents, and skip the rest.

### Out of scope, and why

| Target | Why not |
| --- | --- |
| Product Hunt | Owner decision, 2026-08-10 and again 2026-09-16. Not yet. |
| Hacker News (Show HN) | Held by owner 2026-08-12. Draft below, do not post. |
| Dev Hunt | $49 per launch week; free tiers only this round |
| OpenSourceAlternative.to (expedited) | $29; the free submission is already in the queue, see 2026-08-29 below |
| Microlaunch | `/submit` now redirects to `/premium#pricing`: paid |
| G2 · Capterra · GetApp · TrustRadius | Reviews platforms. A profile with no reviews is an empty shelf; worth doing once there are users who would write one |
| Wikidata | Needs serious, independent, published sources. A repo this young does not clear the notability bar, and a rejected item is worse than none |
| AppSumo | A deals marketplace for paid software. Wrong shape for a free MIT product |
| console.dev | Editorial, refuses automation, and its `/tools/submit/` path is now a 404. Re-find the current path before spending a sign-in on it |

## What the owner has to do

**Nothing on this page can be filed without a sign-in.** That is not a scoping choice: every open form in the
list redirects to a login (Uneed, BetaList, OpenHunts, Indie Hackers, TinyLaunch), and the higher-authority
half returns 403 to anything that is not a real browser (AlternativeTo, SourceForge, Crunchbase, SaaSHub's
own login, G2). Verified one by one on 2026-09-16.

Two things unlock the whole page:

1. **Create `hello@intentic.dev`.** Cloudflare Email Routing is already enabled on the zone (the
   `route1/2/3.mx.cloudflare.net` MX records are live), so this is Email → Email Routing → Routing rules →
   Create address, forwarding to the owner's mailbox. Under a minute, free. It is what turns the existing
   SaaSHub entry into a *verified* alternative on every competitor page it was filed against, moves that
   queue from 32 days to fast, and opens the 110-directory console. The sandbox's Cloudflare token carries
   DNS but not the Email Routing grant, so this one has to happen in the dashboard.
2. **Sign in once per site**, in the sandbox's own browser, so the session persists for the filing. Order by
   value: SaaSHub → AlternativeTo → SourceForge → OpenAlternative → Crunchbase → LinkedIn → StackShare →
   the Tier B launch platforms. Google sign-in covers OpenAlternative, Crunchbase and Peerlist; AlternativeTo,
   SourceForge and SaaSHub each want their own account.

### Notes that decide whether a submission survives

- **The live SaaSHub listing currently publishes a model's refusal as intentic's feature list.** Its
  "Features & Specs" section reads *"Unable to verify. I do not have access to real-time browsing or verified
  information about intentic.dev, so I cannot confirm specific pros of this product or service."* That is on
  a page that already ranks for the product's own name. Claiming the listing and replacing it is the single
  cheapest quality win available, ahead of any new submission.
- **AlternativeTo, SourceForge, Crunchbase and console.dev all refuse a headless browser.** They need a real
  signed-in browser profile, not a fresh automated one.
- **Fazier and TinyLaunch both buy a link with a link.** The footer badge is a site change and a taste call.
  Fazier is approved as of 2026-09-16; TinyLaunch is the same trade and has not been decided.
- **One identity per listing, and keep it straight.** The 2026-08 submissions went in under
  radarsuspam@gmail.com. Anything filed from a different account from here on cannot claim them, so record
  which account filed what, in this file, at the time.

## opensource.builders: prepared, awaiting a go-ahead

The one target on this page that needs no sign-in, because it takes GitHub issues rather than a form. The
maintainer closes anything that ignores the template (issues #573, #574, #578 are all "read the format"), and
issue #572 shows the exact shape a competitor used. The connected GitHub token is the owner's own account,
`radarsu`, so filing this posts publicly as the owner: it has not been filed.

Title:

> Add intentic as an open-source alternative to Cursor, Claude Code and Devin

Body, in the repo's template #2 format:

> Add open source alternative to Cursor:
> - Name: intentic
> - Repository: https://github.com/intentic/intentic
> - Description: A workspace for coding agents. Each agent works in a sandbox on your own machine, in a git
>   worktree of its own, and keeps running when you close the browser.
> - Similarity Score: 70
> - Notes: Where Cursor puts you at the keyboard with AI assistance, intentic puts the agent there and gives
>   you the surfaces to supervise it: a fleet board, plan-mode approvals, per-hunk diff review and the same
>   terminal the agent types into. Runs survive the browser closing and resume from any device. MIT, free, and
>   it drives Claude Code, Codex, Grok, Kimi Code and Gemini on your own subscriptions.
>
> Add open source alternative to Devin:
> - Name: intentic
> - Repository: https://github.com/intentic/intentic
> - Description: Self-hosted workspace for autonomous coding agents, running on your own hardware.
> - Similarity Score: 65
> - Notes: Same autonomous-agent job, opposite trust model. Agents run in a Docker sandbox on your laptop,
>   desktop or VPS rather than a vendor's cloud, credentials stay inside that sandbox, and every change waits
>   on its branch until you have read the diff. No per-token metering.

## Show HN: prepared, held by owner decision 2026-08-12

**Held, deliberately, not blocked.** Asked on 2026-08-12 whether to open an account now so it could age, the
owner chose to hold HN entirely for now. Do not post it, and do not open the account as a side effect of some
other task: the single shot is being kept in reserve until there is more to point at than a one-week-old repo
at 8 stars.

Two facts to re-check when it is picked back up: there is **no Hacker News account on any identity in the
roster** (verified 2026-08-12), and the rule below requires the account to pre-date the posting day: so
un-holding this costs a lead time of at least a day, not an afternoon.

One shot, so it goes out deliberately: a weekday, 08:00–10:00 US Eastern, from an account that exists before
the day it posts. Title, at 77 of the 80 characters HN allows:

> Show HN: intentic – a browser workspace for coding agents

First comment, posted immediately after submitting:

> I kept losing track of which terminal was running which agent, and closing the laptop killed the run. So the
> agents got a machine instead of a tab: each one lives in its own container sandbox, laptop,
> desktop or VPS: in a git worktree of its own, and the browser is just a window onto it. Close it, reopen on a
> phone, the run is still going.
>
> The parts I actually care about: plan mode before it acts, every change landed per hunk from a diff panel, and
> the sandbox image being a Dockerfile the agent proposes and I approve rather than a fixed environment.
> Credentials sit inside the sandbox and get injected per turn, so they are never in the file tree.
>
> It works with Claude Code, Codex, Grok, Kimi Code and Gemini on your own subscription: intentic charges
> nothing and never meters model usage. MIT, and the platform tier is deliberately thin: it knows who you are
> and where your sandbox is, and every keystroke goes browser-to-your-machine over your sandbox's own tunnel.
>
> Demo, which is the real workspace running against fixtures: https://intentic.dev/demo/
> Source: https://github.com/intentic/intentic
>
> It is six days old in public and rough in places. Happy to answer anything about the trust model: that is the
> part I would poke at first.

## Done 2026-08-10

- **SaaSHub**, submitted with the free tier: name, the 152-char tagline, categories *AI Developer Tools · AI
  Coding · Self-hosted*, competitors *Cursor · Claude Code · Devin by Cognition*, and filed as an alternative on
  the *8080.AI*, *Augment Code* and *Windsurf Editor* pages. The listing was live by 2026-08-29 and also appears
  on the Devin alternatives page; claiming it and uploading the logo still need an account.

## Done 2026-08-29

- **OpenSourceAlternative.to**, submitted to the free waitlist as an open-source, self-hosted alternative to
  Claude Code. The public submission page is [under review](https://opensourcealternative.to/project/intentic);
  the site quotes 6+ months for free review, and no paid expedited review was purchased.

## Done 2026-09-16

Preparation only. Nothing was filed: see "What the owner has to do" for why.

- **Decided the submission URL is `https://intentic.dev/`**, not `/desk`, and recorded the reasoning above so
  the question does not get re-opened. `desk.astro` was not touched.
- **Re-verified every target** against the live sites, dropped the ones that have since gone paid or 404, and
  added Tier A's LinkedIn and SourceForge rows and Tier B's LibHunt, Indie Hackers, opensource.builders and
  TinyLaunch rows.
- **Found the SaaSHub listing is live but publishes a model refusal as its feature list**, and found the free
  110-directory console that claiming it unlocks.
- **Found LibHunt already carries a page** for the repo, unclaimed.
- **Built [`press-kit/`](press-kit/)**: logo, cover and five screenshots, all sized for upload forms.
- **Wrote the length ladder** above, so no submission needs new copy written at the form.
- **Drafted the opensource.builders issue** in the maintainer's required template, unposted.
- Budget for the round set to free tiers only, with Fazier's badge-for-listing trade approved.

## Done 2026-09-17: the card every share renders

The old OG card was a black rectangle with the page title set in it, and the page title is what the platform
already prints underneath the picture. It spent its whole area repeating a sentence the reader was being shown
anyway, and showed nothing of the product. Owner's verdict: "very ugly", and not something to put on social.

Rewrote `_site/site/scripts/og-template.mjs`:

- **Light skin, not dark.** `#f5ede7`, the same value BaseLayout ships as the light `theme-color`. The desk
  palette's oklch tokens resolved to sRGB, so the card cannot drift from the site.
- **The landing card says the brand line**, `More work. Less AI waste. Same subscriptions.`, instead of the page
  title. Every other page still gets its own title, since for those the title is the useful thing.
- **A real screenshot of the light app** runs off the bottom edge under the text: the fleet board, three lanes
  of agents, and the plan with **Approve** under it — product proof rather than headline illustration. `marginTop: auto` pins it, so a three-line title eats the gap above the picture instead of pushing
  it off the card.
- The assets it inlines live in `_site/site/scripts/og/`.

Checked at 1200px, at 500px (feed size) and at 320px: the headline, the sub and the wordmark all hold, and the
screenshot reads as a dense working app even where its text does not resolve. Route matching is covered by a
throwaway check over `""`, `/`, `index.html`, `desk`, `desk/`, `/desk/` and `desk/index.html`, all of which
have to land on the landing card; `oxlint`, `prettier` and `check-desk-palette.mjs` all pass.
