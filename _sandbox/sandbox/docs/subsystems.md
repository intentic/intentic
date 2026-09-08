# What each part of the daemon holds

A reader's tour of `src/`: which directory answers which question, and the file inside it to open first.

- [src/app.ts](../src/app.ts), the Hono HTTP API's composition root: the middleware stack (boot gate, CORS, the bearer check with its exemptions and role floor), `/health`, and every route the browser and the CLI reach the daemon through, mounted in one fixed order from the `*.routes.ts` module of the area that owns it. The order is behavior — Hono matches in registration order and the exemptions are keyed by path — so it stays in this one file while each handler lives beside the code it drives (`auth/members.routes.ts`, `environment/environment.routes.ts`, `portability/arrival.routes.ts`, `platform/sync.routes.ts`, `extensions/backend/backend-proxy.routes.ts`, …).
- [src/agent](../src/agent), **singular**: one conversation, split by what each part does — `run/` (the turn loop), `routes/`, `prompt/` (what the model is told), `tools/`, `providers/` (the runtime seam and the account doors), `models/` (what an account can run, and the helper roles), `verification/` (did the turn prove anything), `subagents/`, `anchors/` (what a message can go back to) and `context/`.
- [src/agent/providers/provider-registry.ts](../src/agent/providers/provider-registry.ts): the provider list, once. Each native provider's directory exports one `ProviderModule` (its adapter row, turn arm, Services slice, catalog, readiness rung, boot tasks, pack wants, secrets rows and its ACCOUNT DOOR — src/agent/providers/provider-module.ts is the seam), and the shared surfaces DERIVE from the aggregation instead of each keeping its own enumeration. Adding a provider is its contract row (the one-row-per-provider table in `@intentic/sandbox-contract`'s provider-specs.ts), its directory, and one import line here; the registry throws at init on a missing or duplicate module, so forgetting the line fails every suite rather than shipping a provider whose secrets rows and readiness silently do not exist (which happened twice while these lists were hand-kept).
- [src/agent/routes/accounts.routes.ts](../src/agent/routes/accounts.routes.ts): the accounts this sandbox holds ITSELF, one route family with the provider in the path (`/accounts/{provider}`: start, complete, cancel, list, rename, disconnect). Four families used to serve this, each "the previous one's shape" with a verb renamed; the operations are the same six for every provider, so what differs is each module's `AccountDoor` (Anthropic's paste-back with the PKCE verifier now HELD in the door rather than round-tripped through the browser, Cursor's held verifier, xAI's device code through OpenCode, a minted key), and the route says the part no door owns: which provider was asked for and whether it has a door at all (a translator-only provider answers 404), how a door's own refusal reaches the wire (a 412 in its words), and the two answers a finishing call can give (the account, where the exchange ends there; nothing, where a mint follows and the row lands in the list).
- [src/runtimes/minted/](../src/runtimes/minted): the providers whose SIGN-IN MINTS their key (Meta's Muse Code, Z.ai's GLM Coding Plan). The token their sign-in issues is not an inference credential — either vendor's model endpoint refuses it — so the flow has a second half the user never sees: mint the vendor's own API key from it and store that, which is exactly what those vendors' own CLIs do. Nobody pastes a key; a raw key against somebody's own gateway is still an `endpoint` capability and always was. The key then points the Claude Code loop straight at the vendor's Anthropic Messages endpoint — no translator hop, no adapter, no new runtime, the same road an `anthropic`-protocol endpoint capability takes. One store, one login machine, one catalog per ESTATE and one module FACTORY serve all of them: what differs between two minted providers is a login driver and a seed list, and Z.ai's two estates (api.z.ai and open.bigmodel.cn, whose hosts refuse each other's keys) differ only in a pair of URLs on the spec row. A third provider is a contract row, a seed and a driver.
- [src/agent/models/model-catalog.ts](../src/agent/models/model-catalog.ts): "what can this account run", once, for all six providers that have to answer it (Claude, Codex, Cursor, Gemini, Kimi, Grok). The ladder is live discovery → the persisted last-known-good list → a compile-time seed floor, and the two properties each provider used to re-derive are true here instead: only a REAL answer is cached (so a seeded read retries on the next call, rather than pinning a placeholder row for a minute), and the file goes through [src/store/json-file.ts](../src/store/json-file.ts), read via the caller's schema and written atomically (so a self-heal write cannot be caught half-done by the read that falls back on it). A provider brings its own `discover`, what it keeps on disk, its floor, and how each rung renders; Cursor also keeps the raw vendor items, because a turn needs their parameter definitions to translate an effort tier. [src/agent/models/model-discovery.ts](../src/agent/models/model-discovery.ts) is the ASKING, shared by the four providers that ask an OpenAI-compatible endpoint: the bearer GET that answers `undefined` instead of throwing, the `{ data: [{ id }] }` unwrap, the id→label humanizer (one, where three had drifted over whether `gpt` is an acronym), and the "Did you mean: …" reader that is the only catalog some subscription accounts ever produce.
- [src/agents](../src/agents), **plural**: the fleet — `registry/` (the roster and its record), `worktrees/` (`worktrees.ts`, `isolation.ts`: the isolated checkout), `land/` (`land.ts`, `origins.ts`, `landed-presence.ts`, `landed-history.ts`: work coming back into the main tree) and `recall/` (`fleet-recall.ts` + `fleet.routes.ts`, what one conversation can learn about another, see below).
- [src/runtimes/cursor](../src/runtimes/cursor), the Cursor runtime, run in this process: the account store and its browser sign-in (`cursor-credentials.ts`), the adapter (`cursor-agent.ts`), the delta→frame mapping (`cursor-events.ts`), the socket-backed command gate Cursor calls back into (`cursor-hooks.ts`), the dynamic module resolution that lets the daemon boot without it (`cursor-sdk.ts`), and the provider module that registers all of it (`cursor-provider.ts`).
- [src/git/git.routes.ts](../src/git/git.routes.ts) (status/commit/push over the wire; [src/workspace](../src/workspace)) the repo layout the daemon serves; `workspace-bytes.routes.ts` is its byte surface, the raw and ranged-media reads and the three upload doors, off oRPC because their bodies are streamed bytes. The push is not a request but a RUN ([src/git/ops/push-run.ts](../src/git/ops/push-run.ts)): it runs the repository's own pre-push hook, which in a gated workspace is the whole suite, so it starts at once in the same terminal as the pre-push check ([src/prepush](../src/prepush)), is polled for its verdict, and settles with git's last word and who refused it (the hook, the remote, or the transport: `pushRefusal` in `git.ts`, read off real transcripts). Both runs are one shape (`CommandRun` in the contract) over one engine (`rules/rule-command.ts`), which is what lets the app show a refused push with the card, the terminal link and the proposed fix a red check already gets. [src/workspace/layout/workspace-scope.ts](../src/workspace/layout/workspace-scope.ts) decides WHOSE copy a file read means: the shared `/work` tree, or one conversation's own checkout when the request names it (`?agent=`). Reads only (no write route can name a checkout) and a request naming one that was archived away says so specifically instead of reporting a missing file.
- [src/composition.ts](../src/composition.ts) (what is wired to what; [src/main.ts](../src/main.ts)) the entrypoint that builds it and serves.
- [src/environment](../src/environment): the overlay Dockerfile pipeline (capability fragments + the owner-approved
  custom section), and the image boundary held by the harness rather than by prose. The install-steering hook
  ([src/agent/providers/agent-installs.ts](../src/agent/providers/agent-installs.ts)) classifies image-scoped installs into the
  runtime-install ledger (`runtime-installs.ts`, `.intentic/records/runtime-installs.json` — it survives container
  recreates, which is what makes "installed again in a fresh container" observable); the drift sweep
  (`drift-sweep.ts`, idle-only) observes what the live container has that the image did not put there (`drift.ts`:
  dpkg's own log for apt, an mtime sweep for everything else); and an install that recurs across sessions, is
  corroborated by drift, and has a mechanical template is auto-drafted into the owner's proposal (`auto-drafts.ts`).
  Rejection tombstones the tool in the ledger so the machine never re-proposes what the owner already declined.
  The `/environment` routes (read, contents, approve, reject, one runtime-install decision) are `environment.routes.ts`.
- [docs/env-contract.md](../docs/env-contract.md): the environment every command a turn starts receives, layer by
  layer — the image's `ENV` block, the turn's live-derived connector credentials, extension settings and `PATH`
  (narrowed by the persona in `personas/personas.ts`), the workload stamp — and the short list an extension
  author may rely on. Written so the answer to "what does my CLI see" is read, not remembered.
- [src/engines](../src/engines): which version of each upstream agent program this sandbox runs, and where it came
  from. An *engine* is the program a runtime rides on — the Claude Code CLI and its SDK, the `codex` wrapper,
  `@cursor/sdk`, `opencode`, the `cli-proxy-api` translator — and until this existed the only way to move one
  was to publish a sandbox image, which made an ordinary upstream event (a model raising the client version it
  requires) a fleet-wide outage with no local fix. Versions now live in a store on the daemon's volume
  (`engine-store.ts`, `/history/engines/<id>/versions/<version>`, one directory per version, a data pointer
  rather than a symlink), are installed by npm and verified before the pointer moves (`engine-install.ts`,
  `engine-descriptors.ts` — a copy that will not launch, or an SDK missing an export the daemon calls, is
  quarantined and never activated), and are resolved once per turn with the image's copy as the answer to every
  doubt (`engine-resolve.ts`). Each engine's channel (`engine-policy.ts`, `.intentic/config/engines.json`) is
  `blessed` by default — the version this repository's suite ran against, published as `engines.json` at the
  repo root and read hourly, so blessing one is a commit rather than a release — with `latest`, a pin and the
  image itself as the alternatives. [src/runtimes/claude/claude-sdk.ts](../src/runtimes/claude/claude-sdk.ts) is the loader that
  makes it real for the engine loaded IN this process: both halves of the Claude SDK come from one installed
  prefix, resolved at turn start so a version can never change under a turn already running. Its `/engines` routes are `engines.routes.ts`.
- [src/dependencies](../src/dependencies): whether the version an agent is about to pin is the one its registry
  actually has. [src/agent/providers/agent-freshness.ts](../src/agent/providers/agent-freshness.ts) reads the pins out of an install
  command or a manifest edit and hands the difference back as context, never as a refusal — matching a version the
  workspace already pins is the commonest reason to write something other than the newest, and it is a good one.
  `registry-freshness.ts` does the asking under two separate clocks: the caller waits a fraction of a second, the
  fetch itself gets much longer and is not cancelled when the caller gives up, so a cold lookup lands in the cache
  and the PostToolUse pass reports it a beat later instead of it being lost. `successors.ts` is the curated half
  and the only opinion in the feature: it supplies the NAME of a replacement, while whether the incumbent is
  actually finished stays a registry measurement, so an entry that stops being true stops being said. Off by
  default (`dependencyFreshness`); off wires no hook and contacts nothing.
- [src/agent/verification/agent-tests.ts](../src/agent/verification/agent-tests.ts): the `verify-tests` built-in, what a turn did to its tests,
  read at the Stop over every test file the tree says the turn touched. Two measurements: the assertion ratchet
  (the file's exact matchers, loose matchers and pinned literal text against the same file at HEAD, reporting a
  downgrade or a narrowing; the same measure the push gate refuses an undeclared weakening with,
  `_tools/constants/src/assertion-measure.mjs`, and the two are held to each other by a test), and the fault check
  below. That measure reads two languages: a TypeScript file by its matchers, a python file by what its `assert`
  statements and unittest methods pin down, and the same module owns which files are test files at all — pytest's
  collection rule as well as `*.test.ts`, one copy, so the push gate and the Stop cannot measure different sets.
  The first test file a turn edits is also told the two rules that apply at that moment, once. Reports,
  never refuses: a refactor from prose to structure and a test written ahead of its implementation both pass
  honestly.
- [src/agent/verification/agent-test-strength.ts](../src/agent/verification/agent-test-strength.ts): whether a test the agent wrote would have
  passed BEFORE the change it tests. A test that passes against the old code does not test the new code, and
  nothing else in the loop can see it: it type-checks, it lints, the suite is green. The check re-runs the one file
  with the turn's changed source served from HEAD through a vite `load` hook, so the working tree is never written
  over — a check that reverted files in place would trade a whole turn's work for a lint-grade signal the first
  time it died between the revert and the restore. Same package only, because a sibling package resolves to its
  built output where there is nothing to swap. Asked at the Stop by `verify-tests` (above) rather than on the
  first edit of each test file, where it measured the first draft under a 20-second budget and only where the edit
  tools could see the edit. The `load` hook is vitest's, so this answers only for a test vitest runs: a python
  suite the ratchet measures gets no answer here, and says nothing rather than reporting a pass it never observed.
  Off with the rule; off runs no suite.
- [src/agent/tools/agent-shell-edits.ts](../src/agent/tools/agent-shell-edits.ts): which files a shell command changed, for the
  hooks that only ever heard the edit tools. The dirty paths of the turn's repos and their mtimes are snapshotted
  before every Bash command and compared after it, so a file `sed -i` or a heredoc rewrote gets the same type
  diagnostics an Edit does (agent-diagnostics.ts), in the agent's own names. Two snapshots rather than a rolling
  comparison, so the edit tools' work between two commands is never charged to the second.
- [src/agent/verification/turn-checks.ts](../src/agent/verification/turn-checks.ts): what the turn's own `turn.ending` command check said, kept
  per conversation from the Stop that ran it to the land that reads it. The last run wins, which is what the
  re-measuring follow-up loop (rules/turn-ending.ts) is for; a turn whose check is still red lands as
  `outcome: "checks-failed"` and is held on its branch whatever the landing rule or the card's override says
  (rules/rules.ts landingVerdict), with the feed naming the check.
- [src/extensions/extension-updates.ts](../src/extensions/extension-updates.ts): the update lifecycle for git-installed
  extensions: the periodic registry comparison (update badges, blocked-listing advisories that pull the switch), the
  official-registry admission check (an unaudited sha never becomes an install or update offer),
  staged powers-diff preview, the apply/revert transactions over the handler's quiesce-and-swap (the outgoing checkout
  is kept one version back), the post-update health watch, and the owner's per-extension policy (notify / agent-prepared
  / auto). Nothing auto-updates by default; the auto rung is opt-in and gated on a verified listing whose powers didn't
  grow, health-watched with auto-revert.
- [src/processes/service-processes.ts](../src/processes/service-processes.ts): the supervisor for extension-declared
  background processes (the messaging connectors' gateways and kin) as the daemon's own children: real exits,
  respawn with capped backoff, a stable PORT per start, one size-capped log file each (the terminal panel's
  read-only log view tails it under the `svc-*` name). The interactive and daemon-restart-surviving tmux surfaces
  — panels, dockerd, local models, one-shot jobs — stay on
  [src/processes/managed-processes.ts](../src/processes/managed-processes.ts); the split and its reasons are the
  supervisor's header.
- Heavy agent commands take turns, because priorities could not make them.
  [src/platform/resources/heavy-commands.ts](../src/platform/resources/heavy-commands.ts) holds an editable rule list
  (`.intentic/config/heavy-commands.json`, tracked config the owner and the agent both edit: regex per rule,
  first match wins, `exempt` for the narrow escape above a broad rule) and the agent's Bash hook splices
  [bin/queue-run](../bin/queue-run) in front of any command that matches, which holds one of N `flock` slots for
  the life of the command's process tree. The slot is a kernel lock rather than a counter in the daemon
  precisely so a killed, backgrounded or orphaned command releases it with no lease to expire. Ahead of the
  slot, [bin/memory-gate](../src/platform/resources/memory-gate.ts) runs the daemon's OWN admission policy
  (`memory-admission.ts`, previously reachable only from the pre-push check) as a command, so the numbers that
  refuse a turn and the numbers that hold a suite are one set of numbers. Both are bounded and both fail open:
  past the deadline the command runs anyway, because a queue that can block forever turns one stuck suite into
  a dead sandbox. Why it exists: nice/ionice ration CPU, and a monorepo fan-out exhausts MEMORY, which no
  scheduler class rations — on 2026-08-25 09:07-09:29 four sessions' fan-outs pinned this cgroup at 16.00 GiB
  with memory PSI `full` at 88%, load1 at 312, and the daemon's event loop stalled for 615s; turbo's
  `concurrency: 4` and `VITEST_MAX_WORKERS=4` each bound ONE invocation and know nothing of the other three.
- The two things that keep a busy sandbox from eating itself, both keyed on the fact that a child inherits from
  its parent without anyone propagating anything:
  [src/platform/resources/workload-priority.ts](../src/platform/resources/workload-priority.ts) renices every direct child so the
  control plane outranks the work it started, and
  [src/platform/boot/reaper.ts](../src/platform/boot/reaper.ts) reclaims everything a STOPPED conversation still holds, on
  one clock: how long since its turn settled. The provider CLI's MCP servers and headless browsers (three
  levels down, nothing here holds a handle on them) carry the conversation's stamp
  ([src/platform/boot/leftovers.ts](../src/platform/boot/leftovers.ts)) and go a couple of minutes after the stop; the
  conversation's `agent-*` tmux sessions: live panes included, so a left-behind dev server no longer outlives
  its turn by days: go minutes later unless somebody is attached; its browser records close; and the temp
  state turns mint (tmux-run capture dirs, land/classify patch dirs) is swept by prefix and
  age. Archive and discard are the hard stop: their press reaps the conversation on the spot. WHICH of those
  processes are this daemon's at all is the PROCESS GROUP for everything it forked itself: a container can
  hold two daemons, a second one is in the group of the shell that started it, and a sweep enumerates its own
  group and never learns the other's processes exist: plus, for pane trees the tmux server forked, the
  registry: a stamped survivor is reclaimed only when its owner is a conversation this daemon's own roster
  knows. The group check is deliberately not one the sweep can get wrong: twice on 2026-08-11 a source run of
  this daemon read the live one's processes as a dead life's leavings and killed four agent turns mid-answer,
  and no amount of care in this file would have helped, because the file doing the killing was a checkout from
  a branch that predated the care.
- [src/platform/boot/container-owner.ts](../src/platform/boot/container-owner.ts): which daemon this one is. This repository
  is the sandbox, so an agent working in it runs the daemon from source to watch a change work, and everything
  held once per container (HOME, the tmux server, the process sweep, the translator, the platform registration,
  the scheduler, the drafts publisher, the CI hooks) is claimed rather than assumed. A daemon that finds a live
  claim: or finds `INTENTIC_AGENT_SESSION` on itself, the badge
  [src/agent/tools/agent-terminals.ts](../src/agent/tools/agent-terminals.ts) puts on every command a conversation runs, which
  everything forked from one inherits, comes up a GUEST: it serves its own routes, converges only roots nobody
  else holds, and sweeps nothing. A claim binds the pid to its kernel start-time tick: container restarts commonly
  reuse pid 7, and the new daemon must take over that dead process's claim rather than locking itself into the
  guest posture. Two incidents wrote this: 2026-07-31, where a dev run took the live sandbox's
  git access down, and 2026-08-11, where one killed four agent turns mid-answer and did it again 26 minutes
  later from roots that were safely under `/tmp`.
- The four change feeds that keep the browser fresh without it ever asking twice, all riding the one `/events`
  stream: [src/workspace/watch/workspace-watch.ts](../src/workspace/watch/workspace-watch.ts) (files),
  [src/workspace/watch/repo-watch.ts](../src/workspace/watch/repo-watch.ts) (the repo set, and the one memo of it every
  reader shares — the discovery walk used to run again inside each Changes scan),
  [src/git/remote/ref-watch.ts](../src/git/remote/ref-watch.ts) (refs), and
  [src/system/runtime-watch.ts](../src/system/runtime-watch.ts): everything that is RUNNING rather than written:
  tmux sessions, panel dev servers, listening sockets, the agent's browsers and its subagents. The first three
  start from a file; the fourth cannot, which is why it is announcements from the subsystems that do the thing,
  plus one shared sampler that runs only while a browser is connected, plus the one announcement that arrives
  from outside the daemon: the image's zsh touches a file in `/run` on every preexec and precmd
  ([src/terminal/prompt-signal.ts](../src/terminal/prompt-signal.ts)), because a command starting and finishing
  inside a live pane is the one transition tmux tells nobody about, and sampling it is what used to leave the
  terminal panel's busy dot lit for seconds after the command was done. The file feed has one more
  subscriber than the browser: [src/derived/sidecar-service.ts](../src/derived/sidecar-service.ts), which spawns
  the baked `fileq` CLI (`_sandbox/fileq`) to keep a markdown shadow of every binary workspace file (docx,
  pdf, images, audio) converged under `.intentic/local/cache/derived/` — gated by the `sidecars` setting,
  serialized to one child at a time, and sweeping the whole tree when the setting flips on.
- [src/peers](../src/peers), the substrate under everything of the user's that DIALS this sandbox and then serves
  a contract back over the socket it opened: their computer, their browser, one of this sandbox's own runners.
  Three doors, one shape, written once: the hub (which peers hold a socket right now, the typed client for
  each, a heartbeat that drops a lid that closed without a close frame, the facts a peer last reported kept for
  its card after it goes), the store (a single-use pairing bound to ONE id, redeemed once for a durable token
  whose digest lives on /history, over `store/enrollment.ts`), the routes (the socket authenticated by its
  first frame, `enroll`, the owner's `pair`/roster/revoke, and the MCP bridge the agent's tools point at, a
  PIPE that parses no tool schema so a peer learns a tool without a daemon release), the capability handler,
  the tool builder and the one invariant (a live socket the store no longer vouches for). What a door declares
  is the data that varies, in a `PeerDoor` beside the code that is genuinely its own:
  - [src/hosts](../src/hosts): `host-peer.ts` is the door (the grant is the capability's config, pushed down on
    every connect; a `run_command` headed for somebody's laptop is judged against the owner's safety policy
    before it crosses, `host-command-gate.ts`), `host-seed.ts` the card the setup flow creates for the machine
    that installed this sandbox, granted its sandboxes and nothing else, and the Devices view's data
    (`device-reports.ts`, served by `devices.routes.ts`). Acting on one of those sandboxes STREAMS, because the
    slowest of those actions pulls an image for minutes; the scope behind it is checked on the machine and
    never here. `device-commands.ts` is the other door: one of the machine's OWN CLI actions run from a button
    rather than through an agent, a closed enum whose argv is built here from the name, never sent by the
    caller, because the socket underneath also carries `run_command`. Readings are served from memory and
    refreshed behind the answer, each carrying its own `capturedAt` for the view to age it by.
  - [src/webext](../src/webext): `webext-peer.ts` is the door, with the three differences a browser makes: a
    tighter heartbeat (an MV3 service worker is killed after 30s of silence), facts re-asked when a card reads
    them (a grant can be revoked in Chrome's own settings), and a bridge that is NOT a pure pipe: every tool
    result that could carry page text is sealed in the outside-content envelope on the way back, because a
    browser answers with websites and an old or tampered extension must not be able to skip that.
    `webext.routes.ts` holds the two credential doors: `session-import.ts` is the one a credential comes IN
    through (a site's cookies, handed over by the owner's click, written into a `browser` capability's
    Chromium profile by launching it headless, never a tool result, because a tool result is something the
    model reads), and `session-export.ts` the same door outbound, lending a sandbox account's session to the
    person's own browser for a step no remote browser can do.
  - [src/runners](../src/runners), both halves, since a runner IS this daemon in another posture. Parent half:
    `runner-peer.ts` is the door (every pairing burned on redemption because it always ends up in a
    container's env; no grant and no bridge, the contract is typed end to end), a per-repo git door (stock
    smart HTTP off the real git dirs), the turn dispatch the remote arm of agent.routes drives, plus the
    credential doors: per-turn access tokens and mid-turn re-mints resolved by the same code local turns use,
    and the translator re-served behind the runner's own bearer, so a remote turn spends THIS sandbox's model
    providers and no refresh token or auth file ever leaves. Runner half: identity, the outbound link serving
    the runner contract, a workspace mirror moved by git both ways, and the parent-first credential source
    harness-credentials consults. A dispatched turn re-enters `streamAgent` on the far side, which is the
    whole design: same code, different machine. Parity is itemized through the definition surface: a runner's
    hello declares its settings as a settings-only `sandbox.toml`, the parent diffs that (plus the overlay
    hashes) into per-line drift on the runner's summary, and the sync door (`runner.routes.ts`) pushes this
    sandbox's settings down the live link (replace semantics — the parent is a runner's whole authority).
    `docs/remote-runners-plan.md` at the workspace root says why every seam sits where it does.
- [src/tunnel](../src/tunnel), the substrate under the two things the sandbox holds a TUNNEL for: a VPN into
  somewhere of the user's ([src/vpn](../src/vpn)) and a geo exit out of somewhere else ([src/exit](../src/exit)).
  The second was written as the first one's shape retold and said so; what was retold is here once: the
  interface-name rule (IFNAMSIZ, a hash fallback, an `x` prefix so the two kinds cannot meet in one netns),
  the advisory up marker, the manifest join (`tunnelEntries`, `tunnelEntry`, the "not carried yet" sentence a
  dial answers with before the rebuild), the one-move-per-id streaming route (`heldStream`: refuse the second
  dial, end on the link's own state, surface a failure as both an error frame and a thrown error), the
  capability handler both kinds are instances of (`tunnelHandler`: store first so the fragment lands, write
  the shared skill, take the old one down, dial only when wanted and only when the client exists, drop the
  skill with the last entry), wg-quick as both kinds drive it, and `net-probe.ts`, which reads a live tunnel
  back off the machine. What a kind keeps is exactly what differs: its link's shape, its drivers' SPI, and
  what a start owes before it counts (an exit must prove its country from the outside; a vpn's interface is
  the whole answer).
- [src/guard/guard.ts](../src/guard/guard.ts): the one gate every gated action consults (fail-closed); [src/guard/actions.ts](../src/guard/actions.ts) is the catalog of decisions, and [src/guard/command-gate.ts](../src/guard/command-gate.ts) is the one that can park a running turn on a card. It runs four tiers and only the last interrupts anybody: TRIAGE (the classifier), the HARD RULE (`commandRun`, un-waivable, one class), the JUDGE (a model reading the owner's policy), and the PERSON. The last two are the owner's to decline (`settings.commandJudge`: `off` never calls the judge, `watch` calls it and records every verdict while holding nothing, `on` lets the verdict decide) — a tier that spends money and interrupts people has to be refusable, and the redesign had quietly made itself the one part of the sandbox you could only opt further into. The hard rule is outside all three, so no setting can leave a turn with nothing between it and a formatted disk, which is what makes the switch offerable. THE CARD'S TITLE IS THE JUDGE'S OWN SENTENCE, not a class: it used to be `This command would ${LABEL[matches[0]]}`, the first class the catalog matched, in the catalog's own order — so a command that cleaned a build directory and then published a package read "This command would delete files recursively" over a sentence about npm, with the `rm -rf` marked beneath it as the fragment it was stopped for. Every word of that card except the sentence was about the wrong half of the command, and it is how a gate comes to look like it is crying wolf about deletions when it never was. Only the hard rule still titles a consequence, because it alone is a typed verdict over a named class. `credentialUse` is the catalog's fifth action and the only one whose sole DENY is "there is nobody to ask": a gate is never a ban, so an unattended turn and a turn with no live conversation are refusals while everything else is a hold that asks a named person (src/secrets/credential-gate.ts). WHAT a command is, as opposed to what may be done about it, lives one package out in
  [sandbox-contract/src/policy/command-classes.ts](../../../_shared/sandbox-contract/src/policy/command-classes.ts): the same table the
  machine agent reads before running anything on somebody's own computer, so the two enforcement points cannot
  drift about what counts as a recursive delete. It is regex over shell text and says so: friction for
  well-behaved work, never the boundary for a hostile one, which stays structural (the container, the
  worktree, the land gate, an automation's tool allowlist). It no longer DECIDES anything, which changes what
  its patterns should optimise for — a false positive costs one model call rather than one interruption, so
  anyone tuning one should widen rather than narrow it. The classifier reports WHERE as well as whether
  (`matchCommand` hands back the offsets each pattern fired at), and the gate carries those onto the card with
  the program itself, so the browser marks the fragment that actually stopped it rather than re-running the
  patterns and marking whatever a second copy of them finds.
  `commandRun` in actions.ts is all that is left of the three layers that used to decide here (the owner's
  `commandRules`, a standing floor, and a taint floor over deletes and leaving credential reads): all three
  read a regex match, so none could tell a string being written to a file from a command about to run. The
  taint bit is a FACT handed to the judge now, which is what lets "be strict about deletes after reading a web
  page" be a sentence the owner can narrow or drop. What stayed typed is the handful of classes where nothing
  recovers — a model can be argued into anything by text inside the command it is reading, and being wrong once
  about a block device costs the machine.
- [src/guard/credential-files.ts](../src/guard/credential-files.ts): the fact under `secrets.access`. Patterns are
  the right instrument for a verb and the wrong one on their own for a FILE — `~/.npmrc` earned the class
  because that name usually holds a token, which meant cards over registry config, over dotenvs holding a port
  number, over `~/.ssh/known_hosts`, and over paths that were not there at all. This runs on the machine that
  is about to run the command, resolves the path the classifier marked, reads the file, and asks
  [sandbox-contract/src/policy/credential-material.ts](../../../_shared/sandbox-contract/src/policy/credential-material.ts) whether there is
  anything in it. It may only ever SUBTRACT, and only on evidence: a glob, a variable, a directory, a remote
  path, an unreadable or oversized file all answer "cannot tell", which leaves the class exactly where the
  pattern put it. The asymmetry is the design — a wrong "yes" costs one card, a wrong "no" un-gates a real
  credential read — and the reason it is worth having at all is that a card raised over an empty file is not a
  near miss but noise, and noise is what teaches an owner to answer cards without reading them.
- [src/agent/models/role-answer.ts](../src/agent/models/role-answer.ts): what a one-shot reply has to BE before a helper may
  use it, and the reason every one-shot caller now asks for a value instead of text. A session title, a
  commit subject, the sentence on a permission card and a loop's verdict all get written into a durable field,
  so each of them used to own the same guards separately — and the family kept growing on one caller at a time:
  a spent allowance arriving as prose, then an auth failure (four fleet cards renamed), then a model answering
  the asker instead of the ask, then a rung TYPING OUT the tool call it would have made
  ([src/agent/providers/failure-sentences.ts](../src/agent/providers/failure-sentences.ts), `isToolCallStandIn`: four more cards and
  three commits named `[tool_call: glob for pattern '**']`, because OpenCode prepends its own 27k-character
  coding-agent prompt, whose worked examples demonstrate exactly that, to every Gemini rung). The ask carries
  the contract now, and [src/agent/models/role-model.ts](../src/agent/models/role-model.ts) reads the reply INSIDE the walk, so
  a rung that answers unusably is a rung that refused and the next model down gets asked — where the old
  post-hoc checks ran after the chain was finished and left the helper with nothing however many working
  accounts sat below. It is the one refusal that earns no memo: wrong shape is a sample, not a condition.
  WHICH LOOP RUNS A RUNG is the adapter's, not the walk's: each runtime's one-liner is its adapter's `oneShot`
  ([src/agent/providers/adapter.ts](../src/agent/providers/adapter.ts); `claude/claude-one-shot.ts` on the harness's own credentials,
  `cursor/cursor-one-shot.ts`, `gemini/gemini-one-shot.ts`), so the walk asks the adapter the contract names for
  the provider exactly as a turn does, and a runtime with no helper is a refusal it steps over. AN UNSET JOB IS
  REFUSED BEFORE ANYTHING IS READ ([src/agent/models/role-model-unset.ts](../src/agent/models/role-model-unset.ts)): a helper
  role whose list is empty used to derive a ladder from whatever was connected, so a sandbox nobody had
  configured spent an account on every landing, on a ranking this repo invented. Not set means not set, and
  because that is the owner's answer rather than a fault it is its own error class — the two callers that must
  stay silent ask `roleModelIsSet` and never start (a landing would otherwise open a "writing…" chip and end it
  red), and the safety gates catch it and say the judge has no model rather than that it could not be reached.
- [src/agent/tools/command-judge.ts](../src/agent/tools/command-judge.ts): whether a flagged command should run, asked of a
  model that has read the owner's written policy. The layer that replaced a table of per-class regex verdicts,
  and the reason it had to: the classifier's match used to BE the card, so `echo "rm -rf /"` written into a
  README, `rg 'rm -rf'` over the tree, and an actual recursive delete all produced the same interruption. No
  threshold separates those, because telling them apart is an act of understanding. So the classifier keeps its
  job and loses its authority — it is TRIAGE now, deciding only that a judge should look, which is why being
  over-inclusive costs one model call instead of one interruption. The judge is handed three things and the
  boundary between them is the safety property: the POLICY and the DAEMON'S FACTS (which classes fired, the
  cwd, whether this turn has taken in outside content and from where, whether anybody is watching) are trusted;
  the PROGRAM is fenced and labelled as data. The gated model contributes nothing — not its reasoning, not its
  stated intent — because a verdict whose persuasive half was written by the thing being judged argues for its
  own approval, and the turn that raises most of these cards is exactly the one that has read a stranger's
  words. Wired as a callback the gate is handed rather than as anything guard/ knows about, so the account
  chain stays behind one seam. It can still be argued with, and two things bound that: the hard rule applied
  before it is ever called, and tier 0. WHICH MODEL judges is the `safety-judge` role's own list, like every
  other job in this sandbox that picks one (contract `model-roles.ts`) — it used to be the single exception, a
  second setting bolted beside one shared "quick model" chain because a verdict visibly could not be configured
  with commit messages. That exception is now the rule. Its pins are read when the TURN IS PLANNED and handed
  down (`askRoleModel`'s `pins`), so one turn is judged by one policy document and one model however long it
  runs; every other helper here writes a sentence somebody can edit afterwards, while this one decides whether a
  card is raised at all, and its input is the only adversarial one in the family.
- [src/safety/safety-policy-store.ts](../src/safety/safety-policy-store.ts): the policy itself
  (`.intentic/config/safety.md`), the one state file whose reader is a model rather than a parser — so it is
  prose, travels verbatim in both directions, and has no shape to be wrong in. Absent is a normal state, not an
  unconfigured one: the shipped default describes the posture a fresh sandbox already has. The AGENT may edit
  it when asked, and that is safe for a stated reason — the document governs FRICTION, never boundaries.
  Nothing in it can widen a machine's scopes, unfence the JS runtime, reveal a secret or reach outside the
  container. [src/safety/safety-log.ts](../src/safety/safety-log.ts) is the other half of the Safety page and the
  thing that makes the first half writable: nobody can author a policy for behaviour they cannot see. It
  records the ALLOWS too, which are most of them and the ones that matter — a card you answered is something
  you already know about, and "why wasn't I asked about that" is the question it exists to answer.
- [src/hosts/host-command-gate.ts](../src/hosts/host-command-gate.ts): the same pipeline over a command headed for
  one of the owner's own computers, run on the daemon before it crosses the tunnel. Enforcement still lives on
  the machine and does not move — but the machine has only two answers (`destructive` on or off) and cannot
  park a card, so the owner's only choices used to be "always" and "never", and in practice the switch stayed
  off. The daemon can ask. It only ever makes the machine stricter: an allow here is not permission, it just
  means the daemon had no objection of its own.
- [src/guard/outside-results.ts](../src/guard/outside-results.ts): the mid-turn half of the envelope around
  anything the owner did not write — it wraps every MCP server except the daemon's own control servers (an
  exception list a conformance test pins, so a server added without a decision fails the suite); the other
  seam is a stranger's message at turn birth (src/automations/scheduler.ts). The envelope and its neutralizer
  themselves live in `@intentic/base/outside-text`, shared with webq's saved pages and fileq's sidecars, which
  must neutralize identically. [src/guard/turn-taint.ts](../src/guard/turn-taint.ts) is the one-way bit the
  wrapping sets and the command gate reads.
- [src/browser/sessions/session-store.ts](../src/browser/sessions/session-store.ts): whose browser an account lives in. An
  IDENTITY (one email address, a capability of its own) owns one persisted Chromium profile; the platform
  accounts born from it share that browser: which is what makes a site's "Continue with Google" one click:
  while a hand-connected account keeps its own. All of them stand behind ONE MCP server, `browser`
  ([bin/browser-router.mjs](../bin/browser-router.mjs), configured by
  [src/browser/tools/browser-tools.ts](../src/browser/tools/browser-tools.ts)): every tool takes an `account` argument the
  router resolves to a profile, so the prompt pays for one schema set however many accounts are connected:
  before this every account pinned its own copy of ~21 tool schemas. The router also answers the harness's
  startup handshake from a version-keyed schema cache and spawns an account's real node+playwright backend
  only when a call names it: before that, every turn started one such process per connected account, ~3.5 GB
  a turn for browsers mostly never touched: and an `account` outside the turn's persona-filtered manifest is
  refused by name, which is what makes the persona rule hold at the tool layer. The same collapse holds for
  the SKILLS: one `identities` skill and one per connected SITE, each account a roster line, converged by
  [src/capabilities/account-skills.ts](../src/capabilities/account-skills.ts): never a per-account clone. The
  owner signs the email provider in themselves in a live
  window (`browser-profile.ts`); the agent connects accounts through
  [src/browser/tools/accounts-tools.ts](../src/browser/tools/accounts-tools.ts): stored credentials are typed for it, never
  shown to it; a linked mailbox answers "the newest code from this site" and nothing more
  (`email-codes.ts`); opening a NEW account is gated on the identity card's own switch
  ([src/capabilities/open-account.ts](../src/capabilities/open-account.ts)); and anything only a person can clear
  parks on a help request the owner answers over the live view.
- [src/browser/cast/live-view.ts](../src/browser/cast/live-view.ts): what "watching a browser" actually sends, and the one
  place the choice is made for both surfaces. A browser is headed on a virtual X display OF ITS OWN
  ([src/browser/cast/display.ts](../src/browser/cast/display.ts)), so the display is the browser: H.264 grabbed off it
  ([src/browser/cast/videocast.ts](../src/browser/cast/videocast.ts)) carries the whole window — chrome, the real cursor,
  an open `<select>`, the autofill drop-down, the file picker, the permission prompt — and XTEST drives that
  same display ([src/browser/cast/xinput.ts](../src/browser/cast/xinput.ts)), so all of it is clickable. One coordinate
  space containing everything, which is what let the drop-down reimplementation and the HTML address bar be
  deleted rather than maintained: both existed only because the old picture was one page's compositor surface
  with nothing outside it. It is also ~1% of the bytes: three seconds of a settled page is ~23 kB where one
  JPEG frame of it was 150-250 kB. The CDP screencast ([src/browser/cast/screencast.ts](../src/browser/cast/screencast.ts))
  remains for the one case with no display to grab — a sandbox without the browser pack, whose Chromium can
  only run headless — and says so in its `ready` so the client builds the right decoder.
- The session a site's sign-in lives in crosses BOTH ways, on its own HTTPS door rather than the socket,
  because a socket answer is an MCP result and an MCP result is something the model reads:
  [src/webext/session-import.ts](../src/webext/session-import.ts) takes one from the owner's own browser into a
  sandbox profile, and [src/webext/session-export.ts](../src/webext/session-export.ts) lends one back for the
  steps no remote browser can perform — a passkey bound to an authenticator they hold, a hardware key that has
  to be touched, an SSO that checks the device.
- [src/secrets/secret-registry.ts](../src/secrets/secret-registry.ts): every stored credential under its stable
  name, and the `{{secret:name}}` reference language built on it: masking rewrites values to references in
  every tool result ([src/agent/tools/agent-redaction.ts](../src/agent/tools/agent-redaction.ts)) and in the terminal lane
  (`bin/cleaners.mjs`), and the two exits resolve them back: the shell rewrite inside the tmux wrapper
  ([src/agent/tools/agent-secrets.ts](../src/agent/tools/agent-secrets.ts)) and the browser's `type_secret`
  ([src/browser/tools/secrets-tools.ts](../src/browser/tools/secrets-tools.ts)): each use landing on the ledger
  (`src/secrets/secret-uses.ts`) the inventory joins as "last used".
- [src/secrets/credential-gate.ts](../src/secrets/credential-gate.ts), the release gate: the one consult every
  exit and every mount shares, so the rule cannot be enforced at three doors and forgotten at the fourth. The
  payment gate's shape (card raised from outside the turn generator, pushed into the live run, two different
  no's) with one difference that is the whole feature: the card is addressed to a NAMED LIST, so the waiter
  carries a `mayAnswer` the reply route checks against the verified identity on the request
  ([src/agent/tools/agent-requests.ts](../src/agent/tools/agent-requests.ts)), and a stranger's click — yes or no — is
  refused with the card left standing. The policy is a file off the workspace
  ([src/secrets/credential-gates.ts](../src/secrets/credential-gates.ts), which refuses an unreadable policy
  rather than reading it as "nothing gated"); the "rest of the conversation" releases are in memory
  ([src/secrets/credential-grants.ts](../src/secrets/credential-grants.ts)) and deliberately die with the daemon,
  because a release that outlived every turn and card it was given in would be consent nobody is present for.
- [src/wallet/payment-offer.ts](../src/wallet/payment-offer.ts), the payment gate: probe unpaid, parse the
  endpoint's challenge, check the owner's caps, card it (or not, inside their band), have the platform sign,
  retry with payment, receipt what settled. The ledger row ([src/wallet/wallet-ledger.ts](../src/wallet/wallet-ledger.ts))
  opens BEFORE the signature is asked for: an unwritable ledger refuses the payment, and an in-flight row
  holds its amount against the daily cap so two turns cannot race one budget.
- [src/personas/personas.ts](../src/personas/personas.ts): who a turn is and what it may do, resolved in one
  function whose header carries the reasoning for why accounts default to nothing and powers default to
  everything. Identities count as accounts there: an unattended wake that names no persona loses them first. [src/personas/persona-scope.ts](../src/personas/persona-scope.ts) is the folder limit and the
  "change the sandbox" switch as a PreToolUse hook: a refusal, honestly weaker than the container, and the
  card's own UI says so where it is set. Nothing is seeded: a fresh workspace has no personas, and
  [src/personas/front-desk.ts](../src/personas/front-desk.ts) is the one card the daemon writes by itself: the
  read-only front desk a public web chat answers through, created when a Front Desk is saved rather than at boot.
  [src/personas/persona-kit.ts](../src/personas/persona-kit.ts) is the folder beside each card, shaped as a plugin
  so the runtime's own loader reads that persona's prompt, skills and tools and this daemon parses none of it.
- [src/agent/context/conversation-context.ts](../src/agent/context/conversation-context.ts): which part of the workspace a
  conversation carries. The answer is on the persona card the opening turn wears (contract `schemas/personas.ts`
  `context.repos`): a card names the nested repositories its conversations hold, root always, and a conversation
  wearing no card, or a card that says nothing about it, carries everything. Decided on the turn that creates
  the conversation's worktrees and recorded on the registry entry beside them; every later turn hands the record
  back to `ensure` in [src/agents/worktrees/worktrees.ts](../src/agents/worktrees/worktrees.ts), whose `selection` creates checkouts
  only for the named repos and brings a recorded composition to it, a repo joining at main's head or from its
  parked branch, a repo leaving with its remainder committed and its branch parked.
  [src/agent/context/context-note.ts](../src/agent/context/context-note.ts) is what the model is told about it, on the opening
  turn and after a compaction: the repositories carried, and the live ones not, counted out loud, because a
  directory that is not there reads like one that was deleted. Static by design: a card is the sandbox's one
  description of a working posture, so every conversation on it opens on the same tree with the same prefix,
  and the only per-chat decision is WHICH card, which [src/agent/prompt/persona-router.ts](../src/agent/prompt/persona-router.ts)
  answers from the first message (`docs/context-composition-plan.md` at the workspace root says why not a
  per-session pick).
- [src/agent/prompt/system-prompt.ts](../src/agent/prompt/system-prompt.ts): what the model is told before the conversation
  starts, composed once per turn for whichever runtime is about to serve it. Its header carries the split that
  makes the setting honest: which guidance is a fact about the WORKSPACE or the image (the reference shelf, the
  public outbox, `rg` being the search binary that is installed) and therefore travels to every runtime, and
  which names a mechanism only the Claude Code loop wires (the question and plan cards, the checklist tools, the
  secret references, the outside-content envelopes, the browser servers, the diagnostics server, the
  `run_in_background`/watch seams that exist so a turn never polls a build with `sleep`, and the `intentic`
  skill). It also says what the agent is INSIDE OF: the base prompt names the product in four words and the
  Claude preset never does, and an agent that knows only that answers questions about the product from its
  training, so one unconditional block gives the identity, points at the skill, and states the precedence rule
  that a workspace's AGENTS.md is the owner's instruction rather than a description of the product.
  [src/runtimes/codex/codex-instructions.ts](../src/runtimes/codex/codex-instructions.ts) is the Codex half: two
  undocumented config keys, verified by reading what reached the wire.
- [src/agent/prompt/workspace-memory.ts](../src/agent/prompt/workspace-memory.ts): the owner's own standing rules,
  the workspace's `AGENTS.md` files from the root down to the folder the turn starts in. Composed here rather than
  left to the runtime, because the loops disagree about both the filename and the ceiling — Claude Code walks cwd up
  to `/` reading CLAUDE.md, Codex reads AGENTS.md and stops at the enclosing `.git` (so a persona starting in a
  nested repo lost the workspace's rules), and Pi and ACP read no such file at all. It rides the same seams as the
  persona note, and is the one thing a custom system prompt does NOT drop: "nothing added" is about this product's
  guidance, and these are the owner's own words.
- [src/agent/prompt/workspace-map.ts](../src/agent/prompt/workspace-map.ts): the AREAS of the project a run starts in, read off
  the filesystem when a conversation opens and prepended to its first message (opt-in: `workspaceMap`). Rooted at
  where the run actually begins (a persona's start folder, an isolated worktree) rather than at `/work`, and
  the shelf it is standing in is the one that opens — or, for a run standing at the project root, the area
  holding most of the project, which across 470 mapped conversations here was every run, and that area is the
  one 97.7% of them opened a file under. Every rule in it is structural rather than named, so it
  answers the same way in a repository shaped like nothing here: areas are whatever directories a project has, a
  `packages/`-style shelf is recognised as a directory of manifest-bearing directories, and each line's purpose
  is that folder's own manifest description or the first prose line of its README: empty where there is neither,
  never invented. It is REGENERATED and never stored, which is the whole argument for it being a mechanism
  instead of a paragraph: over the ten days that motivated it, this repo's two busiest top-level directories
  stopped existing and ten sessions went on naming them.
- [src/auth/role-floor.ts](../src/auth/role-floor.ts): the minimum trust tier per route, in one table. [src/auth/auth.ts](../src/auth/auth.ts) resolves who a caller is (owner TOFU, members with granted roles); the floor decides what that tier reaches. The plain-Hono routes that gate on the owner share one pair of gates (`owner-gates.ts`: the maintainer-equivalent operating gate, and the ownership gate reserved for membership) and sit beside it: the roster (`members.routes.ts`), control tokens (`control-tokens.routes.ts`), and browser credentials — the WebSocket ticket, sign-out-everywhere and retirement (`access.routes.ts`). [src/auth/control-tokens.ts](../src/auth/control-tokens.ts) is the program's credential: hashed at rest with an optional expiry and a last-use mark, and its scopes (`read`/`drive`/`land`, plus the `editor` slice) are DERIVED from the same role floors a member is held to, so a route added tomorrow lands in the right rung by its floor. [src/auth/door-tokens.ts](../src/auth/door-tokens.ts) holds the credentials behind the public doors (an event automation's webhook, a workflow's release gate, a bug intake's key) in `.intentic/secrets/doors.json`, out of the versioned manifests that declare them, and hands each to an operator only ([src/auth/operator.ts](../src/auth/operator.ts)) through the route that lists the automation or workflow; a door takes its token as `?token=` or as a bearer header. [src/auth/grants.ts](../src/auth/grants.ts) is the one table of every non-bearer credential and what each reaches; a control token's admission hands back a principal ([src/auth/principal.ts](../src/auth/principal.ts)) that the turn it starts is attributed to ([src/agent/run/turn/turn-actor.ts](../src/agent/run/turn/turn-actor.ts): the activity log's `actor`, the agent card's `startedBy`).
- [src/workflows](../src/workflows): workflow scheduling, immutable run snapshots, restart recovery, run-ledger
  retention, and complete, resolved handoff artifacts; [src/loops](../src/loops) drives each individual step.
