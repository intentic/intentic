# intentic — Positioning

Who intentic is for, the pains it removes, and why it wins. **The product being sold is
intentic-app** — the hosted workspace at app.intentic.dev: a persistent **sandbox** per co-piloted
**specialized agent**, on hardware you own, with any browser as a window onto it. The sandbox and
CLI those agents run on are MIT open source on GitHub
(`github.com/intentic/intentic`) — the trust layer you can read and run yourself. Every claim traces
to a file in the repo; if a claim has no path, it doesn't go on the site.

Companion docs: [messaging.md](messaging.md) (what we say), [landing-blueprint.md](landing-blueprint.md) (where we say it).

## What it is

**intentic gives your agents a machine of their own — it runs on hardware you own, and every
browser is a window onto it.** The agents live on your machine, not in a tab: close the laptop and
the runs keep going; open any browser — or a phone — and the same fleet is there, sorted by who
needs you. What lives on that machine is a **specialized agent** — an autonomous employee in a
purpose-built **sandbox** on hardware *you* own: its dev-tools really installed, wired to the
systems it may reach (**capabilities**), its context curated for one job, running on your own
Claude/Codex/Grok subscription. Run one, or ten in parallel.

"Window" is literal. The browser holds nothing a run depends on — closing every window loses
nothing — and you and the agent drive the same surfaces, by construction: one implementation of
what connecting a VPN means (the browser on `/vpn`, the agent on `/usr/local/bin/vpn` — the tunnel it
dials appears in your UI with nothing syncing the two), one `tmux` server behind your terminals and
its shell commands, one `iq` index behind `/workspace/search` and its Bash calls, and one tree — each
agent on its own git worktree, landing its delta into your Changes panel as the review boundary
(`_sandbox/sandbox/src/agents/worktrees.ts`, `land.ts`). A window opened anywhere shows the run as
it actually is, not a replay of it.

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
**automations**, and run a whole team of agents. The platform is architecturally a
thin identity store that *cannot* touch your code, secrets, or systems (`README.md`, `ARCHITECTURE.md`).

**Category**: the persistent agent sandbox you own — cloud-grade reach and observability with
local-grade ownership.

**Business model**: bring your own model subscription + your own hardware, and nothing to pay us —
never a meter on model usage. There are no tiers and no limits: every sandbox, capability and shared
workspace is included. The whole product is MIT open source (`LICENSE`, GitHub).

## Who it's for

**Primary — the professional dev adopting agents who won't hand over their code.**
Wants Devin/Cursor-agent-style autonomy but refuses to ship source, credentials, and prod access
into someone else's cloud sandbox. intentic's answer: the agent's sandbox runs on *their* machine;
the platform stores only identity + a URL and sits off the command path (bar the optional free trial, which
is labelled wherever it is offered). Job to be done: *"When I
put an agent to work on my real systems, keep the code, secrets, and blast radius under my control,
so I can use full autonomy without betting the company on a vendor's security."*

**Primary — the operator running a team of specialized agents.** Wants more than one chat window: a
fleet of purpose-built agents (one per role or project), each with its own sandbox, context, and
capabilities, all configured once and supervised from a single fleet board (`_editor/web/src/pages/Agents.vue`).
Job to be done: *"Stand up an agent per job, wire it to the right systems, and steer the whole
workforce from one place."*

**Secondary — teams sharing an agent workspace.** Owner invites teammates by email; grants
are enforced by the sandbox daemon fail-closed
(`_platform/api/src/invite/invites.ts`, `_platform/api/src/invite/invite.routes.ts`).

**Emerging — the automation operator.** Wants the agent on-call: wake on a Sentry alert, a Stripe
payment event, a GitHub push, a new email — with a guard command deciding whether each wake runs
(`_platform/api-contract/src/schemas.ts`).

## Pain → promise → proof

| # | Pain | Promise | Proof |
|---|------|---------|-------|
| P1 | Cloud AI dev environments want your code, secrets, and prod access on their servers | The agent's sandbox runs on your machine; the platform stores only identity + a sandbox URL, sits off the command path (except the optional, clearly-labelled free trial), and cannot reach your daemon | `README.md`, `ARCHITECTURE.md` |
| P2 | A generic chat box isn't an autonomous employee — no real tools, no persistent context, no way to supervise it on real work | A specialized agent: dev-tools really installed, wired to your systems, context curated for one job — configured and steered from a real workspace (IDE + observability), not a prompt window | `_editor/web/src/pages/workspace/`, `_editor/web/src/pages/Agents.vue`, `_platform/capability-catalog/src/index.ts` |
| P3 | Setting up a private agent environment is an evening of DevOps | Minutes to a live sandbox: Google sign-in → one copy-paste command. No Cloudflare account required; Docker auto-installed; no open inbound ports | `_editor/web/src/pages/Setup.vue` |
| P4 | Agent autonomy is scary on real systems — you can't just fire-and-forget | Co-piloting: every agent works in its own branch and lands nothing until you accept it — a changes-review panel (diff → discard or commit), per-edit permission modes (plan / accept edits / ask before edits, the default on the shared tree), owner-approved environment changes, a transcript per run | `_editor/web/src/composables/chat/catalog.ts`, `_editor/web/src/pages/workspace/ReviewPanel.vue`, `_editor/web/src/pages/sandbox/EnvironmentCard.vue` |
| P5 | Wiring the agent to your tools (repos, DBs, chat, monitoring) is N one-off integrations | A capabilities catalog: GitHub/GitLab/Redmine, SQL databases, Sentry/SigNoz, Discord/IMAP, Stripe, SSH/VPN, custom MCP servers, Claude plugins — credentials stay inside the sandbox | `_platform/capability-catalog/src/index.ts` (CAPABILITY_CATALOG), `_editor/web/src/pages/Capabilities.vue` |
| P6 | The agent only works while you sit there — close the laptop and the session dies with the tab | The runs live on your machine, not in the browser: close every window and the agents keep working; reopen from any device onto the same board. Automations go further and start them without you — a schedule, a webhook, or live events (GitHub/GitLab push, Sentry alert, Stripe payments, new email, Discord), each run a fresh session with a transcript, optionally gated by a guard command | `_sandbox/sandbox/src/agent/`, `_platform/api-contract/src/schemas.ts` (Automation schemas) |
| P7 | AI SaaS lock-in — models, data, exit | BYO agent (Claude Code, Codex, or Grok), your repos are plain git on your machine, GDPR export + account deletion, MIT sandbox + CLI on GitHub if you leave the app entirely | `_editor/web/src/composables/chat/conversation.ts`, `_platform/api/src/router.ts` (me.export), `LICENSE` |

## Selling points, ranked

Ranked for the **landing page**, which gets one claim and about five arguments. The order changed on
2026-08-02: #1 and #3 used to lead, and the site spent four bands on them. They are reasons to believe
— true, and only legible to a reader already inside the agent-tooling debate. Re-centered 2026-08-07:
#1 now carries persistence and reach — the machine-of-their-own claim — after the brand line moved off the IDE
frame (see messaging.md's retired-framing list). What is both unique and picturable in one read is #1
below, so that is what the page now claims and proves; the rest support it or live on `/features/*`,
`/docs/*` and `/compare/`. See
[landing-blueprint.md](landing-blueprint.md#core-thesis-the-spine) for the whole rationale.

1. **A persistent fleet on hardware you own — still running when you look away, nothing landing
   unread** — one sandbox and one git worktree per agent, run ten at once; the runs live on your
   machine, not in the tab, so any browser or phone reopens onto the same board; and the review
   boundary is a real branch: land it into your tree or discard it
   (`_sandbox/sandbox/src/agents/worktrees.ts`, `land.ts`, `_editor/web/src/pages/Agents.vue`).
   Local orchestrators share the ownership instinct; none of them pair it with the persistence, the
   reach and the environment below. (P1, P2, P4, P6)
2. **Ownership without giving up the cloud UX** — the moat: the only agent workspace where the
   vendor is architecturally *unable* to read your code or drive your sandbox (identity-only hub,
   off the command path; secrets AES-256-GCM at rest with no decrypt path, `_platform/api/src/crypto.ts`). (P1)
3. **The whole environment is editable, not just the prompt** — everyone lets you tune a system
   prompt; intentic opens the image the dev-tools are installed in (owner-approved overlay), the
   systems the agent may reach (capabilities, with a "this will add to your sandbox" effects panel
   before you commit), and the context it loads each turn. You can't make the model smarter; you can
   make it better informed and better equipped. One workspace, two operators. (P2)
4. **Co-piloted, not fire-and-forget** — AI still needs its context configured, its work
   supervised, and a human in the loop. The IDE surfaces (editor, files, diffs, terminal) and the
   observability surfaces (fleet board, plan mode, permission modes, changes review, transcripts)
   exist for exactly that. Trust is a UX feature, not a policy PDF. (P4)
5. **Economics that don't punish usage** — bring your own model subscription, run on your own
   hardware, pay us nothing. Never a meter on model tokens. It earns its band because "ten agents"
   triggers "that must cost a fortune". (P7)
6. **Minutes to a live workspace** — Google sign-in, one copy-paste command, no Cloudflare account,
   no open ports, workspace opens itself when the sandbox reports in. (P3)
7. **A lean core plus extensions** — automations, Discord/Slack, IMAP, memory, pipelines, previews and
   the Front Desk webchat are things you bolt on, not what the product is (`_extensions/README.md`, the
   VSCode bet). This is genuinely a selling point *and* the thing that blurred the site when it was
   sold band by band; on the landing page it is one quiet index with links out. (P5, P6)

## Competitive frame

The public form of this section is the **comparison shelf** — `/compare/`, authored in
`_site/site-content/src/compare.ts` and rendered by `_site/site/src/pages/compare/`. This section is its
source of truth; changing a position here means changing that file in the same commit.

**The reframe that makes the shelf work: most of the named tools are not competitors.** Four out of five
times someone asks "how does intentic compare to X", X is something intentic *runs* or something they *keep*.
Saying so plainly is both truer and more persuasive than a scorecard, and it is why the shelf leads with the
taxonomy rather than with us. The field sorts into five families on two questions — *whose machine does the
agent run on* and *how much of the agent's environment can you change* (the same two the landing `#contrast`
band argues).

| Family | Examples | The verdict | Why |
|---|---|---|---|
| **Agent CLIs** | Claude Code, Codex, Grok, Kimi Code, Gemini CLI, OpenCode, Goose, Qwen Code | *intentic runs these* | A harness is the engine, not the garage. Five are native (`_sandbox/sandbox-contract/src/agent-catalog.ts`); any ACP agent is one capability away (`_platform/capability-catalog/src/index.ts` — `opencode-acp`, `gemini-acp`, `acp-agent`). |
| **AI editors** | Cursor, Windsurf, VS Code + Copilot, Zed, JetBrains AI | *keep yours* | Different primary operator: they put the human at the keyboard. Composes for real via desktop sync (`_sandbox/sync/`) and `@intentic/acp-bridge`, not diplomatically. |
| **Personal AI assistants** | OpenClaw, Hermes, Khoj, Leon | *a different job* | Self-hosted on your hardware and your accounts — the same conviction — but pointed at a life rather than a repository. The unit of work is a reply, not a diff. Composes: an assistant that can call a webhook can start an agent here. |
| **Local orchestrators** | Conductor, Nimbalyst, Crystal, Vibe Kanban, Sculptor | *same instinct, wider scope* | The closest neighbours; they got ownership right. The gap is everything around the agent: the image (overlay Dockerfile), capabilities, automations, browser/phone reach, team sharing. |
| **Cloud agent platforms** | Devin, Cursor cloud agents, Codex cloud, Claude Code on the web, Jules, Replit Agent | *the opposite trade* | The only genuine either/or, and it is P1: whose computer holds your source and your service credentials. |

Rules that keep the shelf credible — it is the easiest page on the site to turn into slop:

- **Every page carries a `pickThem`** — a real, usable case for the other product, in the last position and
  at full weight. If that section is soft the whole page reads as marketing and everything above it stops
  counting.
- **Every table carries rows marked `theirs`**, and the caption counts them ("4 of these 11 rows go to
  Nimbalyst"). A table with no losing rows is one nobody believes. Nimbalyst's visual editors, Conductor's
  native Mac app and cloud workspaces, Cursor's inline editing, OpenCode's 75+ providers, a cloud platform's
  zero setup and elastic capacity — these are real and they are on the page.
- **Quote them, and link them.** `theirPitch` is close to their own words; `url` is their site with
  `rel="nofollow"` so a reader can check. Nothing goes on a page that isn't on the vendor's public site today.
- **No prices, either side.** Ours are a recorded no (landing-blueprint.md); theirs rot within a quarter.
- **Invite the correction.** Both the hub and every page link to the issue tracker for inaccuracies. A
  comparison page that asks to be contradicted is the only kind worth trusting — and it is the same posture
  as MIT-on-GitHub.

## Honest maturity (say it, don't hide it)

- The hosted app is new (launching at app.intentic.dev); it is free, and a real sandbox rather than a demo.
- The sandbox and CLI that run on your machine are MIT and developed in the open on GitHub — read
  exactly what executes on your hardware before you trust it. Verify test counts at build time —
  never hardcode stale numbers.
- No testimonials yet — do not fabricate; lead with verifiable architecture and open source
  (see landing-blueprint.md).

## The trust posture

This product asks for more trust than a SaaS signup does: the visitor runs a container on their own
hardware and hands it a GitHub token, a database password and write access to a repo. So "who are
you?" is a real objection on the path to the CTA, and the answer is **verifiability, not popularity**
— the landing page's `#trust` band and `/about/`, authored in `_site/site-content/src/about.ts`.

Four legs, and the fourth is what makes the first three land:

1. **A named, checkable person** — Artur Kurowski, with GitHub, LinkedIn and radarsu.com as real
   outbound `rel="me"` links and as `sameAs` on the Person schema. An anonymous "our team" reads worse
   than a solo founder, not better.
2. **Code you can read before you run it** — MIT on GitHub, the parts that touch your machine.
3. **The dogfooding proof, which nobody else has** — most of this repository's commits are authored by
   `agent@intentic.dev`, in public. It is a trust signal *and* a proof of the core claim: the fleet on
   the page shipped the page. Counted from git at build time (`gitStats()`), never authored.
4. **The admission** — weeks old, no case studies, no testimonials. A trust section that concedes
   nothing reads as marketing and takes the other three down with it.

Hard nos, for the same reason the comparison shelf has hard nos: no logo wall, no testimonial slot, no
"trusted by N developers", and **no metric that could render as zero or one**. An empty counter costs
more trust than it buys.
