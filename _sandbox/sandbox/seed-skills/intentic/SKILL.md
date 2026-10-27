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

The detail is in `/root/.claude/skills/intentic/references/` (`references/<file>` below; they name each other by
file name): read the one a row or section names before answering from it.

What the daemon does around you:

- **Conversations are agents on worktrees.** Each conversation works on its own git branch
  (`agent/<conversation-id>`), checked out in a worktree that is mounted over `/work` for the turn and rebased
  onto the main tree's last commit before each turn. When a turn ends cleanly its delta waits as **Ready to
  land** until the owner **lands** it (it lands by itself only with **Land finished work automatically** on):
  applied to the owner's main tree as UNCOMMITTED changes, so their own commit is the review boundary. That is
  why you commit only when asked. A patch that will not apply refuses the whole land and raises a conflict card
  naming the paths. Scratch-shaped untracked files never ride a land (`references/land-save-rebuild.md`).
- **Nothing holds your work back.** No check holds a land, a commit or a push; CI checks what the owner pushes. Run
  the checks you judge worth running, scoped to what you changed (the test files that cover it, its package's
  typecheck), never the whole repository (`pnpm test`, `pnpm typecheck`, `pnpm verify`, an unfiltered `turbo run`):
  several conversations share the machine. A failure in code you did not touch may be main's own. Repository checks
  and the CI fix agent: `references/checks-and-ci.md`.
- **Runtimes.** A turn runs on Claude Code (this loop), native Codex, OpenCode (Grok, Gemini), Pi, Cursor or
  an ACP agent, chosen per conversation; Codex and OpenCode also host other providers' models (Kimi, Z.ai, a model
  endpoint, Grok on Codex, ChatGPT on OpenCode) where the picker offers that loop.
- **Capabilities** are the connections the owner made: connectors (GitHub, Notion, databases…), browser
  accounts and identities, their own devices (computers, and Android phones through the Intentic Device app), Docker,
  MCP servers, a wallet. Each connected one ships a skill and its tools. A missing one is asked for with the
  `capabilities` skill, never set up by hand.
- **Personas** are cards the owner writes that decide what a turn IS and MAY DO: which accounts it speaks through,
  which shelves of tools are open, which folder it may touch, which model and system prompt it runs on. Enforcement
  is by absence: a withheld tool is not mounted and a withheld credential is never injected, so a refusal you meet
  may be a card, not a fault (`references/personas-and-models.md`).
- **Automations** start a turn on their own (a cron expression, a connector's listener); one with a model-free check
  is a **watch**. **Workflows** are daemon-scheduled graphs of turns. **Approvals** hold posts and outward-facing
  actions for the owner's yes. **Extensions** add connectors, channels, viewers and skills
  (`references/automations-and-extensions.md`).
- **Secrets** reach you only as `{{secret:name}}` references, substituted at execution: you never see a value and
  never ask for one in chat. Some are gated to a named person, guarded to named hosts, or kept in a keyring on one of
  the owner's computers (`references/secrets-and-privacy.md`).
- **Needs** are what a conversation has asked people for: a connection, a secret, a grant, a release, a tool
  for the image. Each is a card in its chat, pinned above the composer and shown on its agent's card on the
  board; it outlives the turn that raised it, and its answer continues the conversation by itself. `needs` lists this
  conversation's, and `needs cancel <id>` withdraws one the task no longer needs. A `--reconnect` card for a
  credential you reported refused is the one the sandbox cannot see fixed: once the owner says it is and a retry
  works, `needs done <id> --how "…"` closes it as met.

## Scope and verification: never a negative answer from memory

This skill is a map, not the whole product. A feature, setting or button it does not describe is not thereby
absent. Before telling the owner Intentic cannot do something, check, cheapest first:

1. The skill list in your prompt: the task skills routed below, plus one skill per connected capability.
2. The deferred tool list: `ToolSearch` with a keyword (`+browser`, `+diagnostics`, `+deps`) shows what this
   turn can load.
3. The daemon's own state, readable under `/work/.intentic/config/` (`references/paths.md`). In an isolated turn
   that is your branch's copy of the configuration; the live one, with the owner's uncommitted edits, is at
   `/mnt/intentic-main/.intentic/config/`.
4. The product's source, when the owner has it checked out (a repository whose root holds `_sandbox/sandbox/`,
   `_editor/web/`, `_platform/api/`, `_extensions/`). It is the owner's project, not a manual: read it to
   answer, and treat any edit to it as a product change.
5. Ask the owner. "I could not find it" is an honest answer; "Intentic can't" is a claim.

A workspace's `AGENTS.md` or `README.md` is the owner's instruction to you. It is not a
description of the product, and it may describe a project that has nothing to do with Intentic.

Memory is that `AGENTS.md`, at the workspace root, which the daemon composes into every runtime's instructions. It is
read from the turn's own tree, so the owner's uncommitted edit reaches isolated conversations only once committed.
Settings, personas and grants are read as each turn is planned: a change applies from every conversation's next turn,
with no restart (`references/instructions-and-settings.md`).

## Routing: what the owner wants → what to do

| The owner wants… | Do |
|---|---|
| a service, account, device, database or Docker this sandbox is not connected to | `capabilities` skill: `capabilities list`, then `capabilities request <card> --why …` (`--target` for the site or host, `--set` for what you can fill in) |
| a setting changed on a connected one (a device switch, a Docker option) or a refused credential replaced | `capabilities request <connection> --set key=value --why …`, or `--reconnect`: the card shows the change, and the owner applies it with one press |
| a tool, toolchain or system package that survives a rebuild | `environment` skill: `environment propose <tool>` puts the overlay steps on a card the owner approves |
| an account, folder or shelf of tools this conversation's persona or area withholds | `grants request capability\|folder\|shelf <what> --why "…"`; it reaches the conversation from its next turn |
| to know what this conversation is still waiting on people for | `needs`; answers arrive by themselves, so never poll and never ask twice |
| a repo they can open, run and preview from the sidebar | `panels` skill: give the repo an `operator/` web app |
| a model on their GPU, or a model server they already run | a model endpoint, never a model built into this image: `references/personas-and-models.md` |
| to pay an x402 endpoint | `wallet` skill; the owner approves each payment outside their auto-approve band |
| a SEPARATE sandbox: a second project, a specialized agent with its own tools and access, a team of them | `fleet` skill (`sandboxes` CLI); every create and removal asks in chat first. A difference only in how a turn behaves is a persona, not a machine |
| work done in ANOTHER of the owner's sandboxes, with its credentials, repos or devices | `links` skill: `mcp__<name>__delegate`, followed with `wait`; it lands over there, on that owner's terms. No link yet: `capabilities request link --why …` |
| a post (X, Reddit, Discord, YouTube…) or an outward-facing action prepared rather than done | `approvals` skill: one JSON file per item in `.intentic/config/approvals/` |
| to act as one of the sandbox's signed-in accounts on a site | `mcp__accounts__roster`, then `ToolSearch` `+mcp__browser__`; the account's own skill holds the site's cheatsheet |
| to wait on a CI run, a deploy, anything outside this sandbox | `mcp__watch__start` with a cheap check command, then end the turn. It lasts a day at most: longer is the next row |
| to be told, or to pick this conversation back up, when something happens out in the world (a version ships, a repository releases, a page changes), or any recurring or event-triggered task | a watch the owner approves on a card: `automations propose <id> --npm …\|--github …\|--url …\|--guard '<cmd>' --prompt "…" --why "…"`; never write `automations.json` yourself. Flags and targets: `references/automations-and-extensions.md` |
| to wait on work started here: a background command, a subagent | `mcp__subagents__wait` with the command's ID from its Bash call, or the subagent's id (its Agent call's, or the one spawn returned); `mcp__subagents__stop` ends a background command early, whichever ID names it; never `sleep`, and never detach a process yourself |
| to know why something failed, died, hung or felt slow | Diagnostics, below |
| how personas work, keeping an agent inside one project, which model runs what (and whether that is enforced) | `references/personas-and-models.md` |
| the workspace from a phone or another computer, the app's link, letting someone else in | `references/remote-access.md` |
| to rename agents, tell them apart at a glance, tag or filter them | `references/agents-board.md` (there are no tags; it says what exists instead) |
| where instructions live (`AGENTS.md`, the system prompt, a persona's prompt, skills), or whether a change needs a restart | `references/instructions-and-settings.md` |
| Land, Accept, Save changes, Back up, Approve, Rebuild explained, and in which order | `references/land-save-rebuild.md` |
| what a view, panel, card or button of the editor does, or where a setting is | `references/editor.md` |
| "needs an update" in place of the sandbox, an editor error naming a part of the app or a field ("too old for this part of the app", "doesn't provide", "didn't keep", "answered in a shape"), a blank panel, a setting that snaps back | the sandbox is likely older than the app: check the daemon's version before blaming the browser (`references/sandbox-behind-app.md`) |
| a secret or API key used | `{{secret:name}}` in the command. None stored: `secrets ask NAME --why "…"`; one the task can make: `secrets generate NAME` (`references/secrets-and-privacy.md`) |
| a credential that says it needs approval, an account that looks unconnected, or a secret refused for where it was going | it is gated or host-guarded: `secrets gates`, `secrets hosts NAME`, `secrets request <id> --why "…"` (`references/secrets-and-privacy.md`) |
| personal data kept from untrusted model providers, or tokens like `⟦PERSON_3⟧` in what you read | the privacy shield: write a token exactly as given and it resolves before anything runs; `privacy` says whether it is on, `privacy learn` teaches it a dataset (`references/secrets-and-privacy.md`) |
| a file handed over by link | `/work/public/`, and say the link is public |
| an outside codebase studied | clone it into `/work/refs/` |
| a change to an installed extension (a page under `/ext/…`, its panel, tools or skill) | its source checkout under `/work/extensions/<name>` (`extension list`), then `extension dev <name>`; never the installed copy in `.intentic/local/extensions/`. Pushing it publishes it: ask first (`references/automations-and-extensions.md`) |
| the sandbox itself changed (image, packages, the dormant Docker engine, the browser pack) | `environment` skill; approving is the owner's. Hosted (`SANDBOX_VM=1`): one press of **Rebuild now**, never a command to paste; elsewhere it runs on the host, next row (`references/land-save-rebuild.md`) |
| anything that has to happen on the machine THIS sandbox runs on (a container restart, a rebuild, a script in the host checkout, a look at its docker) | when that machine is a connected device (its skill is in your list), do it yourself: `list_sandboxes` finds this sandbox by the slug in `SANDBOX_NAME`, then `run_command`, `manage_sandbox`, `swap_sandbox`, `reshape_sandbox`, `sandbox_logs`. Never hand the owner a command for a machine you can reach. Anything that restarts this container ends your turn: say so and get a yes first |

## Key paths

`/work` is the workspace (your worktree, in an isolated turn); `/work/refs/` the reference shelf (read, never edit);
`/work/public/` the outbox (public on the internet); `/work/.intentic/config/` the daemon's tracked configuration;
`/opt/sandbox/package.json` the daemon's version (`0.0.0`: an unreleased build); `/history/logs/` its logs, read
through the diagnostics tools. Every other path, and what each config file holds: `references/paths.md`.

## The editor

The app is **https://app.intentic.dev**. Its views: **Home** (`/home`, every sandbox), **Agents** (`/agents`, the
board; **Land** / **Accept** is on its cards), **Chat** (`/chat`), **Workspace** (`/workspace/<path>`, files and
**Commit**), **Capabilities**, **Devices**, **Browsers**, **Sandbox** (`/sandbox/<tab>`: Models, Agent, Environment,
Secrets, Extensions, Access, Personas, Privacy & safety, Activity…), **Settings** (the person's own), and extension
pages under `/ext/…`. Settings and config are the owner's to change there: read them to answer, edit them only when
asked to. What each view holds, in the owner's words: `references/editor.md`.

## Diagnostics (read-only)

The daemon writes everything down: ask the records instead of re-instrumenting code or reproducing. For one
conversation, start with `agents show <id>` (`--transcript` for what was said), then `mcp__diagnostics__timeline`
with its `conversationId`. `ToolSearch` `+diagnostics` loads the rest: `turns` (failed or unproven turns, which model
ran), `restarts`, `errors` (`source: "browser"` for the editor), `slow`, `resources`. They cannot write, and nothing
here restarts anything. Which tool answers which symptom, how to read the logs yourself, and how to report:
`references/diagnostics.md`.

## Hard invariants

- The owner lands and commits; you commit only when asked.
- A secret is a reference, never a value: not in a file, not in chat, not in a log.
- A refused credential is somebody's decision, not an obstacle to route around: carry on without it and say
  plainly what you left undone.
- `public/` is public; `refs/` is read-only; `/history` is the daemon's record and is not yours to edit.
- Do not restart the daemon, kill processes you did not start, or edit the daemon under `/opt/sandbox`. A fix
  at that level is the owner's, and the `environment` skill is how the image changes.
- Nothing about Intentic is answered "no" from memory: check, then say what you checked.
