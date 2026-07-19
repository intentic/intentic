# intentic — Messaging

What we say, in which words, everywhere. Pairs with [positioning.md](positioning.md) (P1–P8 pain
references) and [landing-blueprint.md](landing-blueprint.md) (section placement). The product
being sold is **intentic-app** (app.intentic.dev); the open-source engine is the trust layer and
the DevOps capability.

## Rules of voice

- Engineer-to-engineer. Declarative sentences. Second person for the reader; "intentic" always lowercase.
- Evidence over adjectives: no claim a screenshot, code block, or repo link can't back.
  Banned words: effortless, blazingly, seamless, magic, revolutionize, supercharge.
- The product already wrote its best lines — reuse in-app copy verbatim before writing new copy.
  The app and the site must sound like one author.
- Ownership language is the spine: "your machine", "your accounts", "you own every line",
  "stays inside your sandbox". Never "we host your code" — we don't.
- Provider-agnostic: intentic works with Claude Code, Codex, and whatever ships next. Name
  providers as plural examples for credibility, never as the headline or the brand hook — the
  subject is always "your coding agent".
- Honesty is a feature: the free tier is stated plainly, the engine's v0 status and limitations are linked.

## Message hierarchy

**The one thing the page sells (single use-case):** your coding agent — Claude Code or Codex —
running on a machine you own, driven from any browser. Everything else (capabilities, automations,
the deploy engine) is support: one card each in the "What's included" row, never a flagship band.
The deploy engine is a deliberate **sidecar** — it lives in that row and in the FAQ, and its
vocabulary never leads.

Landing copy lives in code: `_libs/site-content/src/landing.ts` defines three complete variants of
the page — the same skeleton and claims, three doors in:

| Variant | Angle | H1 |
|---------|-------|----|
| `a` (default) | Agent-led — the terminal agent, upgraded | Your coding agent. Out of the terminal. |
| `b` | Ownership-led — the pain of vendor-cloud custody | The AI workspace you own. |
| `c` | Moment-led — narrates the use-case itself | Start at your desk. Approve from your phone. |

Switching: `SITE_VARIANT=a|b|c` at build/dev time selects what `/` renders (default `a`);
`astro dev` additionally serves `/preview/a|b|c` with a floating switcher for side-by-side
comparison (those routes do not exist in production builds).

**Hero CTA (all variants):** `Get started free` → app.intentic.dev. Secondary: `See the open-source engine` → GitHub.

Retired hero: "Build software with intent." (stays as the brand tagline in org metadata / fallback
titles) and the infra-first subhead "An AI-native workspace for infra, data, apps, and code…".

## Page skeleton (shared by all variants; per-variant copy in landing.ts)

| # | Section (id) | Job | Pain |
|---|--------------|-----|------|
| 1 | Hero (`#hero`) | The one-sentence what + the workspace mock mid-plan-approval. | P1, P2 |
| 2 | Get connected (`#connect`) | Speed proof: the 3 wizard steps + the one command. | P3 |
| 3 | Anywhere (`#anywhere`) | The use-case in action: desk → phone → back to diffs. | P2 |
| 4 | Ownership (`#ownership`) | The moat: browser → tunnel → sandbox diagram + three facts. | P1 |
| 5 | Control (`#control`) | Plan mode default, four permission modes, changes review. | P4 |
| 6 | Included (`#more`) | Capabilities · automations · deploys — one card each. | P5, P6, P7 |
| 7 | FAQ (`#faq`) | The objection bank (shared across variants). | all |
| 8 | Final CTA | Variant close + `Get started free`. | close |

**Free-first, no pricing section (principle, not a section).** There is deliberately no on-page
pricing block and no "Pricing" nav/footer link — a monetization-forward page reads as slop that
wants money, when in fact everything is free to explore and users upgrade in-app. The free story is
carried softly by the hero "Free plan" chip, the final CTA "Free to start.", and the FAQ answer
"What's free and what's Pro?" (free = one full sandbox; Pro = unlimited sandboxes + team sharing).
Do not reintroduce a pricing section.

## Glossary (use these words, exactly)

- **workspace** — what the user experiences in the browser: chat + files + editor + terminal over a sandbox.
- **sandbox** — the per-project agent daemon running on the user's machine, reached over its own
  private tunnel. Never "VM", "container instance", or "environment".
- **capability** — an installable power for the sandbox (GitHub, SQL database, Discord, DevOps…).
  Never "integration" or "plugin" (plugins are a specific capability).
- **automation** — a rule that wakes the agent (schedule / event / listen), optionally gated by a
  **guard command**. Never "cron job" or "workflow".
- **plan mode** — the default agent permission mode: propose, then wait for approval. Also:
  accept edits / ask before edits / auto.
- **desktop sync** — two-way near-real-time folder sync between the user's editor and the sandbox.
- **agent** — the coding agent working inside the sandbox (Claude Code, Codex, …). Name providers
  as examples; never "our AI", never one provider as the brand.
- Engine vocabulary — **intent, `i.have`/`i.want`, derive, desired state, reconcile, reads true** —
  is used only in the FAQ's DevOps answer and engine docs, defined on first use. It never appears
  in a landing section.

## Objection bank (FAQ source of truth)

1. **Where does my code live?** — On your machine. The sandbox runs where you start it; your
   browser reaches it over a private Cloudflare tunnel. The platform stores your identity and the
   sandbox's URL — it never relays your files or sits between you and your sandbox.
2. **Can intentic read my secrets?** — No. Credentials live inside your sandbox; the platform has
   no path to them. What little the platform does store (OAuth tokens, connect tokens) is
   AES-256-GCM encrypted with no decrypt path in the product. Secret files are denylisted from the
   workspace file relay.
3. **Which AI models does it use?** — Your choice per conversation: Claude Code (Opus, Sonnet,
   Haiku) or Codex, with adjustable reasoning effort. Your provider, your account, your usage.
4. **Do I need a Cloudflare account?** — No. By default intentic provisions the tunnel under its
   own domain. Bring your own zone if you prefer — your token is used once to list zones and is
   never stored.
5. **What do I need to run a sandbox?** — A machine with Docker (installed automatically if
   missing, with your confirmation) and a Google account. No open inbound ports, nothing deployed.
6. **Can the agent break my stuff?** — It starts in plan mode: it proposes, you approve. Every
   file change is reviewable as a diff you can discard or commit; environment (Dockerfile) changes
   require your explicit approval; stricter and looser modes are one click away.
7. **What's free and what's Pro?** — Free: one full sandbox — every capability, the agent, and
   automations included. Pro: unlimited sandboxes and team sharing (invite by email). Pricing at
   checkout via Stripe; cancel anytime. Removing access (revoke, leave) never requires Pro.
8. **What are automations?** — Scheduled or event-driven agent wake-ups: GitHub/GitLab pushes,
   Sentry alerts, Stripe payments, new email, Discord messages, or plain cron — each run a fresh
   agent session with a transcript, optionally gated by a guard command you define.
9. **What's the DevOps capability?** — The open-source intentic engine: declare what you have (a
   host, a Cloudflare account) and what you want (apps); it derives and reconciles git, CI, a
   registry, deploys, a tunnel, and DNS — zero inbound ports. Also stands up services like
   Outline, SigNoz, Paperless-ngx, OpenProject, Invoice Ninja, and Infisical.
10. **Is it open source? Can I use it without the app?** — The engine is MIT on GitHub and works
    standalone as a CLI. The hosted app adds the workspace, capabilities, automations, and teams.
11. **What about my data — export, deletion?** — Settings → Export downloads everything the
    platform stores about your account as JSON (deliberately excluding credentials). Account
    deletion cancels billing and cascades sandboxes, sessions, and grants.
12. **Is it production-ready?** — The app is new and says so. The engine is v0, MIT, with 100+
    tests including a real end-to-end run through a live Cloudflare tunnel; known limitations are
    documented in the README. Read exactly what it does before pointing it at anything you care about.

## SEO strings

- Landing title/description are **per variant** — see `meta` in `landing.ts`. Fallback (page-meta.ts):
  `intentic — Your coding agent, on your machine, in any browser`.
- Org description (site.ts, JSON-LD): `Your coding agent — Claude Code or Codex — running on your
  own machine, driven from any browser. Your code and secrets never leave your hardware.
  Capabilities, automations, and an open-source deploy engine included. Free to start.`
- Keywords to carry naturally: coding agent, Claude Code, run Claude Code remotely, self-hosted AI
  agent, agent sandbox, AI workspace in the browser, Devin alternative, own your code.
