# Working across sandboxes: the design

Why opening a second project today means opening a second application, what a view above sandboxes would
have to be, and which parts of the app have to stay below it.

## 1. What a switch tears down

`composables/sandbox/sandboxScope.ts` is the inventory, and it is long because the active sandbox is not a
filter, it is the app's whole coordinate system.

| Torn down on switch | Owner |
| --- | --- |
| Every open conversation and its stream | `resetChat` |
| Editor buffers, tab strip, tree state, terminal dock | `resetEditBuffers`, `resetWorkspaceTabs`, `resetWorkspaceTreeState`, `resetTerminalOpen` |
| The staged push and everything it names | `resetPushFlow` |
| Recently-changed paths, code stats, preview target | `resetWorkspaceLive`, `resetCodeStats`, `resetPreviewSurface` |
| The fleet roster, its archive, its revision line | `resetAgents`, `resetArchive` |
| Presence | `resetPresence` |
| Every activation and every extension's own scope | the extension host, which retires and reloads |

Three more things re-establish outside that file. The endpoint is re-selected (`endpoint.ts` probes local
candidates at up to 1500 ms each, and in Chrome the first reach for loopback spends a Local Network Access
prompt). A daemon-session bearer is minted or read for the incoming box. The route is replaced by whatever
that sandbox was last showing (`sandboxScreen.ts`), and the rail re-derives itself, because
`detectActivations` runs against the new box's repos and capabilities.

Every one of those is correct on its own terms. Together they are a cold start.

## 2. So the complaint is not that switching is slow

It is that the sandbox id is the only addressing scheme the app has. It is a segment on every cache key
(`sandboxKey`), the base URL of every daemon call, and the scope of every module singleton. Exactly one
sandbox exists in the app's mind at a time, so the only way to ask *what is happening over there* is to go
there, and going there costs section 1.

The two things asked for, agents across sandboxes with review and land, and a view of what landed in `/work`
across sandboxes, are both read-heavy and write-light. That shape is what makes them affordable. Section 10
is where it stops being affordable.

## 3. The rule for what crosses

The extension manifest already draws this line one level down. `ViewContributionSchema.surface` offers
`sandbox` for "a view whose subject is the BOX rather than the work". Apply the same test one level up: a
surface belongs above sandboxes when its subject is the work, and below when its subject is the machine.

| Surface | Above? | Why |
| --- | --- | --- |
| Agents board, review, land | yes | An agent's work is the subject. The box it ran in is an attribute of it. |
| Changes, push state | yes, as a ledger | See section 7. Not as a tree. |
| Chat / steering a turn | no | Stateful streaming singleton. See section 6. |
| Work terminals | as evidence only | See section 8. |
| Workspace tree, search, editor | no | Two boxes' `/work/intentic` are two checkouts. There is no merged thing to browse. |
| Extensions, pipelines, deployments | no | `detect(repos, capabilities)` runs against one box's connectors. One Komodo connection would appear once per sandbox, or not at all. |
| Preview, ports, terminals-as-workspace | no | Properties of a running machine. |
| Secrets, environment, access, settings | no | The `/sandbox` hub already exists and is already correct. |
| Browsers | no | See section 8. |

The instinct about pipelines and deployments was right, and the reason is stronger than "too much noise":
those tiles are gated on a capability connected in a particular box, so an all-sandboxes rendering of them
has no honest subject.

## 4. A sandbox is a machine. The unit being thought in is a project

This is the decision that shapes the board, so it is worth stating before the layout.

The temptation is a column per sandbox. That reproduces the problem in miniature: the reader still scans by
machine, and an agent needing them in the fourth column is as easy to miss as it is today. **Sandbox is a
label on a card, never an axis.** The board keeps its three lanes (Attention, Active, Finished), cards from
every box mix inside them, and Attention sorts by what the agent is waiting for and how long it has waited.
The sandbox chip on the card can reuse the switcher's per-sandbox `image` and monogram, so the box is
recognizable without being read.

Grouping by *project* would be better than either, and it is not available. `GitRemoteState.remote` is a
remote **name** ("origin"), not a URL, so nothing in the contract can tell that two sandboxes hold clones of
the same repository. Adding the remote URL (or its host, owner and name) to that schema is a small change
and it unlocks both project grouping here and the deduplication section 7 needs. Worth doing early. Until
it exists, do not promise project grouping.

## 5. The board: a scope on `/agents`, not a new tile

`core-views/registry.ts` argues that the rail can hold roughly nine tiles above a laptop fold and that every
silent permanent tile pushes a badged one under it. A second Agents tile fails that on its own merits, and
it would also put two tiles named for the same noun next to each other.

So the scope is a control on the board, sitting in its header beside the filter, with two settings: **This
sandbox** and **All sandboxes**. An account preference, like the terminal panel's own switches: which fleet you
want in front of you is a property of how a person works, not of the box they are pointed at, and storing it
per sandbox would flip it back every time you crossed to a card you had just found through it. It is drawn only
where there is a second connected sandbox to be about.

What this buys beyond the tile count:

- `AgentCard`, the lanes, the drag-to-act drops, `AgentReviewPanel` and the archive are reused whole. The
  cross-sandbox board is the same board with a wider source.
- The rail keeps its rule that everything on it is about this box, with one exception the reader chose.
- The Agents tile badge follows the scope (section 9).

Partial failure is the state to design first. Every other view in this app is connected or it is not. This
one is "three of five answered", and it must say so: a line under the header naming the sandboxes that did
not answer, never an empty lane and never a zero. That is the same mistake `docs/deployments-rail-design.md`
catches in Komodo's `live` flag, where "registered" was rendered as "healthy".

## 6. Read and land anywhere. Converse where it lives

> **Superseded in part — see section 14.** The rule below held for a year and its reasoning is still the
> reason the *board* offers a crossing on a remote card. What changed is that the composer can now home a
> conversation in another sandbox outright, so "converse where it lives" became "the conversation lives
> wherever you sent it, and this window renders it". Read this section for why replying was hard, then 14 for
> what it cost to make it easy.

This is the action rule, and it falls out of the code rather than out of taste.

Review, land, discard, archive, stop and approve-a-held-wake are stateless calls addressed by agent id.
`agentActions.ts` sends them through `sandboxJson`, and the only thing binding them to the active sandbox is
which target that helper picks. Point them at another box's target and they work, with no chat, no tree and
no extension host involved.

Replying is different in kind. A turn streams into a `Conversation` held by the `useChat` singleton, which
`sandboxScope` resets on every switch, and the transcript, the composer, the draft echo and the run graph
all hang off it. Making that multi-box is a far larger change than the ask.

So: **read and land from anywhere, converse where the agent lives.** A card from another sandbox offers Land,
Discard, Archive and its full review. Where Reply would be, it offers **Open in `<sandbox>`**, which switches
deliberately and says that it will. That line matches what was asked for exactly, and it keeps the expensive
half of the app single-box.

The conflict ladder inherits the same line. "Have the agent resolve it" starts a turn, so from a distance it
reads *Open in `<sandbox>` to resolve*. Merging and landing do not start a turn and stay available.

## 7. The `/work` view is a ledger, not a tree

A cross-sandbox file tree has nothing to show. Paths collide, and neither checkout is the other's parent.

What is real, and currently invisible, is already named in `outgoingWork.ts`: work that exists on one disk
and nowhere else, on a machine that can go away. That module computes it per repo today, for one box. Across
four sandboxes the exposure multiplies and nothing counts it.

So the second surface is a table, one row per repo per sandbox:

| Sandbox | Repo | Uncommitted | Ahead | Upstream | Last landed |
| --- | --- | --- | --- | --- | --- |

with Push and Publish on the row (git cannot span remotes, so per-repo is the only shape a batch verb could
have taken anyway) and Open, which switches. `unpublished()` already decides which of the two verbs a row
gets.

"What landed in `/work`" is the same read. `RepoChanges.origins` and `OriginAgent` already tie landed lines
to the agent that wrote them, and the review keeps that record after the agent leaves the roster, so a
landed feed needs no new daemon work.

One naming note: do not call it the outbox. `usePublicOutbox` owns that word for `public/`. Use the same
**All sandboxes** scope control the board uses, on the Changes surface.

## 8. Terminals yes, as evidence. Browsers no

**Terminals.** The reason given (watching pre-push tests run) is right and the surface it implies is wrong.
`useWorkTerminals.ts` already settled the shape of this: a work terminal is evidence about something that
ran, not a workspace, and the only question worth answering is *what is running right now*. A cross-sandbox
terminal strip would be a row of eight-hex pills from three machines, which is the exact failure that file
describes, multiplied.

Put the evidence on the card instead. An agent card whose box has a live `agent-<session>` or `job-*` session
shows a running indicator, and pressing it opens that one terminal in the panel. That answers "are the tests
still going" with no cross-sandbox terminal surface at all.

**Browsers.** A browser session belongs to a box and to an identity, and the one fact about it that crosses
is that it is blocked waiting for a person (`request_help`). That is an attention item, so it reaches the
board as a state on the agent that is blocked, not as a tab.

## 9. Badging, which is the part that decides whether this gets used

The standing rule, from `_extensions/maintenance/src/attention.ts`: a badge means something happened here
you do not already know about, never here is a statistic.

The naive cross-sandbox badge is the sum of per-sandbox counts, which on four sandboxes is lit permanently
and teaches the reader to stop looking. Two instruments instead, each about one subject:

- **The Agents tile badge follows the board's scope.** Set to All sandboxes, it counts agents needing you
  everywhere, and pressing it lands on a board that shows them. Set to This sandbox, it counts this one. A
  badge that opens a view where the thing it counted is not visible is worse than no badge.
- **The switcher popover's rows carry per-sandbox counts.** That popover is opened deliberately, so a number
  in it is a statistic in the one place statistics are fine, and it answers "what is happening over there"
  without a new surface. The chip itself does **not** sum them, for the reason `sandboxAttention.ts` already
  gives about the contended-port note: a count that is true every day sits on the chip forever and burns the
  next badge that matters.

A sandbox that has not answered shows a dash on its row, never `0`. Reporting zero agents for a box we could
not reach is the `live: true` failure again.

## 10. What the code already supports, and where it stops

The credential and addressing layers were built for this and do not need changing:

- `sandboxSession.ts` keys `sessions`, `inflight`, generations and storage by `sandboxId` throughout, and
  `getSessionToken(target)` takes the target explicitly.
- `sandboxAuthenticatedFetch(request, target = currentSandboxTarget())` already accepts any target, and
  `belongsTo` already refuses a request signed for a different base.
- `SandboxTarget` is an immutable `{sandboxId, base, connectToken}` snapshot, written precisely so a switch
  mid-flight cannot pair one box's token with another's URL.
- `sandbox.list()` returns `daemonUrl` and `token` for every sandbox the user can reach. The browser already
  holds every credential a fan-out needs.

What has to be built:

- **`targetFor(sandboxId)`.** `currentSandboxTarget()` reads the active singleton and `useEndpoint()`
  resolves one base. Background sandboxes should use the tunnel base unconditionally and skip the local
  probe: `couldBeOnThisMachine` gates it, but the probe still costs up to 1500 ms per candidate and, on
  Chrome, a permission prompt. Local resolution stays a privilege of the active box.
- **A cross-sandbox key constructor.** `sandboxKey` appends the active id, and `queryKeys.guard.test.ts`
  forbids using it outside `queryKeys.ts`. Add `ofSandbox(id, ...)` to the family shape there, in that file,
  for the same reason the guard exists.
- **A pull-based reader.** `useSandboxAgents(sandboxId)` over `GET /agents`, which the fleet store already
  uses for `refresh()`.

Two things not to do:

- **Do not open N `/events` streams.** That stream drives the active workspace, and its watchdog, backoff,
  presence, workspace-live routing and revision-epoch guard are all written for one connection per browser.
  Background sandboxes get a plain read on mount, on window focus, and on a slow interval (30 to 60 s). The
  active sandbox keeps its stream, so the box being worked in stays as live as it is today.
- **Do not wake sleeping machines.** Hosted sandboxes idle-stop themselves, and the wake reflex in
  `useSandbox.ts` deliberately fires only for the active box. A board that polls every sandbox would hold
  every hosted machine awake and bill for it. A sandbox whose `hosted.state` is not `started` draws as
  asleep, with its last-known counts and an explicit Wake. This rule is what keeps the feature cheap.

And one fact worth stating plainly: **the platform cannot help.** `SandboxSummarySchema` carries addressing,
boot reports and roles, and no work state at all. There is no server-side aggregate to reach for, by design,
since the platform is out of the browser-to-daemon path. Every count on this board comes from a daemon.

## 11. Staging

Each step is useful on its own.

1. `targetFor(sandboxId)`, `ofSandbox` keys, `useSandboxAgents(sandboxId)`. No UI. This is the whole seam.
2. Counts on the switcher rows. Smallest thing that answers "what is happening over there", and it needs no
   new surface. Worth shipping even if nothing after it does.
3. The `/agents` scope control: mixed lanes, sandbox chips, review and land through the parameterized
   client, "Open in `<sandbox>`" where Reply would be.
4. The Changes scope control: the per-repo-per-sandbox ledger, with Push and Publish on the row.
5. Remote URL on `GitRemoteState`, then project grouping on both surfaces.
6. Running-process indicator on cards, opening one work terminal.

## 12. Known costs

- The board is the first surface in this app whose failure mode is partial rather than binary. Section 5
  handles it, but it will need its own tests, and every count it renders needs an "unknown" state distinct
  from zero.
- Landing from a distance happens without the box's workspace in front of the reader. `AgentReviewPanel`
  carries the diff, the conflict report and the per-file blockers, which is most of what makes that safe,
  but the reader has no tree to go check something against without switching.
- Two sandboxes holding the same repo read as duplicate work until step 5 lands.
- The archive, the held-wake queue and the receipt/undo machinery in `useAgents` are all module singletons
  scoped to one box. Widening the board means deciding what Undo means when the last archive happened in a
  different sandbox. The conservative answer, and the one to start with, is that Undo stays per sandbox and
  the receipt names it.

## 13. What shipped, and what it taught

Steps 1 to 4 are built. Steps 5 and 6 are not.

**The seam, unchanged from section 10.** `targetFor(sandboxId)` in `sandboxTarget.ts` (tunnel for every box
but the active one, which delegates), `sandboxRequestAt` / `sandboxJsonAt` beside their ordinary siblings, and
`QueryFamily.ofSandbox` in the key registry. `agentActions` grew a trailing `AgentReach` on land, discard,
stop and request-land, and `askAgentToResolve` deliberately did not.

**Two stores, not one.** `fleetAcross.ts` polls `/agents` per box and `changesAcross.ts` polls `/git/changes`.
Both are inert until a surface subscribes, and their watchers are registered by the first subscriber rather
than at module scope, because `watch` reads its source to take a first value and importing a file should not
pull the sandbox list into existence. That was found by four unrelated suites failing to load.

**The `/work` half is a folded section, not a scope control.** Section 7 asked for the ledger and step 4 called
it a scope, and a scope was wrong: the Changes panel is a review of files you can stage, and the ledger is
exposure you cannot, so one switch between them would have swapped two surfaces that answer different
questions. It ships as `In other sandboxes` at the foot of the panel, folded, below every repo of this
workspace. The board's scope control stayed a scope control, because there both settings are the same board.

**The import edge that must not exist.** `agentActions` re-reads both stores after a mutation that crossed, so
neither store may reach the router. `openWorkspaceIn` was in `changesAcross` for one commit and moved into the
component that presses it, and the four suites that failed are the standing guard on that rule.

**Two boxes can hold one agent id**, and it is not exotic: a workspace cloned onto a second machine, or a
conversation resumed there. Identity is therefore `(id, sandboxId)` everywhere it decides an action, the drag
in flight (`draggedBox`), the busy marker on a card, and the review's own lookup. An id-only test would have
dimmed two cards for one land and, in the drag's case, acted on the wrong agent.

**Still open.** Project grouping waits on a remote URL in `GitRemoteState` (section 4). The running-process
indicator (section 8) is unbuilt, so watching another box's pre-push run still means crossing to it. Undo
stays per sandbox, as section 12 proposed.

## 14. Starting work in another sandbox, from the composer

Section 6 said a reply is a crossing, and the board still offers one. The complaint that reopened it was the
other half: **you could not START a conversation anywhere but the box you were standing in.** Sending a task
to a second machine meant switching the whole app to it — section 1's cold start — and then switching back,
which is a poor trade for "also run this over there".

**A conversation has a home box.** `Conversation.box` is a sandbox id, or undefined for the box this browser
is pointed at, and it is an ADDRESS rather than a mode: every daemon call the object makes (`/agent`,
`/agent/attach`, steer, stop, reply, rewind, the transcript read, an attachment's bytes) goes through
`sandboxRequestVia(this.at, …)`. One field decides the whole correspondence, so no half of it can end up
talking to a different machine than the other half.

**Nothing new was needed underneath.** A turn already runs as a detached run on a daemon with every window
merely rendering it (`turnStream`), `sandboxSession` already keys bearers by sandbox, and `targetFor` already
resolves any box. What section 6 called "a far larger change" was true of the ALTERNATIVE reading — making the
chat singleton multi-box — and false of this one: the singleton still holds one list of tabs, and a tab knows
where it talks.

**What does not cross, and why each one is refused at its own control rather than in a banner.** A remote
conversation carries no account (an account id is one daemon's store key; omitting it is already "use your
first account for this provider"), no persona (a card in one daemon's record; a named card that cannot be
found is the fail-closed case), no editor context and no `@`-mention completions (paths in THIS workspace),
and no runner (paired to the sandbox that made it). The model and provider DO cross: a model id belongs to the
provider, and the target daemon resolves it against its own catalog or refuses at the door in a sentence the
composer shows. `turnRequest.ts` states each omission next to the field it drops.

**The registration latch had to grow a second source.** `registered` latches on a roster frame, and this
browser streams one sandbox, so a remote conversation would have stayed a "draft" for good — drawing a phantom
New-agent card beside the real card the All-sandboxes read brings back for it. The daemon's ack of the first
send is the same fact from the other end, and that is what latches it (`latchRemoteRegistration`).

**`open` and `unsent` stopped being false for a distant card.** They were hardcoded on the reasoning that a
summary read from another daemon has no tab; now it can, so `otherFleet` joins against this browser's tabs on
`(id, sandbox)`. That pair is the identity rule section 13 already found, applied to one more place.

**What is still a crossing.** The BOARD's remote card opens its review and offers "Open in `<sandbox>`", as
section 6 describes: opening a distant agent as a local tab would also have to answer what `markSeen`,
archive and the watch marker mean at a distance, all of which write through the active daemon's roster. The
seed carries the box already (`AgentTabSeed.sandboxId`), so that is a wiring job rather than a design one.
