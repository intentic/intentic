# intentic — Messaging

What we say, in which words, everywhere. Pairs with [positioning.md](positioning.md) (personas +
pains, P1–P7) and [landing-blueprint.md](landing-blueprint.md) (section placement). The product
being sold is **intentic-app** (app.intentic.dev): co-piloted **specialized agents** — autonomous
employees, each a sandbox on hardware you own. The sandbox and CLI that run on your machine are MIT
open source on GitLab — the trust layer you can read and run yourself.

## Rules of voice

- Engineer-to-engineer. Declarative sentences. Second person for the reader; "intentic" always lowercase.
- Evidence over adjectives: no claim a screenshot, code block, or repo link can't back.
  Banned words: effortless, blazingly, seamless, magic, revolutionize, supercharge.
- The product already wrote its best lines — reuse in-app copy verbatim before writing new copy.
  The app and the site must sound like one author.
- Ownership language is the spine: "your machine", "your accounts", "you own every line",
  "stays inside your sandbox". Never "we host your code" — we don't.
- Provider-agnostic: intentic works with Claude Code, Codex, Grok, and whatever ships next. Name
  providers as plural examples for credibility, never as the headline or the brand hook — the
  subject is always the **specialized agent** (the autonomous employee), never one provider.
- Honesty is a feature: the free tier is stated plainly; the app is new and says so.

## Message hierarchy

**The one thing the page sells:** **a shared IDE for you and your agents — one workspace, two kinds
of operator.** Everywhere else the prompt is the only layer of an agent you can change; here every
layer is visible and yours to edit: the image its dev-tools are really installed in, the systems it's
allowed to reach (capabilities), the context it loads every turn. The agents that workspace is built
for are **co-piloted specialized agents** — autonomous employees, each a purpose-built sandbox on
hardware you own, running on your own Claude/Codex/Grok subscription. Run one, or ten in parallel.

The claim is literal, not a metaphor, and that is what makes it defensible: you and the agent drive
the *same* surfaces. One implementation of what connecting a VPN means (`/vpn` for the browser,
`/usr/local/bin/vpn` for the agent); one shared `tmux` server behind your terminals and its shell
commands; one `iq` index behind `/workspace/search` and its Bash calls; one tree, where each agent
works on its own git worktree and lands its delta into your Changes panel for review.

An autonomous agent is not fire-and-forget. AI still needs (a) its context configured, (b) its work
supervised, and (c) a human in the loop for the decisions that matter. So every agent is
**co-piloted** — and that is exactly why intentic is a full workspace, not a chat box. Two families
of surfaces earn the "workspace" claim, and every band on the page ladders up to one of them:

- **IDE** — editor, file tree, diff review, terminal: the surfaces that let you *configure* an agent
  and read its work.
- **observability** — the fleet board, plan mode, per-edit permission modes, changes review,
  transcripts: the surfaces that let you *watch and steer* the agents you run.

**Ownership** is the trust foundation under both (agent on your own hardware, platform off the
command path, code and keys never leave your machine). **Automations** make agents event-driven;
**Pro** runs a whole team of them; the **economics** are BYO subscription + your own hardware + a
flat fee — never a meter on model usage.

Landing copy lives in code: `_libs/site-content/src/landing.ts` is a single `LandingContent` object
— **one page, no variants** (there is no `SITE_VARIANT`, no `/preview` route, no a/b/c doors).
Change copy there, not in the `.astro` files.

**Hero CTA:** `Get started free` → app.intentic.dev. Secondary: `See the source` → the GitLab repo
(gitlab.com/radarsu/intentic) — the trust-through-transparency path.

Retired framing (do not bring back): "Your coding agent. Out of the terminal.", "Build software with
intent." as the definition, "An AI-native workspace for infra, data, apps, and code…", "Specialized
agents that own their workspace", and **"A specialized agent is more than a prompt."** as the
headline — it argued against a strawman nobody's pain matches, restated the contrast band 1500px
early, and filed us with prompt-builders instead of Cursor/Codespaces/Devin. "specialized agent"
survives as *mechanism* vocabulary (see the glossary); it is no longer the headline claim. The brand
tagline is now "A shared IDE for you and your agents" (org metadata,
`_libs/site-content/src/site.ts`), rendered as the hero `The IDE you share / with your agents.`

## Section order

The page is a single continuous scroll; the full section-by-section blueprint (ids, jobs, accuracy
rules) lives in [landing-blueprint.md](landing-blueprint.md). At the message level the order tells
one story: **state the thesis** (Hero) → **show it's real** (the product tour of screenshots) →
**the prompt is the only layer anyone else opens** (contrast) → **break one agent down** (anatomy,
inside a sandbox) → **wire it to your systems** (integrations hub) → **scale to a team** (workforce,
Discord teammate) → **carry the trust** (ownership, shared safely) → **zoom out to a company**
(the whole picture) → **the deal** (economics) → **get connected** → **final CTA**. Each pain from
positioning.md (P1–P7) surfaces where its band lands.

**Free-first, no pricing section (principle, not a section).** There is deliberately no on-page
pricing block and no "Pricing" nav/footer link — a monetization-forward page reads as slop that
wants money, when in fact everything is free to explore and users upgrade in-app. The free story is
carried softly by the hero "Free plan" chip, the economics band, the final CTA "Free to start.", and
the FAQ answer "What's free and what's Pro?" (free = one full sandbox; Pro = unlimited sandboxes +
team sharing). Do not reintroduce a pricing section.

## Glossary (use these words, exactly)

- **specialized agent** (a.k.a. **autonomous employee**) — a coding agent given its own sandbox for
  one job: dev-tools really installed, wired to your systems, context curated for that role. A
  *mechanism* word — what you build in the shared IDE — never the headline claim.
- **the environment** — the sum of the layers a prompt can't reach: the image the tools are installed
  in, the capabilities the agent may use, the context it loads each turn. The page's real subject,
  because intentic's differentiator is that all of it is **visible and editable**, not that it exists.
- **co-piloted** — the working stance: the agent runs autonomously, but you configure its context,
  supervise its work, and stay in the loop for the decisions that matter. Never "fire-and-forget",
  never "fully autonomous" without this qualifier.
- **workspace** — what the user experiences in the browser: chat + files + editor + diff review +
  terminal (the **IDE** surfaces) over a sandbox, plus the **observability** surfaces that watch and
  steer it. The reason it's a workspace and not a chat box.
- **fleet board** — the /agents home surface: every running agent as a parallel, isolated
  conversation — the coworking-space view of your workforce.
- **sandbox** — the per-agent daemon running on the user's machine, reached over its own private
  tunnel. Never "VM", "container instance", or "environment".
- **capability** — an installable power that wires the sandbox to your systems (GitHub, a SQL
  database, Discord, Stripe, SSH, an MCP server…). Never "integration" or "plugin" (plugins are a
  specific capability).
- **automation** — a rule that wakes the agent (schedule / event / listen), optionally gated by a
  **guard command**. Never "cron job" or "workflow".
- **plan mode** — the permission mode where the agent proposes and waits for approval; the default
  for a chat on the shared workspace tree, one click away everywhere else. An agent working in its
  own branch defaults to **auto** (it owns that worktree; its output is reviewed as a diff, not
  approved command by command). Also: accept edits / ask before edits.
- **desktop sync** — two-way near-real-time folder sync between the user's editor and the sandbox.
- **agent** — the coding agent working inside the sandbox (Claude Code, Codex, Grok, …). Name
  providers as examples; never "our AI", never one provider as the brand.
- **Deployment is not a landing element.** The monorepo happens to include a deployment engine, but
  it is just one of the many tools an agent can run (like `psql`, a headless browser, or `docker`) —
  never a pillar, section, "superpower", card, or FAQ headline. Its vocabulary (intent,
  `i.have`/`i.want`, derive, reconcile, desired state) belongs to the engine's own docs and never
  appears in landing or FAQ copy. If deployment comes up at all, it is one unremarkable example of a
  tool an agent can run, nothing more.

## Objection bank (FAQ source of truth)

1. **Where does my code live?** — On your machine. The sandbox runs where you start it; your
   browser reaches it over a private Cloudflare tunnel. The platform stores your identity and the
   sandbox's URL — it never relays your files or sits between you and your sandbox.
2. **Can intentic read my secrets?** — No. Credentials live inside your sandbox; the platform has
   no path to them. What little the platform does store (OAuth tokens, connect tokens) is
   AES-256-GCM encrypted with no decrypt path in the product. Secret files are denylisted from the
   workspace file relay.
3. **Which AI models does it use?** — Your choice per conversation: Claude Code (Opus, Sonnet,
   Haiku), Codex, or Grok, with adjustable reasoning effort. Your provider, your account, your usage.
4. **Do I need a Cloudflare account?** — No. By default intentic provisions the tunnel under its
   own domain. Bring your own zone if you prefer — your token is used once to list zones and is
   never stored.
5. **What do I need to run a sandbox?** — A machine with Docker (installed automatically if
   missing, with your confirmation) and a Google account. No open inbound ports, nothing deployed.
6. **Can the agent break my stuff?** — No, because it's co-piloted, not fire-and-forget. It starts
   in plan mode: it proposes, you approve. Every file change is reviewable as a diff you can discard
   or commit; environment (Dockerfile) changes require your explicit approval; stricter and looser
   modes are one click away.
7. **What's free and what's Pro?** — Free: one full sandbox — every capability, the agent, and
   automations included. Pro: unlimited sandboxes and team sharing (invite by email). Pricing at
   checkout via Stripe; cancel anytime. Removing access (revoke, leave) never requires Pro.
8. **What are automations?** — Scheduled or event-driven agent wake-ups: GitHub/GitLab pushes,
   Sentry alerts, Stripe payments, new email, Discord messages, or plain cron — each run a fresh
   agent session with a transcript, optionally gated by a guard command you define.
9. **Is it open source? Can I run it without the app?** — Yes. The sandbox and CLI that execute on
   your machine are MIT on GitLab (gitlab.com/radarsu/intentic) — read exactly what runs on your
   hardware, and drive a sandbox from the CLI without ever signing in. The hosted app adds the
   browser workspace, the fleet board, capabilities, automations, and teams.
10. **What about my data — export, deletion?** — Settings → Export downloads everything the
    platform stores about your account as JSON (deliberately excluding credentials). Account
    deletion cancels billing and cascades sandboxes, sessions, and grants.
11. **Is it production-ready?** — The app is new and says so. Because the sandbox and CLI are MIT on
    GitLab, you can read exactly what runs on your machine before you trust it with anything you
    care about — and because the agent is co-piloted (plan mode, reviewable diffs, owner-approved
    environment changes), you stay in control of every change. Verify test counts and prices at
    build time — never hardcode stale numbers.

## SEO strings

- The landing is a single page — its title/description are **not** per-variant. Fallback
  (`_libs/site-content/src/page-meta.ts`): `intentic — Specialized agents that own their workspace`.
- Org description (`_libs/site-content/src/site.ts`, JSON-LD) — the canonical product sentence; keep
  the site and these docs in sync with it verbatim: `A shared IDE for you and your agents. intentic
  gives each coding agent — Claude Code, Codex, or Grok — its own sandbox on hardware you own: the
  dev-tools its job needs really installed, wired to your systems, its context curated for one job —
  and every layer of that environment visible and yours to change. Run one, or ten in parallel. Free
  to start.`
- Keywords to carry naturally: AI IDE, agent IDE, shared workspace, specialized agent, autonomous
  agent, AI employee, agent workforce, coding agent, Claude Code, Codex, Grok, agent sandbox, AI
  workspace in the browser, self-hosted AI agent, Devin alternative, own your code.
