# @intentic/sandbox

The **per-project AI-agent dev daemon**, a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own tunnel (Google-backed renewable sessions): run provider-native agent turns over the project's repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

The daemon runs in one of two **profiles** ([src/platform/profile.ts](src/platform/profile.ts)). `container`
(the default) is everything above. `local` is the same daemon as a plain process on the user's own machine,
serving a folder they already own: for host applications (an editor extension, a CLI) that embed the product
without a sandbox. Local means: loopback only and refuses any env that says otherwise (the fail-closed floor
beside the auth floor), no auth (the person at the keyboard is the owner), HOME never claimed or converged,
repos never reshaped (no separate git dirs, no gitlink surgery: a `.gitmodules`-declared submodule is spared
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
- Follow the agents a turn starts. Every child: an Agent-tool subagent, a delegated `codex exec` or `opencode
  run`, is a record on one roster (src/agent/subagents.ts), and the delegates report their OWN state into it: a
  daemon-authored codex hook drops event files into a signal spool (src/codex/codex-config.ts →
  src/agent/delegation-signals.ts), and a delegated OpenCode session runs attached to the warm server whose
  event stream the daemon already reads (src/grok/opencode.ts). Each is stamped with the tool call that started
  it (codex through the pane environment, opencode through its session title) so a signal names its own record
  rather than being matched by timing. That is what gives a child a real session id, a `blocked` status, and its
  own last words as its report, and what the turn's `wait` tool parks on (src/agent/subagent-wait.ts): sleep
  until one of this turn's own children needs input or finishes, instead of polling a terminal tail.
- Outwait the world on the agent's behalf. For a condition OUTSIDE the harness: a CI run, a deploy, a remote
  queue, the agent arms a condition watch (src/agent/watch-server.ts): a check command that exits 0 when the
  thing has happened. The daemon polls it between turns (src/agent/watchers.ts) and wakes the arming
  conversation exactly once: on the check passing or on the deadline, whichever first, with the check's own
  output: so the agent writes no sleep loop and holds no turn open. The CLI's own scheduling tools
  (ScheduleWakeup, the Cron family) are disallowed on every turn: they live in a process that dies with the
  turn, so they accept schedules that can never fire.
- Open a brand-new sandbox with something running in it. A fresh workspace used to arrive empty, so the first
  screen of a product whose claim is "say what you want changed and watch it change" had nothing to change; the
  first boot now seeds a one-page starter site as its own repo and starts its dev server
  ([src/scaffold/starter-site.ts](src/scaffold/starter-site.ts)), and the browser puts that preview on screen on
  the first visit. It is a file COPY, not a scaffold: the image bakes the whole monorepo with its dependencies
  already installed, so the wait is a few seconds rather than the minute or two an install costs. Fresh
  workspaces only, and only where the daemon owns the workspace, a local daemon runs over a folder the user
  chose and never seeds anything into it.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Turn the composer's voice into text without the audio leaving the box: the browser records and segments
  utterances itself and posts each one's WAV to `/speech/transcribe`, where whisper.cpp answers
  (src/speech/transcribe.ts: the `whisper` feature pack, baked into standard images; the model downloads into
  the workspace volume on first use, shared with Discord voice).
- Run a chat model inside the box when the owner adds a `localmodel` capability: the handler downloads the
  chosen GGUF into the workspace cache and serves it with the image's bundled llama-server (the `llamacpp`
  feature pack, baked into standard images; the optional CUDA build plus the `--gpus=all` directive ride the
  overlay) on a loopback port derived from the entry's id. The add does not wait for tens of gigabytes: it
  starts the download and returns, the entry's status carries the progress, and a part file is resumed by
  range rather than re-fetched, so a restart mid-download costs seconds. How much conversation the server holds
  is the owner's choice on the card (rungs from 16k, or a typed number), because it is a trade only they can
  make: the cache costs roughly a gigabyte of RAM per 16k of window, and a window under what a turn of the agent
  loop costs on its own serves fine as a quick-model pin and refuses everything else — so the resolved number is
  quoted back wherever the entry is shown, and `src/endpoints/local-model.ts` is the one place the card's two
  fields become the one `--ctx-size` the server is started with. To everything downstream it is an
  `endpoint/<id>` provider like any user-added model API: src/endpoints/local-model.ts is the one place the
  two kinds are joined, and src/capabilities/handlers/localmodel.ts owns the download, the panel session, the
  boot restore, and the one moment this kind does not share with a user-added endpoint. The translator's
  routing table is synced by the capability route at add time, which for a local model is minutes before it
  can serve anything, so the handler re-syncs when llama-server actually answers /health; without that the
  entry routes an empty model list and every turn on it is refused while the card reads "active".
- Manage the app dev server and report preview status, including what is ACTUALLY answering inside the box: each
  listening port with the process that took it and the terminal that process descends from, whoever started it.
- Keep the tree true after lands: reinstall drifted dependencies, run the project's own checks, and announce the
  edges (`deps.broken`/`deps.fixed`) that wake a fix chore the owner picked from the Automations templates: every
  step in a visible terminal panel and the activity feed (src/workspace/reconcile-deps.ts → verify-deps.ts →
  src/automations).
- Hold outbound posts as an approval queue: the agent proposes drafts as files (`.intentic/config/drafts/`, src/drafts),
  the owner approves them on the Drafts page, and the daemon itself sends each one the moment it comes due:
  sleeping on one timer until then rather than sweeping, since it is the process that wrote the deadline. A
  platform with a real API goes out as an authenticated request; one that is only a logged-in browser goes out
  as an agent turn, pinned to the persona the draft NAMES (`actsAs`). That pin is the difference between a post
  and a failure: an unattended turn that names no persona is denied every account, so a browser-published draft
  without one is failed unsent rather than handed to a turn that cannot reach the login.
- Gate what runs without the owner, in two layers that share one decision seam (src/guard). Before a session
  starts: every outside-driven wake (automations, listeners, the Front Desk, the workflow release gate) is
  allowed, held for approval, or refused. Inside a session already running: classified outbound provider calls
  are checked against the owner's action rules, and shell commands whose class the owner holds: destructive
  git, recursive deletes, credential reads, publishes, outbound fetches: park on a permission card before they
  execute. Both in-turn gates are PreToolUse hooks, which is what makes them hold in the autonomous posture
  where the permission cards are never raised at all.
- Tell the agent which words are not the owner's, and act on it (src/guard/outside-content.ts). Everything that
  arrives from outside the workspace: a stranger's listener or Front Desk message, a fetched page, a foreign MCP
  server's answer, the output of a shell command that reached the internet: is wrapped in an
  `<untrusted-content>` envelope whose id is minted per wrap, so content can never close its own envelope and
  speak in the owner's voice after it. Marker lookalikes (including fullwidth, CJK and zero-width spellings),
  the harness's own control tags, and foreign models' reserved tokens are neutralized inside the body. The
  system prompt states the language once rather than repeating a warning per wrap. Wrapping also sets the
  turn's outside-content bit, and while it is set a credential read the owner has not explicitly ruled on stops
  being auto-allowed: which is the middle link of the chain (outside text → read a credential → send it out)
  and the only one a policy can stand in.
- Let the agent USE a stored secret without ever holding it (src/secrets). Every credential the sandbox stores
  (a connector's token, the DevOps `.env`, the deploy engine's generated values) is masked out of everything
  the agent reads as a stable `{{secret:name}}` reference rather than a blank, and the same token resolves back
  to the real value only at the exits: spliced into a shell command as it runs (a Komodo config payload, a curl
  body) or typed into a focused browser field (`type_secret`). Files at rest keep the reference; every
  resolution lands on a use ledger the Secrets view shows as each entry's "last used".
- Run the agent's JavaScript, not only its shell (src/execution). The JS execution backend is the second way a
  turn runs work of its own: declared per runtime (`AgentCapabilities.execution`), granted per persona card
  beside the shell switch, planned into the one request every runtime builds on, and served on the Claude Code
  loop as the `Code` tool. The model writes an ES module instead of a grep/curl pipeline; the daemon runs it
  in a Node subprocess under Node's permission model, which is what makes this fence real where the shell's is
  advisory: reads and writes are granted per directory from the card's files answer and folder scope, and
  starting other programs is granted only when the card also holds the shell: so "code yes, commands no" is a
  posture that actually holds. Scripts ride the same seams commands do: the command gate classifies them
  against the owner's rulebook, `{{secret:name}}` resolves on the way into the process and lands on the use
  ledger's code lane, results are masked, and a script that fetched the open internet has its output wrapped
  as outside content exactly as a fetching curl's is. The one stated gap: the fence cannot cut the network.
- Decide who a session IS, what it may do and what it is TOLD, once per turn and above the choice of runtime
  (src/personas). A persona card names the connected accounts a session may speak through, which shelves of its
  toolbox are open: files, shell, code runs, web, browser, connectors, computers, MCP connections, delegation,
  changing the sandbox: where in the workspace it works, and which system prompt it runs on. Accounts, connectors,
  computers and MCP connections are enforced by ABSENCE: the credential is never injected and the server never
  mounted, so nothing depends on the model cooperating. The plain switches take their tools out of the turn,
  and the folder limit refuses file tool calls that point outside. Naming no persona keeps the full toolbox and
  reaches no logged-in account; naming one that does not exist gets neither.
- Give one persona its own prompt, skills and tools (src/personas/persona-kit.ts). Each card may carry a kit
  folder beside it, laid out as a Claude Code plugin (`PROMPT.md`, `skills/`, `agents/`, `.mcp.json`) so the
  runtime's own loader reads it on the turns wearing that card and no others, with nothing copied into the
  workspace and nothing to sweep back out when the persona changes. The card stores only which base it runs on;
  a card that says nothing follows the sandbox, which is what almost every card means.
- Tell every runtime what the owner wrote, and say plainly which ones cannot hear all of it. The system-prompt
  setting used to be composed inside the Claude Code arm, so a turn on native Codex, Grok, Gemini, Pi or an ACP
  agent ran without it (and without the persona note) while nothing on screen was wrong. What each runtime
  will accept is a declared axis now (`AgentCapabilities.instructions`) and src/agent/system-prompt.ts composes
  to it: a replacement where one may be sent (the Claude Code loop; native Codex, through
  `model_instructions_file` and `developer_instructions`), an addition where only that is possible (OpenCode's
  per-message `system`), and the user-message door for the persona note where there is no system seam at all.
- Say what the agent actually KNOWS, and own the half of it the owner wrote (src/settings/skill-inventory.ts).
  Skills reach the agent from six directions: this image's baked tools, the owner's own, the cheatsheet every
  connection writes, an installed extension's checkout, a plugin capability's clone, and whatever is simply
  sitting in the loaded folder: and nothing joined them, so "what is my agent carrying" had no answer. The
  inventory reads all six off disk and reports where each came from, which is what decides whether a row may be
  switched, rewritten or deleted at all: a control the source would undo on the next reconcile is not offered.
  The owner's own skills are stored APART from the folder the agents read (`.intentic/config/skills/`, reconciled into
  `.agents/skills/` by src/settings/skills.ts) so that switching one off keeps what they wrote: in the loaded
  folder, "off" and "deleted" would be the same operation. The loaded folder is the vendor-neutral one on
  purpose (src/settings/loaded-skills.ts): Codex and Gemini read `.agents/skills/` natively, Claude Code reads
  it through per-skill symlinks under `.claude/skills/`, and runtimes with no skill loader get a managed index
  block in AGENTS.md naming each skill, its description, and its file.
- Schedule workflow graphs daemon-side. A run snapshots every repository HEAD once, creates every fresh step
  from those exact commits, holds candidate branches instead of auto-landing them, and resumes workflow-owned
  loops through one coordinated restart path. At most four workflow graphs execute across a sandbox at once.
  A handover names a predecessor's branch only after resolving it (src/workflows/handover-branches.ts): the ref
  has to exist and carry commits the pinned base does not, so a repository the step never touched is dropped
  and a step that committed nothing says so: an unresolved name sends a reviewer to an empty diff, which comes
  back as a pass over work it never saw.
- Hold up the daemon's end of the creator pool: with NO usage telemetry, by design. Installing (or updating)
  a `tier: "premium"` extension donates the owner's credits to its publisher through the platform
  (src/platform/pool-donate.ts: the donation IS the premium gate, keyed on the checkout's own manifest
  identity, refused installs leave no debris); enabling one re-checks the membership (src/platform/pool-status.ts);
  nothing about what runs on this machine is ever reported. Metered service runs relay through
  src/platform/pool-services.ts: the daemon adds the connect token, the member gate, the credit meter and
  the refund discipline are the platform's. A run's answer is the platform's NDJSON stream (the contract's
  ServiceStreamEvent vocabulary plus its own receipt trailer), which the relay forks: provider `status`
  lines surface live, the buffered `result` is what the caller is answered with. The AGENT's own run is
  additionally parked on an owner-approval card in the chat before anything is forwarded
  (src/platform/service-offer.ts): every number on the card is the platform's catalog answer, the owner's
  click is the only thing that releases the spend, and one click covers one run: consent is plumbing, not
  the skill's etiquette. While the approved run streams, its status lines land under that card as
  service_event frames, and the receipt frame is the platform's trailer verbatim. The agent reaches the
  priced catalog through the `services` CLI (bin/services + the baked services skill), scoped by the agent
  token's grant; `services wanted` files a "the catalog had nothing for this" onto the platform's public
  wanted list (no spend, no card, bounded platform-side) and the baked **provide** skill walks an owner
  from an existing API to a listable wrapper endpoint (self-tested against the admission probe's three
  checks) plus the exact values the listing screen asks for. An extension backend's runs pass straight
  through the gate, because which services it may spend the owner's credits on is a `permissions.daemon`
  glob approved at install.
- Let an agent ask the owner, in chat, to connect a capability the task is missing: the same consent shape
  as the spend gate, pointed at setup instead of money (src/capabilities/capability-offer.ts). The agent's
  `capabilities request` (bin/capabilities + the baked capabilities skill) parks on a card titled with the
  catalog's own words (the daemon validates the ask against src/capabilities/connectable.ts: the static
  catalog merged with contributed cards); a yes keeps the call parked while the daemon watches the manifest
  for the connection to come live, so the agent resumes in the same turn with the capability usable; a no is
  remembered for the conversation so a repeat ask never raises a second card. The model contributes one line
  of why and can connect nothing itself.
- Let an agent **pay for things on the open web** out of a USDC wallet, under the owner's policy
  (src/wallet/). The agent's `wallet fetch` (bin/wallet + the baked wallet skill) parks while the daemon
  makes the request itself, reads the endpoint's own **x402** challenge (src/wallet/x402.ts: both live wire
  revisions parsed into one quote; the rival MPP dialect refused by name rather than misread), checks the
  wallet capability's caps, and raises the spend gate's card with every number taken from that challenge and
  the payment ledger (src/wallet/payment-offer.ts). Payments inside the owner's standing auto-approve band
  skip the card; everything else needs the click. **No key is ever in this container**: the signature over
  the one-transfer EIP-3009 authorization is minted by the platform (src/wallet/wallet-signer.ts), which
  re-checks the same caps where the key lives: the daemon's checks are the UX, the platform's are the
  guarantee. A payment that fails after signing spends nothing, because the authorization expires unused.

## Key files

- [src/app.ts](src/app.ts), the Hono HTTP API: every route the browser and the CLI reach the daemon through.
- [src/agent](src/agent), **singular**: one conversation. The turn loop, its tools, steering, terminals and diagnostics.
- [src/agents](src/agents), **plural**: the fleet. The registry, `worktrees.ts`, `isolation.ts`, `land.ts`, `origins.ts`, `landed-presence.ts`.
- [src/git/git.routes.ts](src/git/git.routes.ts) (status/commit/push over the wire; [src/workspace](src/workspace)) the repo layout the daemon serves. [src/workspace/workspace-scope.ts](src/workspace/workspace-scope.ts) decides WHOSE copy a file read means: the shared `/work` tree, or one conversation's own checkout when the request names it (`?agent=`). Reads only (no write route can name a checkout) and a request naming one that was archived away says so specifically instead of reporting a missing file.
- [src/composition.ts](src/composition.ts) (what is wired to what; [src/main.ts](src/main.ts)) the entrypoint that builds it and serves.
- [src/extensions/extension-updates.ts](src/extensions/extension-updates.ts): the update lifecycle for git-installed
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
  one clock: how long since its turn settled. The provider CLI's MCP servers and headless browsers (three
  levels down, nothing here holds a handle on them) carry the conversation's stamp
  ([src/platform/leftovers.ts](src/platform/leftovers.ts)) and go a couple of minutes after the stop; the
  conversation's `agent-*` tmux sessions: live panes included, so a left-behind dev server no longer outlives
  its turn by days: go minutes later unless somebody is attached; its browser records close; and the temp
  state turns mint (tmux-run capture dirs, land/classify patch dirs, delegation signals) is swept by prefix and
  age. Archive and discard are the hard stop: their press reaps the conversation on the spot. WHICH of those
  processes are this daemon's at all is the PROCESS GROUP for everything it forked itself: a container can
  hold two daemons, a second one is in the group of the shell that started it, and a sweep enumerates its own
  group and never learns the other's processes exist: plus, for pane trees the tmux server forked, the
  registry: a stamped survivor is reclaimed only when its owner is a conversation this daemon's own roster
  knows. The group check is deliberately not one the sweep can get wrong: twice on 2026-08-11 a source run of
  this daemon read the live one's processes as a dead life's leavings and killed four agent turns mid-answer,
  and no amount of care in this file would have helped, because the file doing the killing was a checkout from
  a branch that predated the care.
- [src/platform/container-owner.ts](src/platform/container-owner.ts): which daemon this one is. This repository
  is the sandbox, so an agent working in it runs the daemon from source to watch a change work, and everything
  held once per container (HOME, the tmux server, the process sweep, the translator, the platform registration,
  the scheduler, the drafts publisher, the CI hooks) is claimed rather than assumed. A daemon that finds a live
  claim: or finds `INTENTIC_AGENT_SESSION` on itself, the badge
  [src/agent/agent-terminals.ts](src/agent/agent-terminals.ts) puts on every command a conversation runs, which
  everything forked from one inherits, comes up a GUEST: it serves its own routes, converges only roots nobody
  else holds, and sweeps nothing. Two incidents wrote this: 2026-07-31, where a dev run took the live sandbox's
  git access down, and 2026-08-11, where one killed four agent turns mid-answer and did it again 26 minutes
  later from roots that were safely under `/tmp`.
- The four change feeds that keep the browser fresh without it ever asking twice, all riding the one `/events`
  stream: [src/workspace/workspace-watch.ts](src/workspace/workspace-watch.ts) (files),
  [src/workspace/repo-watch.ts](src/workspace/repo-watch.ts) (the repo set),
  [src/git/ref-watch.ts](src/git/ref-watch.ts) (refs), and
  [src/system/runtime-watch.ts](src/system/runtime-watch.ts): everything that is RUNNING rather than written:
  tmux sessions, panel dev servers, listening sockets, the agent's browsers and its subagents. The first three
  start from a file; the fourth cannot, which is why it is half announcements from the subsystems that do the
  thing and half one shared sampler that runs only while a browser is connected.
- [src/hosts](src/hosts), the user's own computers: the socket each one holds open, the Computers view's data
  (`machine-reports.ts`), and `host-seed.ts`: the card the setup flow creates for the machine that installed
  this sandbox, granted its sandboxes and nothing else. Acting on one of those sandboxes STREAMS, because the
  slowest of those actions pulls an image for minutes; the scope behind it is checked on the machine and never
  here.
- [src/guard/guard.ts](src/guard/guard.ts): the one gate every gated action consults (fail-closed); [src/guard/actions.ts](src/guard/actions.ts) is the catalog of decisions, and [src/guard/command-gate.ts](src/guard/command-gate.ts) is the one that can park a running turn on a card.
- [src/guard/outside-content.ts](src/guard/outside-content.ts): the envelope around anything the owner did not
  write, and the neutralizer that keeps content from forging one. Two seams apply it: a stranger's message at
  turn birth (src/automations/scheduler.ts) and everything the agent pulls in mid-turn
  ([src/guard/outside-results.ts](src/guard/outside-results.ts), which wraps every MCP server except the
  daemon's own control servers: an exception list a conformance test pins, so a server added without a
  decision fails the suite). [src/guard/turn-taint.ts](src/guard/turn-taint.ts) is the one-way bit the wrapping
  sets and the command gate reads.
- [src/browser/session-store.ts](src/browser/session-store.ts): whose browser an account lives in. An
  IDENTITY (one email address, a capability of its own) owns one persisted Chromium profile; the platform
  accounts born from it share that browser: which is what makes a site's "Continue with Google" one click:
  while a hand-connected account keeps its own. All of them stand behind ONE MCP server, `browser`
  ([bin/browser-router.mjs](bin/browser-router.mjs), configured by
  [src/browser/browser-tools.ts](src/browser/browser-tools.ts)): every tool takes an `account` argument the
  router resolves to a profile, so the prompt pays for one schema set however many accounts are connected:
  before this every account pinned its own copy of ~21 tool schemas. The router also answers the harness's
  startup handshake from a version-keyed schema cache and spawns an account's real node+playwright backend
  only when a call names it: before that, every turn started one such process per connected account, ~3.5 GB
  a turn for browsers mostly never touched: and an `account` outside the turn's persona-filtered manifest is
  refused by name, which is what makes the persona rule hold at the tool layer. The same collapse holds for
  the SKILLS: one `identities` skill and one per connected SITE, each account a roster line, converged by
  [src/capabilities/account-skills.ts](src/capabilities/account-skills.ts): never a per-account clone. The
  owner signs the email provider in themselves in a live
  window (`browser-profile.ts`); the agent connects accounts through
  [src/browser/accounts-tools.ts](src/browser/accounts-tools.ts): stored credentials are typed for it, never
  shown to it; a linked mailbox answers "the newest code from this site" and nothing more
  (`email-codes.ts`); opening a NEW account is gated on the identity card's own switch
  ([src/capabilities/open-account.ts](src/capabilities/open-account.ts)); and anything only a person can clear
  parks on a help request the owner answers over the live view.
- [src/secrets/secret-registry.ts](src/secrets/secret-registry.ts): every stored credential under its stable
  name, and the `{{secret:name}}` reference language built on it: masking rewrites values to references in
  every tool result ([src/agent/agent-redaction.ts](src/agent/agent-redaction.ts)) and in the terminal lane
  (`bin/cleaners.mjs`), and the two exits resolve them back: the shell rewrite inside the tmux wrapper
  ([src/agent/agent-secrets.ts](src/agent/agent-secrets.ts)) and the browser's `type_secret`
  ([src/browser/secrets-tools.ts](src/browser/secrets-tools.ts)): each use landing on the ledger
  (`src/secrets/secret-uses.ts`) the inventory joins as "last used".
- [src/wallet/payment-offer.ts](src/wallet/payment-offer.ts), the payment gate: probe unpaid, parse the
  endpoint's challenge, check the owner's caps, card it (or not, inside their band), have the platform sign,
  retry with payment, receipt what settled. The ledger row ([src/wallet/wallet-ledger.ts](src/wallet/wallet-ledger.ts))
  opens BEFORE the signature is asked for: an unwritable ledger refuses the payment, and an in-flight row
  holds its amount against the daily cap so two turns cannot race one budget.
- [src/personas/personas.ts](src/personas/personas.ts): who a turn is and what it may do, resolved in one
  function whose header carries the reasoning for why accounts default to nothing and powers default to
  everything. Identities count as accounts there: an unattended wake that names no persona loses them first. [src/personas/persona-scope.ts](src/personas/persona-scope.ts) is the folder limit and the
  "change the sandbox" switch as a PreToolUse hook: a refusal, honestly weaker than the container, and the
  card's own UI says so where it is set. Nothing is seeded: a fresh workspace has no personas, and
  [src/personas/front-desk.ts](src/personas/front-desk.ts) is the one card the daemon writes by itself: the
  read-only front desk a public web chat answers through, created when a Front Desk is saved rather than at boot.
  [src/personas/persona-kit.ts](src/personas/persona-kit.ts) is the folder beside each card, shaped as a plugin
  so the runtime's own loader reads that persona's prompt, skills and tools and this daemon parses none of it.
- [src/agent/system-prompt.ts](src/agent/system-prompt.ts): what the model is told before the conversation
  starts, composed once per turn for whichever runtime is about to serve it. Its header carries the split that
  makes the setting honest: which guidance is a fact about the WORKSPACE (the reference shelf, the public
  outbox) and therefore travels to every runtime, and which names a mechanism only the Claude Code loop wires
  (the question and plan cards, the checklist tools, the secret references, the outside-content envelopes, the
  browser servers). [src/codex/codex-instructions.ts](src/codex/codex-instructions.ts) is the Codex half: two
  undocumented config keys, verified by reading what reached the wire.
- [src/agent/workspace-map.ts](src/agent/workspace-map.ts): the AREAS of the project a run starts in, read off
  the filesystem when a conversation opens and prepended to its first message (opt-in: `workspaceMap`). Rooted at
  where the run actually begins (a persona's start folder, an isolated worktree) rather than at `/work`, and
  the shelf it is standing in is the one that opens. Every rule in it is structural rather than named, so it
  answers the same way in a repository shaped like nothing here: areas are whatever directories a project has, a
  `packages/`-style shelf is recognised as a directory of manifest-bearing directories, and each line's purpose
  is that folder's own manifest description or the first prose line of its README: empty where there is neither,
  never invented. It is REGENERATED and never stored, which is the whole argument for it being a mechanism
  instead of a paragraph: over the ten days that motivated it, this repo's two busiest top-level directories
  stopped existing and ten sessions went on naming them.
- [src/auth/role-floor.ts](src/auth/role-floor.ts): the minimum trust tier per route, in one table. [src/auth/auth.ts](src/auth/auth.ts) resolves who a caller is (owner TOFU, members with granted roles); the floor decides what that tier reaches.
- [src/workflows](src/workflows): workflow scheduling, immutable run snapshots, restart recovery, run-ledger
  retention, and complete, resolved handoff artifacts; [src/loops](src/loops) drives each individual step.

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own tunnel; the daemon verifies Google identity when establishing a renewable session, resolves the selected provider's credential from its **own** stored accounts, and starts that provider's runtime per turn. The platform is never on this path and never contacts the sandbox: it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

Native Codex turns use `codex app-server --stdio`. A subscription turn gives app-server a custom Responses
provider aimed at the bundled CLIProxyAPI translator; the translator authenticates upstream with the owner's
connected ChatGPT account, so image generation consumes that subscription rather than an `OPENAI_API_KEY`.
Generated PNGs are copied out of Codex's provider state into `.intentic/records/artifacts/imagegen/`; only the durable
workspace-relative path enters the event stream and transcript. The `@openai/codex-sdk` dependency remains the
exact CLI-version anchor and the locator for a vendored development fallback, not the native turn transport.

That transport is bidirectional, which is what lifts the native Codex runtime off the foreign-loop floor. A
mid-turn message from `/agent/steer` is delivered as `turn/steer` rather than forcing an abort-and-resend; the
thread's skills are published as the composer's `/` commands and a picked one rides back as a structured skill
input; and the experimental question request (`item/tool/requestUserInput`, which Codex only offers the model
once the thread config asks for it) raises the same card the Claude Code loop's `ask` tool does. Approvals stay
declined on purpose (the container is the isolation boundary) so app-server's other server-initiated requests
are refused the moment they arrive, before anything can block a turn on an answer that is never coming. Isolation
is the same mount namespace the Claude Code loop gets: app-server is a child process, so `nsenter` puts it (and
everything it forks, its shell and its browser servers included) in the turn's anchor, where `/work` **is** the
conversation's worktree instead of a path that still reaches the shared checkout.

## Conventions & gotchas

- Workspace-root daemon state has a lifecycle taxonomy: provider homes are secret under `.intentic/secrets/auth/`,
  resumable Claude state is carried under `.intentic/records/sessions/claude/`, rebuildable caches (the iq index, the
  whisper model) are under `.intentic/local/cache/`, durable attachments/browser captures/generated images/run
  evidence/workflow reports are under `.intentic/records/artifacts/`, extension scratch is derived under
  `.intentic/local/runtime/`, and agent scratch is derived under `.intentic/local/tmp/`. Small owner-edited manifests remain
  directly under `.intentic/` so their stable paths stay readable. A janitor
  (src/workspace/state-janitor.ts) collects what the classes call disposable: tmp/ at boot, retired derived
  roots, unreferenced pnpm-store blobs, browser captures past thirty days.
- The Claude credential lives in the sandbox's own `.intentic/secrets/auth/claude/` store (connected via the daemon's
  `/claude/*` flow), resolved + injected into the SDK per turn: never held by the platform. The generic file API
  protects the whole `auth/` parent, provider-native `sessions/`, and logged-in `browser/` profiles; purpose-built
  routes expose only the safe slices those stores need.
- The daemon authenticates every request itself (a Google ID token only at exchange, then a daemon-minted session verified per request), since it is reached directly over its public tunnel, it owns its own auth. Access is tiered: the owner binds on first sign-in, and every invited member holds a granted role (viewer / collaborator / maintainer) stored in `.intentic/identity/members.json`. The bearer middleware holds each request to its route's floor (`src/auth/role-floor.ts`): viewers read, collaborators drive agents (their lands become requests on the agent card), maintainers ship and get the terminal, and credentials-adjacent surfaces stay owner-only. Rotating sessions or changing a member's grant closes that identity's live event, terminal, and browser transports and invalidates unused connection tickets. Account deletion retires browser authorization at the daemon before the platform record disappears; if the daemon cannot be reached, deletion stops and names the sandbox that still needs attention. The platform only mirrors the grants; this daemon is the enforcer.
- Resource diagnostics survive the container. Once a minute `src/platform/resource-metrics.ts` appends one JSON
  object to `/history/logs/resource-metrics.jsonl`: daemon heap/native memory, GC and event-loop windows, cgroup
  pressure, process memory/CPU grouped by workload role, and cardinalities for the resident transcript, turn,
  browser, performance, and IQ owners. It is readable directly from a later sandbox shell (for example,
  `tail -n 20 /history/logs/resource-metrics.jsonl | jq .`) and through the existing authenticated
  `GET /logs/file?name=resource-metrics.jsonl&bytes=1000000` route. The normal logs retention applies: files are
  tail-truncated after 5 MB, expire after 30 days, and participate in the 100-file cap.
- **A failed turn leaves a record that outlives the feed it happened in.** Two facts about a turn used to live
  only in `activity.jsonl`, which prunes to its most recent entries, and in the client's event stream, which
  exists only while a browser is attached: that it failed, and what it failed with. So the most common failure in
  the product was the one least likely to leave a mark, and a burst of them, four sessions dying together, was
  unreadable an hour later. The spend ledger (`src/usage/usage-store.ts`) carries them instead, because it is the
  one daemon log that is never pruned: every turn appends a row with `outcome` (`ok` / `error` / `cancelled`),
  the failing frame's `errorCode` and trimmed `errorMessage`, and `modelRequested` beside the `model` that
  actually ran, so a routing surprise is a diff on one row rather than a walk through four resolution paths.
  Every turn, not only billed ones: a refusal that arrives before the provider charges a token is exactly the
  kind that arrives in bursts. `rollup` keeps the money honest by summing only turns the provider counted, and
  the experiment readers drop failed and cancelled turns, whose zero prose and zero searches are arithmetic
  rather than behaviour.
- **Automatic tier selection is judged in one place, said out loud, and refusable.** Every turn passes a pure
  keyword-and-weights judge before it is planned (`src/agent/turn-tier.ts` over the contract's
  `prompt-complexity.ts`), which costs no call and, in the default `shadow` mode, no I/O either: the verdict is
  recorded and nothing is moved. It can only ever route DOWN, to a cheaper rung of the provider the turn is
  already on, because the standard tier is not a setting, it is whatever the user picked. Three things follow
  from that being invisible for as long as it was. The daemon emits a `tier` frame on every judged turn, so the
  chat can say which model actually ran and why (silence is what made the mechanism unauditable). The user can
  refuse: `AgentTurn.tierHold` is a per-conversation veto, persisted on the entry beside `fast`, honoured after
  the cheaper model is resolved so the chat can still name what was declined. And the ledger's tier columns are
  read back by `src/usage/tier-report.ts` into `SavingsReport.tier`, the fast share, what the fast-judged turns
  that stayed on the pick actually cost (never a counterfactual: this log holds what turns cost, not what they
  would have cost elsewhere), the realized routed spend, and the guardrail, how often the very next turn of the
  same conversation asked for a dearer model. A mechanism that changes what the user's money buys owes them all
  three: a warning, a veto, and the numbers.

  Two consequences of taking that seriously. The warning is RECORDED, not merely drawn: `restoredTurn` folds a
  routed `tier` frame into a notice row carrying its own one-press opt-out, because a line only the window that
  watched it ever saw is not a record of anything, and the question a week later is "was THIS answer the cheap
  one". And the cutoff is the owner's (`settings.autoTierEagerness`, three named stops over `FAST_CEILINGS`),
  since measurement with no way to act on it is a report nobody can use. The dial moves the cutoff and nothing
  else: a fast verdict additionally requires a positively-easy signal, enforced in the judge rather than left to
  the weights summing past the ceiling, so no setting of it can downgrade a short vague request. That is also
  why the ledger records the verdict and the ceiling beside the score, a bare 0.35 is standard on one stop and
  fast on the next, and a refit reading the score column alone could not tell those rows apart.
- **`slow` spans live in their own file so that `daemon.log` can be read.** `src/platform/perf.ts` warns one line
  per slow span, which is right, and in a live 3.5 MB `daemon.log` those lines were 5,465 of the warnings against
  six errors in the whole file: a log whose signal could not be found. The per-span lines now go to
  `logs/perf.jsonl` (`createPerfLogger`, same format and timestamps, so a merged timeline is one `sort` away),
  each stamped with the machine's one-minute load, because the same operation is a fifth of a second idle and
  5.7 seconds on a loaded builder and without the load beside the duration "slow" and "broken" are one line. The
  ranked summary stays in `daemon.log`, where somebody investigating an incident is already looking. A turn
  failure logs there too: `error` for an unclassified one, `warn` for the four codes that already own a durable
  trace elsewhere (a spent allowance, an outage, a refused token, a disabled seat).
- **The records are asked, not tailed** (`src/logs/diagnostics-tools.ts`). Everything above was written well and
  was, in practice, unreachable: measured over 728 sessions the `/logs` route was used *zero* times, `daemon.log`
  150 times and the resource series 69, against 1,679 hand-rolled `/tmp/*.log` files and 178 occasions where an
  agent added a `console.log` to find out what was happening. A raw tail of a 5MB JSON log is worse than the
  print statement it replaces — oldest-first, unfiltered, mostly routine — so the unit is a filtered read:
  `mcp__diagnostics__errors` (level floor, time window, substring, newest first), `slow` (the perf file, by
  operation), `turns` (outcomes from the ledger, optionally failures only) and `resources` (a dotted path into
  the metric series, with a summary). On the live sandbox that is 4,084 warnings and 6 errors in one file
  reduced to "the 35 warnings from the last ten minutes". An answer whose read started mid-file says so, because
  an empty result over a window nothing could see reads exactly like proof that nothing happened. The tools are
  read-only and confined to `historyRoot/logs` plus the ledger — a turn reads the record of what it did and can
  never edit it — and they are withheld from a persona whose `files` power is `none`. Their results are
  deliberately **not** in `INTERNAL_SERVERS`: two of the four relay a provider's own sentence verbatim, and a
  third party's words dressed as the platform's own log is what the outside-content envelope is for.
- **The browser is the only witness to its own crashes**, so it gets the one write on the logs router.
  `POST /logs/client` (`src/logs/logs.routes.ts`) accepts a capped batch of what the editor caught, measured or
  recovered from and appends it to `logs/client.jsonl`; `mcp__diagnostics__errors` reads it under
  `source: "browser"`. Its own file rather than `daemon.log`, and every line stamped `client: true`, because the
  other files are trustworthy precisely in that only the daemon writes them, and a reader who could not tell the
  two apart would eventually trust the wrong one. What the page sent rides under `report` so nothing it chooses
  to send can collide with `time`, `level` or `message` and rewrite the frame the daemon put around it. Its own
  level floor too, not the daemon's `logLevel`: a sandbox running at `warn` would otherwise drop the client's
  stall reports, which are the half that answers "the UI feels slow". It floors at **viewer** against a
  maintainer prefix and a maintainer mutation default, because a viewer whose page just white-screened is
  exactly who needs to report it and cannot raise their own role to do it.
- **One id joins a browser call to the daemon line that served it.** Both halves of a slow interaction were
  measured already and could not be paired: the browser times what the user waited for, the daemon times what it
  served, and on a sandbox answering several calls a second the only join was a timestamp and hope. The web app
  mints an id per call and sends it as `REQUEST_ID_HEADER` (`@intentic/sandbox-contract`, shared so the two sides
  cannot silently disagree on the name); the outermost middleware in `src/app.ts` echoes it onto the
  `http.request` span. The header is in the CORS allowlist deliberately — one the preflight does not allow is one
  the browser drops without telling anyone, which would leave this permanently and inexplicably empty.
- **An OOM kill is the loudest thing in the log, not a number in a file.** The cgroup counters were always in
  every sample, which is indistinguishable from not recording them: "agents spawn too many subagents and some get
  killed" cost 185 tool calls against data already on disk. `resource-metrics.ts` now diffs each sample's
  `event_oom_kill` against the previous one and logs at `error`, naming the roles that lost processes. A delta,
  not a level — the counters are cumulative for the container's life, so their absolute value is true forever
  after the first kill — and silent on the first sample after a restart, which has nothing to compare against.
  The series also gets its own retention (`FILE_CAPS` in `src/logs/log-files.ts`): at ~4KB a minute the shared
  5MB ceiling was about 21 hours, so it could not answer "what did memory do yesterday" no matter who asked.
- **This process is the control plane, so weight is kept out of it.** Every browser request, agent turn and git
  poll goes through one event loop, and what makes them slow is usually not their own work but the daemon's
  resident size: `fork()` copies page tables in proportion to it (1.5 ms from 55 MB, 27 ms at the 1.8 GB this
  used to run at, paid synchronously on the loop by whoever spawns), and a big process on a memory-pressured
  host gets paged out. Two things follow. Git is never forked from here: one tiny long-lived child does it
  (`@intentic/scaffold`'s forker), so every `git` costs a fork from ~50 MB. And the search engine runs in its
  own process (`@intentic/iq-engine/host`, logged with its pid at boot) rather than as worker threads sharing
  this address space, because threads move CPU off the loop but leave the models and the index cache resident
  here. Anything new that is large or forks often belongs on the far side of one of those boundaries.
- Built on Hono, zod, and provider-native runtimes. Claude uses the Agent SDK; Codex uses app-server, whose
  runner seam is injectable so co-located tests run without a provider process or network.
- There is more than one workspace, and a path alone does not say which. Every isolated conversation has its own checkout, so the same path names a different file in each, which is why the workspace read routes take an optional conversation and resolve the root in one place (`src/workspace/workspace-scope.ts`). A checkout is **not** a superset of `/work` (the mirrored dirs are bare mount points from outside the turn's namespace, and untracked workspace content was never in it), so a scoped read falls back to the shared tree and reports which one answered. Search is the stated exception: the iq index is built over `/work` and stays there.
- A land's product is **uncommitted**: it patches the main working tree and moves no commit. So every reading taken between two shas (`standing.ts`) is blind to the user discarding it afterwards; `landed-presence.ts` is the one that asks the working tree, and it is what keeps a card from claiming work is in a workspace that no longer holds it.
- Workflow run artifacts are shared state under `.intentic/workflow-runs/`. The JSON ledger retains every active
  run plus 50 ended runs and removes a run's artifacts when that record is evicted or forgotten.
- **The hosted flavor** (`SANDBOX_VM=1`) runs this image as a whole microVM the platform created, with one
  persistent volume standing in for the three docker ones (the entrypoint's VM mode links `/work`, `/history`
  and dockerd's data-root onto it: layout in `@intentic/sandbox-run/fly`). Two stated deviations from the
  container flavor: the whole box is the platform's machine rather than the user's (so its reachability grant
  is necessarily within the agent's reach: its scope is this sandbox's own address and nothing else), and the
  daemon **stops itself when idle** (`IDLE_STOP_MINUTES` →
  `src/system/idle-stop.ts`: nobody connected, no turn, no live delegate, no armed condition watch, no terminal
  output for the window → the graceful exit, so the machine stops and the platform wakes it on the next visit). The corollary worth
  knowing: scheduled automations run only while the box is awake. Nested dockerd needs no privilege directive
  here: VM root already holds every capability, so the docker capability starts its engine without a rebuild.
- **A platform on your own machine arrives as a self-signed certificate on `host.docker.internal`**, and every
  sandbox→platform caller in this daemon is allowed not to verify it: one closed list of hosts, in
  `src/platform/local-tls.ts`. One caller is not in this daemon: the bundled translator is a Go binary, it opens
  the free trial's own connection, and it verifies. Against a dev platform that failed every trial turn as a 500,
  which the harness reads as an outage: so the chat said "The model provider is not responding" about a
  certificate name. `src/platform/local-tunnel.ts` terminates that TLS on its behalf: a loopback listener the
  trial's base URL points at instead. Opened **only** for a platform on that same closed host list; a deployed
  one gets none of it and the URL is unchanged.
- **The free trial is offered by probe but routed by constant.** Whether the picker shows the trial follows the
  platform's live answer (`src/trial/trial.ts`, layered over the capability store); whether the translator can
  route `free-trial/auto` follows nothing but configuration (`trialCompatEntry` in `src/trial/trial-endpoint.ts`:
  platform address, connect token, one synthetic model id). The two were once one, and the one dependency was a
  boot race: the routing table rendered before the availability probe answered, so a fresh install offered a
  trial it could not route and every first message died with "unknown provider for model". Anything new about
  the trial keeps this split: offer surfaces may read the probe, the turn path and the routing table must not.
- Archiving a finished agent preserves its transcript and parked branches while reclaiming checkouts. Explicitly
  purging the archive also removes the daemon transcript, unshared attachment UUID dirs, and separately-owned
  Claude session files; provider-native state that still shares an auth home is never guessed at destructively.
- **The image runs a different dependency graph than the tests do**, and nothing but booting it says so. Every
  check upstream of the image jobs runs in the development install: all devDependencies present, every
  workspace package linked: while `prepare-image-trees.sh` prunes the shipped tree with `pnpm deploy --prod`.
  A host-side module that reaches a browser-facing barrel therefore type-checks, builds and tests green, and
  then dies at `ERR_MODULE_NOT_FOUND` as PID 1: that is how a `vue` re-export inside `@intentic/extension-api`
  killed the daemon on boot (hence `@intentic/extension-api/protocol`, the vue-free entry point host code
  imports). The rule that follows: **daemon code importing a package that also ships browser modules takes a
  node-safe entry point, never the root barrel**: type-only imports from the root are fine, they are erased.
  `_tools/scripts/smoke-image.sh` is the gate. It boots each freshly built half on the arch that produced it
  and requires `/health` to report `ok` with `boot.ready` and no failed step, before `images-merge` stitches
  `latest` and before the release can move `stable`: so a daemon that cannot start now fails the pipeline that
  built it rather than the nightly a day later.
