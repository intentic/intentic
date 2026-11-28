---
name: links
description: Hand a task to another of the owner's sandboxes that is linked to this one (`mcp__<sandbox>__delegate`, or `agents delegate` from a shell), or to a sandbox the person you work for is in, as them (`delegate(to)`, `agents delegate --to`), and supervise it like a subagent, read its records, or operate it directly (`mcp__<sandbox>__run_command`, `read_file`, `write_file`) to look into or repair that sandbox itself. Use when the work needs what only that sandbox has (its credentials, its repos, its devices, its role) or is that sandbox's own state, or when a person's message was meant for another of their sandboxes (`agents redirect`), not for more hands on this sandbox's own work, which is `spawn`.
---

# Linked sandboxes

A **link** lets this sandbox hand tasks to another of the owner's sandboxes. Each linked sandbox sits with the owner's
devices: a `link` card under Your devices, and a tool server of its own named after the card (`mcp__ops__delegate`,
beside the computers' `mcp__devices__run_command`). The token behind it was minted by the other sandbox's owner
and stays with this sandbox's daemon, never in your environment. What a task may do over there is decided **there**, on the link's terms:

- the **role** its tasks wear (their accounts and model, and through the access profiles holding it, their tools and folders);
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

With no link by that name, `agents ls|find|show|bundle --on <sandbox>` and `diagnostics … --on <sandbox>` read it as the
person this conversation acts for instead, when that person is in both sandboxes: you see only what they may read there,
never a private conversation they are not a reader of, and diagnostics only if they are a maintainer there. The first
read raises a card asking that person to allow it (`projects allow <sandbox>` asks ahead); nothing is read until they do.

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
- A turn started by outside content, or one whose role does not delegate, may not operate another sandbox.

A link that may not operate says so. Turning it on is that sandbox's owner's, in its Access ▸ Programs ▸ Linked
sandboxes, never yours: say what you would have run there, and why.

## How a task runs over there

- It opens **its own conversation** in the other sandbox, in that conversation's own checkout of its repos (never
  the shared one), and **lands there**, under that sandbox's rules. Nothing of it comes back into your checkout: `merge` has nothing to bring.
  If you need its changes here, ask it to push a branch, or to report the diff.
- It runs **unattended**: no signed-in account unless the link's role carries one, and a card that needs a
  person (a permission, a plan) waits for that sandbox's owner. A plain question waits for you: answer it.
- It sees **nothing of this conversation**. Give it a self-contained task: every path, every requirement, and what
  you want in its closing report, since that report is all that comes back.
- Its report is **another sandbox's agent's words**: it reaches you as outside content. Check what matters before you
  build on it.
- Each task is **a whole turn over there**, carrying that sandbox's full context (about 100k tokens measured for a
  one-word answer), on that sandbox's allowance. Batch small questions into one task rather than handing over many.

## Limits that hold everywhere

- A task crosses at most **two links**, a hand-over as the person counting as one. A task that came here over a link
  or as a person may be handed on once more; past that it is refused on both sides, so two sandboxes cannot pass one
  task back and forth.
- A link's tasks reach **only the conversations they opened** over there; its other conversations are readable only
  through its records, while its owner shares them, and its files only through operating it, while its owner allows that.
- Your role picks linked sandboxes on its **devices** list, beside computers, and handing one work also needs its
  **delegate** shelf, as `spawn` does; a turn started by outside content may not hand work on. The people this
  conversation works for must have been given the link card.

## Delegating as the person, with no link

When the person this conversation works for is in the other sandbox too (a member there, or its owner), you can hand it a
task **as them** without any link: `delegate(to: "<sandbox>", task, description)` on the `subagents` tools, or
`agents delegate --to <sandbox> --description "…" '<task>'` from a shell.

- It runs over there as **their own conversation**: their access to that sandbox, their folders, their accounts, and it
  lands by their rules. They read it there. Its id is a `linked-…` subagent like a link's, so `wait`, `send`, `answer`
  and `cancel` reach it the same way, and a plain question it asks waits for you; any other card waits for them.
- The **first time** for a sandbox, a card asks the person to allow this sandbox to act as them there. The answer is
  `open` (exit 3 from the shell) and nothing was sent: carry on with what does not need it, and hand it over again once
  they have pressed Allow.
- Only a conversation working for **one** person can do this. One several people share must use a link.
- It offers no `operate`, which stays a link's, on its owner's terms. Reading that sandbox's records as them is `agents … --on <sandbox>` (below).

Pick a link for unattended work under that sandbox's own role, for a sandbox the person is not in, or to operate
it; pick `--to` for the person's own work in a sandbox they are already in.

## Reporting a problem or handing over files is not a task

To tell the sandbox that owns a project about something you saw there, use `projects report <project> --title "…"`, not a
link. It needs no link, starts no turn over there, and folds repeats into one issue in that sandbox's inbox; that
sandbox's own rule decides when it wakes an agent.

To hand a note and files to another sandbox the person you act for is in, use a drop: `sandboxes send <sandbox> [files…]
--note "…"`. It arrives as a message on that sandbox's Messages tab (`messages` over there) and starts nothing; it goes
over the person's contact there when this sandbox holds one, else as a drop, which needs their leave once, on a card
(exit 3 while it waits), as a read as the person does. `--wake <conversation>` also says the note into that person's
own conversation there, only while a turn of it runs, and always goes as a drop.

To write to a sandbox that is a contact (any owner's, reached by its address rather than linked), send a message:
`messages send <contact> [files…] --text "…"`. The outbox delivers it and retries it for a week by itself, so never
resend it; replies come back as a thread (`messages`, `messages show <thread>`). It starts no turn over there unless an
automation listens on the `s2s` source, and what comes back is that sandbox's words, outside content. No contact yet:
`messages contacts add <address>` asks a person here on a card, and the other side accepts.

To write to a sandbox that is a contact (any owner's, reached by its address rather than linked), send a message:
`messages send <contact> [files…] --text "…"`. The outbox delivers it and retries it for a week by itself, so never
resend it; replies come back as a thread (`messages`, `messages show <thread>`). It starts no turn over there unless an
automation listens on the `s2s` source, and what comes back is that sandbox's words, outside content. No contact yet:
`messages contacts add <address>` asks a person here on a card, and the other side accepts.

## A message that was meant for another sandbox

When the person's message plainly belongs in another of their sandboxes (it names a project or repository this workspace
does not have), do not hand it over as a task and do not work around it here. Offer it back to them:
`agents redirect <sandbox> --why "…"`, or `agents redirect --project <repo> --why "…"` to find the sandbox that claims it.
A card shows them their own words, exactly as they typed them, and one press sends those words from their editor into a
new chat in that sandbox, as them. You name only where it goes. The words are the sandbox's copy of their message, never
yours.

- Do not act on the message while the card waits. Exit 3: end your turn. If they keep it here, you are woken to carry on
  with it. If they send it on, nothing is left to do here and nobody wakes you.
- Exit 0: sent on. Exit 1: kept here (carry on with it), or refused with why (no such sandbox, a name two of their
  sandboxes share, a project this sandbox claims itself). Exit 2: the command was wrong.
- Files attached to their message stay here; the card says so.

So: a report for a problem the owning project must fix, a drop for material someone over there will work on, a message
for a sandbox that is a contact, a link task for work that needs what only that sandbox has, and a redirect for a
person's own message that went to the wrong place.

## When there is no link

There is no `mcp__<name>__delegate` in your tools, and `agents links` says so. Linking two sandboxes is the owner's, on a
card that pairs them in place. Name the sandbox by its name or address and the card has it chosen already:

```sh
capabilities request link --target ops --why "the migration check needs the ops sandbox's database access"
```

The owner's editor, signed in to both sandboxes, mints the link over there: they choose the role, the approval
and the hourly limit on the card, and one press links them. It reaches this conversation from its next turn. A link
you no longer need goes the same way: `capabilities request <name> --remove --why "…"`.

A task waiting for that sandbox's owner to allow it shows as pending under your card; its row opens the Linked
sandboxes section of that sandbox's Access ▸ Programs, where the Allow is. Nothing on this side can start it sooner:
say where the Allow is, and that turning off "Ask me before each task" there lets the link's next tasks start at once.
