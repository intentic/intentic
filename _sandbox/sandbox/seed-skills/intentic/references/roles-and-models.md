# Roles, and which model runs what

## What a role is

A role is the job a conversation does, not an agent. Any number of conversations can wear the same one at once,
each in its own copy of the workspace. It decides who a turn is and how it works: which signed-in accounts it speaks
through, which folder it starts in, which repositories its checkout carries, which model it opens on, and which system
prompt and skills it runs with. What a conversation wearing it may reach (tools, connections, folders) is access, not
the role: every access profile that lists the card holds it, the same way a person's or a service's profile does.

It lives in two places, both tracked in git under `.intentic/config/`:

- **The card**: one entry in `roles.json`. Fields: `id`; `label` (the name on screen); `brief` (one line, what
  it is for, which new chats are matched against); `capabilities` (the signed-in accounts it speaks through, by id);
  `workspace.startIn` (the folder a conversation opens in); `context.repos` (which nested repositories its checkout
  holds); `briefing.omit` (which of the notes sent with each message it goes without); `models` (an ordered list of
  models); `systemPromptMode` (absent follows the sandbox; `intentic`, `claude` or `custom`). There is no prompt-text
  field on the card, and no limit: a card's `powers` and `workspace.folders` were moved into access profiles on
  2026-11-18.
- **The kit**: the folder `roles/<id>/`. `PROMPT.md` is its own system prompt, used only when the card's
  `systemPromptMode` is `custom`; with the file missing or empty the role falls back to the sandbox's prompt.
  `skills/<name>/SKILL.md` are skills only its turns can reach. `.claude-plugin/plugin.json` is written by the
  daemon: the kit loads as a Claude Code plugin, so its skills reach turns on the Claude Code loop.

The owner edits both on **Sandbox ▸ Roles** (`/sandbox/roles`, **Add a role**). A role opens on four
tabs: **Speaks as** (name, **What it's for**, **Speaks through**), **Access** (**Starts in**, and **What it may
reach**: the access profile that holds it, with **Held to** to move it onto another one), **Runs on** (its models, and
**Carries**: its repositories), **What it is told** (the system prompt: **Sandbox's**, **Intentic**, **Claude** or
**Its own**; **Its own skills**; and **Sent with every message**, the notes it may drop). A new role is held to no
profile: it reaches what the people it works for may.

## What a role may reach

Its limits are access profiles (**Sandbox ▸ Access ▸ Profiles**): a profile's **Roles held to it** lists the cards
it holds, and a conversation wearing one reaches no more than every such profile allows, whoever it works for. A
profile answers the shelves of tools (**Files**, **Commands**, **Code**, **Web**, **Browser**, **Subagents**,
**Sandbox settings**), the connections and secrets it may spend, the AI accounts it may run on, and the areas its file
tools may touch. The link is on the profile, on the history volume beside the roster, rather than on the card, so a
conversation that can edit `roles.json` still cannot widen its own role. Only someone who runs people and access
moves a card onto a profile. A profile that lists a role cannot be deleted until it lists none.

A turn whose role holds something back can ask with `grants request capability|folder|shelf <what> --why "…"`.
The card it raises offers the roles whose access has it; the person's pick switches the conversation to that
role from its next turn. It is refused outright when the people or service the conversation works for were not
given it, since no role has more than they do.

## "Make it work inside one project only"

Give the role **Starts in** = the project folder and, under **Carries**, only the repositories the work needs. Then
hold it to a profile whose areas are that project: file tools pointed outside are refused. With **Commands** allowed by
the profile, a folder fence stops mistakes and misread instructions, not a shell; turn commands off in the profile for a
role that has to be fenced in. A conversation started by someone whose access is limited to areas is narrower
still: its turn works inside the profile's areas AND that person's.

A folder a role starts in shows a person icon on its row in the workspace file tree; it opens **Who works in
<folder>**, where a role can be added there, moved there, or edited.

Enforcement is by absence: a withheld shelf's tools are not mounted, a connection outside reach has its credentials
stripped from the turn's environment, and an account the role does not speak through is never loaded.

## The two built-in roles

Every turn acts as a role. Besides the cards on Sandbox ▸ Roles, every sandbox has two built-in ones, listed
read-only at the top of that page. They can't be edited or removed, and no card may take their ids:

- **All accounts** (`full-access`, its id from when it was called Full access): every connected account. A chat a
  person starts without picking a role wears it.
- **No accounts** (`no-accounts`): no signed-in account (site accounts, identities, the owner's own browser).
  Connector credentials stay. Anything that runs while nobody watches and names no role wears it: an automation, a
  queue, an approved action.

Neither is held to a profile: both reach what the people or service the conversation works for may. A guest wears
neither: a guest always speaks through one of its own cards.

## How a role gets onto a conversation

- **By hand**: the composer's **Role** pill (it reads **Acts as: <name>**), or `@role:` typed in the
  composer. The menu lists **All accounts** and **No accounts** first, then the cards. Picking All accounts sends no
  role at all, since that is what no pick means. The pick travels with each message. The chat list does not offer
  roles: **New agent** starts on All accounts, and the role is picked in the chat or by routing. A conversation a
  person switched to another role on a grant card moves its pill there too.
- **By routing**: with **Match new chats to a role** on (Sandbox ▸ Roles; `roleRouting` in settings,
  on by default) AND a model set for **New chat routing** (Sandbox ▸ Agent ▸ Jobs), a new chat's first message
  is read against each card's one line when it is sent, and the chat says in its transcript which role it
  landed on. A pick by hand wins. Never for a guest, and never for an unattended run.
- **Automations** name their own role, and the picker offers the built-ins too. One that names none wears No
  accounts. A new automation starts on **All accounts** when nothing from outside reaches its prompt (a schedule, a
  one-time wake or a workspace moment with no check), and on **No accounts** otherwise (a listener, a webhook, a
  watched page, release or package, a guard command), until a person picks one. Existing automations keep what they
  name. Saving one that names a card that doesn't exist is refused, and a card an automation or a sender rule still
  wears can't be removed until they are pointed elsewhere.
- **Subagents** wear their parent's role: the card or built-in the parent's own turn wore. Whatever the spawn
  asked for is ignored, so an agent can't hand its child a wider role than its own.
- A turn naming a card that no longer exists gets nothing at all: no accounts and no tools.

The role and the profiles holding it are read again on every turn, so an edit applies from each conversation's
next turn.

## A model on their own GPU, or a model server they already run

That is a model endpoint, never a model built into this image: Ollama or LM Studio on the computer hosting the sandbox
is `http://host.docker.internal:<port>/v1` (11434, 1234). The Local models panel finds and adds those by itself; for
anything else, `capabilities request endpoint --set baseUrl=… --why …`. Local models inside the sandbox run on its CPU
only.

## Is model routing enforced, or a polite ask?

For the model a conversation runs on, it is real: the model is which provider and model the session is started
on, not an instruction in the prompt. It is a default, though, and a model chosen for the turn always wins.

- A role's **Runs on** list is an ordered ladder. Picking the role (by hand or by routing) moves the
  composer's model pill to the first model on it whose provider is connected; the person can still move the pill
  afterwards, and the pill is what runs.
- For a turn that names no model (a Fix, a chore, another job the sandbox starts), the daemon fills it from the
  role's list first, then from the job's own list, stepping over a model whose account is recorded as spent
  or failing in a row. An automation names its own models, required on the automation itself.
- Which models each job runs on is set on Sandbox ▸ Agent ▸ Jobs, as **setups**: named, ordered lists of models
  (`modelSetups` in settings) that any number of jobs share. **Low**, **Medium** and **High** are always there,
  worked out from the connected accounts (each provider's newest model at that level) until someone edits one;
  the owner can make more. A sandbox that never placed its jobs runs every job on its suggested Low, Medium or
  High setup; once a job is placed, the assignments (`roleSetups`) stay as written, including jobs taken off a
  setup. Drag a job onto a setup, or press it and pick one; "Place on suggested setups" restores unplaced jobs to
  their suggestions. The sandbox's own jobs are helpers (**Commit messages**, **Session titles**, **Safety judge**,
  **Loop verdicts**, **Hand-off summaries**, **Spoken replies**, **New chat routing**, **Subagent sizing**) and runs
  (**Workflow fixes**, **Approvals queue**, **Extension update reviews**, **Loop iterations**). Each extension adds
  the jobs it starts runs for (`contributes.modelRoles`): **Pipeline fixes** (Pipelines), **Deployment fixes**,
  **Maintenance chores**, **Documentation runs** and **Acceptance runs**, shown while the extension is on, its
  choice kept while it is off. A helper with no models does not run; a run with no models opens on a connected
  provider.
- What is connected at all is Sandbox ▸ Models (`/sandbox/models`): every account, subscription, model on this
  machine and endpoint the sandbox can run on, what needs a person (sign in again, verify, an admin's seat), and the
  one place a model is connected. `/connect` is an old address for it. Connecting is the owner's (a maintainer's);
  send them there rather than describing the steps. A static key (Cursor, Devin, Z.ai, Meta, a model endpoint) and a
  connector card can be saved to the owner's computer and taken into any other of their sandboxes: the **connections
  hub**, kept in that computer's Passwords keyring, with a yes at the computer each time. A subscription that renews
  its sign-in (Claude, Codex, Grok, Kimi, Gemini) is signed in on each sandbox; sandboxes no longer lend accounts to
  each other (withdrawn 2026-11-11).

"An orchestrator on one model that delegates to cheaper subagents": the orchestrator is whatever its conversation
runs on (the pill, or the role's **Runs on**). A spawned subagent's provider and model are named by the parent
on each spawn: both are required, and no setting picks them. So "spawn the cheap work on model X", written into
`AGENTS.md` or the role's `PROMPT.md`, is followed by the model, not enforced. What is enforced:

- **Spawn subagents** on Sandbox ▸ Guardrails: **Default** (runs, asks after outside content), **Always
  allow**, **Ask me**, **Never** (`actionRules["agents.spawn"]` in settings.json). The same group sets, per
  connected service, whether sending a message or an office act runs, asks first or is refused (the other
  `actionRules` keys), and the group below it whether work started from outside may run (`admission`). A per-provider key,
  `actionRules["agents.spawn.<provider>"]` set to `deny` or `hold`, wins over the general one: that is how a
  provider is refused for subagents.
- With **Ask me**, every start raises a card, **Start a subagent on <provider>?**, naming what the child runs on;
  the owner can re-point the start to another model before allowing it.
- **Subagents at once**, **Subagents per conversation** and **Nesting depth** cap how many; they also bound the
  subagents a runtime starts in-process (Claude Code's own Agent tool), which run inside the parent's turn and
  which the spawn rule does not cover. A spawn past **Subagents at once** waits as pending and starts by itself when
  one of the parent's children ends; past **Subagents per conversation** it is refused, a count that survives a
  restart. All three sit under **Advanced**: free memory and the allowance plan already hold spawned subagents back,
  so the width binds mostly on pay-per-token accounts and the in-process ones.
- Spawned subagents are always planned by allowance: one starts only where an account can carry it, and the rest wait
  as pending. **Room kept for you** (Simple) is how many points of each window, out of 100, they leave for the owner's
  own chats; 0 keeps none.
- A subagent the sandbox has no memory for yet waits as pending, its row saying since when, why and where it stands
  among the subagents waiting for room, and starts by itself once there is room; work people send goes first. It
  waits up to six hours, then ends unstarted with nothing spent and its parent is woken to hear it. Its wait counts
  the sandbox's own memory, and the computer under it only down to that computer's floor (1.5 GiB), since its heavy
  commands queue for that computer on their own. `agents show <id>` on one that has not started says where it stands.
- A subagent's spawn prompt is its brief for good: until a model has read it, every turn the sandbox starts on it (a
  `send`, a move to another provider, a fallback, a re-run) opens with that brief and then the new words, so a
  "there is room now, carry on" never reaches a child that never saw its task. One a restart caught before it started
  starts again by itself.
- The sandbox opens that brief with a note of its own (**You are a subagent**), so a parent writes only the task. It
  is computed as the turn starts: which `AGENTS.md` files are already in the child's instructions (the daemon composes
  them for every loop) and which repositories' own it must read; not to commit, and where its work lands; its
  artifacts folder, `.intentic/records/artifacts/subagents/<id>/`; the parent's other subagents with their status and
  the files each has changed and not landed; the build and test tools installed (the queue's parallelism, `quiet`,
  `base run`, the test digest); and a four-part report (files changed, checks with new-vs-main failures, decisions,
  what is unverified). It rides every turn that carries the brief and no other, once.
- `after: [ids]` on a spawn names other subagents of the same parent that must finish first: the child is filed at
  once, pending ("Waiting after …" in `wait` and `agents show`), and starts by itself once each has finished and its
  work is in the parent's checkout, so its worktree is cut with that work in it. One whose work is held on its branch
  keeps it waiting for the parent's `merge` or `settle`; one that failed or was cancelled keeps it waiting for the
  parent, who is told. A message sent to it starts it at once, its task first; a cancel drops it. An id the parent did
  not spawn is refused. `agents spawn --after <id>,<id>` from a shell.
- `cancel` (`agents cancel <id>`) stops a subagent and every subagent below it, and any agent above it may ask, not
  only the one that spawned it; `all` stops all of the caller's. A cancelled subagent stays stopped: the jobs and
  watches it left are stopped too, nothing the sandbox does wakes it again, and only a message from a person or an
  agent starts it. What it wrote stays on its own branch for a follow-up or `merge`. A person's **Stop all** on a card
  does the same for everything below that card. The board draws a subagent's own subagents in its root card's tray,
  each nested under (or marked "via") the one that started it.
- A subagent placed on a runner whose copy of the workspace cannot be prepared runs here instead, in the same
  conversation, and its parent is told; nothing had run there.
- **Wait for a reset** is how long a subagent refused for a spent allowance waits for the provider's reset before it
  goes again by itself (six hours unless changed, 0 for never); one spawned with fallbacks moves to them after 90
  minutes instead.
- A **workflow** (the `workflow` tool beside `spawn`) is a script the agent writes to run many subagents for it: each
  `agent()` call names its provider and model, or takes the run's, and goes through the same rules and caps as a
  spawn. Its finished calls are kept, so a restart or a `resume` of an edited script does not pay for them again.
- A role with **Delegate** off can do neither: the in-process agent tools are removed and it cannot spawn.

Which model actually ran each turn is recorded: `mcp__diagnostics__turns`.
