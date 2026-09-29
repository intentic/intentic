# Where instructions live, and when a change reaches agents

## Where instructions live

**Memory: `AGENTS.md` at the workspace root.** This is the file meant when the owner asks for "Intentic's
AGENTS.md". Edited on Sandbox ▸ Agent ▸ Instructions, **Memory** (`/sandbox/agent?section=instructions`; **Open
file** opens `/workspace/AGENTS.md`), or as any file. **Bring memory over from another assistant** on the same page
merges an export from another AI into a marked block of that file. The daemon reads it itself, plus an `AGENTS.md`
in each folder on the way down to where the turn starts (a persona's **Starts in**), root first, and composes them
into the turn's instructions under "Standing instructions for this workspace" on every runtime; no loop's own file
discovery decides. The whole block is capped at 20,000 characters: a file that would cross it is left out whole and
named. An `AGENTS.md` inside a repository is that repository's own, added only for turns that start inside it.

**The system prompt.** Sandbox ▸ Agent ▸ Instructions, **System prompt** (`systemPromptMode`, `systemPrompt` in
settings.json):

- **Intentic** (the default): Intentic's own prompt, tuned for the app and updated with it.
- **Claude**: Claude Code's own prompt, read from the CLI installed in the sandbox.
- **Custom**: the owner's text (`systemPrompt`, at most 20,000 characters) is the whole prompt. Both built-in bases
  go, and so does the product's own guidance, including what drives the chat's question cards, checklist panel
  and browser tools, the field notes and the note naming the persona a turn acts as. The owner's `AGENTS.md`
  still rides with it.

Runtimes take it differently: Claude Code and Codex replace their base prompt with it; OpenCode and Cursor can only
add, so it is appended to theirs; Pi and ACP have no system prompt seam, so a custom prompt is not applied there,
and the persona note and `AGENTS.md` go with the message instead. **Short guidance** (`leanGuidance`) sends the
product's guidance in its short form.

**A persona's own prompt**: `.intentic/config/personas/<id>/PROMPT.md`, used when the persona's **What it is told**
is **Its own** (`systemPromptMode: "custom"` on its card). It replaces the sandbox's prompt on that persona's turns,
exactly as a custom sandbox prompt does; empty or missing falls back to the sandbox's. See
`/root/.claude/skills/intentic/references/personas-and-models.md`.

**Skills.** The owner's own are stored in `.intentic/config/skills/` and switched on as copies in
`/work/.agents/skills/` (Claude links them from `/work/.claude/skills/`), managed on Sandbox ▸ Agent ▸
Instructions, **Skills**. A persona's own are in its kit, `personas/<id>/skills/`. The image-baked ones, this
skill among them, are in `/root/.claude/skills/`, which only the Claude Code loop loads.

**Field notes**: `.intentic/config/field-notes.toon`, a brief on how work goes in this sandbox, rewritten monthly by
an automation from past sessions. Sent only with the **Field notes** switch on (Sandbox ▸ Agent ▸ Tools;
`fieldNotes`, off by default), up to `fieldNotesBudget` characters (default 4,000).

## When a change reaches agents

No restart is needed for any of these. Each is read when a turn is planned, so a change applies from the NEXT turn
of every conversation, including ones already open; a turn already running keeps what it started with.

- `settings.json` (the settings on Sandbox ▸ Agent), read from the live main tree.
- Personas: the card, its fence and shelves, its `PROMPT.md`. Its **Runs on** list is applied when the persona is
  picked, and to jobs that name no model, so an open chat keeps the model its pill shows.
- Areas and grants: a grant given to or taken from one conversation applies from its next turn.
- The checks each repository declares (`.intentic/checks.json`), read every turn.
- `AGENTS.md` and field notes, with one catch below.

The catch: `AGENTS.md` and field notes are read from the turn's own tree. An isolated conversation (the default)
works in a worktree rebased onto the main tree's last COMMIT before each turn, so an edit the owner has not
committed yet does not reach isolated conversations until it is committed (**Save changes** / **Commit**). With
**Save a version of accepted work** on, the owner's uncommitted edits are committed as "Your edits" before each
isolated turn, and it arrives by itself. During an isolated turn the owner's live copy is under
`/mnt/intentic-main/`.

Some things ride only a conversation's first message, so turning them on shows in new conversations: the project
map (`workspaceMap`), and, on OpenCode, Pi, Cursor and ACP, the list of skills (those runtimes cannot read the
skills folder themselves). The comparison shares (`workspaceMapHoldout`, `iqSearchHoldout`,
`fieldNotesHoldout`, `leanGuidanceHoldout`) assign whole conversations, not turns.

Changing the model within the same provider keeps the conversation's session. Changing the provider, the loop
(harness) or the account starts a fresh session on the next turn, handed the conversation's record and a "Where the
work stands" note.

What does need more than a new turn:

- A tool, package or toolchain in the image: an overlay the owner approves, then **Rebuild now** (the `environment`
  skill). The sandbox restarts for about half a minute; `/work` is kept.
- A newer daemon: the owner's update, see `/root/.claude/skills/intentic/references/sandbox-behind-app.md`.

A restart stops running turns; they must be resumed afterwards unless **Resume turns after a restart** is on
(Sandbox ▸ Agent ▸ Finishing).
