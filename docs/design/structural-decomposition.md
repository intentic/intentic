# Structural decomposition of the turn engine, the wire and the editor

The conversation lifecycle was the one place where fixes kept landing: it ran from the daemon through the contract
into the editor, and nothing owned it. Its state sat in about thirty module-level maps and fifty-five JSON files, its
policy was interleaved with I/O inside two generators of 570 and 390 lines, and a 155-member `Services` object let every
subsystem reach into it. This records the eight changes that gave it an owner, a pure core and typed edges, what each
was chosen over, and what each costs. The measurements are in
[docs/audits/structural-decomposition-2026-09.md](../audits/structural-decomposition-2026-09.md).

## 1. A turn is a pipeline with a pure middle

`runTurn` and `runConversationTurn` (`_sandbox/sandbox/src/agent/routes/agent.routes.ts`) are short orchestrators over:

- `agent/run/decide/`: `gatherTurnFacts` does every read, timed under the same `turn.plan.*` spans; `decideTurn` is
  pure over those facts; the A/B experiments are one registry (`experiments.ts`), salts and ledger fields unchanged.
- `agent/run/frames/`: one reducer per concern (usage, silence, checklist, context, failure, walls), pure per-frame
  decorators (attribution, cache TTL, abort suppression, the silent ending), and `classifyFailure`, which reads through
  injected queries and returns the writes a failure is worth instead of making them.
- `agent/run/settle/`: `settleTurn` turns the readings into a `SettlementPlan`; `performSettlement` executes it in the
  old order.
- `agent/run/conversation/`: one `Placement` (main tree, worktree, runner) instead of three near-copies, and the
  after-turn land as its own sequence with a pure decision.

Chosen over keeping one generator with every concern wired by hand, where adding a concern meant editing the frame loop
and the `finally` together and the only test was an integration suite standing up the whole daemon. The cost is more
modules and a generic reducer/decorator shape that a new concern has to fit.

## 2. One owner per conversation

A `ConversationActor` (`agents/actor/`) holds everything the daemon keeps in memory about one conversation. Its phase
and readings change only through a pure `decide(state, event, now, entry)`, whose effects are data. Records that hold
closures, timers or objects patched in place live in declared holdings (`conversation-holdings.ts`): parked cards,
children and subagents, background jobs, watches, live runs. One `dispose(id)` reaches all of it, and the model-based
test (`conversation-actors.test.ts`) asserts after every step that nothing keyed by a disposed id remains anywhere.

Chosen over module-level `Map`s per concern, each with its own cleanup, which no test could reset and no reader could
ask "what state is this conversation in". The cost: a new per-conversation record must declare a holdings kind rather
than open a `Map`, and `decide` needs the persisted entry beside the event.

A turn's identity (runtime, model settings, account, persona, role) is one `TurnProfile` (`_shared/sandbox-contract`,
`schemas/agent.ts`), carried whole by every continuation: resume, watch wake, verify nudge, fork, child spawn, loop
round. The wire `AgentTurn` stays flat because it is a request, not a record.

## 3. The runtime layer is thin and sits below the planner

Adapters and provider modules take the narrow dependencies they declare, never `Services`; the one module that knows
every runtime is `runtimes/runtime-table.ts`. The Claude Code loop's request builder moved to `agent/run/harness/`, so
the planner imports adapters and nothing under `runtimes/` or `agent/providers/` imports the planner. That dissolved a
29-file runtime import cycle. `AgentRequest` (`agent/providers/agent-request.ts`) is grouped as spec, policy, tools,
hooks and a credential whose variant is the runtime's own. The watchdog, plan-mode emulation, vendor-error
classification and attachment loading each exist once, in `runtimes/decorators/`, applied from the capability row.

## 4. Subsystems depend on ports, and the gate is blocking

Nothing outside the turn engine imports `streamAgent` or `startConversationTurn` any more. Subsystems start and drive
turns through `TurnStarter` (`src/seams/turn-starter.ts`), and what a turn announces reaches them through
`DomainEvents` (`src/seams/domain-events.ts`): typed, synchronous (subscribers run in subscribe order before `publish`
returns, which the history snapshot's ordering relies on) and isolated (a throwing subscriber is logged, never
propagated). Where the turn needs an answer (dependency verification after a land) it is a port, not an event.

Mutual value-import cycles between daemon subsystems went from 50 to 10 and whole-`Services` takers from 12 to 0.
`_tools/checks/daemon-boundaries.mjs` is a `code` gate: a new value-import edge that closes a cycle of any length, or a
new whole-`Services` taker, is refused at the push. The cycle edges still standing are its shrink-only baseline,
`_tools/checks/baselines/daemon-cycles.json`, where the ten mutual pairs keep the reason each could not be cut cleanly.

## 5. The contract is the only door

Every procedure carries a typed `RouteMeta` (`protocol/route-meta.ts`) and every hand-written Hono route is declared
in `RAW_ROUTES` (`protocol/raw-routes.ts`); `app.ts`, `auth/role-floor.ts`, `auth/grants.ts` and
`auth/control-tokens.ts` derive their decisions from them, and `src/raw-route-server.ts` refuses to register an
undeclared raw route. `auth/route-reach.test.ts` holds each route's policy as literal data recorded from the path tables
this replaced, so a route that becomes more or less reachable fails a test by name. Moving policy into one table
surfaced one silent override: `POST /logs/client` was documented at the viewer floor and served at maintainer, because a
`/logs` prefix rule ran first; it now serves the documented floor.

The editor, every in-repo extension (browser half and backend half, `api.daemon.rpc` in SDK 2.17.0) and the SDK samples
call the daemon through the typed client, which parses every non-stream answer with the contract's output schema
(`sandboxAnswerSchema`, one lookup for every client). `_tools/checks/contract-paths.mjs` refuses a literal contract path
anywhere outside the clients, with an empty baseline. The demo's fake daemon (`_site/demo/src/router.ts`) is a router
typed against the contract and dispatched by its own matcher, so a contract change breaks the demo's typecheck rather
than the landing page; `pnpm -C _site/demo smoke` parses every served answer.

Chosen over path tables and string paths, where a renamed route compiled green in every consumer. The cost: a new
route must declare its meta or raw entry and a row in the reach table, and a daemon that answers in a shape this build
does not know now shows the version-drift notice instead of being tolerated field by field.

## 6. Editor state has a lifetime, and components are headless

Sandbox-scoped module state is declared through the same primitive extensions use (`sandboxRef`, `sandboxShallowRef`,
`sandboxValue` in `_shared/extension-api/src/scope.ts`), reset from one switch point
(`features/sandbox/client/sandboxScope.ts`) on a sandbox switch and when the daemon reports the workspace replaced.
`moduleState.guard.test.ts` walks the editor's modules and refuses any other module-level reactive state outside an
allowlist in which every entry carries its reason. The chat session is split into a pure selection reducer, a
`TurnClient` run-phase machine, one `reply(requestId, answer)` for every card kind, and the transcript view.
`ChatPane`, `Setup`, `Capabilities`, `WorkspaceTree`, `AgentsView` and `TerminalPanel` are template and wiring over
tested modules; the flows that were state machines in disguise (the setup lanes, machine power, the inline rename,
the terminal strip) are explicit ones.

Chosen over a hand-kept list of reset functions and over an `effectScope` container per sandbox: the first missed every
new singleton, the second would have rebuilt 81 files' state for no gain the primitive does not already give. The cost:
a replaced workspace now resets everything scoped to the sandbox, the fleet and presence included, which repaint from
the next hello; and the guard cannot see state created inside helpers such as `useAsyncAction`.
`_tools/checks/submit-guards.mjs` follows Enter-bound handlers into the modules that now hold them.

## 7. One storage unit per conversation, transactions where facts must agree

The registry, per-repo provenance, checkpoints, the turn journal and watches are tables in `/history/conversations.db`
(`node:sqlite`, WAL, foreign keys, `ON DELETE CASCADE`); a turn's start, a land and a purge are each one transaction.
Everything else a conversation owns on the history volume lives in `/history/conversations/<id>/`. Purge is the actor's
dispose, one cascading delete and one directory, and its test walks the volume and queries every table rather than a
list of paths. `PersistedAgent` is nested records whose invariants are types: a branch exists only on a worktree
placement, limit facts only on a `limited` ending. `agents show <id> --stored` prints everything stored about one
conversation.

Per the repository's no-migration rule the new storage starts empty: an upgraded sandbox's board, history and search
begin fresh, and files in the previous layout are never read. They are never destroyed either. The boot prune deletes
only what a record names, since a discard or purge removes its checkout, overlay and refs before its rows; a checkout or
parked ref no record names is logged and left for its owner. A fenced turn keeps the previous layout's `transcripts/` and
`sessions/` masked while they exist on disk.

Chosen over fifty-five JSON files, each with its own retention (checkpoints were an LRU of 500 conversations that
outlived deletion) and a purge that enumerated what it knew about. The cost: state is not readable with `cat`; two
daemons sharing a volume share one database and wait up to five seconds for its lock; and an owner who wants the old
history keeps the old files.

## 8. What is still open

- The cycle edges held in `_tools/checks/baselines/daemon-cycles.json`, the ten mutual pairs among them.
- The watcher runtime is a module-level value set at boot; it no longer hides an import, but it is still a global.
- `agents.begin` counts a refused turn as a turn, so a conversation whose first send is refused skips its opening
  notes (`turns-that-never-ran.md`), and `begin` does not record `forkedFrom`; both predate this work.
- Found in passing, not fixed: the inline rename field selects its text before the text is filled in, and a double
  press on the archive purge confirmation can start two purges.
