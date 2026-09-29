# Land, Accept, Save changes, Back up, Rebuild: what each does, in order

The words depend on Settings ▸ Appearance, **How you work**: **I write code** shows git's own words, **I don't**
shows plain ones. The switch changes words and the home page only. The sandbox keeps each person's answer, so every
browser and device they open it on uses the same words, while two people on one sandbox can each keep their own. The
first-visit question (**How will you work here?**) is the one exception: answering **I don't write code** there also
offers to switch on the two automatic rules in steps 2 and 3 below.

| I write code | I don't | What it is |
|---|---|---|
| branch | draft | where one agent's work sits until it is applied |
| **Ready to land** | **Ready to accept** | a card whose finished work waits for that press |
| **Review & land** | **Look & accept** | the way from that card to the work, to read it first |
| **Land now** | **Accept** | apply that work to the workspace, uncommitted |
| **Landed** / **Couldn't land** | **Accepted** / **Couldn't accept** | how that press went |
| **Land again** | **Accept again** | apply it once more after it was taken out |
| **Commit** | **Save N changes** | a git commit of the workspace |
| **Push** / **Sync** / **Publish** | **Back up** | send commits to the remote (GitHub, GitLab…) |
| Discard | Throw away | drop an agent's work |
| uncommitted change | unsaved change | |

## The order, simply

1. **An agent works on its own branch.** Each conversation has a private copy (a worktree on
   `agent/<conversation-id>`), so nothing it does touches the owner's files yet. When a turn ends cleanly its card
   reads **Ready to land** (**Ready to accept**), and pressing it opens **Review & land** (**Look & accept**): the
   agent's changes, to read.
2. **Land / Accept** applies the agent's work to the workspace as uncommitted changes. HEAD does not move. By
   default it is all or nothing: one conflict and nothing is written, and a card names the files. The button is on
   the agent's card on `/agents` and on its review page; there is none in the chat. A **Collaborator** gets
   **Request land** / **Ask to accept** instead. With **Land finished work automatically** on (Sandbox ▸ Agent ▸
   Finishing; off by default, also per agent from its ⋯ menu: **Land automatically** / **Hold work on the
   branch**), a clean turn lands by itself; a failed or stopped one never does.
3. **Save changes / Commit** makes it a version. Until then the landed work is uncommitted, and isolated agents
   start from the last commit, so later agents do not see it. The plain-words **Save** panel commits the whole tree,
   named by the subject written for the landing when the tree holds only that one, else "Your edits". With **Save a
   version of accepted work** on, this happens by itself after each land, and the owner's own edits are committed
   before the next agent starts.
   **Save changes** in a file's own editor is different: it writes that file to disk.
4. **Back up / Push** sends the commits to the remote. It is a separate press, never automatic, and the repository's
   own pre-push hook runs. CI checks what was pushed.

**Land again / Accept again** is not the next step. It appears only when work that already landed was later taken
out of the workspace (discarded by hand or by another agent tidying up), and it puts that work back. The card says who
took it out when the sandbox could tell (**Removed by you**, or by a named agent). When an agent took it out, the card
does not offer **Land again**, since that was deliberate; it stays in the card's ⋯ menu. Later turns of the same agent
land through the ordinary **Land now** / **Accept**. On a phone, a land pressed on a card asks first.

A land that fails (git refuses, or the agent's copy lost its link to the workspace) puts the card in the board's
**Attention** lane with **Couldn't land** and the reason, and it stays there, whatever turns run after it, until a land
goes through.

If the owner's own uncommitted edits sit on the files a land needs, the card says so; committing them first
unblocks it. **Have the agent resolve it** (plain words: **Ask the assistant to redo it**) merges in the agent's own
worktree, and nothing reaches the workspace unless that succeeds.

## The environment is a separate track

Files and commits never change the sandbox's image. A tool or package that must survive a rebuild goes:

1. An agent runs `environment propose <tool>` (the `environment` skill), which puts a card in the chat.
2. The owner presses **Approve**, on that card or on the Environment card (Sandbox ▸ Environment). The card then
   says the tool arrives when the sandbox is rebuilt; its **Rebuild** button only opens Sandbox ▸ Environment.
3. **Rebuild now** on Sandbox ▸ Environment builds the approved recipe and restarts the sandbox for about half a
   minute. `/work` is kept. A hosted sandbox builds on a machine intentic runs and keeps working meanwhile; on the
   owner's own machine the build runs there, from a connected device or the desktop app, or as a command to paste.
   Running turns stop and must be resumed unless **Resume turns after a restart** is on. When agents are mid-turn
   on a sandbox whose machine is connected as a device, the rebuild dialog names them and offers two ways round
   that: leave **Let them pick up again by themselves once the sandbox is back** ticked (the sandbox resumes the
   turns the restart cut), or press **Rebuild when they're idle** (the sandbox holds the rebuild, starts it once no
   agent is mid-turn, and the card says whom it waits for, with **Cancel rebuild**). The owner can also take a tool out
   again with **Remove from environment** on its row in Contents; that too waits for a rebuild.

Not the same thing: the **Update** card on Sandbox ▸ Overview moves the sandbox to a newer Intentic release
(`/root/.claude/skills/intentic/references/sandbox-behind-app.md`), and **Restart sandbox** on the version card is
for a sandbox built from a source checkout.
