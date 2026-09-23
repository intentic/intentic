# Structural decomposition: before and after (2026-09-23)

What was measured before the decomposition described in
[docs/design/structural-decomposition.md](../design/structural-decomposition.md), on `main` at `bbbebdd21`, and the same
readings after it. Churn figures are from the rename-followed git history of 3,393 commits (1,004 of them fixes).

## Where fixes had been landing

The files that changed and were fixed most were composition roots and the turn engine, not features:
`composition.ts` (141 commits, 17 fixes), `main.ts` (101, 15), `app.ts` (81), the demo's hand-written daemon (68, 10),
`agent.routes.ts`, `turn-plan.ts`, `agents-registry.ts`, and the editor's chat and fleet files. Fix subjects over the
45 days before clustered on five themes: which account or model serves a turn, transcripts duplicated on reattach,
resume after a restart, multi-repo land atomicity, and state leaking between conversations.

## Readings

| Reading | Before | After |
|---|---|---|
| `runTurn` / `runConversationTurn` | 565 / 388 lines | 56 / 38 lines |
| `agent.routes.ts` | 1,836 lines | 899 lines |
| `turn-plan.ts` (`planTurn` + the Claude Code arm) | 1,279 lines | 85 lines (`decide/` and `harness/` beside it) |
| Per-conversation module-level `Map`/`Set` holders in `agent/` and `agents/` | ~30 in 13 files | 0 (five caches keyed by provider, plugin, root or role remain) |
| Registry runtime state | 27 flat fields | actor phase union + readings, pure `decide` |
| `PersistedAgent` | 55 flat fields, 45 optional | nested records, invariants as types |
| Runtime import cycles (strongly connected components) | 29, 3, 2 files | 3, 2 files |
| Mutual value-import cycles between daemon subsystems | 50 | 10, each with its reason |
| Modules taking the whole `Services` | 12 | 0 (`daemon-boundaries` is a `code` gate) |
| `Services` members | ~155 | 147 (grew by the new ports; no module takes it whole) |
| `AgentRequest` | 82 optional fields | spec / policy / tools / hooks / per-runtime credential |
| Contract routes with policy outside the contract | 310 procedures + ~130 raw routes in path tables | 0 (`RouteMeta`, `RAW_ROUTES`; 443-row reach table) |
| Literal contract paths in the editor / extensions | ~170 / ~50 | 0 / 0 (empty `contract-paths` baseline) |
| Demo daemon | untyped string route table | router typed against the contract, smoke-parsed |
| Editor module-level reactive state outside a scope | 205 in 81 files, reset by a hand list | 0, 67 app-wide entries allowlisted with reasons |
| `Conversation` class (editor) | ~1,660 lines | 160 lines over tested units |
| SFC script: `ChatPane` / `Setup` / `Capabilities` / `WorkspaceTree` / `AgentsView` / `TerminalPanel` | 1,246 / 1,466 / 1,195 / 1,167 / 1,140 / 1,021 | 306 / 313 / 186 / 178 / 113 / 196 |
| Durable per-conversation stores | ~55 JSON files, per-store retention, enumerated purge | one database with cascades + one directory per conversation |
| Enter-bound async handlers the submit gate reads | 15 | 21 (follows handlers into modules) |

## Tests

| Suite | Before | After |
|---|---|---|
| Daemon (unit + integration) | 3,505 + ~2,700 | 3,963 + 2,766 |
| Editor | 5,908 | 6,824 |
| Contract | 817 | 839 |

The additions include characterization suites that pinned the turn's frames and writes before the pipeline was
extracted, a model-based actor test (seeded walks over every lifecycle event, crash and restart, asserting that dispose
leaves nothing keyed by the conversation), a literal per-route policy table, rpc gate conformance for every procedure,
and a purge test that walks the history volume and queries every table.
