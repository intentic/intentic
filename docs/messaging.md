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
- Honesty is a feature: the free tier is stated plainly, the engine's v0 status and limitations are linked.

## Message hierarchy

**Tagline / hero H1 (sitewide, meta, OG) — verbatim from the product (`Login.vue:46-48`):**
> Build software with intent.

**Hero subhead — verbatim (`Login.vue:51`):**
> An AI-native workspace for infra, data, apps, and code — you own every line, we handle the wiring.

**Hero CTA:** `Get started free` → app.intentic.dev. Secondary: `See the open-source engine` → GitHub.

**Hero footnote:** `Free plan · Your machine, your accounts · No open inbound ports · Open-source MIT engine`

Alternate H1s (only if testing): "Your agent. Your machine. Any browser." / "The AI workspace you own."
Retired: "Infrastructure as intent for self-hosters" (now the DevOps-band message, not the brand).

## Section messages (one-liners the page is built from)

| ID | Section | Headline | Support line | Pain |
|----|---------|----------|--------------|------|
| M1 | Hero | Build software with intent. | An AI-native workspace for infra, data, apps, and code — you own every line, we handle the wiring. | P1, P2 |
| M2 | Onboarding | A few minutes to a live workspace. | Sign in with Google, name your sandbox, paste one command. No Cloudflare account required; Docker installed if missing; no open ports, nothing deployed. | P3 |
| M3 | Ownership | You own every line. | Your sandbox runs on your machine. The platform stores your identity and a URL — nothing else. It can't read your code, hold your credentials, or reach your daemon. | P1 |
| M4 | Agent in control | Autonomy with a steering wheel. | Plan mode by default: the agent proposes, you approve. Review every change as a diff — discard or commit. Environment changes ship only with your sign-off. | P4 |
| M5 | Capabilities | Grow your sandbox. | GitHub, databases, Sentry, Discord, Stripe, SSH, MCP servers, plugins — credentials stay inside your sandbox and never leave it. | P5 |
| M6 | Automations | Your agent, on call. | Wake it on a schedule, a webhook, or live events — a Sentry alert, a Stripe payment, a push, an email. Each run is a fresh session with a transcript. | P6 |
| M7 | DevOps band | Infrastructure as intent. | The flagship capability: declare what you have and what you want; the open-source engine derives git, CI, registry, deploys, tunnel, and DNS — and reconciles until reality matches. Zero inbound ports. | P7 |
| M8 | Trust band | Built to be unable to betray you. | Off-command-path platform, AES-256-GCM secrets at rest, GDPR export and deletion, unprivileged sandbox, MIT open-source engine you can read. | trust |
| M9 | Final CTA | Build software with intent. | One command from a live workspace. Free to start. | close |

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
- **agent** — Claude Code or Codex working inside the sandbox. Name the providers; never "our AI".
- Engine vocabulary — **intent, `i.have`/`i.want`, derive, desired state, reconcile, reads true** —
  is used only inside the DevOps band and engine docs, defined on first use.

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

- Title: `intentic — Build software with intent`
- Meta description: `An AI-native workspace for infra, data, apps, and code. Your agent runs on your machine — the platform can't read your code or secrets. Capabilities, automations, team sandboxes, and an open-source engine that self-hosts your infrastructure. Free to start.`
- Keywords to carry naturally: AI development workspace, coding agent, Claude Code, self-hosted AI
  agent, agent sandbox, Devin alternative, AI DevOps, infrastructure as intent, own your code.
