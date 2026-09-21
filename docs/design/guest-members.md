# Guest members

A fourth grantable tier, below viewer: a member who reaches the sandbox only through the assistants that work in the
part of it the owner handed them. Written 2026-09-20, with the build; the analysis it came out of is the "company
brain" question: when one sandbox holds everything a company knows, who gets an area, and what is the area made of.

## The short version

Two access models already existed and did not meet. Members held **verbs** (viewer, collaborator, maintainer,
owner; `auth/role-floor.ts`) over the whole box: every tier read every file, every transcript, the whole fleet.
Outsiders held **nouns**: a Visitor chat visitor or a channel sender reached the brain only through one persona persona
(`personas/visitor-chat.ts`, `Automation.senders[].actsAs`) and saw only the reply. A guest is the second model applied to
a member: a signed-in person whose every turn wears one of their personas, who sees their own conversations and nothing
else of the box.

The persona stays what it was, a posture (`docs/design/accounts-and-personas.md`: accounts, powers, folders, carried
repositories, kit, models). The **member** gains a fence: `{ email, role: "guest", areas: [<area id>…] }` in
`.intentic/identity/members.json`, the daemon's alone and never mirrored to the platform, which records the tier only.

Which personas a guest speaks through is **derived from that fence, not listed beside it**. A persona lives where it works —
its `workspace.startIn`, else the `workspace.folders` it may touch, else the workspace root — and a person reaches it
when the folders their areas name cover that home (`policy/persona-home.ts`, `personas/persona-reach.ts`). One
decision per member instead of two that could disagree: an area is a part of the workspace, and the assistants that
work there come with it. A persona homed at the root is nobody's but the owner's, since no fence covers the root.

## What a guest is, and is not

It is a **narrowing of what a person is handed**, enforced by the daemon at three layers:

| Layer | Where | What it holds |
| --- | --- | --- |
| Admission | `auth/role-floor.ts` `guestReach`, consulted by the bearer middleware instead of the floor | An allowlist of routes: signing in and being present, the chat it drives, the fleet (narrowed below), the personas its areas reach, the reads a composer needs, and the workspace read-only — every one of those applies the guest's own fence, so none can answer with the whole tree. Everything unnamed is refused, so a route added later is closed to a guest until somebody decides. |
| Ownership | `auth/fleet-scope.ts`, applied in `agents.routes.ts`, `agent/routes/agent.routes.ts`, `system/system.routes.ts` | A guest sees, drives, renames, archives and reads the transcript of conversations it owns or started; the roster and the `/events` roster frames are filtered the same way; path and repository frames are cut to its fence; held wakes are never shown. |
| The persona | `agent.run` (`refuseUnlessReachable`) and `personas.list` (`reachablePersonas`) | A turn must name a persona the guest's areas reach (naming none is refused too, the unattended rule); the persona list is those personas and the accounts they name. The turn then resolves through `turnPersona` unchanged. |

A guest is **always fenced**: the roster refuses a row that names no area (`auth/auth.ts` `MemberSchema`), and the
grant route refuses one whose areas no persona works in, since a guest reaches nothing else and would sign in to a chat
that answers nothing. The areas fence *is* real — a turn works inside the persona's folders AND the starter's areas,
and the file routes refuse outside them — but it is a folder fence, so what the PERSONA itself claims beyond folders is
still a posture. `workspace.folders` is a PreToolUse refusal on the file tools and does not reach a shell;
`context.repos` is filesystem-real (an unlisted repository is absent from the worktree) but names whole nested
repositories only. The honest configuration for a guest persona today is `shell: false, code: true` ("code yes, commands
no" is the one execution posture whose fence is real), `delegate: false` until a child's persona is capped by its
parent's, and `context.repos` naming the repositories the guest is for.

## The editor

`useRole` reads `isGuest`, and `canDrive` is true for a guest (it drives its own chats) while `canReview` (review, ask
for a landing) and `canShip` are not. The shell keeps a guest to the screens the daemon answers it on
(`shell/guestFence.ts`): the rail is Chat and Agents (`core-views/registry.ts` `makerRailGroups`), the sandbox hub is
the Access section alone, the home redirect is the chat, and a guest standing anywhere else is sent there. The persona
picker offers a guest its personas and neither "Anyone" nor the personas page; a new chat wears the first held persona from
its first word; the router that reads a first message for a persona is never asked for a guest; the composer's file
mentions are not offered.

The Access page grants a guest with the **area** picker every tier below maintainer shares, and the picker reports the
consequence the fence cannot show on its own: which assistants those folders hand over, or the refusal when they hand
over none. A guest row's description is the assistants it reaches, since for that tier the fence is the whole of what
it can do. Picking the tier is never itself the write: the row stages until its fence would be accepted, the same way
a writer's does. Two other screens close the loop — the Areas page names the assistants each area holds, and a persona's
"Starts in" says which areas gain it. The daemon refuses an unfenced guest, an area the workspace does not have, or a
fence no persona works in, on the spot (`auth/members/members.routes.ts`), and a sweep catches a persona's starting folder
being edited out from under an existing grant (`areas/invariant.ts`).

## Deferred, and named so nobody reads the tier as more than it is

- **Cones and search scope** (`docs/context-composition-plan.md` steps 3–4): a persona cannot yet carry a folder of a
  repository, and retrieval indexes all of `/work`. A guest on a monorepo package sees the package's repository whole.
- **A child's persona capped by its parent's**: a guest persona with `delegate` on can spawn a conversation wearing no persona.
  Until the cap exists, guest personas should have delegation off.
- **Transcripts with teeth for tiered members** (`docs/design/session-ownership.md` phase 3): a viewer still reads
  every transcript; only a guest is narrowed.
- ~~**Scope on the principal**~~: built, as Areas. A member's row names areas, every tier below maintainer can carry
  them, and the same fence decides which folders they read and which assistants they speak through.
- **Cross-area questions**: a guest gets no hand-off to a broader persona. The brain's value is cross-cutting, and the
  hand-off is a confused deputy until it is designed as one.
