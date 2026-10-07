# Naming agents and telling them apart

## Where a title comes from

A conversation's title has a source, and a higher one replaces a lower one, never the reverse:

1. `derived`: the first message, cut to a line (openers like "can you please" and code blocks dropped, cut on a
   sentence or word boundary, at most 80 characters).
2. `model`: the naming pass. When **Session titles** has a model (Sandbox ▸ Agent ▸ Jobs), it names the
   conversation a moment into its first turn, in a few words. With no model on that job the pass does not run and
   the title stays the cut of the first message. A spawned subagent is named by the parent's description of it.
3. `plan`: the agent's own plan heading.
4. `user`: a rename by a person. It outranks everything, so nothing automatic renames it afterwards.

To rename (at most 80 characters):

- **Agents** board: hover a card and press the pencil (**Rename agent**). Cards of this sandbox only; the card's
  right-click menu has no rename.
- **Chat**: double-click the title in the header, or press **F2** (the command **Rename…**). The chat list's row
  menu has **Rename** too.
- An agent's review page: the ⋯ menu, **Rename**.

The route behind all of them is `agents.rename` (`POST /agents/{id}/rename`).

## What tells cards apart at a glance

Each card on `/agents` shows: a leading tile tinted and marked by the kind of work read from the title (a fix, a
feature…), or the provider's logo when no kind is read; the title; a status pill; a line naming the owner (when it
is not you), the model, the machine it runs on when that is elsewhere, the branch (without `agent/`) and the
account; and a row with lines added and removed, cost and reactions. The card does not show the persona or the
repository.

**Reactions** are the one mark people add: 👍 and 👎 in one press, the rest from a fixed picker (**Add reaction**).
Everyone sharing the sandbox sees them and who left each; one per person per emoji, up to 24 different emoji on a
conversation. The board cannot filter by them.

A chat tab can be pinned (**Pin**), which keeps it open and out of bulk closes. That is this browser's tab state,
not a label on the agent.

## There are no tags

Agents have no tags, labels, colors or stars, and personas have no icon or color. What exists instead:

- **Rename** with a convention (a project or ticket prefix): the board's search matches titles.
- The board's filters: **This sandbox** / **All sandboxes** (with more than one sandbox), **Everyone** / **Mine** /
  one chip per person (when others share the sandbox), the project filter chip, and the search box **Filter by
  your messages or id…**, which matches a title or either side's messages, archived agents included. There is no
  filter by status, provider, model, persona or reaction; the lanes are fixed: **Attention**, **Active**,
  **Finished**.
- The chat list switches between **Agents** and **Personas**; the second groups chats under the persona they act
  as, which is the way to see agents by persona.
- **Reactions**, as above.

## Where finished agents go

A finished agent is archived after `agentRetentionDays` (default 3; Sandbox ▸ Agent ▸ Finishing, **Archive
finished agents**: 1 day, 3 days, 1 week or Never), or by hand from its card. The **Finished** lane's **Open the
archive (N)** lists them, with **Restore** on each. Archiving commits what the conversation still had in progress
onto its own branch and releases its working copy.

A subagent rides in the tray under the card of the agent that spawned it. When it stops (an error, a spent
allowance, a Stop) the stop is reported to that parent, so it moves the parent's card to **Attention** only until
the parent has moved past it. A parent that carried on and landed sits in **Finished**, with the stop kept in its
tray. What only you can answer (a permission, a plan, a setup, a credential) and a question nobody answered still
reach **Attention**. When a parent is archived, by hand, by **Clear** or by age, the subagents that stopped before
it last moved go with it.
