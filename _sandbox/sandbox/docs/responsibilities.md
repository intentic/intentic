# What the daemon is responsible for

Every surface this one process owns, and the reason each one lives here rather than in the editor or the platform.

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/inventory`, `/info`, `/preview`, `/health`); the browser calls it directly over the sandbox's tunnel, each request authenticated by a daemon session minted from verified Google identity (`/health` carved out for liveness).
- Run one Claude Code, Codex app-server, OpenCode, ACP, Pi or Cursor turn over the workspace, normalizing each
  runtime's native stream into typed `AgentEvent`s and serving them as SSE `data:` frames.
- Follow the agents a turn starts. Every child — an Agent-tool subagent the runtime runs in-process, or a full
  agent the daemon spawned for the turn — is a record on one roster (src/agent/subagents/subagents.ts). An SDK child's
  life arrives on the harness's own task stream; a spawned child's is reported by the service driving it, by
  direct call at each move. That is what gives a child a `blocked` status and its own last words as its
  report, and what the turn's `wait` tool parks on (src/agent/subagents/subagent-wait.ts): sleep until one of this
  turn's own children needs input or finishes, instead of polling.
- Say whether anything CHECKED what a child reports (src/agent/subagents/child-verification.ts). Work merging into the
  main tree passes a gate (src/agents/land/land.ts refuses a patch that will not apply); a claim merging into the
  parent's context passed none, and a child's "done, it handles the empty case now" became the parent's
  premise unexamined. So each child keeps a ledger of the files it edited against the checks that ran after
  them, and the verdict — `verified` / `unproven` / `failing` / `no-code`, naming the check that spoke — is
  stamped on its record the moment it ends, rides the frame that carries its report, and is appended to the
  Task tool's own result on its way into the parent. Fed from the NORMALIZED frames every adapter already
  emits rather than from the Claude arm's hooks, which is what makes it hold for a child running on Codex,
  Cursor or Gemini; the same ledger the turn-ending nudge is built on (src/agent/verification/agent-verification.ts), read
  by a second reader that states all four standings instead of going silent on two. Only the two states that
  carry a warning are spoken into the parent's context — an Explore child that edited nothing is the
  commonest child there is — while all four ride the wire for the roster, the card and the `wait` answer.
- Spawn full agents from inside a turn, on ANY connected provider, from ANY runtime. The engine is one
  (src/agent/subagents/children.ts): a child is an ordinary isolated unattended conversation served by whichever
  provider adapter the spec names, so a Claude turn starts Cursor's Composer with the same call a Cursor turn
  would start Codex with. What differs per runtime is only the DOOR, each the widest seam that runtime has:
  the Claude Code loop mounts `spawn`/`wait` as SDK MCP tools (src/agent/subagents/subagent-wait.ts), Cursor gets the
  same pair as custom tools (src/runtimes/cursor/cursor-tools.ts), and every runtime with a shell — Codex, OpenCode,
  Kimi, Pi, ACP — gets the `agents` CLI (bin/agents → /children routes), taught once by a note on the
  conversation's opening turn (src/agent/subagents/spawn-note.ts). The persona gate is decided once at plan time and
  recorded as the armed supervisor itself (children.routes.ts), because the agent token names the sandbox,
  never a persona. The daemon drives both ends of every child, so its life is reported onto the roster by
  direct call (the `spawned` kind), nothing sniffed from stdout or hooks; the owner's delegation ceilings
  (`subagentsAtOnce` / `subagentsPerTurn` / `subagentDepth`) are enforced in the daemon, because a spawned
  child gets the spawn door too and a cap a model is merely told about is a cap a runaway chain never reads.
  The ESCALATION LADDER is part of the same surface, with one hard rule: a child parked on a QUESTION is the
  parent's to answer (`answer`, through the very request registry the child's ask parked on), a child parked
  on CONSENT — a permission hold, a plan approval — is the owner's alone and refuses by kind, because a parent
  that could approve its child's held commands would be a model approving its own dangerous actions through a
  proxy. `send` steers a working child where its runtime takes mid-turn input, and runs a follow-up turn on a
  settled one, continuing the session its last turn reported, so refinement costs a message rather than a
  fresh agent. The owner's action rulebook binds the whole surface (`agents.spawn`, or `agents.spawn.<provider>`
  for one provider, guard/actions.ts childSpawn), and two floors compose with it: a parent turn that has taken
  in outside content is held from every supervisor mutation unless the owner wrote an explicit allow (the
  wallet's argument — a child spends the owner's accounts on the parent's say-so, and a hostile page is exactly
  what may have replaced that judgment), and starting a child on a runtime beyond every gate (rulebook "none")
  marks the parent's own taint bit, so its credential floor engages exactly as it does for a fetched page.
- Answer one conversation about another, in one call. The same `agents` CLI carries three READ verbs
  (`show`, `ls`, `find`) over two routes that can only read (src/agents/recall/fleet.routes.ts), joining what was
  always here but never named: the fleet registry, the per-conversation record, the worktree composition and
  the phrase index (src/agents/recall/fleet-recall.ts). `show <handle>` takes any spelling of a conversation — its
  id, its branch, an id prefix, its runtime session id, or words from its title — and answers what it was
  asked, where it got to, how it ended, its branch and worktree, its per-repo delta and whether that landed,
  and where its record is, with the whole transcript one flag further. The measurement it was built from: one
  in seven of this workspace's Claude sessions contains a hand-rolled hunt for exactly this, a median of three
  shell calls and as many as thirty-five, ~2 600 tokens each, all of it re-deriving a layout the daemon has
  always known. So the surface is a grant over COST, not over reach — every byte it answers was already
  readable from the turn — which is why the routes are their own namespace rather than a widening of
  `/agents`, whose neighbours land, discard and archive (auth/grants.ts states the bargain). The standing
  prompt names the verb on every runtime (`FLEET_GUIDANCE` in src/agent/prompt/system-prompt.ts), and `iq sessions
  list` joins the same registry so a runtime session prints the conversation it belonged to instead of a bare
  uuid.
- Outwait the world on the agent's behalf. For a condition OUTSIDE the harness: a CI run, a deploy, a remote
  queue, the agent arms a condition watch (src/agent/verification/watch-server.ts): a check command that exits 0 when the
  thing has happened. The daemon polls it between turns (src/agent/verification/watchers.ts) and wakes the arming
  conversation exactly once: on the check passing or on the deadline, whichever first, with the check's own
  output: so the agent writes no sleep loop and holds no turn open. The CLI's own scheduling tools
  (ScheduleWakeup, the Cron family) are disallowed on every turn: they live in a process that dies with the
  turn, so they accept schedules that can never fire. What is armed rides the fleet card
  (src/agent/verification/watch-state.ts → `AgentSummary.watches`), which is what stops a watch from being a promise made
  in silence: the conversation reads as finished on every screen, keeps a hosted machine awake, and then
  starts working by itself hours later. A card carrying one sits in the board's Active lane and wears the
  press that ends it beside the readout that announces it (`agents.stopWatching`): the arrangement is one the
  agent entered into on the user's behalf, so the fact and the way out of it are the same line on the card.
  A watch OUTLIVES THE DAEMON, which it has to, because its whole life happens between turns and intentic
  recreates its own container on every update, every environment approval and every `dev-sandbox.sh` swap:
  held only in memory it died silently, no fire and no timeout wake, since the deadline that owed the wake
  died in the same record. So an armed watch is written to a journal on the history volume
  (src/agent/verification/watch-journal.ts) and put back at boot (src/agent/verification/watchers.ts `restoreWatchers`), which re-checks
  each one before deciding anything: a condition met during the rebuild wakes the conversation immediately, a
  deadline that passed while the box was down wakes it with that ending said plainly, and the rest are
  re-armed with the time they have left. The journal carries no credential, only the NAMES of the environment
  the arming turn ran with; the values are re-derived from the live capability store
  (src/capabilities/turn-env.ts), which reproduces the persona's withholding, picks up a rotated token, and
  declines to hand back one that has since been revoked.
- Open a brand-new sandbox with something running in it. A fresh workspace used to arrive empty, so the first
  screen of a product whose claim is "say what you want changed and watch it change" had nothing to change; the
  first boot now seeds a one-page starter site as its own repo and records it in `.intentic/config/autostart.json`, which the `autostart` boot step starts on every boot (a wake, a restart, a prewarmed pool volume); `SANDBOX_PREWARM=1` (`platform/prewarm.ts`) runs the same chain onto a pool machine's volume ahead of any owner and exits
  ([src/scaffold/starter-site.ts](../src/scaffold/starter-site.ts)), and the browser puts that preview on screen on
  the first visit. It is a file COPY, not a scaffold: the image bakes the whole monorepo with its dependencies
  already installed, so the wait is a few seconds rather than the minute or two an install costs. Fresh
  workspaces only, and only where the daemon owns the workspace, a local daemon runs over a folder the user
  chose and never seeds anything into it. "Fresh" is decided ONCE, in `createServices`, before this process has
  written a byte into `/work` (`workspaceArrivedEmpty`), so the verdict describes what the user handed over
  rather than dotted state a concurrent setup or boot step converged first.
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
  loop costs on its own serves fine as a one-shot helper's pin and refuses everything else — so the resolved number is
  quoted back wherever the entry is shown, and `src/endpoints/local-model.ts` is the one place the card's two
  fields become the one `--ctx-size` the server is started with. Only one local-model server owns the machine at
  a time: the last restored or updated entry becomes active, a late download cannot steal that slot, and the
  others remain cached in standby. Before launch, their weights plus priced KV cache are checked against a
  reserved GPU/container budget, then llama.cpp's own auto-fit decides the exact layer split. To everything
  downstream it is an
  `endpoint/<id>` provider like any user-added model API: src/endpoints/local-model.ts is the one place the
  two kinds are joined, and src/capabilities/handlers/localmodel.handler.ts owns the download, the panel session, the
  boot restore, and the one moment this kind does not share with a user-added endpoint. The translator's
  routing table is synced by the capability route at add time, which for a local model is minutes before it
  can serve anything, so the handler re-syncs when llama-server actually answers /health; without that the
  entry routes an empty model list and every turn on it is refused while the card reads "active".
- Manage the app dev server and report preview status, including what is ACTUALLY answering inside the box: each
  listening port with the process that took it and the terminal that process descends from, whoever started it.
  A repo's preview hostname routes on those sockets rather than on the port the panel manager assigned
  (src/panels/panel-upstream.ts): a `dev` that fans a turbo run out across packages pinning their own ports binds
  none of the assigned one, and a server somebody started by hand was assigned nothing at all. A preview URL is
  reported only where that hostname really serves the repo, so the three answers that are not one previewable
  address (starting, several servers at once, nothing running) reach the browser as themselves instead of as a
  URL that 502s. The proxy also answers `/__intentic/preview-probe` with CORS open, which is the only way a
  browser can tell "this name never reached the sandbox" from "it did, and the dev server is down".
- Keep the tree true after lands: reinstall drifted dependencies, run the project's own checks, and announce the
  edges (`deps.broken`/`deps.fixed`) that wake a fix chore the owner picked from the Automations templates: every
  step in a visible terminal panel and the activity feed (src/workspace/deps/reconcile-deps.ts → verify-deps.ts →
  src/automations).
- Open exactly two doors to callers with no identity at all, and open them through one substrate
  (src/automations/public-door.ts): the Front Desk (src/webchat) and the bug intake (src/issues) are the
  inbound-HTTP mirror of the gateway-process pattern, a `<script>` on somebody else's page instead of a process
  holding a connection, so their routes ARE the source. The door owns what both need: which automation a public
  id names and whether this origin (or this door's own key) may reach it, a fixed rate window per caller, the
  proof-of-work puzzle, the day's ceiling spent last, the config route that doubles as the install probe, and
  the thread that makes a series of arrivals one conversation. Each door adds its one verb: a message that
  streams a reply, a report that is filed and only sometimes wakes anyone. The embeds' half of the same wire is
  the contract's `embed` entry, shared by both bundles.
- Take bug reports straight from the owner's own sites and apps (src/issues): a reporter SDK
  (`@intentic/issue-sdk`, served at `/intake/sdk.js`) POSTs crashes and written reports to a public ingest, and
  every one of them is FINGERPRINTED before anything else happens, so a crash loop on a popular page is one
  inbox row with a rising count rather than one agent turn per affected browser. A group wakes an agent when it
  is new and again only once it has grown past its escalation step; the wake carries the stack, the breadcrumbs
  and the build, and the build is what replaces a sourcemap pipeline outright, since the agent has the
  repository and can check that commit out and read the real frames. Held for the owner by default (the
  `issues` admission floor), because a bug-fix turn has the run of the repo on a brief a stranger's browser
  wrote. The owner's side is the Issues page over `/issues`.
- Hold outbound work as an approvals queue: the agent proposes posts and actions as files (`.intentic/config/approvals/`,
  src/approvals), the owner approves them on the Approvals page, and the daemon carries each one out the moment it comes due:
  sleeping on one timer until then rather than sweeping, since it is the process that wrote the deadline. A
  platform with a real API goes out as an authenticated request; one that is only a logged-in browser goes out
  as an agent turn, pinned to the persona the draft NAMES (`actsAs`). That pin is the difference between a post
  and a failure: an unattended turn that names no persona is denied every account, so a browser-published draft
  without one is failed unsent rather than handed to a turn that cannot reach the login.
- Gate what runs without the owner, in two layers that share one decision seam (src/guard). Before a session
  starts: every outside-driven wake (automations, listeners, the Front Desk, the workflow release gate) is
  allowed, held for approval, or refused. Inside a session already running: classified outbound provider calls
  are checked against the owner's action rules, and shell commands whose class the owner holds: destructive
  git, recursive deletes, disk and volume wipes, credential reads, publishes, outbound fetches: park on a
  permission card before they execute. Both in-turn gates are PreToolUse hooks, which is what makes them hold
  in the autonomous posture where the permission cards are never raised at all. The rulebook starts empty and
  one floor sits under it: the class nothing brings back (a formatted disk, a deleted Docker volume, a
  recursive delete aimed at a root rather than at something inside one) is held on every turn, configured or
  not, so a fresh sandbox is not one mistyped path away from it. An explicit `allow` still outranks the floor,
  everything recoverable is still never asked about, and the cost is stated where it is paid: the vendor
  runtimes whose gate is their own approval channel now ask per command rather than never.
  The same classifier runs a second time on a different machine: `_devices/machine` reads it beside its scopes,
  so a destructive command sent to somebody's own laptop needs that computer's `destructive` switch, which is
  off until they turn it on. The sandbox can afford to hold only what nothing undoes because the container is
  disposable; a laptop has no image to be recreated from, and the two defaults differ for exactly that reason.
- Tell the agent which words are not the owner's, and act on it (@intentic/base's outside-text). Everything that
  arrives from outside the workspace: a stranger's listener or Front Desk message, a fetched page, a foreign MCP
  server's answer, the output of a shell command that reached the internet: is wrapped in an
  `<untrusted-content>` envelope whose id is minted per wrap, so content can never close its own envelope and
  speak in the owner's voice after it. Marker lookalikes (including fullwidth, CJK and zero-width spellings),
  the harness's own control tags, and foreign models' reserved tokens are neutralized inside the body. The
  system prompt states the language once rather than repeating a warning per wrap. Wrapping also sets the
  turn's outside-content bit, and while it is set a command that reads credential material AND reaches the
  internet in the same breath stops being auto-allowed unless the owner ruled on the class: the last link of the
  chain (outside text → read a credential → send it out). The middle link is where this floor used to stand, and
  it moved because the reading no longer carries the value: results are masked before the model sees them (the
  next point), so a tainted turn that opens a dotenv learns its key names, and a card over that is one an owner
  learns to click through. The gap this accepts — two commands doing what one no longer can — is stated in
  [src/guard/actions.ts](../src/guard/actions.ts) rather than papered over.
- Let the agent USE a stored secret without ever holding it (src/secrets). Every credential the sandbox stores
  (a connector's token, the DevOps `.env`, the deploy engine's generated values) is masked out of everything
  the agent reads as a stable `{{secret:name}}` reference rather than a blank, and the same token resolves back
  to the real value only at the exits: spliced into a shell command as it runs (a Komodo config payload, a curl
  body) or typed into a focused browser field (`type_secret`). Files at rest keep the reference; every
  resolution lands on a use ledger the Secrets view shows as each entry's "last used". A credential the sandbox
  does NOT store — the project's own dotenv, a token minted an hour ago — has no name to be masked to, so it is
  blanked instead, and only where the tool call itself named a credential file
  ([src/agent/tools/agent-redaction.ts](../src/agent/tools/agent-redaction.ts)): the same classifier the command gate consults
  decides that, so the shape patterns that would mangle source code never run on any.
- Put the riskiest credentials behind a NAMED PERSON (src/secrets/credential-*.ts). Masking answers "can the
  model see this value"; it never answered "who decided to spend it". Any stored secret, and any connected
  account, can be gated to an exact list of members: after that no exit resolves it, no turn mounts it and no
  environment carries it until one of those people clicks Release on a card in the live conversation. The
  approvers are a LIST rather than a role floor, because "only Bob may release the production password" is the
  sentence people mean and a floor of `maintainer` says the opposite; the owner is on it only if they put
  themselves on it. One click releases one use by default (per-entry, the owner can say "the rest of this
  conversation" instead); a browser account, an identity and an MCP server are forced to conversation scope
  because a signed-in profile is loaded for a whole turn and cannot be released for a single use. Enforcement
  is at the exits for values ([src/secrets/credential-gate.ts](../src/secrets/credential-gate.ts)) and by ABSENCE
  for accounts ([src/secrets/credential-gating.ts](../src/secrets/credential-gating.ts), the persona filter's own
  pattern) — with a turn note naming the door, because a withheld account otherwise reads to a model as one
  that is not connected. It FAILS CLOSED four ways: an unreadable policy, an unattended turn, no live
  conversation, and a release with no verified identity behind it are each a refusal that names the approvers
  and tells the model not to retry. The policy lives OFF the workspace beside the credential vault
  ([src/secrets/credential-gates.ts](../src/secrets/credential-gates.ts)) for the vault's own reason: `.intentic/
  config/` is tracked and agent-editable, so a gate kept there would be a lock with its key in the room with
  the agent. WHAT IT IS NOT A WALL AGAINST: a shell in this container runs as the owner of both the vault and
  the policy, so a compromised container is out of scope here exactly as it is for the vault (SECURITY.md); the
  gate is a wall against the AGENT's own judgment being the last word on WHEN a credential is spent. Two gaps
  are open and stated rather than papered over: a release card raised by a turn running on a REMOTE RUNNER is
  refused on relay, because the relayed reply carries the answer and not the verified answerer
  ([src/runners/runner-service.ts](../src/runners/runner-service.ts)); and the deploy engine reading
  `desired-state/.env` on its own is not an agent exit, so a gated env secret still reaches a deploy the agent
  starts — the gate covers what the AGENT spends, not what the engine consumes.
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
  will accept is a declared axis now (`AgentCapabilities.instructions`) and src/agent/prompt/system-prompt.ts composes
  to it: a replacement where one may be sent (the Claude Code loop; native Codex, through
  `model_instructions_file` and `developer_instructions`), an addition where only that is possible (OpenCode's
  per-message `system`), and the user-message door for the persona note where there is no system seam at all.
- Say what the agent actually KNOWS, and own the half of it the owner wrote (src/settings/skill-inventory.ts).
  Skills reach the agent from six directions: this image's baked tools, the owner's own, the cheatsheet every
  connection writes, an installed extension's checkout, a plugin capability's clone, and whatever is simply
  sitting in the loaded folder: and nothing joined them, so "what is my agent carrying" had no answer. The
  inventory reads all six off disk and reports where each came from, which is what decides whether a row may be
  switched, rewritten or deleted at all: a control the source would undo on the next reconcile is not offered.
  The owner's own skills are stored APART from the folder the agents read (`.intentic/config/skills/`) so that
  switching one off keeps what they wrote: in the loaded folder, "off" and "deleted" would be the same operation.
  An own skill is on exactly while its copy under `.agents/skills/` exists, and only the owner's own save, switch
  or delete moves that copy (src/settings/skills.ts); the settings `skills` list names baked tools alone, so no
  reconcile, boot or settings write can create or delete an owner's file. The loaded folder is the vendor-neutral one on
  purpose (src/settings/loaded-skills.ts): Codex reads `.agents/skills/` natively, Claude Code reads it through
  per-skill symlinks under `.claude/skills/`, and runtimes with no skill loader get the same name, description
  and file path as a disclosed note on the conversation's opening prompt. `AGENTS.md` remains entirely the
  user's file. The one skill about the product itself is image-baked beside the task skills
  (`skills/intentic/SKILL.md`, copied to `/root/.claude/skills` by the Dockerfile): what Intentic is in the
  owner's words, a routing table from what they want to the skill or seam that does it, the key paths, a
  read-only diagnostics playbook, the editor's own vocabulary, and the rule that a negative answer about the
  product is checked before it is given. The system prompt points at it; nothing else describes the product to
  the model, and a customer's workspace holds no README about it.
- Schedule workflow graphs daemon-side. A run snapshots every repository HEAD once, creates every fresh step
  from those exact commits, holds candidate branches instead of auto-landing them, and resumes workflow-owned
  loops through one coordinated restart path. At most four workflow graphs execute across a sandbox at once.
  A handover names a predecessor's branch only after resolving it (src/workflows/handover-branches.ts): the ref
  has to exist and carry commits the pinned base does not, so a repository the step never touched is dropped
  and a step that committed nothing says so: an unresolved name sends a reviewer to an empty diff, which comes
  back as a pass over work it never saw.
- Let an agent ask the owner, in chat, to connect a capability the task is missing: the same consent shape
  as the wallet's payment gate, pointed at setup instead of money (src/capabilities/capability-offer.ts). The
  plumbing itself is src/agent/run/offer-card.ts, shared by every card a gate raises from outside the turn
  generator (a capability ask, a payment, a gated credential, a command headed for somebody's machine): find the
  live run the caller may draw in, push the raised and resolved frames into its log and the registry by hand,
  hold the call under a deadline, and tell an answer from the abort stand-in. The agent's
  `capabilities request` (bin/capabilities + the baked capabilities skill) parks on a card titled with the
  catalog's own words (the daemon validates the ask against src/capabilities/connectable.ts: the static
  catalog merged with contributed cards); a yes keeps the call parked while the daemon watches the manifest
  for the connection to come live, so the agent resumes in the same turn with the capability usable; a no is
  remembered for the conversation so a repeat ask never raises a second card. The model contributes one line
  of why and can connect nothing itself.
- Let an agent ask a NAMED PERSON to release a credential the owner gated (src/secrets/credential-gate.ts).
  The agent's `secrets gates` (bin/secrets) says what is gated and by whom, and `secrets request <id> --why`
  parks on the release card for the people the gate names. It exists because of an asymmetry: a gated SECRET
  announces itself (write its reference, the exit parks), while a gated ACCOUNT is simply absent from the turn
  and reads as one that was never connected — so the CLI plus a turn note is the door the model can find. The
  two routes it reaches (`GET /secrets/gates`, `POST /secrets/request`) are the only ones under `/secrets` the
  agent token has ever been given (src/auth/grants.ts), and both answer names: the read cannot return a value
  and the ask cannot grant itself anything.
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
- Move the agent programs themselves without shipping an image (src/engines). The Claude Code CLI and its SDK,
  `codex`, `@cursor/sdk`, `opencode` and the translator used to be frozen into the image, so an upstream event
  nobody here controls — a model raising the client version it requires — failed every turn on that model in
  every running sandbox until a new image reached it. Each of those programs is now an ENGINE with a version
  the sandbox can move: installed into a store on the daemon's volume, verified by asking it for its version
  (and, for the SDK loaded in-process, by importing it and checking it still exports what the daemon calls)
  before anything points at it, and resolved once per turn with the image's copy as the answer to every doubt —
  a bad publish is quarantined and the sandbox keeps working exactly as it did before any of this existed. The
  default channel is `blessed`: the version this repository's suite ran against, published as `engines.json` at
  the repo root and read hourly, so blessing a version is a commit rather than a release. An owner who would
  rather have upstream's newest says so per engine (`latest`), or pins one, on the Environment card. What is
  never automatic is a version OUTSIDE the channel: a turn refused for running too old an engine
  (`engine-version-floor`) holds the message and offers the install, because a version that satisfies a floor
  the blessed list has not reached yet is by definition one nobody here has tested.
- Move a sandbox: two things go OUT, and everything comes back in through one door (src/portability). A
  **bundle** is the whole environment as a gzipped tar of the two volumes, driven entirely by the state
  manifests' portability classes (carry / secret / identity / derived). A
  **definition** is the declarable half of the same thing as a `sandbox.toml`: the workspace itself by remote,
  repositories by remote, connections by shape, secret NAMES, agent settings, the overlay as source — derived
  from the live manifests on every export (never stored, and the daemon keeps no copy in the workspace),
  applied preview-first through the same native write paths the UI uses, and diffable against the running
  sandbox for drift. The owner downloads it from the Environment tab and keeps it wherever a definition belongs
  to them: committed beside a project, handed to somebody else, applied to an empty sandbox. `[workspace]` is
  what makes the sandbox's own way of working travel: `/work` is itself a repo (the `root` scope), tracking
  exactly the owner's authored content, so publishing it turns notes, skills, personas, automations, designs
  and drafts from bundle-only bytes into one reference. The bundle manifest embeds the definition (one schema,
  two doors), and applying a definition keeps the consent model: the overlay lands as a proposal at the approval
  gate, capabilities arrive unauthenticated, credentials never ride along, and the three things a checked-out
  workspace could do by itself (an approved overlay, enabled automations, workspace extensions) arrive switched
  off with the report naming each one. **Coming IN, all four sources are one pipeline** (src/portability/arrival.ts):
  a definition, a bundle, and a Hermes or OpenClaw home directory each get a parser, and everything after the
  parser is shared — `POST /arrivals/plan` sniffs the upload from two bytes and the first tar header, answers
  with a checklist the owner unticks, and `apply` writes only the ticked rows against a plan re-derived from
  the held artifact. That is what gave a bundle a preview (it is the one arrival that lands OVER a workspace
  rather than beside it, and it was the one that used to write on file pick), what makes "bring the sandbox,
  leave the six-gigabyte monorepo" a sentence an owner can say, and what moved the credential consent to the
  side that receives them. A runner can stamp `SANDBOX_DEFINITION_SEED` (sandbox-run's `definition`
  option) and an empty workspace boots pre-shaped — the fleet door. This sandbox's own runners are the first
  fleet through it: `runner-up` ships a settings-only definition plus the approved overlay with its pinning
  hash (approval by provenance — this owner already reviewed those bytes, and a runner has no owner of its
  own), so a runner starts as this sandbox's twin, and the definition machinery is also what itemizes runner
  drift and fixes the settings half over the live link. The HTTP doors are three plain-Hono route modules
  beside the machinery they drive: `bundle.routes.ts`, `definition.routes.ts` and `arrival.routes.ts`.
