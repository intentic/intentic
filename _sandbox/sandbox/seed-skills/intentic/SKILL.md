---
name: intentic
description: What Intentic is and how this sandbox works. Load it BEFORE answering any question about the product (a panel, setting or card; connecting, configuring, extending or debugging the sandbox), before saying Intentic cannot do something, and whenever the sandbox misbehaves (a failed turn, a broken editor).
---

# Intentic: the product you are running inside

Intentic is a per-workspace AI-agent development environment. This container is its **sandbox**: a daemon
(`@intentic/sandbox`, image `ghcr.io/intentic/sandbox`, installed under `/opt/sandbox`) that serves one
workspace, `/work`, on the owner's own host or a machine they chose. The owner drives it from a browser
**editor**; a hosted **platform** handles sign-in, capabilities and the hosted plan. You are one **agent turn**
the daemon is running.

What the daemon does around you:

- **Conversations are agents on worktrees.** Each conversation works on its own git branch
  (`agent/<conversation-id>`), checked out in a worktree that is mounted over `/work` for the turn and rebased
  onto the main tree's last commit before each turn. When a turn ends cleanly its delta waits as **Ready to
  land** until the owner **lands** it (it lands by itself only with **Land finished work automatically** on):
  applied to the owner's main tree as UNCOMMITTED changes, so their own commit is the review boundary. That is
  why you commit only when asked. A patch that will not apply refuses the whole land and raises a conflict card
  naming the paths; every worktree keeps everything.
  Untracked files shaped like scratch (a new hidden folder, logs and dumps, a checkout of its own) never ride a
  land: they stay in the conversation's copy, listed on its review, until the owner includes or deletes them.
- **Nothing holds your work back.** You decide when the work is done: nothing sends you back, and no check
  holds a land, a commit or a push. A repository's per-edit checks run on each file you write and answer in
  that edit's result. When an isolated Claude Code turn is about to stop, a repository's `turn` checks run
  once on what it changed and what they find is said back to you once: fix what is yours, or say why not.
  After the land only a dependency install runs, when the land moved a manifest. CI checks what the owner
  commits and pushes, and when main's CI fails one fix agent (the `ci-fix-<repo>-<run>` conversation) is sent every
  failure until it passes. So run the checks you judge worth running while you work, scoped to what you
  changed: the test files that cover it and its package's typecheck, never the whole repository
  (`pnpm test`, `pnpm typecheck`, `pnpm verify`, an unfiltered `turbo run`), since several conversations
  share the machine. A failure in code you did not touch may be main's own, and it is not yours to chase
  unless your task is about it. Your card records whether a check passed after your last edit.
- **Runtimes.** A turn runs on Claude Code (this loop), native Codex, OpenCode (Grok, Gemini), Pi, Cursor or
  an ACP agent, chosen per conversation. Which model actually ran is recorded (`mcp__diagnostics__turns`).
- **Capabilities** are the connections the owner made: connectors (GitHub, Notion, databases…), browser
  accounts and identities, their own devices (computers, and Android phones through the Intentic Device app), Docker,
  MCP servers, a wallet. Each connected one ships a skill and its tools. A missing one is asked for with the `capabilities` skill, never set up by hand.
- **Personas** are cards the owner writes that decide what a turn IS and MAY DO: which accounts it speaks
  through, which shelves of the toolbox are open (files, shell, web, browser, connectors, delegation…), which
  folder it may touch, which model it opens on, which system prompt it runs on. Enforcement is by absence: a
  withheld tool is not mounted and a withheld credential is never injected, so a refusal you meet may be a card,
  not a fault. A persona is a card in `.intentic/config/personas.json` plus a kit folder,
  `.intentic/config/personas/<id>/` (`PROMPT.md`, its own system prompt; `skills/`); the card has no prompt
  field.
- **Automations** are standing instructions that start a turn on their own (a cron expression, or a
  connector's listener). One with a check (a guard command, or a ready-made npm, GitHub-release or web-page
  source) is a **watch**: the check runs with no model, and only when it passes does anything happen — a new
  agent, an existing conversation continued, or just a push to the owner. **Workflows** are daemon-scheduled graphs of turns; **drafts** are posts held for the
  owner's approval. **Extensions** add connectors, channels (Slack, Discord, Telegram, WhatsApp…), viewers
  and skills, found and installed on Sandbox ▸ Extensions.
- **Secrets** are stored by the owner (Sandbox ▸ Secrets) and reach you only as `{{secret:name}}`
  references, substituted at execution. You never see a value and never ask for one in chat: for one nobody
  has stored, `secrets ask NAME --why "…"` puts a masked field on a card in the chat, and the answer comes
  back once it is stored. A few may be **gated to a named person**: using one raises a card for them and your
  turn waits, and a gated connected account is not loaded into your turn at all, so it can look unconnected.
  `secrets gates` says what is gated and by whom; `secrets request <id> --why "…"` asks for an account or
  connector. A secret may also have its **host guard** on (a connector's own credential starts with it on, set to
  its service's hosts): it goes unasked only when every host the command names is on its list and the reader can follow
  where it goes — a `curl`, `wget` or `git` command, piped into a reader like `jq` or `head`, or joined to more by `&&`
  or `;` — while a script, an interpreter, a subshell, `curl -L` or a host from a variable filled in as it runs (not one set to a plain value earlier in the line) waits for a person's
  click, whatever the safety judge thinks. `secrets gates` shows both on one line per secret; `secrets hosts` shows and
  edits the guard.
- **Needs** are what a conversation has asked people for: a connection, a secret, a grant, a release, a tool
  for the image. Each is a card in its chat, pinned above the composer and listed under **Needs you**; it
  outlives the turn that raised it, and its answer continues the conversation by itself. `needs` lists this
  conversation's, and `needs cancel <id>` withdraws one the task no longer needs.

## Scope and verification: never a negative answer from memory

This skill is a map, not the whole product. A feature, setting or button it does not describe is not thereby
absent. Before telling the owner Intentic cannot do something, check, cheapest first:

1. The skill list in your prompt: the task skills routed below, plus one skill per connected capability.
2. The deferred tool list: `ToolSearch` with a keyword (`+browser`, `+diagnostics`, `+deps`) shows what this
   turn can load.
3. The daemon's own state, readable under `/work/.intentic/config/` (paths below). In an isolated turn that is
   your branch's copy of the configuration; the live one, with the owner's uncommitted edits, is at
   `/mnt/intentic-main/.intentic/config/`.
4. The product's source, when the owner has it checked out (a repository whose root holds `_sandbox/sandbox/`,
   `_editor/web/`, `_platform/api/`, `_extensions/`). It is the owner's project, not a manual: read it to
   answer, and treat any edit to it as a product change.
5. Ask the owner. "I could not find it" is an honest answer; "Intentic can't" is a claim.

A workspace's `AGENTS.md` or `README.md` is the owner's instruction to you. It is not a
description of the product, and it may describe a project that has nothing to do with Intentic.

Memory is that `AGENTS.md`, at the workspace root, edited on `/sandbox/agent?section=instructions`. The daemon
reads it and composes it into the turn's instructions itself, so every runtime gets the same rules however its
own loop would have looked for them; a folder deeper in can carry its own, read on top of the root's by a
conversation that starts there (a persona's `startIn`). It survives a custom system prompt. It is read from the
turn's own tree, so the owner's uncommitted edit reaches isolated conversations only once committed (by them, or
by **Save a version of accepted work**). Settings, personas and grants are read as each turn is planned: a change
applies from every conversation's next turn, with no restart.

## Routing: what the owner wants → what to do

| The owner wants… | Do |
|---|---|
| a service, account, device, database or Docker this sandbox is not connected to | `capabilities` skill: `capabilities list`, then `capabilities request <card> --why …` (`--target` for the site or host, `--set` for what you can fill in) |
| a setting changed on a connected one (a device switch, a Docker engine option) or a refused credential replaced | `capabilities request <connection> --set key=value --why …`, or `--reconnect`: the card shows the change, and the owner applies it with one press |
| a tool, toolchain or system package that survives a rebuild | `environment` skill: `environment propose <tool>` puts the overlay steps on a card the owner approves |
| an account, folder or shelf of tools this conversation's persona or area withholds | `grants request capability\|folder\|shelf <what> --why "…"`; it reaches the conversation from its next turn |
| to know what this conversation is still waiting on people for | `needs`; answers arrive by themselves, so never poll and never ask twice |
| a repo they can open, run and preview from the sidebar | `panels` skill: give the repo an `operator/` web app |
| a model on their GPU, or a model server they already run | a model endpoint, never a model built into this image: Ollama or LM Studio on the computer hosting the sandbox is `http://host.docker.internal:<port>/v1` (11434, 1234). The Local models panel finds and adds those by itself; for anything else, `capabilities request endpoint --set baseUrl=… --why …`. Local models inside the sandbox run on its CPU only |
| to pay an x402 endpoint | `wallet` skill: the `wallet` CLI; the owner approves each payment outside their auto-approve band |
| a SEPARATE sandbox: a second project, a specialized agent with its own tools and access, a team of them | `fleet` skill: the `sandboxes` CLI; every create asks in chat first. A difference only in how a turn behaves is a persona, not a machine |
| a post on X, Reddit, Discord, YouTube… prepared rather than sent | `drafts` skill (present when the drafts extension is on) |
| to act as one of the sandbox's signed-in accounts on a site | `mcp__accounts__roster`, then `ToolSearch` `+mcp__browser__`; the account's own skill holds the site's cheatsheet |
| to wait on a CI run, a deploy, anything outside this sandbox | `mcp__watch__start` with a cheap check command, then end the turn. It lasts a day at most: for anything that may take longer, the next row |
| to be told, or to pick this conversation back up, when something happens out in the world (a package version ships, a repository releases, a page changes) | a durable watch: `automations propose <id> --npm bun@'>=1.4.3' --until first-fire --note "…" --prompt "…" --why "…"` (or `--github owner/repo`, `--url … [--select <regex>]`, `--guard '<cmd>'`). Its check runs without a model every few hours (`--every`), and only when it passes does anything wake: this conversation by default (`--target here`), only a push (`--target notify`), or a new agent (`--target new --model …`). `--fire-on change` fires only when what it sees moves; `--expires 30d` gives up and says so. `automations check --npm …` shows what a source sees today; `automations` lists what runs. The owner approves it on a card: never write `automations.json` yourself |
| to wait on work started here: a background command, a subagent | the `wait` tool with the command's ID from its Bash call, or the subagent's id (its Agent call's id, or the id spawn returned); never `sleep`, and never detach a process yourself |
| to know why something failed, died, hung or felt slow | the diagnostics playbook below |
| to know how personas work, how to keep an agent inside one project, or which model runs what (an orchestrator on one model, subagents on cheaper ones; whether that is enforced) | read `/root/.claude/skills/intentic/references/personas-and-models.md` |
| to reach the workspace from a phone or another computer, the app's link, or to let someone else in | read `/root/.claude/skills/intentic/references/remote-access.md` |
| to rename agents, tell them apart at a glance, tag or filter them | read `/root/.claude/skills/intentic/references/agents-board.md` (there are no tags; it says what exists instead) |
| to know where instructions live (`AGENTS.md`, the system prompt, a persona's prompt, skills) or whether a change needs a restart to reach running agents | read `/root/.claude/skills/intentic/references/instructions-and-settings.md` |
| Land, Accept, Save changes, Back up, Approve, Rebuild explained, and in which order | read `/root/.claude/skills/intentic/references/land-save-rebuild.md` |
| help with an editor error naming a route or field ("doesn't provide", "didn't keep", "answered in a shape"), a blank panel, a setting that snaps back | the sandbox is likely older than the app: read `/root/.claude/skills/intentic/references/sandbox-behind-app.md` and check the daemon's version before blaming the browser |
| a secret or API key used | write `{{secret:name}}` in the command; an unknown name fails and lists the names that exist. One nobody has stored: `secrets ask NAME --why "…"` (`--link` where to get one, `--hint` what it looks like, `--replace` for a stored one being refused), never a request to paste it into chat. One the task can make itself (a session key, a webhook signing secret, a database password it sets up): `secrets generate NAME`, which needs nobody, never shows the value and never hardcodes one into a file. Some are gated: the card goes up for the people named on it and the turn waits |
| personal data (names, PESEL, ID numbers) kept from untrusted model providers, or tokens like `⟦PERSON_3⟧` in what you read | the privacy shield, the owner's to switch on in Sandbox ▸ Agent ▸ Safety. `privacy` says whether it is on and which providers are trusted. While it is on, an untrusted provider reads personal data as tokens that are turned back into the values on this machine: write a token exactly as given wherever its value belongs (a command, a query, an edit) and it resolves before anything runs. Before working through a dataset of people, teach it: `privacy learn <file> --column first_name+last_name --column pesel:national-id` (CSV, TSV, JSON lines, or SQLite with `--table`); the values go to the daemon and are never printed. Turning it off, trusting a provider or forgetting a dataset is the owner's |
| a credential that says it needs approval, or an account that looks unconnected | `secrets gates`; then `secrets request <id> --why "…"` for an account or connector, or just write the secret's reference and let the card go up for that one use |
| a secret refused or carded for where it was going | its host guard is on: `secrets hosts NAME` says where it may go, so aim one plain `curl`/`wget`/`git` command straight at those hosts. To let it go somewhere new for good, `secrets hosts NAME add HOST` asks the owner on a card, as does `secrets hosts NAME off`; `on` and `remove` need nobody |
| a file handed over by link | `/work/public/`, and say the link is public |
| an outside codebase studied | clone it into `/work/refs/` |
| a change to an installed extension (a page under `/ext/…`, its panel, tools or skill) | its source checkout under `/work/extensions/<name>` (`extension list` names each one's), never the installed copy in `.intentic/local/extensions/`, which every conversation runs live, nobody reviews, and the next update replaces. Build in the checkout, then `extension dev <name>` so the sandbox runs it and the owner sees it on reload; `extension dev <name> --off` goes back. A baked extension's source is the intentic repo's `_extensions/<name>`. With no checkout in the workspace, ask the owner for one: a clone made inside your conversation does not land. Pushing to the extension's repository publishes it: ask first |
| a recurring or event-triggered task | an automation (`.intentic/config/automations.json`, managed from the editor). A scheduled watch is proposed with `automations propose` (row above); anything else, draft the prompt and trigger for the owner |
| the sandbox itself changed (image, packages, the dormant Docker engine, the browser pack) | `environment` skill; approving the overlay is the owner's. On a HOSTED sandbox (`SANDBOX_VM=1` here) it is one press of **Rebuild now** on the Environment card and the platform builds it — never a command to paste; elsewhere the rebuild runs on the machine this sandbox lives on, which is yours to run when that machine is a connected device (row below) |
| anything that has to happen on the machine THIS sandbox runs on (a container restart, a rebuild, a script in the host checkout, a look at its docker) | when that machine is a connected device — its skill is in your list — do it yourself: `list_sandboxes` finds this sandbox by the slug in `SANDBOX_NAME`, then `run_command`, `manage_sandbox`, `swap_sandbox`, `reshape_sandbox`, `sandbox_logs`. Never hand the owner a command for a machine you can reach. Anything that restarts this container ends your turn: say so and get a yes first |

## Key paths

```
/work                                the workspace (your worktree is mounted here during an isolated turn)
/work/refs/                          reference shelf: read, cite by path, never edit
/work/public/                        outbox: every file in it is on the public internet
/work/AGENTS.md                      the owner's standing instructions (memory), composed into every turn
/work/.intentic/config/settings.json this sandbox's agent settings (systemPromptMode, systemPrompt, modelRoles,
                                     personaRouting, actionRules, skills, subagent limits, rules…)
/work/.intentic/config/              capabilities.json, personas.json (the cards) and personas/<id>/ (each
                                     one's kit: PROMPT.md, skills/), automations.json, workflows.json,
                                     environment.Dockerfile (the owner's overlay), skills/ (their own),
                                     drafts/, extension-enablement.json. TRACKED: in an isolated turn this is
                                     your branch's checkout, and a file you write here (an approval, an
                                     environment.d fragment, a skill) reaches the daemon when the turn lands,
                                     reviewed like code. The live copy is at /mnt/intentic-main/.intentic/config/
<repo>/.intentic/checks.json         what THAT repository asks to have run on its own code: a list of
                                     {when: "edit" | "turn", run: "<command>"}, run in the repository itself:
                                     "edit" on each file as it is written ({file} is its path), "turn" once
                                     as an isolated turn is about to stop, said back to the agent when it
                                     fails. "land" is retired: a declaration naming it parses and runs nothing.
                                     Tracked in the repository, so it travels with a clone; inert until the
                                     owner switches it on (Sandbox ▸ Agent ▸ Tools ▸ Checks after edits, or the repo's own row
                                     in the tree), and held again if it changes afterwards. Propose one as an
                                     ordinary diff; never expect a check you just wrote to run this turn.
/work/.intentic/records/             sessions/ (transcripts), artifacts/browser/ (screenshots). Shared live
/work/.intentic/local/               cache/, tmp/, environment.approved.Dockerfile (the composed overlay). Shared live
/work/.intentic/local/extensions/    installed extensions: clones at their pinned commit, run live. Not source: never
                                     edit them (their source is under /work/extensions/, see `extension list`)
/work/.agents/skills/                the loaded skills every runtime reads (Claude links them from .claude/skills/)
/root/.claude/skills/                the image-baked skills: this one and the task skills routed above
/root/.claude/skills/intentic/references/  this skill's longer answers, each named in the routing table
/opt/sandbox/package.json            the daemon's own version ("0.0.0": an unreleased build, e.g. from a checkout)
/history/logs/                       daemon.log, perf.jsonl, resource-metrics.jsonl, client.jsonl (what the
                                     editor reported about itself), filter-stats.jsonl (what the output filter
                                     cut from each Bash call), raw-output/ (a filtered call's whole output),
                                     terminals/ (every pane's lossless log)
```

Settings and config are the owner's to change from the editor (Sandbox ▸ Models, ▸ Agent, ▸ Secrets, ▸ Personas,
▸ Extensions, ▸ Environment). Read them to answer questions; edit them only when asked to.

## Diagnostics playbook (read-only)

The daemon writes everything down. Ask the records instead of re-instrumenting code or reproducing. Load
the tools with `ToolSearch` `+diagnostics`; they read `/history/logs` and the spend ledger, newest first,
over a window you choose. They cannot write, and nothing in this playbook restarts anything.

**Gather**

- A turn failed, died, or answered with the wrong provider's error → `mcp__diagnostics__turns`
  (`only: "failed"`, or a `conversationId`): which model ran, the error code, the provider's own sentence.
- A turn changed code and ran no check after its last edit, or its last check failed →
  `mcp__diagnostics__turns` with `only: "unproven"`. That is the turn's own record, since nothing checks a turn
  when it ends or after it lands. Whether main passes is CI's answer for what the owner pushed: the
  **Pipelines** view, where a failing main shows the fix agent on it above the runs.
- Something errored in the daemon (an automation, a sync, a land, a refused provider) →
  `mcp__diagnostics__errors` (`sinceMinutes`; `contains` a conversation id, route or code; `level`).
- The editor white-screened, stalled or felt slow → `mcp__diagnostics__errors` with `source: "browser"`.
- The editor names a route or a field it lacks, or a panel is blank → the daemon may be older than the app:
  compare `/opt/sandbox/package.json` with the newest release before suggesting a reload
  (`/root/.claude/skills/intentic/references/sandbox-behind-app.md`).
- Work felt slow → `mcp__diagnostics__slow` (`op: "git."`, `"http."`…), with the machine's load at the time,
  which is what separates a regression from a busy machine.
- Out of memory, a killed process, a stalling event loop → `mcp__diagnostics__resources` with a field:
  `system.cgroup.event_oom_kill`, `processes.byRole.toolchain.rssBytes` (also browser, agentRuntime, localModel, container, terminal,
  languageServer, git, extension), `window.eventLoop.delayP99Ms`, `daemon.memory.rssBytes`,
  `system.pressure.memory.some`, `system.loadAverage`.
- Output a command printed that the filter elided → its footer names the exact command:
  `retrieve-output /history/logs/raw-output/<log> [pattern]`.

An answer that says its read started mid-file may be missing older matches: narrow the window or raise the
limit rather than concluding nothing happened.

**Mutate**: nothing. These are reads of the record of what happened.

**Report**: findings in causal order with the evidence line for each; the first failure at an owner boundary
(a refused token, a spent allowance, an outage, a persona's withheld power) named as such; then the next
action, split into what you can fix in the workspace and what is the owner's (a setting, a capability, a
rebuild, a daemon restart from the host). Say plainly that nothing was changed.

## The editor, in the owner's words

- **Chat** (`/`): one conversation. Question cards (`AskUserQuestion`), plan approval, capability asks and
  payment approvals render here. Each session card shows a badge for what its last turn showed of its own
  work.
- **Pages in chat**: `mcp__ui__show_page` draws a self-contained HTML page inline (a chart, a table, a mock-up),
  in the chat's own theme; `mcp__ui__ask_page` draws one as a card and waits for what the page sends back with
  `window.intentic.submit(value)`. Pages run sealed: scripts yes, network no. Files they name on disk and
  libraries on the usual CDNs (jsDelivr, unpkg, cdnjs, d3js.org, cdn.plot.ly, Google Fonts) are carried in when
  the page is shown; anything else does not load. `check: true` lays the page out headless first and returns a
  picture and its console. A page's button can put words in the composer (`window.intentic.send`), never send
  them. Each page is a file under `.intentic/records/artifacts/pages/<conversation>/`; its caption opens it full
  size or publishes it to the outbox. A connected MCP server's own app (an MCP Apps `ui://` resource) is drawn
  the same way after a call to its tool. The owner can switch all of it off (Sandbox ▸ Agent ▸ Tools ▸ Pages
  in chat).
- **Agents** (`/agents`): the fleet board, every conversation as an agent with its branch and status. Every agent
  a conversation started hangs under its card as a row, whichever way it was started, and the chat's list of open
  chats hangs the same rows under its cards: a conversation it spawned (its row opens its own chat) and a subagent
  its runtime ran in-process (its row shows that subagent's own transcript in the parent's chat). Either way the chat
  is read-only: a bar stands where the message box would, naming the parent and leading back to it, since the parent
  directs its subagents; a spawned one can still be written to directly from the bar. A spawned child's code goes
  back into its parent's checkout, as an in-process subagent's edits do, so the family lands once, with the parent.
  **Land** (in plain words, **Accept**) applies a conversation's delta to the main tree; a conflict card names the
  paths. Cards carry titles, reactions and a tint for the kind of work, never tags. With geek metrics
  on (Settings ▸ Appearance), the board's status bar carries the sandbox's CPU, memory and disk, and opens a
  panel with every figure, memory by kind of process, and memory and CPU by session; each card shows its own
  conversation's.
- **Pipelines** (`/ext/pipelines`, a rail tile shown once a GitHub or GitLab account is connected, counting the
  branches whose last commit fails): the workspace repositories' CI runs, each run's jobs drawn as a graph,
  with rerun, cancel and Fix. A failing main-line branch shows above the runs with the one fix agent on it and what
  was last decided about it: the agent has it, it waits for you, or it is only reported because the Agent tab's
  Repair switch is off. Nothing checks a push on its way out: what a push broke is CI's to say, and on main the
  fix agent takes it.
- **Capabilities** (`/capabilities`): the connections; each card is a connector, account, device or service.
- **Sandbox** (`/sandbox/<tab>`): Overview (version, update, Sandbox URL), Usage, Environment, Secrets, Agent
  (`?section=` models, instructions, tools, safety, finishing), Extensions (finding and installing them too),
  Access, Areas, Personas, Devices, Recently deleted.
- **Workspace** (`/workspace/<path>`): the file tree, and the Changes panel where work is committed (**Commit**,
  or **Save N changes** in plain words). **Browsers** (`/browsers`): watch a live browser session. **Settings**
  (`/settings`): the owner's own preferences, not the sandbox's, except Appearance ▸ **How you work**, git's words
  (**I write code**) or plain ones (**I don't**), which the sandbox keeps per person so all of their devices read the same words.
- The app is **https://app.intentic.dev**, from any browser or phone (Add to Home Screen installs it).

## Hard invariants

- The owner lands and commits; you commit only when asked.
- A secret is a reference, never a value: not in a file, not in chat, not in a log.
- A refused credential is somebody's decision, not an obstacle to route around: carry on without it and say
  plainly what you left undone.
- `public/` is public; `refs/` is read-only; `/history` is the daemon's record and is not yours to edit.
- Do not restart the daemon, kill processes you did not start, or edit the daemon under `/opt/sandbox`. A fix
  at that level is the owner's, and the `environment` skill is how the image changes.
- Nothing about Intentic is answered "no" from memory: check, then say what you checked.
