# Where instructions live, and when a change reaches agents

## Where instructions live

**Memory: `AGENTS.md` at the workspace root.** This is the file meant when the owner asks for "Intentic's
AGENTS.md". Sandbox ▸ Agent ▸ Instructions, **Memory** (`/sandbox/agent?section=instructions`) lists every
`AGENTS.md` in the workspace as a chip, the root's under **Every turn** and each folder's under **Turns inside**, with
a ring for how much of the 20,000-character ceiling it takes (red when turns leave it out). Pressing one opens it in
the side panel to edit, with **Open in Workspace** on the tab; **Write memory** appears when the root file does not
exist yet. **Import** beside it opens a dialog that brings memory over from another assistant (ChatGPT, Claude,
Gemini, Grok or any other) and merges the answer into a marked block of the root file. The daemon reads it itself, plus an `AGENTS.md`
in each folder on the way down to where the turn starts (a role's **Starts in**), root first, and composes them
into the turn's instructions under "Standing instructions for this workspace" on every runtime; no loop's own file
discovery decides. The whole block is capped at 20,000 characters: a file that would cross it is left out whole and
named. An `AGENTS.md` inside a repository is that repository's own, added only for turns that start inside it.

**A rule the owner states in chat** ("from now on…", "always…", "never…", "remember…") is kept with
`instructions propose --text "…" --why "…"` (`--file <repo>` for a repository's own `AGENTS.md`, `--text -` from
stdin). It raises a card in the chat showing the exact change as a diff; nothing is written until the owner approves,
and the yes appends the rule to that file in the owner's tree (the main tree, never the conversation's checkout) and
commits that one file on its own (`Instructions: remember in AGENTS.md: …`), so a later discard of other changes
cannot take it. A file that already held the owner's own unsaved edits is written but left for them to commit, and
the answer says so. It then reaches every conversation that starts there from its next turn. The call answers like
every asking command: exit 0 when the file already says it, 3 while the card waits. Only for words the owner said
(`--why` quotes them): not for an instruction about the task at hand, not for a convention an agent worked out itself
(that goes in the repository's docs), and never by editing an `AGENTS.md` yourself unless the owner asked you to edit
that file.

**The system prompt.** Sandbox ▸ Agent ▸ Instructions, **System prompt** (`systemPromptMode`, `systemPrompt` in
settings.json):

- **Intentic** (the default): Intentic's own prompt, tuned for the app and updated with it.
- **Claude**: Claude Code's own prompt, read from the CLI installed in the sandbox.
- **Custom**: the owner's text (`systemPrompt`, at most 20,000 characters) is the whole prompt. Both built-in bases
  go, and so does the product's own guidance, including what drives the chat's question cards, checklist panel
  and browser tools, and the note naming the role a turn acts as. The owner's `AGENTS.md`
  still rides with it.

Runtimes take it differently: Claude Code, Codex and OpenCode (Grok, Gemini) replace their base prompt with it;
Cursor can only add, so it is appended to its own; Pi and ACP have no system prompt seam, so a custom prompt is not
applied there, and the role note and `AGENTS.md` go with the message instead.

**A role's own prompt**: `.intentic/config/roles/<id>/PROMPT.md`, used when the role's **What it is told**
is **Its own** (`systemPromptMode: "custom"` on its card). It replaces the sandbox's prompt on that role's turns,
exactly as a custom sandbox prompt does; empty or missing falls back to the sandbox's. See
`/root/.claude/skills/intentic/references/roles-and-models.md`.

**Skills.** The owner's own are stored in `.intentic/config/skills/` and switched on as copies in
`/work/.agents/skills/` (Claude reads them through `/work/.claude/skills`, one link to that folder), managed on
Sandbox ▸ Agent ▸ Instructions, **Skills**. That list shows every skill as a name on a labelled shelf: the owner's own
(and files dropped into the loaded folder) first, then each role's kit, then what connections, extensions and the image
brought, grouped by where they came from. Pressing one opens its page in the side panel beside Settings (a sheet on a
phone): its trigger line and instructions, written there for the owner's own, how many turns loaded it in the last seven
days (counted from the turns' own tool calls, a skill tool naming it or a read of its `SKILL.md`, kept in
`/history/skill-uses.json`), and the files of its folder, each opening as a workspace file beside it where the folder is
the one the agent reads. A role's own are in
its kit, `roles/<id>/skills/`. The image-baked ones, this skill among them, are in `/root/.claude/skills/`, which only
the Claude Code loop loads.

## When a change reaches agents

No restart is needed for any of these. Each is read when a turn is planned, so a change applies from the NEXT turn
of every conversation, including ones already open; a turn already running keeps what it started with.

- `settings.json` (the settings on Sandbox ▸ Agent), read from the live main tree.
- Roles: the card and its `PROMPT.md`; the access profiles holding it are read the same way. Its **Runs on** list is applied when the role is
  picked, and to jobs that name no model, so an open chat keeps the model its pill shows.
- Areas and grants: a grant given to or taken from one conversation applies from its next turn, and so does a switch
  to another role from a grant card.
- The checks each repository declares (`.intentic/checks.json`), read every turn.
- `AGENTS.md`, with one catch below.

The catch: `AGENTS.md` is read from the turn's own tree. An isolated conversation (the default)
works in a worktree rebased onto the main tree's last COMMIT before each turn, so an edit the owner has not
committed yet does not reach isolated conversations until it is committed (**Save changes** / **Commit**). With
**Save a version of accepted work** on, the owner's uncommitted edits are committed as "Your edits" before each
isolated turn, and it arrives by itself. During an isolated turn the owner's live copy is under
`/mnt/intentic-main/`.

Some things ride only a conversation's first message, so turning them on shows in new conversations: the project
map (`workspaceMap`; on for a sandbox made from November 2026, off for an older one until its owner switches it on),
and, on OpenCode, Pi, Cursor and ACP, the list of skills (those runtimes cannot read the
skills folder themselves). The map lists every area of the project with its size and purpose;
`workspaceMapHoldout` is the share of conversations that open without it. The comparison shares
(`workspaceMapHoldout`, `toolSearchHoldout`, `stableSystemPromptHoldout`,
`coldTrimHoldout`) assign whole conversations, not turns.

`toolSearch` (on by default) keeps the descriptions of connected tools (browsers, devices, accounts, phones) out of
every request until the agent looks one up with ToolSearch; the tools it uses every turn stay loaded. It applies to
Claude models on the Claude Code loop, shielded or not. `toolSearchHoldout` (none by default) is the share of
conversations that load every tool up front instead, so the saving can be measured again: Sandbox ▸ Agent ▸ Tools
shows the prompt size per request on both sides. Held-out conversations open at roughly twice the prompt size.

`stableSystemPrompt` (on by default) keeps the instructions identical between turns of a conversation. The paragraphs
whose condition moves between turns (whether anyone is watching, which of the owner's computers, browsers and phones
are connected) ride the turn's message under "Connected right now" instead, and only on a turn where they changed, or
the first one after a restart or a compaction. In the instructions, every such change rewrote the whole conversation to
the provider's cache. `stableSystemPromptHoldout` (half by default) keeps them in the instructions for that share of
conversations; the same Tools page shows how much prompt each side wrote again per follow-up turn.

`coldTrim` (on by default) applies to native Claude Code follow-ups above `coldTrimMinTokens` (100,000 measured
context tokens): once the known cache deadline has passed by 30 seconds, the turn resumes a copy with older tool output
cleared and recovery directions in its place. Half of conversations carry the whole session instead by default
(`coldTrimHoldout: 0.5`). Unknown cache timing, forks, held hand-offs and compacted sessions stay whole. A trim is shown
in the conversation; the original session remains available.

Changing the model within the same provider keeps the conversation's session. Changing the provider, the loop
(harness) or the account starts a fresh session on the next turn, handed the conversation's record and a "Where the
work stands" note.

What does need more than a new turn:

- A tool, package or toolchain in the image: an overlay the owner approves, then **Rebuild now** (the `environment`
  skill). The sandbox restarts for about half a minute; `/work` is kept.
- A newer daemon: the owner's update, see `/root/.claude/skills/intentic/references/sandbox-behind-app.md`.

A restart stops running turns; they must be resumed afterwards unless **Resume turns after a restart** is on
(Sandbox ▸ Agent ▸ Finishing; on by default).

**Night hours** (Sandbox ▸ Agent ▸ Finishing, settings `nightHours`, off until the owner sets them): the hours the
owner sleeps, on the sandbox's clock (the Clock row just above it). While they last and nobody is at the editor, an
agent's own question no longer parks its turn until morning. **Go with its pick** answers it with the option the agent
marked "(Recommended)", else its first, and the agent lists what was decided under "Decided while you slept" in its
last message; **Save for morning** tells the agent to finish everything that does not depend on the answer and end
with the question. A plan the agent chose to make is approved under the first and waits under the second; a plan the
owner launched the turn in plan mode for, permissions, held commands and cards for a named person always wait. The
turn is told under "Connected right now", and the frozen card says **Picked for you** or **Saved for morning**. Someone
at the editor in the middle of the night is asked as usual.

**Proceed without asking** (Sandbox ▸ Agent ▸ Finishing, setting `proceedWithoutAsking`, off by default): every
turn is told (under "Connected right now" when it changes, on a stable prompt) to carry on with its own recommendation
instead of stopping to propose or to ask for a go-ahead, to stop only before something destructive or outward-facing,
and to end with what it decided.
It is words, not a gate: permission cards, held commands and requests to connect something still wait. One
conversation can say otherwise from its card's menu (**Proceed without asking** / **Ask before going ahead**, route
`POST /agents/{id}/proceed`, `null` to follow again), and a subagent follows the conversation that started it unless
it has an answer of its own. While night hours are in force, they decide instead.

**Carrying on past a large context** (Sandbox ▸ Agent ▸ Finishing, setting `contextContinues`, 0 by default): a turn
that ends by itself saying it stopped because the conversation's context is large, with work still open, is carried on
in a fresh session of the same conversation, at most this many times in a row (a message from anyone else starts the
count again). The fresh session opens with the latest messages, where the work stands, and the stopped turn's closing
words, quoted. At 0 the chat only records a notice saying so; `agents continue <handle>` does the same by hand. A
subagent, a home and a loop's round are left to whatever drives them. A turn the provider refused for overflowing its
window is a different thing, re-run fresh by itself on no setting.

To go to bed early, the moon in the Agents board's header begins the night now (**Good night**), whether or not night
hours are switched on: it lasts until the night's end time (the morning), then ends by itself. While it is night the
moon is lit with that time ("until 07:00"); pressing it again ends a night begun there (**End night**), and the Night
hours card shows it as its own row with the same button.
