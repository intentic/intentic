# Subsystems

How the daemon's parts are built, started and connected: one composition root, a phased boot, a contract-first HTTP surface and in-process seams between subsystems.

```mermaid
flowchart LR
    msg["Message<br/>editor · automation · loop"] --> admit["turn-admission<br/>one at a time"]
    admit --> plan["turn-plan<br/>adapter · placement"]
    plan --> run(["runtime adapter<br/>main tree · worktree · runner"])
    run -->|"frames"| feed["transcript<br/>/agent stream"]
    run --> settle["settle<br/>land rules · proof"]
    settle --> land["land<br/>patch into /work"]
    land --> verify["verify-deps<br/>land check, in the background"]
    verify -->|"red"| route["land-breakage<br/>send back or fix-up"]
    settle -->|"domain events"| react["push · chores · history"]
```

## Composition

`createServices` in [src/composition.ts](../src/composition.ts) builds `Services` once from the config. `Services` is
the sum of slices each subsystem declares beside its own code (`auth/auth-slice.ts`, `conversations/conversations-slice.ts`,
`runtimes/claude/claude-provider.ts`, …), and each slice file also holds the slice's builder (`createConversationsSlice`,
`createGitSlice`, …), which takes what it reads as a typed argument. Composition calls the builders in dependency order,
so a new member of a slice is written in its slice file alone, and a dependency a builder gains but is not handed fails
to compile. A member whose code would close an import cycle if its slice's builder imported it (`daemon-boundaries`) is
built in composition instead: the builder returns `Omit<Slice, …>` over an exported union of those names, and
composition's `createBridgedMembers` returns the `Pick` of the same union.

Nothing is filled in after construction but one binding: `whole`, the finished `Services`, read per call by the few
services whose work reaches most of the daemon (a turn, a land's breakage route, the provider catalogs and readiness,
the safety judge, filing a browser account, recomposing the environment, a host's reach). None of them is called before
`createServices` returns. `runnerParent` is the one holder left, filled when runner mode enrolls after the boot gate.
A module takes `Pick<Services, …>` of the seams it uses, so its dependencies are visible in its signature.
`wireReactions` in the same file subscribes the reacting subsystems to the domain events.

## Boot

[src/main.ts](../src/main.ts) runs the phases in [src/bootstrap/](../src/bootstrap): the front door first, so
`/health` and `/events` answer at once; then the boot chain (`boot-chain.ts`) while data routes wait behind the
readiness gate; then workspace apps, sweeps, restores, schedulers, resumes, version watches and change reactions.
Every subsystem registers its own teardown in one `DisposableStore`, so shutdown enumerates nothing.

## HTTP

Routes are declared in `@intentic/sandbox-contract`, each with a policy (auth floor, stream, boot gating).
[src/app.ts](../src/app.ts) wraps every request in order: security headers, compression, request timing, the boot gate, CORS,
then authentication (the owner's session, the grant table, the role floor). Raw routes register through
`http/raw-route-server.ts` under their `RAW_ROUTES` declaration, so none exists without a policy. The oRPC handler for
[src/router.ts](../src/router.ts) answers everything else.

## Seams

Subsystems that react to each other never import each other:

- `seams/domain-events.ts` carries `workspace`, `run.settled`, `turn.awaiting`, `turn.finished` and `tree.changed`.
  Publishers name the event; `wireReactions` sends them to chore automations, push notifications, history snapshots
  and the conversation queue.
- `seams/runtime-feed.ts` announces tmux sessions, panels, browsers and child turns to `system/runtime-watch.ts`,
  which pushes them over `/events` beside the file watcher and the git ref watcher.
- `seams/turn-starter.ts` is how automations, loops, approvals, CI fixes, subagents and runners start or drive a turn;
  composition hands them `agent/run/turn/turn-doors.ts`.

## Who spoke a row

A turn's words carry who spoke them (`TurnSpeaker`, `seams/turn-speaker.ts`) and, when the sandbox or the editor
composed them, the errand they are (`TurnErrand`, contract `schemas/speaker.ts`): a land's breakage sent back, a red
held on a conversation still working, a land, push or CI fix attempt and its nudge, a land conflict. Both ride the
turn input, the conversation's queue and a live steer onto the transcript row, so no reader shows the sandbox's words
as the owner's. A wake (`agent/run/turn/wake-delivery.ts`) is the sandbox's by construction; a fix attempt
(`conversations/fix/fix-attempts.ts`) names its errand for the opening prompt and the nudge, and is the sandbox's own
when nobody pressed for it. Over HTTP a client may name only `land-conflict`. Rows written before rows named an errand
are still read by the prompt's opening paragraph (`errandOfRow`, contract `events/errands.ts`), which is why every
opening stays byte-identical.

## A turn's close

Every conversation turn ends through one ordered pipeline, `placedTurn` (`agent/run/placement/turn-placement.ts`),
whose steps are named in `agent/run/placement/turn-close.ts`:

1. **Hush.** The body has ended, so its steering closes: a person's words or a wake that fires from here wait in the
   conversation's queue for the next turn, rather than going into a queue no model reads.
2. **Judge jobs**, once per run, however the turn ended (`agent/tools/jobs/job-fates.ts`). A job the agent kept for
   the person with the `keep` tool, or one on a port the conversation already handed over, keeps running for them. A
   server the turn reached and nobody kept is stopped with it; anything else is awaited. The closing reply's words
   decide nothing.
3. **Arm wakes.** Each awaited job, and each finished one whose exit the model never read, is handed to a watch
   (`background-adoption.ts`). Whether the conversation now runs again by itself is read from what it holds:
   `awaitingWake` (`conversations/actor/conversation-state.ts`: an armed watch, or the sandbox's or an agent's words
   waiting in a queue nothing holds). Status, `fixStance` and the card read that one reading
   (`AgentSummary.awaitingWake`); nothing predicts it from job records.
4. **Land**, a clean turn only (`turn-landing.ts`). Nothing lands while the conversation awaits a wake, since the wake
   is the turn that finishes the work. Otherwise the repository's own machine fixers run in the worktree on what the
   turn changed (`conversations/land/worktree-fixers.ts`, `_tools/scripts/verify/fixers.mjs` where the repository
   ships it), so what they write rides this land; then the rules decide, and it lands under the lease. The check after
   the land runs the same fixers on the main tree as the backstop. With the owner's version rule standing, the land's
   claim is then committed (`conversations/land/version-landed.ts`), the one place any land (a turn's, by hand, a
   conflict's re-land, a fix-up's) becomes a commit: a subject that narrates instead of describing a change is replaced
   there by one built from the claimed paths (`committableSubject`), whichever path drafted or stored it.
5. **Settle.** The placement's books, then the conversation's actor.
6. **Publish, once.** The placement announces how the turn ended (`TurnEnding`: failed, stopped, awaiting a wake, or
   finished); a worktree turn's is the workspace `turn.settled` event.

After all of it the run registry announces `run.settled` (`agent/run/turn/turn-runs.ts`). Its listeners are independent
of each other: none reads what another writes, each reads the conversation as the settle left it, and none may be moved
into the pipeline's order by subscribing earlier. They are, in subscription order:

| Listener | Where | What it does |
| --- | --- | --- |
| reaper | `composition.ts` | frees what a stopped owner held |
| taint | `composition.ts` | drops the turn's outside-content taint |
| drain | `composition.ts` (`wireReactions`) | lets out what waited in the conversation's queue |
| held red | `bootstrap/deps-coordination.ts` | routes a main-line red that waited on this conversation |
| invariants | `bootstrap/boot-sweeps.ts` | runs the `turn-settled` self-checks |
| child report | `bootstrap/boot-schedulers.ts` | tells a spawned child's parent it settled |
| keep-warm | `bootstrap/boot-schedulers.ts` | arms a prompt-cache hold after a person's turn, from the event alone |

A listener takes the `run.settled` event and decides for itself; one that needs an order against the close belongs in
the pipeline instead.

## Asking a person

Every card a turn can park on is one list, `PARK_KINDS` in the contract, read by the conversation's parked state, the
push and the silence judge. A gate that asks from outside the turn (a payment, a capability, a credential, a new
sandbox, a command on the owner's machine, a child agent) raises its card through `raiseRequest`
(`conversations/actor/card-offers.ts`, seams from `cardDeps`), which announces `turn.awaiting` and answers
`approved`, `declined` or `unanswered`; each gate keeps only its own policy and wording.

## Peers

`peers/` gives every outside party one door shape: a short-lived pairing, a durable enrollment token, a socket and an
MCP bridge. The owner's computers (`hosts/`), the browser extension (`webext/`) and runners (`runners/`) are its three
users; a bearer route admits one through `bearerPeer`. Desktop sync (`hosts/desktop-sync.ts`) keeps its own token store,
but answers a store it cannot read the way the doors do: unavailable, never unauthorized.

## Shared primitives

Reach for these before writing a new one: `store/keyed-entries.ts` (a ledger keyed by one field, and a counted boot
resume), `resumeCapped` (`loops/loop-runner.ts`), `serialLock`/`keyedLock` (`@intentic/base/async`),
`http/cli-answer.ts` (what a CLI route answers), `exchangeWithPlatform` (`system/platform-client.ts`, every call to the
platform) and `restoreTunnels` (`tunnel/tunnel-links.ts`, boot restore of VPNs and network disks). Session names and
their prefixes (`panelSession`, `panelKeyOf`, `agentSessionName`) come from `@intentic/sandbox-contract/session-names`,
never a spelled prefix: the browser derives the same names.

## Invariants

Each subsystem keeps its self-checks in an `invariant.ts`, registered in `invariants/register.ts`. Checks run at
`boot`, after a turn settles, and on a standing sweep. A violation is logged; it never throws into the daemon.
