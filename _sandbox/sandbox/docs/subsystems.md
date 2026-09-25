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
`runtimes/claude/claude-provider.ts`, …), and a slice whose construction stands alone is built there too
(`createAuthSlice`, `createSessionsSlice`); what spans subsystems is wired in composition, in the one order that works. A
module takes `Pick<Services, …>` of the seams it uses, so its dependencies are visible in its signature. `wireReactions`
in the same file subscribes the reacting subsystems to the domain events.

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
