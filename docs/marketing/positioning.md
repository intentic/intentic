# intentic — Positioning

Who intentic is for, the pains it removes, and why it wins. **The product being sold is
intentic-app** — the hosted workspace at app.intentic.dev, where you run co-piloted **specialized
agents** on hardware you own. The sandbox and CLI those agents run on are MIT open source on GitLab
(`gitlab.com/radarsu/intentic`) — the trust layer you can read and run yourself. Every claim traces
to a file in the repo; if a claim has no path, it doesn't go on the site.

Companion docs: [messaging.md](messaging.md) (what we say), [landing-blueprint.md](landing-blueprint.md) (where we say it).

## What it is

**intentic is a shared IDE for you and your agents — one workspace, two kinds of operator.**
Everywhere else the prompt is the only layer of an agent you can change. Here every layer is visible
and yours to edit: the image its dev-tools are really installed in, the systems it may reach
(**capabilities**), the context it loads every turn. What you build in that workspace is a
**specialized agent** — an autonomous employee in a purpose-built **sandbox** on hardware *you* own,
running on your own Claude/Codex/Grok subscription. Run one, or ten in parallel.

"Shared" is literal. You and the agent drive the same surfaces, by construction: one implementation of
what connecting a VPN means (the browser on `/vpn`, the agent on `/usr/local/bin/vpn` — the tunnel it
dials appears in your UI with nothing syncing the two), one `tmux` server behind your terminals and
its shell commands, one `iq` index behind `/workspace/search` and its Bash calls, and one tree — each
agent on its own git worktree, landing its delta into your Changes panel as the review boundary
(`_apps/sandbox/src/agents/worktrees.ts`, `land.ts`).

But an autonomous agent is not fire-and-forget. AI still needs its context configured, its work
supervised, and a human in the loop for the decisions that matter. So every agent is **co-piloted**
— and that is why intentic is a full workspace, not a chat box. Two families of surfaces exist for
exactly this:

- the **IDE** surfaces — editor, file tree, diff review, terminal — where you *configure* an agent
  and read its work;
- the **observability** surfaces — the fleet board, plan mode, per-edit permission modes, changes
  review, transcripts — where you *watch and steer* the agents you run.

The shape of the product: you sign in with Google and run a sandbox on a machine you control (your
laptop, a VPS), reached by your browser over a private Cloudflare tunnel. Inside it, a coding agent
(Claude Code, Codex, or Grok) works your files and repos with human-in-the-loop approval. You grow
it with capabilities (GitHub, databases, Discord, Stripe, SSH, MCP servers…), wake it on
**automations**, and — on **Pro** — run a whole team of agents. The platform is architecturally a
thin identity store that *cannot* touch your code, secrets, or systems (`README.md`, `ARCHITECTURE.md`).

**Category**: specialized coding agents you own — cloud-grade agent UX and observability with
local-grade ownership.

**Business model**: bring your own model subscription + your own hardware + a flat platform fee —
never a meter on model usage. Free (1 sandbox) / Pro (unlimited sandboxes + team sharing), Stripe
billing (`_apps/api/src/billing/entitlements.ts`). The sandbox and CLI are MIT open source
(`LICENSE`, GitLab).

## Who it's for

**Primary — the professional dev adopting agents who won't hand over their code.**
Wants Devin/Cursor-agent-style autonomy but refuses to ship source, credentials, and prod access
into someone else's cloud sandbox. intentic's answer: the agent's sandbox runs on *their* machine;
the platform stores only identity + a URL and sits off the command path. Job to be done: *"When I
put an agent to work on my real systems, keep the code, secrets, and blast radius under my control,
so I can use full autonomy without betting the company on a vendor's security."*

**Primary — the operator running a team of specialized agents.** Wants more than one chat window: a
fleet of purpose-built agents (one per role or project), each with its own sandbox, context, and
capabilities, all configured once and supervised from a single fleet board (`_apps/web/src/pages/Agents.vue`).
Job to be done: *"Stand up an agent per job, wire it to the right systems, and steer the whole
workforce from one place."*

**Secondary — teams sharing an agent workspace (Pro).** Owner invites teammates by email; grants
are enforced by the sandbox daemon fail-closed; revoke/leave always work even after downgrade
(`_apps/api/src/invite/invites.ts`, `_apps/api/src/invite/invite.routes.ts`).

**Emerging — the automation operator.** Wants the agent on-call: wake on a Sentry alert, a Stripe
payment event, a GitHub push, a new email — with a guard command deciding whether each wake runs
(`_libs/api-contract/src/schemas.ts`).

## Pain → promise → proof

| # | Pain | Promise | Proof |
|---|------|---------|-------|
| P1 | Cloud AI dev environments want your code, secrets, and prod access on their servers | The agent's sandbox runs on your machine; the platform stores only identity + a sandbox URL, sits off the command path, and cannot reach your daemon | `README.md`, `ARCHITECTURE.md` |
| P2 | A generic chat box isn't an autonomous employee — no real tools, no persistent context, no way to supervise it on real work | A specialized agent: dev-tools really installed, wired to your systems, context curated for one job — configured and steered from a real workspace (IDE + observability), not a prompt window | `_apps/web/src/pages/workspace/`, `_apps/web/src/pages/Agents.vue`, `_libs/capability-catalog/src/index.ts` |
| P3 | Setting up a private agent environment is an evening of DevOps | Minutes to a live sandbox: Google sign-in → one copy-paste command. No Cloudflare account required; Docker auto-installed; no open inbound ports | `_apps/web/src/pages/Setup.vue` |
| P4 | Agent autonomy is scary on real systems — you can't just fire-and-forget | Co-piloting: plan mode by default ("Propose a plan and wait for your approval before running"), per-edit permission modes, a changes-review panel (diff → discard or commit), owner-approved environment changes, a transcript per run | `_apps/web/src/composables/chat/catalog.ts`, `_apps/web/src/pages/workspace/ReviewPanel.vue`, `_apps/web/src/pages/sandbox/EnvironmentCard.vue` |
| P5 | Wiring the agent to your tools (repos, DBs, chat, monitoring) is N one-off integrations | A capabilities catalog: GitHub/GitLab/Redmine, SQL databases, Sentry/SigNoz, Discord/IMAP, Stripe, SSH/VPN, custom MCP servers, Claude plugins — credentials stay inside the sandbox | `_libs/capability-catalog/src/index.ts` (CAPABILITY_CATALOG), `_apps/web/src/pages/Capabilities.vue` |
| P6 | The agent only works when you're at the keyboard | Automations: wake it on a schedule, a webhook, or live events (GitHub/GitLab push, Sentry alert, Stripe payments, new email, Discord), each run a fresh session with a transcript, optionally gated by a guard command | `_libs/api-contract/src/schemas.ts` (Automation schemas) |
| P7 | AI SaaS lock-in — models, data, exit | BYO agent (Claude Code, Codex, or Grok), your repos are plain git on your machine, GDPR export + account deletion, MIT sandbox + CLI on GitLab if you leave the app entirely | `_apps/web/src/composables/chat/conversation.ts`, `_apps/api/src/router.ts` (me.export), `LICENSE` |

## Selling points, ranked

1. **The whole environment is editable, not just the prompt** — everyone lets you tune a system
   prompt; intentic opens the image the dev-tools are installed in (owner-approved overlay), the
   systems the agent may reach (capabilities, with a "this will add to your sandbox" effects panel
   before you commit), and the context it loads each turn. You can't make the model smarter; you can
   make it better informed and better equipped. One workspace, two operators. (P2)
2. **Ownership without giving up the cloud UX** — the moat: the only agent workspace where the
   vendor is architecturally *unable* to read your code or drive your sandbox (identity-only hub,
   off the command path; secrets AES-256-GCM at rest with no decrypt path, `_apps/api/src/crypto.ts`). (P1)
3. **Co-piloted, not fire-and-forget** — AI still needs its context configured, its work
   supervised, and a human in the loop. The IDE surfaces (editor, files, diffs, terminal) and the
   observability surfaces (fleet board, plan mode, permission modes, changes review, transcripts)
   exist for exactly that. Trust is a UX feature, not a policy PDF. (P4)
4. **Minutes to a live workspace** — Google sign-in, one copy-paste command, no Cloudflare account,
   no open ports, workspace opens itself when the sandbox reports in. (P3)
5. **From one agent to a workforce** — capabilities wire agents to your systems; automations make
   them event-driven; Pro runs a whole team with daemon-enforced sharing and a fair free tier (1
   full sandbox, nothing crippled). (P5, P6)
6. **Economics that don't punish usage** — bring your own model subscription, run on your own
   hardware, pay a flat platform fee. Never a meter on model tokens. (P7)

## Competitive frame

**vs. cloud AI dev environments (Devin, Cursor background agents, Replit Agent, Copilot Workspace,
OpenHands cloud).** They run the agent on their infrastructure: your code, tokens, and often prod
credentials live in their sandbox. intentic keeps the agent on your machine with a cloud-grade
browser UX and observability on top; the hosted platform can't reach it. BYO model (Claude Code,
Codex, or Grok) instead of a house model. *Pick them when* you want zero local footprint and don't
handle sensitive systems.

**vs. plain local Claude Code / Codex CLI.** Same agents, but terminal-bound, single-machine,
single-player, un-supervised, and asleep when you are. intentic gives each agent a specialized
sandbox, a browser workspace from anywhere, the IDE + observability surfaces to configure and steer
it, capabilities with sandbox-contained credentials, automations that wake it on events, a fleet
board for a whole team, and team sharing. *Pick the bare CLI when* you live in one terminal and need
none of that — the sandbox and CLI are MIT and run standalone.

## Honest maturity (say it, don't hide it)

- The hosted app is new (launching at app.intentic.dev); the free tier is a real sandbox, not a demo.
- The sandbox and CLI that run on your machine are MIT and developed in the open on GitLab — read
  exactly what executes on your hardware before you trust it. Verify test counts at build time —
  never hardcode stale numbers.
- No testimonials yet — do not fabricate; lead with verifiable architecture and open source
  (see landing-blueprint.md).
