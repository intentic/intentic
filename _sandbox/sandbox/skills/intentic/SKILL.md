---
name: intentic
description: What Intentic is and how this sandbox works, the reference for questions about the product itself (a panel, setting, card or button; connecting, configuring, extending or debugging the sandbox; whether Intentic can do something). Load it BEFORE answering any question about Intentic, before saying Intentic cannot do something, and whenever the sandbox itself misbehaves (a failed or dead turn, a crashed automation, a slow or broken editor).
---

# Intentic: the product you are running inside

Intentic is a per-workspace AI-agent development environment. This container is its **sandbox**: a daemon
(`@intentic/sandbox`, image `ghcr.io/intentic/sandbox`, installed under `/opt/sandbox`) that serves one
workspace, `/work`, on the owner's own host or a machine they chose. The owner drives it from a browser
**editor**; a hosted **platform** handles sign-in, capabilities and paid services. You are one **agent turn**
the daemon is running.

What the daemon does around you:

- **Conversations are agents on worktrees.** Each conversation works on its own git branch
  (`agent/<conversation-id>`), checked out in a worktree that is mounted over `/work` for the turn. When a
  turn ends cleanly its delta is **landed**: applied to the owner's main tree as UNCOMMITTED changes, so their
  own commit is the review boundary. That is why you commit only when asked. A patch that will not apply
  refuses the whole land and raises a conflict card naming the paths; every worktree keeps everything.
- **Runtimes.** A turn runs on Claude Code (this loop), native Codex, OpenCode (Grok, Gemini), Pi, Cursor or
  an ACP agent, chosen per conversation. Which model actually ran is recorded (`mcp__diagnostics__turns`).
- **Capabilities** are the connections the owner made: connectors (GitHub, Notion, databases…), browser
  accounts and identities, their own computers, Docker, MCP servers, a wallet. Each connected one ships a
  skill and its tools. A missing one is asked for with the `capabilities` skill, never set up by hand.
- **Personas** are cards the owner writes that decide what a turn IS and MAY DO: which accounts it speaks
  through, which shelves of the toolbox are open (files, shell, web, browser, connectors, delegation…), which
  folder it may touch, which system prompt it runs on. Enforcement is by absence: a withheld tool is not
  mounted and a withheld credential is never injected, so a refusal you meet may be a card, not a fault.
- **Automations** are standing instructions that start a turn on their own (a cron expression, or a
  connector's listener); **workflows** are daemon-scheduled graphs of turns; **drafts** are posts held for the
  owner's approval. **Extensions** add connectors, channels (Slack, Discord, Telegram, WhatsApp…), viewers
  and skills, installed from Sandbox ▸ Discover.
- **Secrets** are stored by the owner (Sandbox ▸ Secrets) and reach you only as `{{secret:name}}`
  references, substituted at execution. You never see a value and never ask for one in chat.

## Scope and verification: never a negative answer from memory

This skill is a map, not the whole product. A feature, setting or button it does not describe is not thereby
absent. Before telling the owner Intentic cannot do something, check, cheapest first:

1. The skill list in your prompt: the task skills routed below, plus one skill per connected capability.
2. The deferred tool list: `ToolSearch` with a keyword (`+browser`, `+diagnostics`, `+deps`) shows what this
   turn can load.
3. The daemon's own state, readable under `/work/.intentic/config/` (paths below).
4. The product's source, when the owner has it checked out (a repository whose root holds `_sandbox/sandbox/`,
   `_editor/web/`, `_platform/api/`, `_extensions/`). It is the owner's project, not a manual: read it to
   answer, and treat any edit to it as a product change.
5. Ask the owner. "I could not find it" is an honest answer; "Intentic can't" is a claim.

A workspace's `CLAUDE.md`, `AGENTS.md` or `README.md` is the owner's instruction to you. It is not a
description of the product, and it may describe a project that has nothing to do with Intentic.

## Routing: what the owner wants → what to do

| The owner wants… | Do |
|---|---|
| a service, account, computer, database or Docker this sandbox is not connected to | `capabilities` skill: `capabilities list`, then `capabilities request <card> --why …` |
| a tool, toolchain or system package that survives a rebuild | `environment` skill: propose overlay Dockerfile steps the owner approves |
| a repo they can open, run and preview from the sidebar | `panels` skill: give the repo an `operator/` web app |
| a heavy or premium capability (research, data, compute) | `services` skill: the `services` CLI; the owner approves the spend on a card |
| to pay an x402 endpoint, or to sell their own API as a paid service | `wallet` skill, `provide` skill |
| a post on X, Reddit, Discord, YouTube… prepared rather than sent | `drafts` skill (present when the drafts extension is on) |
| to act as one of the sandbox's signed-in accounts on a site | `mcp__accounts__roster`, then `ToolSearch` `+mcp__browser__`; the account's own skill holds the site's cheatsheet |
| to wait on a CI run, a deploy, anything outside this sandbox | `mcp__watch__start` with a cheap check command, then end the turn |
| to know why something failed, died, hung or felt slow | the diagnostics playbook below |
| a secret or API key used | write `{{secret:name}}` in the command; an unknown name fails and lists the names that exist; the owner adds one at Sandbox ▸ Secrets |
| a file handed over by link | `/work/public/`, and say the link is public |
| an outside codebase studied | clone it into `/work/refs/` |
| a recurring or event-triggered task | an automation (`.intentic/config/automations.json`, managed from the editor); draft the prompt and trigger for the owner |
| the sandbox itself changed (image, packages, the dormant Docker engine, the browser pack) | `environment` skill; the rebuild is the owner's click |

## Key paths

```
/work                                the workspace (your worktree is mounted here during an isolated turn)
/work/refs/                          reference shelf: read, cite by path, never edit
/work/public/                        outbox: every file in it is on the public internet
/work/.intentic/config/settings.json this sandbox's agent settings (systemPromptMode, skills, terseOutput,
                                     stableSystemPrompt, iqSearch, hashlineEdits, subagent limits, rules…)
/work/.intentic/config/              capabilities.json, personas/, automations.json, workflows.json,
                                     environment.Dockerfile (the owner's overlay), skills/ (their own),
                                     drafts/, extension-enablement.json
/work/.intentic/records/             sessions/ (transcripts), artifacts/browser/ (screenshots)
/work/.intentic/local/               cache/, tmp/, environment.approved.Dockerfile (the composed overlay)
/work/.agents/skills/                the loaded skills every runtime reads (Claude links them from .claude/skills/)
/root/.claude/skills/                the image-baked skills: this one and the task skills routed above
/history/logs/                       daemon.log, perf.jsonl, resource-metrics.jsonl, client.jsonl (what the
                                     editor reported about itself), terminals/ (every pane's lossless log)
```

Settings and config are the owner's to change from the editor (Sandbox ▸ Agent, ▸ Secrets, ▸ Personas,
▸ Extensions, ▸ Environment). Read them to answer questions; edit them only when asked to.

## Diagnostics playbook (read-only)

The daemon writes everything down. Ask the records instead of re-instrumenting code or reproducing. Load
the tools with `ToolSearch` `+diagnostics`; they read `/history/logs` and the spend ledger, newest first,
over a window you choose. They cannot write, and nothing in this playbook restarts anything.

**Gather**

- A turn failed, died, or answered with the wrong provider's error → `mcp__diagnostics__turns`
  (`only: "failed"`, or a `conversationId`): which model ran, the error code, the provider's own sentence.
- A turn finished but nothing checked its work → `mcp__diagnostics__turns` with `only: "unproven"`.
- Something errored in the daemon (an automation, a sync, a land, a refused provider) →
  `mcp__diagnostics__errors` (`sinceMinutes`; `contains` a conversation id, route or code; `level`).
- The editor white-screened, stalled or felt slow → `mcp__diagnostics__errors` with `source: "browser"`.
- Work felt slow → `mcp__diagnostics__slow` (`op: "git."`, `"http."`…), with the machine's load at the time,
  which is what separates a regression from a busy machine.
- Out of memory, a killed process, a stalling event loop → `mcp__diagnostics__resources` with a field:
  `system.cgroup.event_oom_kill`, `processes.byRole.browser.rssBytes` (also agentRuntime, terminal,
  languageServer, git, extension), `window.eventLoop.delayP99Ms`, `daemon.memory.rssBytes`,
  `system.pressure.memory.some`, `system.loadAverage`.
- Output a command printed that the filter elided → its footer names the exact command:
  `retrieve-output /history/logs/terminals/<log> [pattern]`.

An answer that says its read started mid-file may be missing older matches: narrow the window or raise the
limit rather than concluding nothing happened.

**Mutate**: nothing. These are reads of the record of what happened.

**Report**: findings in causal order with the evidence line for each; the first failure at an owner boundary
(a refused token, a spent allowance, an outage, a persona's withheld power) named as such; then the next
action, split into what you can fix in the workspace and what is the owner's (a setting, a capability, a
rebuild, a daemon restart from the host). Say plainly that nothing was changed.

## The editor, in the owner's words

- **Chat** (`/`): one conversation. Question cards (`AskUserQuestion`), plan approval, capability asks and
  payment approvals render here.
- **Agents** (`/agents`): the fleet board, every conversation as an agent with its branch and status.
  **Land** applies a conversation's delta to the main tree; a conflict card names the paths.
- **Capabilities** (`/capabilities`): the connections; each card is a connector, account, computer or service.
- **Sandbox** (`/sandbox/<tab>`): Overview, Status (running turns), Usage, Environment, Secrets, Agent (the
  settings above), Extensions, Discover, Access, Personas, Computers.
- **Workspace** (`/workspace/<path>`): the file tree. **Browsers** (`/browsers`): watch a live browser
  session. **Subagents** (`/subagents`): the children a turn started. **Settings** (`/settings`): the owner's
  own preferences, not the sandbox's.

## Hard invariants

- The owner lands and commits; you commit only when asked.
- A secret is a reference, never a value: not in a file, not in chat, not in a log.
- `public/` is public; `refs/` is read-only; `/history` is the daemon's record and is not yours to edit.
- Do not restart the daemon, kill processes you did not start, or edit the daemon under `/opt/sandbox`. A fix
  at that level is the owner's, and the `environment` skill is how the image changes.
- Nothing about Intentic is answered "no" from memory: check, then say what you checked.
