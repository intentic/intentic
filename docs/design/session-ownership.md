# Session ownership

Every conversation on the `/agents` board records who started it and carries one accountable member, its owner.
The starter is provenance and never changes; the owner is responsibility and can be handed over.

## Why: one sandbox as the company's brain

A sandbox is one workspace, one fleet, one `/history`. When a team shares it, the fleet is where the company's
work-in-progress and its memory live: what was asked, what was decided, what landed, what is still parked on a
question. The board answers "what is happening" well and "whose is it" not at all. Three consequences show up as
soon as a second person signs in:

- A card waits in Attention on a question or a permission and nobody knows who should answer it. The person who
  asked has the context; everyone else sees the same card and either guesses or leaves it.
- A collaborator asks for a land; the maintainer reviewing it cannot tell, from the board, who to ask about the
  work, and `agents show` cannot tell an agent either.
- The archive fills with sessions no one can attribute. Six months on, "who ran the migration audit" is a
  transcript search rather than a column.

Ownership makes a session addressable by person: my sessions, Ania's sessions, the automation's unowned ones
waiting for a claim. That is what lets the fleet be shared rather than merely visible.

## What already existed

- `startedBy` on the persisted entry and `AgentSummary`: a member's email, or `token:<label>` for a program
  holding a control token. Latched on the first turn from what the daemon verified on the request
  (`agent.routes.ts` → `actorOf`), never from the body. The activity log carries the same value per turn as
  `actor`.
- `origin` for a conversation an automation opened: the automation, the listener provider, the channel and the
  relayed author.
- `landRequested` and `reactions`, both stamped with the verified caller.
- Members: the sandbox owner (bound at first sign-in) plus `.intentic/identity/members.json` with `{email, role}`.
  Names and pictures exist only on the presence roster while a member is connected. Control tokens record their
  minter (`createdBy`); automations record no creator.

Where it stopped: the board drew the starter only for the token case, `agents ls|show` and `iq sessions` never
printed it, a spawned child recorded no starter at all, and nothing distinguished "I started it" from "I am
responsible for it".

## The model

Two facts per conversation, kept apart because they answer different questions:

| Field       | Question                          | Mutable | Forms                                                                    |
|-------------|-----------------------------------|---------|--------------------------------------------------------------------------|
| `startedBy` | Who asked for the first turn?     | no      | `<email>`, `token:<label>`, `agent:<conversation id>`; absent for a wake |
| `owner`     | Who answers for it now?           | yes     | `{ email, name?, since }`; absent means nobody has claimed it            |

`agent:<id>` is new: a child another conversation spawned names its parent, the way a token session names its
token. A wake keeps naming its automation through `origin`; a second string saying the same thing would drift.

The owner is derived once, at the first turn, and then only moves by an explicit assignment:

- A member starts it → that member.
- A conversation spawns a child → the parent's owner at the moment of spawning.
- A program with a control token, or an automation → unowned until claimed. Phase 2 inherits the token's minter
  and the automation's creator once automations record one.

"Owner" collides with the top member role. The rule in code and prose: `MemberRole` `owner` is always "the
sandbox owner"; a conversation's owner is "its owner" or "the session's owner". Neither is ever shortened to the
bare word where the other could be meant.

## Policy

One route, `agents.assign { id, to }`, floored at collaborator like every other press that drives a card. It is
three actions in one verb, decided by who is asking:

- **Claim**: the conversation has no owner. Any collaborator may take it, or give it to a colleague.
- **Hand over**: the caller is the owner. They may name any member.
- **Take over / reassign**: the caller is a maintainer or the sandbox owner. Anyone's session, to anyone.

Anything else is FORBIDDEN with a sentence naming the owner, so the answer is "ask Ania" rather than a wall.
`to` must be the sandbox owner or a listed member; an outsider's address is BAD_REQUEST. Assigning leaves
`updatedAt` alone: somebody changing hands is not the conversation doing something.

Ownership gates nothing else yet. A collaborator may still steer, rename and archive a session that is not theirs,
as today; ownership is a label with one press, and the phases below say when it grows teeth.

## Surfaces

- **Board card**: an `OwnerMark` riding the model/branch line, never a row of its own — card height is what decides
  how many cards a lane holds before it scrolls. The reader's own sessions draw NOTHING: on most boards that is
  nearly every card, and a mark carried by nearly every card tells no two of them apart. Someone else's draws as
  that person's hue in a dot plus their given name, a token starter as key and label, a child as the parent's name
  linking to it. The full name stays in the hover, and what may be done about it in the session menu.
  The toolbar gains one exclusive owner filter beside the fleet scope — Everyone / Mine / a chip per other member
  holding a session here, each wearing the same dot its cards do — so ownership is a press rather than a legend.
- **Session menu**: Claim / Take over (to me) and Hand over… (a member picker fed by the presence roster, with a
  free address for someone not connected), offered only when the policy above would say yes.
- **`agents ls`**: a `who` column, the owner's address before the `@`, or the starter for an unowned one.
  `agents ls --owner <text>` narrows to one person. `agents show` adds an `owner … · started by …` line.
- **`iq sessions`**: the conversation line carries the owner, so a recalled session says whose it was.
- **Activity log**: unchanged; `actor` already says who asked each turn.

## Phases

1. **This change**: the schema, derivation and inheritance, `agents.assign`, the three surfaces above.
2. **Inherited ownership for programs**: a token session belongs to the token's minter; an automation records
   `createdBy` and its wakes belong to that member. An owner-aware Attention lane: "needs you" means your
   sessions first. Push targets the owner once endpoints carry a member (today they carry none, so every device
   gets every card).
3. **Ownership with teeth**: archive, discard and rewind on another member's session require maintainer; a
   collaborator's press on someone else's card becomes a request, the way their land already is. Removing a
   member hands their live sessions to the sandbox owner with a notice. The landed commit's trailer names the
   session's owner, so `git log` answers the question the archive could not.
4. **The company brain**: a person page (`agents ls --owner`, mirrored on the board) with their open questions,
   their landed work and their spend; hand-over notes written by the agent when a session changes hands, so the
   new owner opens it briefed; on-duty rotation for automation sessions so a night's unowned wakes have a
   claimant in the morning; the same owner across a workspace's several sandboxes.

## Costs and non-goals

- One optional object per registry entry, one field on the summary, one route. No migration: an entry without an
  owner is unowned, which is also what it was.
- Names are not authoritative. `owner.name` is whatever the assigning sign-in carried; a member assigned by
  address alone has no name until the board can read one off presence. Authorization reads emails only.
- Ownership does not cross into the platform. The platform mirrors grants; who owns which session is the
  sandbox's own record, in its conversations database, like everything else about the fleet.
- Not a lock. Two people may still drive one session; ownership says who answers for it, not who may type.

## Testing

- Registry: the owner latches from the first turn's starter, survives later turns by other members, and a child
  begun with `agent:<parent>` inherits the parent's owner.
- Routes: claim, hand-over and take-over each succeed for the tier that may make them and are FORBIDDEN for the one
  that may not; an outsider's address is BAD_REQUEST; the floor is collaborator.
- Recall: `--owner` narrows the roster; the row and the recall carry both fields.
- Board: the mark draws each of the three forms and nothing at all for the reader's own; the filter offers a chip
  per other owner, once each, and narrows every lane to whoever is lit.
