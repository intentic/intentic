---
name: links
description: Hand a task to another of the owner's sandboxes that is linked to this one (`mcp__<sandbox>__delegate`, or `agents delegate` from a shell), and supervise it like a subagent. Use when the work needs what only that sandbox has (its credentials, its repos, its devices, its persona), not for more hands on this sandbox's own work, which is `spawn`.
---

# Linked sandboxes

A **link** lets this sandbox hand tasks to another of the owner's sandboxes. Each linked sandbox sits with the owner's
devices: a `link` card under Your devices, and a tool server of its own named after the card, the way a computer's is
(`mcp__ops__delegate` beside `mcp__omen__run_command`). The token behind it was minted by the other sandbox's owner
and stays with this sandbox's daemon, never in your environment. What a task may do over there is decided **there**, on the link's terms:

- the **persona** its tasks wear (their accounts, tool shelves, folders and model);
- whether each task **waits for that sandbox's owner** to allow it before anything runs;
- how many **turns an hour** the link may start.

Nothing you say changes those terms. A refusal from over there is that owner's decision: report it and carry on.

## Tools

| You want | Tools | Any shell |
|---|---|---|
| which sandboxes you may hand work to | your tool list: one `mcp__<name>__…` server per linked sandbox | `agents links` |
| whether one answers now, and its terms | `mcp__<name>__about` | `agents links` |
| hand one a task | `mcp__<name>__delegate(task, description)` | `agents delegate <name> --description "…" '<task>'` |
| wait for it to finish or ask something | `wait(target: id)` | `agents wait <id>` |
| answer its question | `answer(child: id, …)` | `agents answer <id> '<text>'` |
| follow up, or continue a finished one | `send(child: id, message)` | `agents send <id> '<message>'` |
| stop it | `cancel(child: id)` | `agents cancel <id>` |

The id a hand-over returns (`linked-…`) is a subagent of this conversation: it shows under your card on the board,
`wait` covers it, and if your turn ends first its report wakes this conversation.

## How a task runs over there

- It opens **its own conversation** in the other sandbox, in that sandbox's own copy of its repos, and **lands
  there**, under that sandbox's rules. Nothing of it comes back into your checkout: `merge` has nothing to bring.
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
- A link reaches **only the conversations it opened** over there: never that sandbox's files, its other
  conversations or its settings.
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
sandboxes section of that sandbox's Access ▸ Programs, where the Allow is.
