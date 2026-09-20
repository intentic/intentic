# Desk members

A fourth grantable tier, below viewer: a member who reaches the sandbox only through the persona cards the owner
handed them. Written 2026-09-20, with the build; the analysis it came out of is the "company brain" question: when one
sandbox holds everything a company knows, who gets an area, and what is the area made of.

## The short version

Two access models already existed and did not meet. Members held **verbs** (viewer, collaborator, maintainer,
owner; `auth/role-floor.ts`) over the whole box: every tier read every file, every transcript, the whole fleet.
Outsiders held **nouns**: a Front Desk visitor or a channel sender reached the brain only through one persona card
(`personas/front-desk.ts`, `Automation.senders[].actsAs`) and saw only the reply. A desk is the second model applied to
a member: a signed-in person whose every turn wears one of their cards, who sees their own conversations and nothing
else of the box.

The card stays what it was, a posture (`docs/design/accounts-and-personas.md`: accounts, powers, folders, carried
repositories, kit, models). The **member** gains the binding: `{ email, role: "desk", desks: [<persona id>…] }` in
`.intentic/identity/members.json`, the daemon's alone and never mirrored to the platform, which records the tier only.

## What a desk is, and is not

It is a **narrowing of what a person is handed**, enforced by the daemon at three layers:

| Layer | Where | What it holds |
| --- | --- | --- |
| Admission | `auth/role-floor.ts` `deskReach`, consulted by the bearer middleware instead of the floor | An allowlist of routes: signing in and being present, the chat it drives, the fleet (narrowed below), the cards it holds, the reads a composer needs. Everything unnamed is refused, so a route added later is closed to a desk until somebody decides. |
| Ownership | `auth/desk-scope.ts`, applied in `agents.routes.ts`, `agent/routes/agent.routes.ts`, `system/system.routes.ts` | A desk sees, drives, renames, archives and reads the transcript of conversations it owns or started; the roster and the `/events` roster frames are filtered the same way; frames naming paths or repositories are dropped; held wakes are never shown. |
| The card | `agent.run` (`refuseUnlessHeld`) and `personas.list` (`heldPersonas`) | A turn must name one of the desk's cards (naming none is refused too, the unattended rule); the persona list is the held cards and the accounts they name. The turn then resolves through `turnPersona` unchanged. |

It is **not a confidentiality fence** where the card's own fence is not one. `workspace.folders` is a PreToolUse
refusal on the file tools and does not reach a shell; `context.repos` is filesystem-real (an unlisted repository is
absent from the worktree) but names whole nested repositories only. A desk card with commands on is a lens, and the
Access page shows the card's bounds beside its name so the owner picks with that in view. The honest configuration
for a desk card today is `shell: false, code: true` ("code yes, commands no" is the one execution posture whose fence
is real), `delegate: false` until a child's card is capped by its parent's, and `context.repos` naming the
repositories the desk is for.

## The editor

`useRole` reads `isDesk`, and `canDrive` is true for a desk (it drives its own chats) while `canReview` (review, ask
for a landing) and `canShip` are not. The shell keeps a desk to the screens the daemon answers it on
(`shell/deskFence.ts`): the rail is Chat and Agents (`core-views/registry.ts` `deskRailGroups`), the sandbox hub is
the Access section alone, the home redirect is the chat, and a desk standing anywhere else is sent there. The persona
picker offers a desk its cards and neither "Anyone" nor the personas page; a new chat wears the first held card from
its first word; the router that reads a first message for a card is never asked for a desk; the composer's file
mentions are not offered.

The Access page grants a desk with a persona picker on the invite, shows a desk row's cards as chips, and re-grades a
row to desk through the same picker. The daemon refuses a desk grant naming no card, or a card the workspace does
not have, on the spot (`auth/members/members.routes.ts`).

## Deferred, and named so nobody reads the tier as more than it is

- **Cones and search scope** (`docs/context-composition-plan.md` steps 3–4): a card cannot yet carry a folder of a
  repository, and retrieval indexes all of `/work`. A desk on a monorepo package sees the package's repository whole.
- **A child's card capped by its parent's**: a desk card with `delegate` on can spawn a conversation wearing no card.
  Until the cap exists, desk cards should have delegation off.
- **Transcripts with teeth for tiered members** (`docs/design/session-ownership.md` phase 3): a viewer still reads
  every transcript; only a desk is narrowed.
- **Scope on the principal**: a member who needs *files* of one product and not another is not a desk (a desk has
  no files at all) and not a viewer (who has them all). That is a path filter beside the role floor, built when the
  case shows up.
- **Cross-area questions**: a desk gets no hand-off to a broader card. The brain's value is cross-cutting, and the
  hand-off is a confused deputy until it is designed as one.
