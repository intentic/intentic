# intentic — Positioning

Who intentic is for, the pains it removes, and why it wins. **The product being sold is
intentic-app** — the hosted AI-native workspace at app.intentic.dev. The open-source engine
(`intentic` repo) appears in two roles: the DevOps capability inside the app, and the trust layer
under it. Every claim traces to a file in the product repos (`intentic-app`, `intentic`); if a
claim has no path, it doesn't go on the site.

Companion docs: [messaging.md](messaging.md) (what we say), [landing-blueprint.md](landing-blueprint.md) (where we say it).

## What it is

**intentic is an AI-native workspace for infra, data, apps, and code — you own every line, it
handles the wiring** (verbatim from the product itself, `intentic-app/_apps/web/src/pages/Login.vue:46-52`:
"Build software with intent.").

The shape of the product: you sign in with Google and run a **sandbox** — an agent workspace
daemon — on a machine *you* control (your laptop, a VPS), reached by your browser over a private
Cloudflare tunnel. Inside it, a coding agent (Claude Code or Codex) works over your files and
repos with human-in-the-loop approval. You grow the sandbox with **capabilities** (GitHub,
databases, Discord, Stripe, SSH, MCP servers…), wake the agent on **automations** (cron, webhooks,
live events), and — via the **DevOps capability**, a deliberate sidecar rather than the headline —
have it stand up and operate real self-hosted infrastructure using the open-source intentic engine.
The thing being sold is the workspace and the single use-case it enables: *your coding agent, on
your machine, from any browser* (see messaging.md).

**Category**: an AI development workspace you own — cloud-grade agent UX with local-grade
ownership. The platform is architecturally a thin identity store that *cannot* touch your code,
secrets, or infra (`intentic-app/README.md`, `intentic/ARCHITECTURE.md:44-57`).

**Business model**: hosted app, Free (1 sandbox) / Pro (unlimited sandboxes + team sharing),
Stripe billing (`intentic-app/_apps/api/src/entitlements.ts`). Engine is MIT open source.

## Who it's for

**Primary — the professional dev adopting agents who won't hand over their code.**
Wants Devin/Cursor-agent-style autonomy but refuses to ship source, credentials, and prod access
into someone else's cloud sandbox. intentic's answer: the sandbox runs on *their* machine; the
platform stores only identity + a URL and sits off the command path. The product names this
audience itself: "For professional developers — Built for REAL systems development, not
vibe-coded demos" (`Login.vue:17`). Job to be done: *"When I put an agent to work on my real
systems, keep the code, secrets, and blast radius under my control, so I can use full autonomy
without betting the company on a vendor's security."*

**Primary — the indie dev / small team who wants an agent that operates infrastructure, not just
edits files.** One workspace where the agent scaffolds a monorepo, wires GitHub/CI, provisions
databases, deploys apps to their own hardware (DevOps capability → OSS engine), and stands up
team services (Outline, SigNoz, Paperless-ngx, OpenProject, Invoice Ninja, Infisical —
`intentic-app/_libs/api-contract/src/schemas.ts:141`).

**Secondary — teams sharing an agent workspace (Pro).** Owner invites teammates by email; grants
are enforced by the sandbox daemon fail-closed; revoke/leave always work even after downgrade
(`intentic-app/_apps/api/src/invites.ts`, `router.ts:321`).

**Emerging — the automation operator.** Wants the agent on-call: wake on a Sentry alert, a Stripe
payment event, a GitHub push, a new email — with a guard command deciding whether each wake runs
(`schemas.ts:645`, `_apps/web/src/pages/Automations.vue`).

## Pain → promise → proof

| # | Pain | Promise | Proof |
|---|------|---------|-------|
| P1 | Cloud AI dev environments want your code, secrets, and prod access on their servers | Your sandbox runs on your machine; the platform stores only identity + a sandbox URL, sits off the command path, and cannot reach your daemon | `intentic-app/README.md`, `intentic/ARCHITECTURE.md:44-57`, `Sandbox.vue` ("The platform keeps only its address; accounts and credentials stay inside it.") |
| P2 | Powerful local agents (CLI) are single-machine, terminal-bound, and solo | A browser workspace over your sandbox from anywhere — chat, file tree, editor, diffs, terminal — plus teams, automations, and two-way desktop sync | `_apps/web/src/pages/workspace/`, `useDesktopSync.ts` |
| P3 | Setting up a private agent environment is an evening of DevOps | Minutes to a live sandbox: Google sign-in → one copy-paste command. No Cloudflare account required; Docker auto-installed; no open inbound ports | `Setup.vue:369` ("A few minutes to a live sandbox — no Cloudflare account required."), `sandboxPool.ts` (pre-provisioned tunnels) |
| P4 | Agent autonomy is scary on real systems | Plan mode by default ("Propose a plan and wait for your approval before running"), per-edit approval modes, a changes-review panel (diff → discard or commit), owner-approved environment changes | `ChatPanel.vue:90`, `useReview.ts`, `EnvironmentCard.vue` |
| P5 | Wiring the agent to your tools (repos, DBs, chat, monitoring) is N one-off integrations | A capabilities catalog: GitHub/GitLab/Redmine, SQL databases, Sentry/SigNoz, Discord/IMAP, Stripe, SSH/VPN/Docker, custom MCP servers, Claude plugins — credentials stay inside the sandbox | `schemas.ts:302` (CAPABILITY_CATALOG), `Capabilities.vue` |
| P6 | The agent only works when you're at the keyboard | Automations: wake it on a schedule, a webhook, or live events (GitHub/GitLab push, Sentry alert, Stripe payments, new email, Discord), each run a fresh session with a transcript, optionally gated by a guard command | `schemas.ts:645` (AUTOMATION_RECIPES), `Automations.vue` |
| P7 | Self-hosting real infrastructure is a second job | The DevOps capability: the agent declares intent and the MIT engine derives, provisions, and reconciles git + CI + registry + deploys + tunnel + DNS — zero inbound ports, drift self-heals | `schemas.ts:302` (DevOps), `intentic/README.md:37,94-107,111` |
| P8 | AI SaaS lock-in — models, data, exit | BYO agent (Claude Code: Opus/Sonnet/Haiku, or Codex), your repos are plain git on your machine, GDPR export + account deletion, MIT engine if you leave the app entirely | `conversation.ts`, `router.ts:97` (me.export), `auth.ts:75`, `intentic/LICENSE` |

## Selling points, ranked

1. **Ownership without giving up the cloud UX** — the only agent workspace where the vendor is
   architecturally *unable* to read your code or drive your sandbox (identity-only hub, off the
   command path; secrets AES-256-GCM at rest with no decrypt path, `_apps/api/src/crypto.ts`). (P1)
2. **Minutes to a live workspace** — Google sign-in, one copy-paste command, no Cloudflare
   account, no open ports, workspace opens itself when the sandbox reports in. (P3)
3. **An agent that operates, not just edits** — capabilities + automations + the DevOps engine
   make it an operator for real systems: provision, deploy, monitor, get woken by alerts. (P5, P6, P7)
4. **Autonomy with a steering wheel** — plan-mode default, four permission modes, review-and-commit
   panel, owner-approved environment changes. Trust is a UX feature, not a policy PDF. (P4)
5. **The self-hosting superpower** — one chat message away from standing up Outline, SigNoz,
   Paperless-ngx, OpenProject, Invoice Ninja, Infisical — or deploying your own apps on your own
   hardware via the open-source engine. (P7)
6. **Teams on Pro** — shared sandboxes with email invites, daemon-enforced grants, and a fair
   free tier (1 full sandbox, nothing crippled). (entitlements.ts)

## Competitive frame

**vs. cloud AI dev environments (Devin, Cursor background agents, Replit Agent, Copilot Workspace,
OpenHands cloud).** They run the agent on their infrastructure: your code, tokens, and often prod
credentials live in their sandbox. intentic keeps the agent on your machine with a cloud-grade
browser UX on top; the hosted platform can't reach it. BYO model (Claude Code or Codex) instead of
a house model. *Pick them when* you want zero local footprint and don't handle sensitive systems.

**vs. plain local Claude Code / Codex CLI.** Same agents, but terminal-bound, single-machine,
single-player, and asleep when you are. intentic adds the browser workspace from anywhere,
capabilities with sandbox-contained credentials, automations that wake the agent on events, team
sharing, and the DevOps engine. *Pick the bare CLI when* you live in one terminal and need none of
that — the engine is MIT and works standalone.

**vs. self-host deploy tools (Coolify, Dokku, Kamal) and IaC (Terraform, Pulumi).** Scoped to the
DevOps capability: they make *you* the operator — you author resources or prepare hosts. intentic's
engine derives the whole platform (git, CI, registry, deploys, tunnel, DNS) from declared intent
and reconciles it, and in the app the *agent* is the operator. *Pick them when* you want hands-on
control of every resource or arbitrary multi-cloud coverage.

## Honest maturity (say it, don't hide it)

- The hosted app is new (launching at app.intentic.dev); the free tier is a real sandbox, not a demo.
- The engine under the DevOps capability is MIT, pre-1.0, developed in the open: a working
  6-command CLI, 100+ tests including a true e2e that stands the stack up through a live
  Cloudflare tunnel (`intentic/ARCHITECTURE.md:235-267`); known limitations documented
  (`intentic/README.md:194-198`). Verify counts at build time — never hardcode stale numbers.
- No testimonials yet — do not fabricate; lead with verifiable architecture and open source
  (see landing-blueprint.md, "Trust band").
