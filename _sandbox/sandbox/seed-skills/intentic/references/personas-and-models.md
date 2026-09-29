# Personas, and which model runs what

## What a persona is

A persona is a posture a conversation wears, not an agent. Any number of conversations can wear the same one at
once, each in its own copy of the workspace. It decides what a turn is and may do: which signed-in accounts it
speaks through, which shelves of tools are open, which folder it starts in and which folders its file tools may
touch, which repositories its checkout carries, which model it opens on, and which system prompt it runs on.

It lives in two places, both tracked in git under `.intentic/config/`:

- **The card**: one entry in `personas.json`. Fields: `id`; `label` (the name on screen); `brief` (one line, what
  it is for, which new chats are matched against); `capabilities` (the accounts it speaks through, by id);
  `powers` (the shelves: `files` none/read/write, `shell`, `code`, `web`, `browser`, `delegate`, `sandbox`, and the
  lists `connectors`, `devices`, `mcp`, `extensions`, where absent means every one and `[]` means none);
  `workspace` (`startIn`, the folder a conversation opens in, and `folders`, the only folders file tools may
  touch); `context.repos` (which nested repositories its checkout holds); `briefing.omit` (which of the notes
  sent with each message it goes without); `models` (an ordered list of models); `systemPromptMode` (absent
  follows the sandbox; `intentic`, `claude` or `custom`). There is no prompt-text field on the card.
- **The kit**: the folder `personas/<id>/`. `PROMPT.md` is its own system prompt, used only when the card's
  `systemPromptMode` is `custom`; with the file missing or empty the persona falls back to the sandbox's prompt.
  `skills/<name>/SKILL.md` are skills only its turns can reach. `.claude-plugin/plugin.json` is written by the
  daemon: the kit loads as a Claude Code plugin, so its skills reach turns on the Claude Code loop.

The owner edits both on **Sandbox ▸ Personas** (`/sandbox/personas`, **Add a persona**). A persona opens on four
tabs: **Speaks as** (name, **What it's for**, **Speaks through**), **What it may do** (the shelves, then **Where it
works**: **Starts in** and **Only these folders**), **Runs on** (its models, and **Carries**: its repositories),
**What it is told** (the system prompt: **Sandbox's**, **Intentic**, **Claude** or **Its own**; **Its own skills**;
and **Sent with every message**, the notes it may drop). A new persona starts with the full toolbox, the whole
workspace and the sandbox's own prompt.

## "Make it work inside one project only"

Give a persona **Starts in** = the project folder and **Only these folders** = that folder, and under **Carries**
keep only the repositories the work needs. File tools pointed outside those folders are refused. That stops
mistakes and misread instructions, not a shell: with **Run commands** on, every other limit on the persona is a
strong default rather than a wall. Turn **Run commands** off for a persona that has to be fenced in. A conversation
started by someone whose access is limited to areas is narrower still: its turn works inside the persona's folders
AND that person's areas.

A folder a persona starts in shows a person icon on its row in the workspace file tree; it opens **Who works in
<folder>**, where a persona can be added there, moved there, or edited.

Enforcement is by absence: a withheld shelf's tools are not mounted, a connector the card does not grant has its
credentials stripped from the turn's environment, and an account it does not speak through is never loaded. The
card itself is a tracked file an agent can read and edit like any other, so it guards against mistakes (the wrong
account, the wrong folder), not against a determined agent with a shell.

## How a persona gets onto a conversation

- **By hand**: the composer's **Persona** pill (it reads **Acts as: <name>**). **Anyone** is the row for no
  persona: every connected account and the full toolbox. The pick travels with each message. The chat list's
  **Personas** view has **New chat as <name>**.
- **By routing**: with **Match new chats to a persona** on (Sandbox ▸ Personas; `personaRouting` in settings,
  on by default) AND a model set for **New chat routing** (Sandbox ▸ Agent ▸ Models), a new chat's first message
  is read against each card's one line when it is sent, and the chat says in its transcript which persona it
  landed on. A pick by hand wins. Never for a guest, and never for an unattended run.
- **Automations** name their own persona. An unattended turn that names none reaches no signed-in account and
  keeps the full toolbox; a turn naming a persona that no longer exists gets nothing at all.

The persona, its fence and its shelves are resolved again on every turn, so an edit applies from each
conversation's next turn.

## Is model routing enforced, or a polite ask?

For the model a conversation runs on, it is real: the model is which provider and model the session is started
on, not an instruction in the prompt. It is a default, though, and a model chosen for the turn always wins.

- A persona's **Runs on** list is an ordered ladder. Picking the persona (by hand or by routing) moves the
  composer's model pill to the first model on it whose provider is connected; the person can still move the pill
  afterwards, and the pill is what runs.
- For a turn that names no model (a Fix, a chore, another job the sandbox starts), the daemon fills it from the
  persona's list first, then from the job's own list, stepping over a model whose account is recorded as spent
  or failing in a row. An automation names its own models, required on the automation itself.
- The jobs' lists are `modelRoles` in settings, edited on Sandbox ▸ Agent ▸ Models: helpers (**Commit messages**,
  **Session titles**, **Safety judge**, **Loop verdicts**, **New chat routing**) and runs (**Pipeline fixes**,
  **Deployment fixes**, **Maintenance chores**, **Documentation runs**, **Acceptance runs**, **Approvals queue**,
  **Extension update reviews**, **Loop iterations**). A helper with no list does not run; a run with no list
  opens on a connected provider.

"An orchestrator on one model that delegates to cheaper subagents": the orchestrator is whatever its conversation
runs on (the pill, or the persona's **Runs on**). A spawned subagent's provider and model are named by the parent
on each spawn: both are required, and no setting picks them. So "spawn the cheap work on model X", written into
`AGENTS.md` or the persona's `PROMPT.md`, is followed by the model, not enforced. What is enforced:

- **Spawn subagents** on Sandbox ▸ Agent ▸ Tools: **Default** (runs, asks after outside content), **Always
  allow**, **Ask me**, **Never** (`actionRules["agents.spawn"]` in settings.json). A per-provider key,
  `actionRules["agents.spawn.<provider>"]` set to `deny` or `hold`, wins over the general one: that is how a
  provider is refused for subagents.
- With **Ask me**, every start raises a card, **Start a subagent on <provider>?**, naming what the child runs on;
  the owner can re-point the start to another model before allowing it.
- **Subagents at once**, **Subagents per conversation** and **Nesting depth** cap how many; they also bound the
  subagents a runtime starts in-process (Claude Code's own Agent tool), which run inside the parent's turn and
  which the spawn rule does not cover.
- A persona with **Delegate** off can do neither: the in-process agent tools are removed and it cannot spawn.

Which model actually ran each turn is recorded: `mcp__diagnostics__turns`.
