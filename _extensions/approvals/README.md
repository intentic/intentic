# @intentic/ext-approvals

The inbox of things the agent prepared and may not do until the owner says yes.

The agent writes one JSON file per item into `.intentic/config/approvals/` (taught by the daemon's approvals
skill); this surface is the owner's approve / edit / reschedule / reject side. There is no create dialog: items
originate with the agent, never the UI. Approving starts a visible one-minute countdown, not the thing itself.

## What belongs here, and what does not

One queue holds every decision of one shape: *the agent prepared an exact thing, the owner's click releases it, a
machine then does precisely that thing, and the outcome is written back.* Two kinds so far, told apart by `kind`:

- **`post`**: words that go out in public under the owner's name. Publishable directly by the daemon where the
  platform has an API (Discord), by an agent turn everywhere else.
- **`action`**: anything else the agent should not do unasked: a booking, a payment, a message, a deletion. The
  agent writes what will happen (`summary`, `details`) and its own brief for the turn that will do it
  (`instructions`). Always an agent turn.

A third kind is one variant in the contract, one executor in the daemon and one body component here; nothing
else on this page moves.

The page also lists the **automations held at the door**: a `requireApproval` automation that fired and is waiting
for a yes, or a `holdForSeconds` one under its countdown. Same shape of decision, so it is drawn here with the
verbs it always had (approve / reject, start now / cancel), but it is deliberately NOT the same store
(`useHeldWakes.ts` explains): a held wake is daemon-minted, consumed on release and carries a webhook's payload,
none of which belongs in the versioned queue the agent writes.

What is deliberately NOT here: the Issues inbox (facts that arrived from a stranger's browser, whose verbs are
resolve / ignore / investigate, with nothing prepared to release), and the holds a *running* turn is blocked on
(a permission card, a spend offer), which live in the conversation because a queue is the wrong latency for a
click somebody is spinning on.

## Responsibilities

- Show the queue as decisions in the order they are owed: broken, waiting on you, going ahead, scheduled, done.
- Approve, edit (posts only), reschedule, reject: every affordance gated to the ship tier (`api.sandbox.role()`),
  because below maintainer the queue is a read and buttons the daemon would refuse teach people that buttons lie.
- Carry the rail badge: what the queue owes its owner, and danger only once something is broken rather than
  merely waiting.

## Key files

- [src/ApprovalsView.vue](src/ApprovalsView.vue): the queue, one section per decision; the envelope every row
  shares, with the body chosen by kind.
- [src/PostBody.vue](src/PostBody.vue) and [src/ActionBody.vue](src/ActionBody.vue): the two bodies. A post is set
  as a post; an action is a headline, its specifics, and the agent's brief folded under them.
- [src/useApprovals.ts](src/useApprovals.ts): the list and the writes, plus `owedOf`, the one definition of what
  the queue owes (the badge, the view and the phone's Review tab all count with it).
- [src/useHeldWakes.ts](src/useHeldWakes.ts): the daemon's held-wake queue (`GET /automations/pending`), its
  approve / reject, and `waitingOf`, which of those wakes genuinely want a person.
- [src/usePostEdit.ts](src/usePostEdit.ts): editing a post's words in place, saved as typed. Posts only: an owner
  rewriting an action's brief is approving something nobody proposed.
- [src/postText.ts](src/postText.ts): platform caps, countdown words, and what makes a post a title.
- [src/extension.ts](src/extension.ts): activation, and the badge, which the queue's own files refresh (the
  manifest's `contributes.files` binding) with a slow interval behind it as a backstop.

## How it fits

This was `drafts`, a queue of posts alone, and before that an in-app page (`/drafts`, a fixed shell tile, a
hand-fed badge). The ENGINE (the store, the executor the daemon arms, the routes) was always core and stays core,
and this package is only the face on it. The generalization from posts to approvals happened because the next
thing an agent needed a yes for was a hotel booking, and a product that grows one inbox per kind of yes ends up
with five tiles that all say "approve".

The phone's fixed Review tab still points here: it PROMOTES this extension's registry entry (route and badge
both) rather than reaching into its data, the same way the desktop rail ranks extension ids for placement.

**The tile is on the rail while the queue owes something, and behind the More menu when it does not.** The area
detects unconditionally, so it is always addressable (that is what the phone's Review tab, the palette's
`view.approvals` and the More list all use); what the badge decides is the SEAT, under the app's own rule
(`core-views/registry.ts`).

**Deliberately not essential.** The daemon's executor runs on its own, but it acts only on items the owner already
approved: switching this surface off starves it rather than blinding anyone, the fail-safe half of the distinction
`ESSENTIAL_EXTENSIONS` draws.

## Conventions & gotchas

- A post's `platform` is a bare string naming the capability whose skill posts it; the display name and brand
  come from the installed pack's own catalog entry, and a platform with no installed connector still renders as
  a monogram: a post can be proposed for somewhere this sandbox cannot yet post.
- A row shows the persona the item acts AS (`actsAs`, in the meta line between the place and the time), because
  the button beside it is Approve and whose name is on a public post is the one thing that click cannot take
  back. The agent writes that field and this surface only displays it.
- Editing is a plain field on the same upsert every other action uses, offered only where changing the words is
  still worth anything: waiting on a yes, or already failed. Rows on their way get "back to review" instead, so
  nothing is rewritten on a row the executor may already be reading.
- The rail's slices are the platforms the queue holds plus one `actions` row when it holds any; the slice lives
  in the URL as `?scope=`. A platform literally named `actions` would be shadowed by that row, which is accepted.
