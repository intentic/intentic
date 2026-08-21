# @intentic/ext-drafts

The approval inbox for posts the agent proposed during its scheduled work.

The agent writes one JSON file per draft into `.intentic/config/drafts/` (taught by the daemon's drafts skill); this
surface is the owner's approve / edit / reschedule / reject side. There is no create dialog: drafts originate
with the agent, never the UI. Approving starts a visible one-minute countdown, not a send.

## Responsibilities

- Show the queue as decisions in the order they are owed: broken, waiting on you, going out, scheduled, posted.
- Approve, edit, reschedule, reject: every affordance gated to the ship tier (`api.sandbox.role()`), because
  below maintainer the queue is a read and buttons the daemon would refuse teach people that buttons lie.
- Carry the rail badge: what the queue owes its owner, and danger only once something is broken rather than
  merely waiting.

## Key files

- [src/DraftsView.vue](src/DraftsView.vue): the queue, one section per decision.
- [src/useDrafts.ts](src/useDrafts.ts): the list and the writes, plus `owedOf`, the one definition of what the
  queue owes (the badge, the view and the phone's Review tab all count with it).
- [src/postText.ts](src/postText.ts): platform caps, countdown words, and what makes a post a title.
- [src/extension.ts](src/extension.ts): activation, the permanent tile, and the badge, which the queue's own
  files refresh (the manifest's `contributes.files` binding) with a slow interval behind it as a backstop.

## How it fits

This was an in-app page (`/drafts`, a fixed shell tile, a hand-fed badge) until the everything-with-a-face
rule: the ENGINE (the store, the publisher automation the daemon fires, the routes) was always core and stays
core, and this package is only the face on it. The move is also why `api.sandbox.role()` exists and why the kit
now hands out `BrandMark`, `NoticeStack`, `useNow` and `useAsyncAction`: each was a private app piece the first
real port needed, which is precisely the pressure that keeps the public API honest.

The phone's fixed Review tab still points here: it PROMOTES this extension's registry entry (route and badge
both) rather than reaching into its data, the same way the desktop rail ranks extension ids for placement.

**Deliberately not essential.** The daemon fires the publish automation on its own, but that engine acts only
on drafts the owner already approved: switching this surface off starves it rather than blinding anyone, the
fail-safe half of the distinction `ESSENTIAL_EXTENSIONS` draws.

## Conventions & gotchas

- A draft's `platform` is a bare string naming the capability whose skill posts it; the display name and brand
  come from the installed pack's own catalog entry, and a platform with no installed connector still renders as
  a monogram: a draft can be proposed for somewhere this sandbox cannot yet post.
- A row shows the persona the draft goes out AS (`actsAs`, in the meta line between the place and the time),
  because the button beside it is Approve and whose name is on a public post is the one thing that click cannot
  take back. The drafting agent writes that field and this surface only displays it: changing it means editing
  the draft file, since the extension API has no personas listing to build a picker from.
- Editing is a plain field on the same upsert every other action uses, offered only where changing the words is
  still worth anything: waiting on a yes, or already failed. Rows on their way out get "back to review" instead,
  so nothing is rewritten on a row the publisher may already be reading.
