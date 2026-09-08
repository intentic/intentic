# Why a large land lags, re-arms its button, then fails to fetch

Read on 2026-09-08 from the daemon's own records (`/history/logs/perf.jsonl`,
`/history/logs/daemon.log`, `/history/logs/client.jsonl`) and the code paths they
name. The incident itself (a 2000+ file delta needing a rebase) predates the logs'
retention: the longest land they still hold took 10.5 s. Every mechanism below is
read off the code; every number is off the record.

## The chain

1. **A land runs inside the HTTP request, under every repo lock, and the
   refusal path cost three git runs per changed file.** `landAgent` writes the
   whole patch and runs one `git apply --check`; when that refused (exactly the
   "main moved under it" case), `classifyDelta` re-diffed and re-checked each
   change alone, forward and reverse. A single `diff --numstat -z` on the
   `sunny-cove-odcb` worktree cost 250–860 ms at load 3–4, so 2000 files came to
   10–30 minutes of lock hold. Smaller lands already showed it: `git.lock.hold`
   46.8 s across all seven repos at 12:25:32, 21.0 s and 19.6 s on `intentic` at
   12:26.
2. **The editor gave up at 45 s.** `sandboxAuthFetch.ts` bounded every call's
   wait for headers at `DEADLINE_MS = 45_000`, the land POST included, then
   demoted the loopback endpoint. The daemon never heard; it kept going.
3. **The button came back because no status said "landing".** The card's
   `landable` is `status === "ready"`, and the daemon records `conflict` only
   after `landAgent` returns. With the browser's busy flag cleared in `finally`
   and the roster still saying `ready`, "Land now" re-armed mid-land.
4. **The second press rebased the worktree the first land was reading.** The
   route refused a land only for a *writing turn*; `syncBeforeLand` took no lock
   at all, so the second request's `commitWorktreeRemainder` + `git rebase` ran
   in the worktree the first land was diffing from, and only then queued on the
   repo lock. It died at 45 s too, now on the demoted endpoint, which is where a
   network-level `TypeError: Failed to fetch` comes from.
5. Minutes later the first land finished, stored the conflict, and the card
   moved to Attention with "Have the agent resolve it".

Aggravating it: `GET /agents/:id/diff` took the same repo lock to re-derive the
stored conflict report, so the review panel's own read waited behind the land
and hit the same deadline.

## Also in the log

- 00:19:43–52: three lands threw `git apply … 'extensions/logs/node_modules'
  mode 120000: Directory not empty`, a symlink landing over a real directory.
  The preflight passes it (a directory may stand where a file will go); the
  write refused, phase two threw, the route answered 500 "unhandled error", and
  the card stayed `ready`. Three presses in nine seconds.
- `GET /chores` 6.0–6.7 s and `POST /personas/route` 6.0 s on every call, a
  ceiling pinned at 6 s that every board load pays. Not this audit's subject.

## What changed

| Where | Change |
| --- | --- |
| `agents/land/land.ts` | The blocked set is read off the one whole-patch refusal (git checks every file patch before giving up and names each), a second reversed check over that set alone peels off content main already holds: two git runs for a delta of any size. The per-change probe survives only as the road for a refusal wording the reader cannot place. |
| `agents/land/land.ts` | `reconcileLockfile` (up to 180 s of `pnpm install --lockfile-only`) runs before the repo locks are taken; it touches only the worktree. |
| `agents/land/land.ts` | A phase-two write the tree refuses is that repo's conflict (`workspace`, the path off git's own message), with the repos already written keeping their advance; a message naming no path is still rethrown. |
| `agents/registry/agents-registry.ts` | One land lease per conversation (`withLandLease`, `landing`), claimed synchronously, later lands queued behind it; the card reads `landing` while it is held, below a live turn's own status. |
| `agents/agents.routes.ts`, `agent/routes/agent.routes.ts` | Every land, manual or end-of-turn, runs under the lease, sync included; a second manual press is refused 409 while one is in flight. Each is an `agent.land` perf span (5 s budget; `agent.sync` 2 s). |
| `agents/agents.routes.ts`, `agents/worktrees/worktrees.ts` | `/diff` serves the stored conflict report while a land holds one of the agent's repos (`repoBusy`) instead of queuing behind it. |
| `sandbox-contract` | `landing` joins `AgentStatusSchema`. |
| `_editor/web` | `landing` is Active, in flight for every guard (no land, discard or archive offered), drawn as `Landing…`; the land request carries no headers deadline, since the status carries the wait. |

Measured after the change, in the land suite: a 60-file delta with 30 refusing
paths classifies in fewer git runs than it has files (it cost 90+ before), and
the symlink-over-directory land reports `pkg/node_modules` as a `workspace`
conflict with `clean: 1`, nothing thrown, no tip moved.
