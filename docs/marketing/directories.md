# Directories and listings — where intentic.dev gets posted

The non-GitHub half of the listing surface. [awesome-lists.md](awesome-lists.md) covers curated GitHub lists,
[article-mentions.md](article-mentions.md) covers the editorial articles answer engines quote; this page
covers product directories, launch platforms, company profiles and the one-shot community posts.
Researched and executed 2026-08-10 against the live sites.

**The fact that orders everything below.** As of 2026-08-10 the domain has **no third-party presence at all** —
a search for the product returns intentic.dev and the GitHub repo, and nothing else. Meanwhile a differently
named product ("Intent", intentapp.dev) already sits in AI-tool directories and answers to the same shape of
query. Every listing here is therefore doing two jobs: earning a link, and making the name resolvable.

## Canonical listing copy

Reuse verbatim; do not re-invent per site. Voice rules are in [messaging.md](messaging.md).

| Field | Value |
| --- | --- |
| Name | `intentic` (always lowercase) |
| Tagline, 37 chars | You delegate. They work. You approve. |
| Short, 152 chars | Agents on hardware you own that keep running when you close the browser. Reopen from any device, steer the fleet, read every diff before it lands. Free. |
| Website | https://intentic.dev |
| Source | https://github.com/intentic/intentic (MIT) |
| Demo | https://intentic.dev/demo/ |
| Docs | https://intentic.dev/docs |
| Contact | radarsuspam@gmail.com (the listing identity) |
| Logo | `_site/site/public/assets/intentic-logo-sized.png` (326×326) |
| Screenshots | `_site/site/src/assets/product/`: `fleet-board.png`, `workspace-editor.png`, `workspace-changes.png`, `mobile-fleet.png` |

Long description, for the sites that give you a paragraph:

> intentic gives every coding agent a machine of its own: a persistent container sandbox on hardware you own —
> laptop, desktop or VPS — with a git worktree of its own. Runs continue after you close the browser and reopen
> from any device, phone included, sorted by which agent needs you. Plan mode by default, per-hunk diff review,
> an environment Dockerfile the agent proposes for your approval, credentials held inside the sandbox and
> injected per turn, and automations that wake an agent on a schedule, a webhook or a live event. Works with
> Claude Code, Codex, Grok, Kimi Code and Gemini on your own subscriptions. MIT licensed and free — no
> per-token metering, no markup on model usage.

Categories to pick, in order of preference where a site offers them: **AI developer tools**, **AI coding**,
**self-hosted**, **developer tools**, **AI agents**. Never "productivity", never "code autocomplete" — both
misdescribe the product and land it beside things it is not.

Competitors to name where a site asks (these are the alternative-pages worth appearing on, and each one has a
matching `/compare/` page on the site): **Cursor**, **Claude Code**, **Codex**, **Conductor**, **Superset**,
**Vibe Kanban**, **Devin**.

## Ranked targets

Ordered by what a listing is worth, not by how easy it is. "Gate" is what stops a submission going in today.

| Target | Why it ranks here | Gate | Status |
| --- | --- | --- | --- |
| [SaaSHub](https://www.saashub.com) | Ranks for "X alternatives" queries and cross-links from every competitor's page | None for submission | **Submitted 2026-08-10**, in the free approval queue (up to 32 days) |
| [GitHub Marketplace](https://github.com/marketplace?type=actions) | Not a listing but a working piece of the product where CI users browse: the `intentic/gate-action` action (built in `_sandbox/gate-action`, synced by `action-publish.yml`) — every workflow that adopts it carries the name in a public repo | Public `intentic/gate-action` repo + `GATE_ACTION_TOKEN` secret + first release; then the one-time Marketplace publish in the UI (developer agreement, categories: Continuous integration / Code review) | Built, awaiting owner setup |
| [AlternativeTo](https://alternativeto.net) | The highest-authority alternatives site; owns the "alternative to Cursor / Claude Code" result | Account **and** a browser that clears its Cloudflare check — automation is blocked outright | Blocked |
| [OpenAlternative](https://openalternative.co) | Open-source-only directory that already has "AI Agent Platforms", plus Claude Code, Codex and Cursor alternative pages — exact-fit taxonomy | Account (email magic link, Google or GitHub) | Blocked |
| [Hacker News](https://news.ycombinator.com) (Show HN) | The largest single traffic event available, and a permanently indexed page | Account; one shot, so timing matters | **Held by owner 2026-08-12** — draft below, do not post |
| [Dev Hunt](https://devhunt.org) | Dev-tools-only launchpad, weekly leaderboard | Account | Blocked |
| [StackShare](https://stackshare.io) | Tool profile that developers cite in stack decisions | Account; rate-limits automation | Blocked |
| [Crunchbase](https://www.crunchbase.com) | Entity record — what disambiguates the name from "Intent" | Account | Blocked |
| [Uneed](https://www.uneed.best) · [Peerlist](https://peerlist.io) | Small launch platforms, quick, cumulative | Account | Blocked |
| [Fazier](https://fazier.com) | Launch platform | Free tier **requires a reciprocal link in intentic's own footer**; paid tiers $29–$149 | Owner decision, not a blocker |
| [G2](https://www.g2.com) | High authority, but it is a reviews platform — a profile with no reviews does nothing | Account, and reviews to make it worth having | Deferred |
| Product Hunt | One-shot launch; thin at 7 stars | — | **Skipped** by owner decision, 2026-08-10 |
| [console.dev](https://console.dev) | Curated dev-tool newsletter, editorial link | Blocks automation; submit by hand | Blocked |

### Notes that decide whether a submission survives

- **SaaSHub verification needs an address on the product's own domain** (e.g. `hello@intentic.dev`), not the
  listing identity's gmail. Verifying is what turns the entry into a *verified alternative* on the competitor
  pages it was filed against, and it moves the queue from 32 days to fast. This is the single highest-value
  follow-up on this page.
- **AlternativeTo and console.dev both refuse a headless browser.** They need the identity's own browser
  profile, not a fresh automated one.
- **Fazier's free tier buys a link with a link.** Adding a directory badge to intentic's footer is a site
  change and a taste call — it is not worth it for a DR-40-ish listing, so it stays a decision rather than a task.
- **G2 before reviews is an empty shelf.** Worth doing after there are users who would write one.

## Show HN — prepared, held by owner decision 2026-08-12

**Held, deliberately, not blocked.** Asked on 2026-08-12 whether to open an account now so it could age, the
owner chose to hold HN entirely for now. Do not post it, and do not open the account as a side effect of some
other task — the single shot is being kept in reserve until there is more to point at than a one-week-old repo
at 8 stars.

Two facts to re-check when it is picked back up: there is **no Hacker News account on any identity in the
roster** (verified 2026-08-12), and the rule below requires the account to pre-date the posting day — so
un-holding this costs a lead time of at least a day, not an afternoon.

One shot, so it goes out deliberately: a weekday, 08:00–10:00 US Eastern, from an account that exists before
the day it posts. Title, at 77 of the 80 characters HN allows:

> Show HN: intentic – a browser workspace for coding agents on hardware you own

First comment, posted immediately after submitting:

> I kept losing track of which terminal was running which agent, and closing the laptop killed the run. So the
> agents got a machine instead of a tab: each one lives in its own container sandbox on hardware I own — laptop,
> desktop or VPS — in a git worktree of its own, and the browser is just a window onto it. Close it, reopen on a
> phone, the run is still going.
>
> The parts I actually care about: plan mode before it acts, every change landed per hunk from a diff panel, and
> the sandbox image being a Dockerfile the agent proposes and I approve rather than a fixed environment.
> Credentials sit inside the sandbox and get injected per turn, so they are never in the file tree.
>
> It works with Claude Code, Codex, Grok, Kimi Code and Gemini on your own subscription — intentic charges
> nothing and never meters model usage. MIT, and the platform tier is deliberately thin: it knows who you are
> and where your sandbox is, and every keystroke goes browser-to-your-machine over your own Cloudflare tunnel.
>
> Demo, which is the real workspace running against fixtures: https://intentic.dev/demo/
> Source: https://github.com/intentic/intentic
>
> It is six days old in public and rough in places. Happy to answer anything about the trust model — that is the
> part I would poke at first.

## Done 2026-08-10

- **SaaSHub** — submitted with the free tier: name, the 152-char tagline, categories *AI Developer Tools · AI
  Coding · Self-hosted*, competitors *Cursor · Claude Code · Devin by Cognition*, and filed as an alternative on
  the *8080.AI*, *Augment Code* and *Windsurf Editor* pages. Awaiting approval; claiming the listing and
  uploading the logo both need an account.

## What unblocks the rest

Every remaining target needs one thing: a signed-in browser belonging to the listing identity
(radarsuspam@gmail.com). Sites that offer "Continue with Google" — OpenAlternative, StackShare, Crunchbase,
Peerlist — fall in one pass once that browser exists; AlternativeTo, Dev Hunt and Hacker News each need their
own account created in it.
