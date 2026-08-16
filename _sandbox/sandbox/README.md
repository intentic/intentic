# @intentic/sandbox

The **per-project AI-agent dev daemon** — a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own tunnel (Google-backed renewable sessions): run provider-native agent turns over the project's repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

The daemon runs in one of two **profiles** ([src/platform/profile.ts](src/platform/profile.ts)). `container`
(the default) is everything above. `local` is the same daemon as a plain process on the user's own machine,
serving a folder they already own — for host applications (an editor extension, a CLI) that embed the product
without a sandbox. Local means: loopback only and refuses any env that says otherwise (the fail-closed floor
beside the auth floor), no auth (the person at the keyboard is the owner), HOME never claimed or converged,
repos never reshaped (no separate git dirs, no gitlink surgery — a `.gitmodules`-declared submodule is spared
in *both* profiles), no unasked-for writes to the user's folder (no skill/seed/shelf convergence; the state
dir is appended to the repo's own `info/exclude` instead), and no container furniture (tmux sweeps, preview
proxy, TLS loopback listener, dockerd, CI hooks, probes, automations scheduler, drafts publisher, extension
processes, image-update checks). What stays on is the product the host embeds: agent turns, the fleet with
per-agent worktrees and review/land, accounts and usage, the guard, watchers, search, resume. `/health`
reports the profile.

## Responsibilities

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/inventory`, `/info`, `/preview`, `/health`); the browser calls it directly over the sandbox's tunnel, each request authenticated by a daemon session minted from verified Google identity (`/health` carved out for liveness).
- Run one Claude Code, Codex app-server, OpenCode, ACP, or Pi turn over the workspace, normalizing each runtime's
  native stream into typed `AgentEvent`s and serving them as SSE `data:` frames.
- Follow the agents a turn starts. Every child — an Agent-tool subagent, a delegated `codex exec` or `opencode
  run` — is a record on one roster (src/agent/subagents.ts), and the delegates report their OWN state into it: a
  daemon-authored codex hook drops event files into a signal spool (src/codex/codex-config.ts →
  src/agent/delegation-signals.ts), and a delegated OpenCode session runs attached to the warm server whose
  event stream the daemon already reads (src/grok/opencode.ts). Each is stamped with the tool call that started
  it — codex through the pane environment, opencode through its session title — so a signal names its own record
  rather than being matched by timing. That is what gives a child a real session id, a `blocked` status, and its
  own last words as its report — and what the turn's `wait` tool parks on (src/agent/subagent-wait.ts): sleep
  until one of this turn's own children needs input or finishes, instead of polling a terminal tail.
- Outwait the world on the agent's behalf. For a condition OUTSIDE the harness — a CI run, a deploy, a remote
  queue — the agent arms a condition watch (src/agent/watch-server.ts): a check command that exits 0 when the
  thing has happened. The daemon polls it between turns (src/agent/watchers.ts) and wakes the arming
  conversation exactly once — on the check passing or on the deadline, whichever first, with the check's own
  output — so the agent writes no sleep loop and holds no turn open. The CLI's own scheduling tools
  (ScheduleWakeup, the Cron family) are disallowed on every turn: they live in a process that dies with the
  turn, so they accept schedules that can never fire.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Turn the composer's voice into text without the audio leaving the box: the browser records and segments
  utterances itself and posts each one's WAV to `/speech/transcribe`, where whisper.cpp answers
  (src/speech/transcribe.ts — the `whisper` feature pack, baked into standard images; the model downloads into
  the workspace volume on first use, shared with Discord voice).
- Manage the app dev server and report preview status — including what is ACTUALLY answering inside the box: each
  listening port with the process that took it and the terminal that process descends from, whoever started it.
- Keep the tree true after lands: reinstall drifted dependencies, run the project's own checks, and announce the
  edges (`deps.broken`/`deps.fixed`) that wake a fix chore the owner picked from the Automations templates — every
  step in a visible terminal panel and the activity feed (src/workspace/reconcile-deps.ts → verify-deps.ts →
  src/automations).
- Hold outbound posts as an approval queue: the agent proposes drafts as files (`.intentic/drafts/`, src/drafts),
  the owner approves them on the Drafts page, and the daemon itself sends each one the moment it comes due —
  sleeping on one timer until then rather than sweeping, since it is the process that wrote the deadline. A
  platform with a real API goes out as an authenticated request; one that is only a logged-in browser goes out
  as an agent turn, pinned to the persona the draft NAMES (`actsAs`). That pin is the difference between a post
  and a failure: an unattended turn that names no persona is denied every account, so a browser-published draft
  without one is failed unsent rather than handed to a turn that cannot reach the login.
- Gate what runs without the owner, in two layers that share one decision seam (src/guard). Before a session
  starts: every outside-driven wake (automations, listeners, the Doorbell, the workflow release gate) is
  allowed, held for approval, or refused. Inside a session already running: classified outbound provider calls
  are checked against the owner's action rules, and shell commands whose class the owner holds — destructive
  git, recursive deletes, credential reads, publishes, outbound fetches — park on a permission card before they
  execute. Both in-turn gates are PreToolUse hooks, which is what makes them hold in the autonomous posture
  where the permission cards are never raised at all.
- Tell the agent which words are not the owner's, and act on it (src/guard/outside-content.ts). Everything that
  arrives from outside the workspace — a stranger's listener or Doorbell message, a fetched page, a foreign MCP
  server's answer, the output of a shell command that reached the internet — is wrapped in an
  `<untrusted-content>` envelope whose id is minted per wrap, so content can never close its own envelope and
  speak in the owner's voice after it. Marker lookalikes (including fullwidth, CJK and zero-width spellings),
  the harness's own control tags, and foreign models' reserved tokens are neutralized inside the body. The
  system prompt states the language once rather than repeating a warning per wrap. Wrapping also sets the
  turn's outside-content bit, and while it is set a credential read the owner has not explicitly ruled on stops
  being auto-allowed — which is the middle link of the chain (outside text → read a credential → send it out)
  and the only one a policy can stand in.
- Let the agent USE a stored secret without ever holding it (src/secrets). Every credential the sandbox stores
  — a connector's token, the DevOps `.env`, the deploy engine's generated values — is masked out of everything
  the agent reads as a stable `{{secret:name}}` reference rather than a blank, and the same token resolves back
  to the real value only at the exits: spliced into a shell command as it runs (a Komodo config payload, a curl
  body) or typed into a focused browser field (`type_secret`). Files at rest keep the reference; every
  resolution lands on a use ledger the Secrets view shows as each entry's "last used".
- Run the agent's JavaScript, not only its shell (src/execution). The JS execution backend is the second way a
  turn runs work of its own — declared per runtime (`AgentCapabilities.execution`), granted per persona card
  beside the shell switch, planned into the one request every runtime builds on, and served on the Claude Code
  loop as the `Code` tool. The model writes an ES module instead of a grep/curl pipeline; the daemon runs it
  in a Node subprocess under Node's permission model, which is what makes this fence real where the shell's is
  advisory: reads and writes are granted per directory from the card's files answer and folder scope, and
  starting other programs is granted only when the card also holds the shell — so "code yes, commands no" is a
  posture that actually holds. Scripts ride the same seams commands do: the command gate classifies them
  against the owner's rulebook, `{{secret:name}}` resolves on the way into the process and lands on the use
  ledger's code lane, results are masked, and a script that fetched the open internet has its output wrapped
  as outside content exactly as a fetching curl's is. The one stated gap: the fence cannot cut the network.
- Decide who a session IS, what it may do and what it is TOLD, once per turn and above the choice of runtime
  (src/personas). A persona card names the connected accounts a session may speak through, which shelves of its
  toolbox are open — files, shell, code runs, web, browser, connectors, computers, MCP connections, delegation,
  changing the sandbox — where in the workspace it works, and which system prompt it runs on. Accounts, connectors,
  computers and MCP connections are enforced by ABSENCE: the credential is never injected and the server never
  mounted, so nothing depends on the model cooperating. The plain switches take their tools out of the turn,
  and the folder limit refuses file tool calls that point outside. Naming no persona keeps the full toolbox and
  reaches no logged-in account; naming one that does not exist gets neither.
- Give one persona its own prompt, skills and tools (src/personas/persona-kit.ts). Each card may carry a kit
  folder beside it, laid out as a Claude Code plugin — `PROMPT.md`, `skills/`, `agents/`, `.mcp.json` — so the
  runtime's own loader reads it on the turns wearing that card and no others, with nothing copied into the
  workspace and nothing to sweep back out when the persona changes. The card stores only which base it runs on;
  a card that says nothing follows the sandbox, which is what almost every card means.
- Tell every runtime what the owner wrote, and say plainly which ones cannot hear all of it. The system-prompt
  setting used to be composed inside the Claude Code arm, so a turn on native Codex, Grok, Gemini, Pi or an ACP
  agent ran without it — and without the persona note — while nothing on screen was wrong. What each runtime
  will accept is a declared axis now (`AgentCapabilities.instructions`) and src/agent/system-prompt.ts composes
  to it: a replacement where one may be sent (the Claude Code loop; native Codex, through
  `model_instructions_file` and `developer_instructions`), an addition where only that is possible (OpenCode's
  per-message `system`), and the user-message door for the persona note where there is no system seam at all.
- Say what the agent actually KNOWS, and own the half of it the owner wrote (src/settings/skill-inventory.ts).
  Skills reach the agent from six directions — this image's baked tools, the owner's own, the cheatsheet every
  connection writes, an installed extension's checkout, a plugin capability's clone, and whatever is simply
  sitting in the loaded folder — and nothing joined them, so "what is my agent carrying" had no answer. The
  inventory reads all six off disk and reports where each came from, which is what decides whether a row may be
  switched, rewritten or deleted at all: a control the source would undo on the next reconcile is not offered.
  The owner's own skills are stored APART from the folder the agents read (`.intentic/skills/`, reconciled into
  `.agents/skills/` by src/settings/skills.ts) so that switching one off keeps what they wrote — in the loaded
  folder, "off" and "deleted" would be the same operation. The loaded folder is the vendor-neutral one on
  purpose (src/settings/loaded-skills.ts): Codex and Gemini read `.agents/skills/` natively, Claude Code reads
  it through per-skill symlinks under `.claude/skills/`, and runtimes with no skill loader get a managed index
  block in AGENTS.md naming each skill, its description, and its file.
- Schedule workflow graphs daemon-side. A run snapshots every repository HEAD once, creates every fresh step
  from those exact commits, holds candidate branches instead of auto-landing them, and resumes workflow-owned
  loops through one coordinated restart path. At most four workflow graphs execute across a sandbox at once.
- Hold up the daemon's end of the creator pool — with NO usage telemetry, by design. Installing (or updating)
  a `tier: "premium"` extension donates the owner's credits to its publisher through the platform
  (src/platform/pool-donate.ts — the donation IS the premium gate, keyed on the checkout's own manifest
  identity, refused installs leave no debris); enabling one re-checks the membership (src/platform/pool-status.ts);
  nothing about what runs on this machine is ever reported. Metered service runs relay through
  src/platform/pool-services.ts: the daemon adds the connect token — the member gate, the credit meter and
  the refund discipline are the platform's. A run's answer is the platform's NDJSON stream (the contract's
  ServiceStreamEvent vocabulary plus its own receipt trailer), which the relay forks: provider `status`
  lines surface live, the buffered `result` is what the caller is answered with. The AGENT's own run is
  additionally parked on an owner-approval card in the chat before anything is forwarded
  (src/platform/service-offer.ts): every number on the card is the platform's catalog answer, the owner's
  click is the only thing that releases the spend, and one click covers one run — consent is plumbing, not
  the skill's etiquette. While the approved run streams, its status lines land under that card as
  service_event frames, and the receipt frame is the platform's trailer verbatim. The agent reaches the
  priced catalog through the `services` CLI (bin/services + the baked services skill), scoped by the agent
  token's grant; an extension backend's runs pass straight through the gate, because which services it may
  spend the owner's credits on is a `permissions.daemon` glob approved at install.
- Let an agent ask the owner, in chat, to connect a capability the task is missing — the same consent shape
  as the spend gate, pointed at setup instead of money (src/capabilities/capability-offer.ts). The agent's
  `capabilities request` (bin/capabilities + the baked capabilities skill) parks on a card titled with the
  catalog's own words (the daemon validates the ask against src/capabilities/connectable.ts — the static
  catalog merged with contributed cards); a yes keeps the call parked while the daemon watches the manifest
  for the connection to come live, so the agent resumes in the same turn with the capability usable; a no is
  remembered for the conversation so a repeat ask never raises a second card. The model contributes one line
  of why and can connect nothing itself.

## Key files

- [src/app.ts](src/app.ts) — the Hono HTTP API: every route the browser and the CLI reach the daemon through.
- [src/agent](src/agent) — **singular**: one conversation. The turn loop, its tools, steering, terminals and diagnostics.
- [src/agents](src/agents) — **plural**: the fleet. The registry, `worktrees.ts`, `isolation.ts`, `land.ts`, `origins.ts`, `landed-presence.ts`.
- [src/git/git.routes.ts](src/git/git.routes.ts) — status/commit/push over the wire; [src/workspace](src/workspace) — the repo layout the daemon serves. [src/workspace/workspace-scope.ts](src/workspace/workspace-scope.ts) decides WHOSE copy a file read means: the shared `/work` tree, or one conversation's own checkout when the request names it (`?agent=`). Reads only — no write route can name a checkout — and a request naming one that was archived away says so specifically instead of reporting a missing file.
- [src/composition.ts](src/composition.ts) — what is wired to what; [src/main.ts](src/main.ts) — the entrypoint that builds it and serves.
- [src/extensions/extension-updates.ts](src/extensions/extension-updates.ts) — the update lifecycle for git-installed
  extensions: the periodic registry comparison (update badges, blocked-listing advisories that pull the switch), the
  official-registry admission check (an unaudited sha never becomes an install or update offer),
  staged powers-diff preview, the apply/revert transactions over the handler's quiesce-and-swap (the outgoing checkout
  is kept one version back), the post-update health watch, and the owner's per-extension policy (notify / agent-prepared
  / auto). Nothing auto-updates by default; the auto rung is opt-in and gated on a verified listing whose powers didn't
  grow, health-watched with auto-revert.
- The two things that keep a busy sandbox from eating itself, both keyed on the fact that a child inherits from
  its parent without anyone propagating anything:
  [src/platform/workload-priority.ts](src/platform/workload-priority.ts) renices every direct child so the
  control plane outranks the work it started, and
  [src/platform/reaper.ts](src/platform/reaper.ts) reclaims everything a STOPPED conversation still holds, on
  one clock — how long since its turn settled. The provider CLI's MCP servers and headless browsers (three
  levels down, nothing here holds a handle on them) carry the conversation's stamp
  ([src/platform/leftovers.ts](src/platform/leftovers.ts)) and go a couple of minutes after the stop; the
  conversation's `agent-*` tmux sessions — live panes included, so a left-behind dev server no longer outlives
  its turn by days — go minutes later unless somebody is attached; its browser records close; and the temp
  state turns mint (tmux-run capture dirs, land/classify patch dirs, delegation signals) is swept by prefix and
  age. Archive and discard are the hard stop: their press reaps the conversation on the spot. WHICH of those
  processes are this daemon's at all is the PROCESS GROUP for everything it forked itself — a container can
  hold two daemons, a second one is in the group of the shell that started it, and a sweep enumerates its own
  group and never learns the other's processes exist — plus, for pane trees the tmux server forked, the
  registry: a stamped survivor is reclaimed only when its owner is a conversation this daemon's own roster
  knows. The group check is deliberately not one the sweep can get wrong: twice on 2026-08-11 a source run of
  this daemon read the live one's processes as a dead life's leavings and killed four agent turns mid-answer,
  and no amount of care in this file would have helped, because the file doing the killing was a checkout from
  a branch that predated the care.
- [src/platform/container-owner.ts](src/platform/container-owner.ts) — which daemon this one is. This repository
  is the sandbox, so an agent working in it runs the daemon from source to watch a change work, and everything
  held once per container (HOME, the tmux server, the process sweep, the translator, the platform registration,
  the scheduler, the drafts publisher, the CI hooks) is claimed rather than assumed. A daemon that finds a live
  claim — or finds `INTENTIC_AGENT_SESSION` on itself, the badge
  [src/agent/agent-terminals.ts](src/agent/agent-terminals.ts) puts on every command a conversation runs, which
  everything forked from one inherits — comes up a GUEST: it serves its own routes, converges only roots nobody
  else holds, and sweeps nothing. Two incidents wrote this: 2026-07-31, where a dev run took the live sandbox's
  git access down, and 2026-08-11, where one killed four agent turns mid-answer and did it again 26 minutes
  later from roots that were safely under `/tmp`.
- The four change feeds that keep the browser fresh without it ever asking twice, all riding the one `/events`
  stream: [src/workspace/workspace-watch.ts](src/workspace/workspace-watch.ts) (files),
  [src/workspace/repo-watch.ts](src/workspace/repo-watch.ts) (the repo set),
  [src/git/ref-watch.ts](src/git/ref-watch.ts) (refs), and
  [src/system/runtime-watch.ts](src/system/runtime-watch.ts) — everything that is RUNNING rather than written:
  tmux sessions, panel dev servers, listening sockets, the agent's browsers and its subagents. The first three
  start from a file; the fourth cannot, which is why it is half announcements from the subsystems that do the
  thing and half one shared sampler that runs only while a browser is connected.
- [src/hosts](src/hosts) — the user's own computers: the socket each one holds open, the Computers view's data
  (`machine-reports.ts`), and `host-seed.ts` — the card the setup flow creates for the machine that installed
  this sandbox, granted its sandboxes and nothing else. Acting on one of those sandboxes STREAMS, because the
  slowest of those actions pulls an image for minutes; the scope behind it is checked on the machine and never
  here.
- [src/guard/guard.ts](src/guard/guard.ts) — the one gate every gated action consults (fail-closed); [src/guard/actions.ts](src/guard/actions.ts) is the catalog of decisions, and [src/guard/command-gate.ts](src/guard/command-gate.ts) is the one that can park a running turn on a card.
- [src/guard/outside-content.ts](src/guard/outside-content.ts) — the envelope around anything the owner did not
  write, and the neutralizer that keeps content from forging one. Two seams apply it: a stranger's message at
  turn birth (src/automations/scheduler.ts) and everything the agent pulls in mid-turn
  ([src/guard/outside-results.ts](src/guard/outside-results.ts), which wraps every MCP server except the
  daemon's own control servers — an exception list a conformance test pins, so a server added without a
  decision fails the suite). [src/guard/turn-taint.ts](src/guard/turn-taint.ts) is the one-way bit the wrapping
  sets and the command gate reads.
- [src/browser/session-store.ts](src/browser/session-store.ts) — whose browser an account lives in. An
  IDENTITY (one email address, a capability of its own) owns one persisted Chromium profile; the platform
  accounts born from it share that browser — which is what makes a site's "Continue with Google" one click —
  while a hand-connected account keeps its own. A turn's account browsers exist ONLY once a tool call arrives
  for one: the harness handshakes every configured server at startup, so what it spawns per account is a ~1 MB
  socat bridge into a per-turn mux ([bin/browser-mux.mjs](bin/browser-mux.mjs), launched by
  [src/browser/browser-tools.ts](src/browser/browser-tools.ts)) that answers the handshake and the tool list
  from a version-keyed schema cache — before this, every turn started one node+playwright process per connected
  account, ~3.5 GB a turn for browsers mostly never touched. The owner signs the email provider in themselves in a live
  window (`browser-profile.ts`); the agent connects accounts through
  [src/browser/accounts-tools.ts](src/browser/accounts-tools.ts) — stored credentials are typed for it, never
  shown to it; a linked mailbox answers "the newest code from this site" and nothing more
  (`email-codes.ts`); opening a NEW account is gated on the identity card's own switch
  ([src/capabilities/open-account.ts](src/capabilities/open-account.ts)); and anything only a person can clear
  parks on a help request the owner answers over the live view.
- [src/secrets/secret-registry.ts](src/secrets/secret-registry.ts) — every stored credential under its stable
  name, and the `{{secret:name}}` reference language built on it: masking rewrites values to references in
  every tool result ([src/agent/agent-redaction.ts](src/agent/agent-redaction.ts)) and in the terminal lane
  (`bin/cleaners.mjs`), and the two exits resolve them back — the shell rewrite inside the tmux wrapper
  ([src/agent/agent-secrets.ts](src/agent/agent-secrets.ts)) and the browser's `type_secret`
  ([src/browser/secrets-tools.ts](src/browser/secrets-tools.ts)) — each use landing on the ledger
  (`src/secrets/secret-uses.ts`) the inventory joins as "last used".
- [src/personas/personas.ts](src/personas/personas.ts) — who a turn is and what it may do, resolved in one
  function whose header carries the reasoning for why accounts default to nothing and powers default to
  everything. Identities count as accounts there — an unattended wake that names no persona loses them first. [src/personas/persona-scope.ts](src/personas/persona-scope.ts) is the folder limit and the
  "change the sandbox" switch as a PreToolUse hook — a refusal, honestly weaker than the container, and the
  card's own UI says so where it is set. Nothing is seeded: a fresh workspace has no personas, and
  [src/personas/front-desk.ts](src/personas/front-desk.ts) is the one card the daemon writes by itself — the
  read-only front desk a public web chat answers through, created when a Doorbell is saved rather than at boot.
  [src/personas/persona-kit.ts](src/personas/persona-kit.ts) is the folder beside each card, shaped as a plugin
  so the runtime's own loader reads that persona's prompt, skills and tools and this daemon parses none of it.
- [src/agent/system-prompt.ts](src/agent/system-prompt.ts) — what the model is told before the conversation
  starts, composed once per turn for whichever runtime is about to serve it. Its header carries the split that
  makes the setting honest: which guidance is a fact about the WORKSPACE (the reference shelf, the public
  outbox) and therefore travels to every runtime, and which names a mechanism only the Claude Code loop wires
  (the question and plan cards, the checklist tools, the secret references, the outside-content envelopes, the
  browser servers). [src/codex/codex-instructions.ts](src/codex/codex-instructions.ts) is the Codex half — two
  undocumented config keys, verified by reading what reached the wire.
- [src/auth/role-floor.ts](src/auth/role-floor.ts) — the minimum trust tier per route, in one table. [src/auth/auth.ts](src/auth/auth.ts) resolves who a caller is (owner TOFU, members with granted roles); the floor decides what that tier reaches.
- [src/workflows](src/workflows) — workflow scheduling, immutable run snapshots, restart recovery, run-ledger
  retention, and complete handoff artifacts; [src/loops](src/loops) drives each individual step.

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own tunnel; the daemon verifies Google identity when establishing a renewable session, resolves the selected provider's credential from its **own** stored accounts, and starts that provider's runtime per turn. The platform is never on this path and never contacts the sandbox — it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

Native Codex turns use `codex app-server --stdio`. A subscription turn gives app-server a custom Responses
provider aimed at the bundled CLIProxyAPI translator; the translator authenticates upstream with the owner's
connected ChatGPT account, so image generation consumes that subscription rather than an `OPENAI_API_KEY`.
Generated PNGs are copied out of Codex's provider state into `.intentic/artifacts/imagegen/`; only the durable
workspace-relative path enters the event stream and transcript. The `@openai/codex-sdk` dependency remains the
exact CLI-version anchor and the locator for a vendored development fallback, not the native turn transport.

## Conventions & gotchas

- Workspace-root daemon state has a lifecycle taxonomy: provider homes are secret under `.intentic/auth/`,
  resumable Claude state is carried under `.intentic/sessions/claude/`, rebuildable caches (the iq index, the
  whisper model) are under `.intentic/cache/`, durable attachments/browser captures/generated images/run
  evidence/workflow reports are under `.intentic/artifacts/`, extension scratch is derived under
  `.intentic/runtime/`, and agent scratch is derived under `.intentic/tmp/`. Small owner-edited manifests remain
  directly under `.intentic/` so their stable paths stay readable. A janitor
  (src/workspace/state-janitor.ts) collects what the classes call disposable: tmp/ at boot, retired derived
  roots, unreferenced pnpm-store blobs, browser captures past thirty days.
- The Claude credential lives in the sandbox's own `.intentic/auth/claude/` store (connected via the daemon's
  `/claude/*` flow), resolved + injected into the SDK per turn — never held by the platform. The generic file API
  protects the whole `auth/` parent, provider-native `sessions/`, and logged-in `browser/` profiles; purpose-built
  routes expose only the safe slices those stores need.
- The daemon authenticates every request itself (a Google ID token only at exchange, then a daemon-minted session verified per request), since it is reached directly over its public tunnel — it owns its own auth. Access is tiered: the owner binds on first sign-in, and every invited member holds a granted role (viewer / collaborator / maintainer) stored in `.intentic/members.json`. The bearer middleware holds each request to its route's floor (`src/auth/role-floor.ts`): viewers read, collaborators drive agents (their lands become requests on the agent card), maintainers ship and get the terminal, and credentials-adjacent surfaces stay owner-only. Rotating sessions or changing a member's grant closes that identity's live event, terminal, and browser transports and invalidates unused connection tickets. Account deletion retires browser authorization at the daemon before the platform record disappears; if the daemon cannot be reached, deletion stops and names the sandbox that still needs attention. The platform only mirrors the grants; this daemon is the enforcer.
- Resource diagnostics survive the container. Once a minute `src/platform/resource-metrics.ts` appends one JSON
  object to `/history/logs/resource-metrics.jsonl`: daemon heap/native memory, GC and event-loop windows, cgroup
  pressure, process memory/CPU grouped by workload role, and cardinalities for the resident transcript, turn,
  browser, performance, and IQ owners. It is readable directly from a later sandbox shell (for example,
  `tail -n 20 /history/logs/resource-metrics.jsonl | jq .`) and through the existing authenticated
  `GET /logs/file?name=resource-metrics.jsonl&bytes=1000000` route. The normal logs retention applies: files are
  tail-truncated after 5 MB, expire after 30 days, and participate in the 100-file cap.
- Built on Hono, zod, and provider-native runtimes. Claude uses the Agent SDK; Codex uses app-server, whose
  runner seam is injectable so co-located tests run without a provider process or network.
- There is more than one workspace, and a path alone does not say which. Every isolated conversation has its own checkout, so the same path names a different file in each — which is why the workspace read routes take an optional conversation and resolve the root in one place (`src/workspace/workspace-scope.ts`). A checkout is **not** a superset of `/work` (the mirrored dirs are bare mount points from outside the turn's namespace, and untracked workspace content was never in it), so a scoped read falls back to the shared tree and reports which one answered. Search is the stated exception: the iq index is built over `/work` and stays there.
- A land's product is **uncommitted** — it patches the main working tree and moves no commit. So every reading taken between two shas (`standing.ts`) is blind to the user discarding it afterwards; `landed-presence.ts` is the one that asks the working tree, and it is what keeps a card from claiming work is in a workspace that no longer holds it.
- Workflow run artifacts are shared state under `.intentic/workflow-runs/`. The JSON ledger retains every active
  run plus 50 ended runs and removes a run's artifacts when that record is evicted or forgotten.
- **The hosted flavor** (`SANDBOX_VM=1`) runs this image as a whole microVM the platform created, with one
  persistent volume standing in for the three docker ones (the entrypoint's VM mode links `/work`, `/history`
  and dockerd's data-root onto it — layout in `@intentic/sandbox-run/fly`). Two stated deviations from the
  container flavor: the whole box is the platform's machine rather than the user's (so its reachability grant
  is necessarily within the agent's reach — its scope is this sandbox's own address and nothing else), and the
  daemon **stops itself when idle** (`IDLE_STOP_MINUTES` →
  `src/system/idle-stop.ts`: nobody connected, no turn, no live delegate, no armed condition watch, no terminal
  output for the window → the graceful exit, so the machine stops and the platform wakes it on the next visit). The corollary worth
  knowing: scheduled automations run only while the box is awake. Nested dockerd needs no privilege directive
  here — VM root already holds every capability, so the docker capability starts its engine without a rebuild.
- **A platform on your own machine arrives as a self-signed certificate on `host.docker.internal`**, and every
  sandbox→platform caller in this daemon is allowed not to verify it — one closed list of hosts, in
  `src/platform/local-tls.ts`. One caller is not in this daemon: the bundled translator is a Go binary, it opens
  the free trial's own connection, and it verifies. Against a dev platform that failed every trial turn as a 500,
  which the harness reads as an outage — so the chat said "The model provider is not responding" about a
  certificate name. `src/platform/local-tunnel.ts` terminates that TLS on its behalf: a loopback listener the
  trial's base URL points at instead. Opened **only** for a platform on that same closed host list; a deployed
  one gets none of it and the URL is unchanged.
- Archiving a finished agent preserves its transcript and parked branches while reclaiming checkouts. Explicitly
  purging the archive also removes the daemon transcript, unshared attachment UUID dirs, and separately-owned
  Claude session files; provider-native state that still shares an auth home is never guessed at destructively.
