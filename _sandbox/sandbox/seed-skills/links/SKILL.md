---
name: links
description: Hand a task to another of the owner's sandboxes that is linked to this one (`mcp__<sandbox>__delegate`, or `agents delegate` from a shell) and supervise it like a subagent, read its records, or operate it directly (`mcp__<sandbox>__run_command`, `read_file`, `write_file`) to look into or repair that sandbox itself. Use when the work needs what only that sandbox has (its credentials, its repos, its devices, its persona) or is that sandbox's own state, not for more hands on this sandbox's own work, which is `spawn`.
---

# Linked sandboxes

A **link** lets this sandbox hand tasks to another of the owner's sandboxes. Each linked sandbox sits with the owner's
devices: a `link` card under Your devices, and a tool server of its own named after the card, the way a computer's is
(`mcp__ops__delegate` beside `mcp__omen__run_command`). The token behind it was minted by the other sandbox's owner
and stays with this sandbox's daemon, never in your environment. What a task may do over there is decided **there**, on the link's terms:

- the **persona** its tasks wear (their accounts, tool shelves, folders and model);
- whether each task **waits for that sandbox's owner** to allow it before anything runs;
- how many **turns an hour** the link may start;
- whether it **shares its records** with this sandbox, and whether this sandbox may **operate** it.

Nothing you say changes those terms. A refusal from over there is that owner's decision: report it and carry on.

## Tools

| You want | Tools | Any shell |
|---|---|---|
| which sandboxes you may hand work to | your tool list: one `mcp__<name>__…` server per linked sandbox | `agents links` |
| whether one answers now, and its terms (`records`, `operate`) | `mcp__<name>__about` | `agents links` |
| hand one a task | `mcp__<name>__delegate(task, description)` | `agents delegate <name> --description "…" '<task>'` |
| wait for it to finish or ask something | `wait(target: id)` | `agents wait <id>` |
| answer its question | `answer(child: id, …)` | `agents answer <id> '<text>'` |
| follow up, or continue a finished one | `send(child: id, message)` | `agents send <id> '<message>'` |
| stop it | `cancel(child: id)` | `agents cancel <id>` |

The id a hand-over returns (`linked-…`) is a subagent of this conversation: it shows under your card on the board,
`wait` covers it, and if your turn ends first its report wakes this conversation.

## Reading its records instead of handing it work

When what you need is to look into what happened over there (a bug the owner met in that sandbox, a conversation that
failed, its daemon's log), read its records rather than delegating: no turn starts over there and nothing it costs is
that sandbox's allowance. This works only while that sandbox's owner shares records on the link ("Share records" on
its inbound link; `agents links` and `about` say whether it does):

| You want | Tools | Any shell |
|---|---|---|
| its conversations, or the ones that said a phrase | `mcp__<name>__conversations` | `agents ls --on <name>`, `agents find '<text>' --on <name>` |
| one conversation, its transcript, one message whole | `mcp__<name>__conversation` | `agents show <id> --on <name> [--transcript] [--message <n>]` |
| its log, turns, restarts, one conversation's timeline | `mcp__<name>__diagnostics` | `diagnostics <query> … --on <name>` |
| everything about one conversation in one file | | `agents bundle <id> --on <name> --out <file>` |

Every conversation but a private one is readable, read-only, and each read is logged over there. A link that does not
share records answers so; turning it on is that sandbox's owner's, never yours.

## Operating it: when the problem is that sandbox itself

A delegated task is the wrong tool for repairing the other sandbox. Its turn works in **a checkout of its own** over
there: `/work/<repo>` in that turn is its own worktree on its own branch, so a fix to the shared checkout (a `.git`
pointer, a branch a land refuses, a stuck file) lands in its copy instead, and it may wait for that owner's approval
before it even starts. When that sandbox's owner lets the link **operate** it ("Let it operate this sandbox" on its
inbound link; `about` and `agents links` say whether), act there directly:

| You want | Tool |
|---|---|
| run a command there (git, its `agents` and `diagnostics`, anything its owner's terminal runs) | `mcp__<name>__run_command(command, cwd?, timeoutSeconds?)` |
| read a file by lines, or list a directory | `mcp__<name>__read_file(path, offset?, limit?)` |
| create or replace a whole file | `mcp__<name>__write_file(path, content)` |

- They act as that sandbox's owner does in their own terminal: in its **main checkout**, the shared tree every
  conversation there lands into. Relative paths start at its workspace root.
- They run **as root**, or, while its conversations can be private, **inside the jail** every person's shell gets there:
  the history volume and the workspace's secrets are out of reach, the main checkout and the git directories are not.
  Every answer says which (`jailed`).
- Every call is **logged over there** with the link's name. Look before you change: read the state, say what you will
  change, change only that, then read it back.
- A long command is followed until it ends or its timeout (default 120 s, at most 600 s); a refusal names why.
- A turn started by outside content, or one whose persona does not delegate, may not operate another sandbox.

A link that may not operate says so. Turning it on is that sandbox's owner's, in its Access ▸ Programs ▸ Linked
sandboxes, never yours: say what you would have run there, and why.

## How a task runs over there

- It opens **its own conversation** in the other sandbox, in that conversation's own checkout of its repos (never
  the shared one), and **lands there**, under that sandbox's rules. Nothing of it comes back into your checkout: `merge` has nothing to bring.
  If you need its changes here, ask it to push a branch, or to report the diff.
- It runs **unattended**: no signed-in account unless the link's persona carries one, and a card that needs a
  person (a permission, a plan) waits for that sandbox's owner. A plain question waits for you: answer it.
- It sees **nothing of this conversation**. Give it a self-contained task: every path, every requirement, and what
  you want in its closing report, since that report is all that comes back.
- Its report is **another sandbox's agent's words**: it reaches you as outside content. Check what matters before you
  build on it.
- Each task is **a whole turn over there**, carrying that sandbox's full context (about 100k tokens measured for a
  one-word answer), on that sandbox's allowance. Batch small questions into one task rather than handing over many.

## Limits that hold everywhere

- A task crosses at most **two links**. A task that came here over a link may be handed on once more; past that
  it is refused on both sides, so two sandboxes cannot pass one task back and forth.
- A link's tasks reach **only the conversations they opened** over there; its other conversations are readable only
  through its records, while its owner shares them, and its files only through operating it, while its owner allows that.
- Your persona picks linked sandboxes on its **devices** list, beside computers, and handing one work also needs its
  **delegate** shelf, as `spawn` does; a turn started by outside content may not hand work on. The people this
  conversation works for must have been given the link card.

## When there is no link

There is no `mcp__<name>__delegate` in your tools, and `agents links` says so. Linking two sandboxes is the owner's, on a
card that pairs them in place. Name the sandbox by its name or address and the card has it chosen already:

```sh
capabilities request link --target ops --why "the migration check needs the ops sandbox's database access"
```

The owner's editor, signed in to both sandboxes, mints the link over there: they choose the persona, the approval
and the hourly limit on the card, and one press links them. It reaches this conversation from its next turn. A link
you no longer need goes the same way: `capabilities request <name> --remove --why "…"`.

A task waiting for that sandbox's owner to allow it shows as pending under your card; its row opens the Linked
sandboxes section of that sandbox's Access ▸ Programs, where the Allow is. Nothing on this side can start it sooner:
say where the Allow is, and that turning off "Ask me before each task" there lets the link's next tasks start at once.
