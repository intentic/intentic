# Naming agents and telling them apart

## Where a title comes from

A conversation's title has a source, and a higher one replaces a lower one. Automatic titles that contain only a
project name, filename or other bare label can be replaced by a useful name regardless of their old rank:

1. `derived`: the first message, cut to a line (openers like "can you please" and code blocks dropped, cut on a
   sentence or word boundary, at most 80 characters).
2. `model`: the naming pass. When **Session titles** has a model (Sandbox ▸ Agent ▸ Jobs), it names the
   conversation a moment into its first turn, describing the work and its specific problem or goal (for example,
   "Fix flaky boot timing test"). The card's work category is stored separately; the visible title keeps its action.
   With no model on that job the pass does not run and the title stays the cut of the first message. Bare automatic
   labels are repaired on a later turn using the opening request. A spawned subagent keeps a useful name its parent
   chose for it.
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
account; and a row with lines added and removed (press it to open the review) and reactions. What each agent has
cost joins that row only with **Geek metrics** on (Settings → Appearance), beside its CPU and memory share; spend
across agents is on the Usage page. The card does not show the persona or the repository.

**Reactions** are the one mark people add: 👍 and 👎 in one press, the rest from a fixed picker (**Add reaction**).
Everyone sharing the sandbox sees them and who left each; one per person per emoji, up to 24 different emoji on a
conversation. The board cannot filter by them.

A chat tab's right-click menu offers what the agent's board card does (**Review changes**, **Land now**, a fresh
session, **Copy session name**, **Archive**) beside the tab's own closes. There is no pin: a tab is this browser's
state, not a label on the agent.

## There are no tags

Agents have no tags, labels, colors or stars, and personas have no icon or color. What exists instead:

- **Rename** with a convention (a project or ticket prefix): the board's search matches titles.
- The board's filters: **This sandbox** / **All sandboxes** (with more than one sandbox), **Everyone** / **Mine** /
  one chip per person (when others share the sandbox), the project filter chip, and the search box **Filter by
  your messages or id…**, which matches a title or either side's messages, archived agents included. There is no
  filter by status, provider, model, persona or reaction; the lanes are fixed: **Attention**, **Active**,
  **Finished**.
- The chat list is one list of every open chat in those same lanes. It is not grouped or filtered by persona: a
  persona is a posture a chat wears, shown and changed on its composer's **Acts as** pill.
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

## Automations that start an agent on every run

Each run of an automation that starts a new agent is a conversation of its own, so an automation on a short clock
(every 10 minutes) would otherwise fill the board with a card per run. Instead, its runs share one card: the card of
its latest run, with a provenance line naming the automation (**Schedule · x-follow**, **Watch · …**, **Webhook ·
…**) and a count with a history glyph (**Earlier runs: N**). The earlier runs are rows in that card's tray, behind
**N finished**, and each still opens its own chat.

The card stands where its latest run stands. An earlier run that failed is history once a later run has run after it,
so it stays in the tray rather than pulling the card into **Attention**; a run that needs something only you can give
(a permission, a credential, a setup) still does. A run that left work to land keeps a card of its own until it lands.
Archiving the card archives every run in it, after a dialog naming the automation and the count (**Archive all 7 runs
of x-follow?**). Runs recorded before this change are recognised by their `a-<automation>-…` id.
