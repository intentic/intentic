# Why landing and committing feel slow

Measured on a live sandbox, 2026-08-20, from the daemon's own instrumentation
(`_sandbox/sandbox/src/platform/perf.ts`, `/history/logs/daemon.log`,
`/history/logs/resource-metrics.jsonl`) after ~4.1 h of uptime. Nothing here is
inferred from reading code alone — every claim below has a number behind it.

## The headline

Landing and committing are slow for **three independent reasons**, and they
compound. In descending order of how much they cost the user:

1. **The daemon's event loop is stalled for seconds at a time**, so *every*
   request pays it. This is not a git problem and not a commit problem.
2. **Per-file attribution is re-derived sequentially, once per landing, on the
   commit's own response path** — and this workspace has 1028 recorded landings
   in one repo.
3. **The land's commit subject is written by a model call that averages 10 s**,
   which is the part of a land the user actually sits and watches.

## 1. The shared floor: the loop is not free

`perf` summary at 17:51 (cumulative over 4.1 h uptime):

| op | count | total ms | mean ms | max ms |
| --- | --- | --- | --- | --- |
| `http.request` | 27 032 | 4 978 848 | 184 | 31 419 |
| `git.run` | 70 762 | 3 154 560 | 45 | 9 211 |
| `git.scan.repo` | 3 875 | 1 122 745 | 290 | 21 772 |
| `git.scan` | 551 | 355 901 | 646 | 30 756 |
| `landing.subject` | 17 | 168 987 | **9 940** | 24 866 |
| `git.lock.hold` | 537 | 153 284 | 285 | 10 743 |
| `git.discover` | 551 | 78 075 | 142 | 12 037 |
| `git.lock.wait` | 537 | 8 426 | 16 | 6 301 |

The slow-tail breakdown of `git.run` is where the diagnosis is. These are the
commands that crossed the 200 ms floor, aggregated by subcommand:

| command | slow count | mean ms | worst repo |
| --- | --- | --- | --- |
| `status --porcelain=v2` | 785 | 744 | `intentic` |
| `branch --show-current` | 804 | 709 | `root` |
| `rev-parse --path-format=absolute --git-dir` | 766 | 727 | `root` |
| `remote` | 723 | 724 | `root` |
| `rev-parse -q --verify` | 510 | 880 | `extensions/homelab` |
| `for-each-ref … refs/heads/agent/` | 298 | 939 | `root` |
| `for-each-ref … refs/heads/main` (upstream) | 315 | 777 | `intentic` |
| `remote -v` | 414 | 409 | `root` |
| `diff --name-only --no-renames` | 247 | 426 | `intentic` |

Now the same commands, run by hand against the same repos, on the same disk,
right now:

```
branch --show-current                       2.7ms / 3.8ms / 1.5ms
rev-parse --path-format=absolute --git-dir  1.8ms / 3.6ms
remote                                      1.5ms / 2.5ms
status --porcelain=v2 -z -uall (intentic)   88.8ms / 92.1ms / 91.0ms
status --porcelain=v2 -z -uall (root)       5.1ms / 4.1ms
```

`branch --show-current` is a 2 ms command that the daemon measures at 709 ms
mean. That is a ~250× gap, and it is uniform across every trivial command —
which is the signature of a shared queue, not of per-command cost.

The gap is the event loop. `git.run` is timed in the parent, around an IPC
round trip to the resident forker (`_sandbox/scaffold/src/exec.ts`), so the
measurement includes however long the parent takes to *process the reply*.

Event-loop delay, from the resource series:

| window | ELU | delay mean | delay max | RSS MB | swap MB | GC ms |
| --- | --- | --- | --- | --- | --- | --- |
| 15:52:25 | 0.49 | 37 | **11 945** | 939 | 1200 | 3048 |
| 16:19:37 | 0.37 | 28 | 8 393 | 3123 | 492 | 289 |
| 15:53:25 | 0.60 | 38 | 8 271 | 939 | 1225 | 688 |
| 13:47:22 | 0.25 | 24 | 8 061 | 760 | 0 | 305 |
| 15:42:23 | 0.38 | 28 | 6 954 | 972 | 1152 | 1487 |
| 17:40:31 | 0.24 | 24 | 6 128 | 2075 | 954 | 54 |

`delayMeanMs` never drops below ~22 ms even in idle windows, and the max
regularly reaches several seconds. Every git call, every route handler, every
frame push queues behind that.

**And the cause of the worst stalls is memory, not CPU.** The host:

```
Mem:  19999 MB total, 478 MB free
Swap: 32768 MB total, 4136 MB IN USE
```

The daemon (pid 7): `VmRSS 1.97 GB`, `VmSwap 902 MB`, `VmHWM 4.71 GB`. V8 heap
limit is 4.5 GB; `old_space` reports 244 MB used of 247 MB sized with 1.7 MB
available — permanently at the edge, with GC bursts up to 3 s per minute.

CPU is not the constraint: 16 cores, load 3.78, `/proc/pressure/cpu` full
avg300 = 0. IO pressure is real but modest (full avg300 = 1.12), and it is
mostly *swap* IO.

So the floor under every user action is: 20–40 ms of loop delay in the good
case, multiple seconds when a GC pass or a major fault lands. The observed
slow-request table is exactly what that predicts — endpoints with nothing to do
with git are just as slow:

| endpoint | slow count | mean ms | max ms |
| --- | --- | --- | --- |
| `GET /workspace/tree` | 566 | 2 860 | 34 287 |
| `GET /capabilities` | 229 | 3 371 | 31 419 |
| `GET /git/changes` | 178 | 4 015 | 33 970 |
| `GET /chores` | 138 | 4 627 | 14 142 |
| `GET /panels` | 179 | 3 111 | 26 192 |
| `GET /agents` | 71 | 5 346 | 33 665 |
| **`POST /git/intentic/commit`** | **44** | **7 287** | **34 295** |

Commit is the slowest *write* on the board, but the whole board is slow. Any
work on land/commit specifically sits on top of this floor.

## 2. The commit-specific cost: attribution scales with all history ever

`POST /git/<repo>/commit` (`_sandbox/sandbox/src/git/git.routes.ts:535`) does,
inside the repo lock:

1. optional `stagePaths`
2. `commitAll` / `commitIndex`
3. `invalidateScan()`
4. **`scanRepo(repo, dir)`** — the repo's fresh rows, carried back on the
   commit's own response

Step 4 is the deliberate optimisation that replaced a workspace-wide rescan,
and it is the right call. But `scanRepo` awaits `services.agentOrigins.forRepo`
(`_sandbox/sandbox/src/agents/origins.ts:245`), and that is where the commit
pays for the workspace's entire history.

The registry (`/history/agents.json`, 2.0 MB) holds **1367 conversations, 1326
of them archived**, and **1144 recorded landings**:

| repo | landings |
| --- | --- |
| `intentic` | **1028** |
| `root` | 95 |
| `extensions/*` | 20 |
| `registry` | 1 |

`forRepo` short-circuits *spent* landings from a memo, and that memo is doing
real work — `agentOrigins` metrics report `spent: 872`. But that leaves ~156
unspent landings in `intentic`, and for each one the loop does:

```ts
for (const landing of landings) {
    const applied = new Set(await appliedPaths(...));       // cached (fixed shas)
    const retired = new Set(await committedSince(...));     // keyed on CURRENT head
    const anchor  = await anchorOf(...);                    // cached (fixed shas)
    for (const path of await landedPaths(...)) { ... }       // cached (fixed shas)
}
```

Three of the four reads are cached on fixed shas and cost nothing on a repeat
scan. `committedSince` is not: it is keyed `${repo} ${landedHead}` and
**replaced whenever `head` changes**. A commit is precisely a head change. So
every commit in `intentic` invalidates ~156 expiry entries and re-derives them
as ~156 `git diff --name-only --no-renames <landedHead> <head>` calls —
**sequentially**, in a `for…of` with awaits, **inside the repo lock, on the
commit's own response path.**

That is the `diff --name-only --no-renames` row in the slow table: 247 slow
calls at 426 ms mean. 156 of those in series is 60+ s at the slow rate; most
resolve faster, which is why the observed commit mean is 7.3 s rather than a
minute — but the shape matches, and the 34 s worst case is this.

The same loop shape exists in `landed-presence.ts:182` (sequential over
entries, then over repos) but that cache is nearly empty here (`spans: 0`,
`settled: 40`), so it is not currently costing anything.

Two further consequences of the same design:

- **The memo is process-lifetime.** After a restart, the first Changes scan
  re-derives all 1028 `intentic` landings — the 10–20 s panel the code comment
  at `origins.ts:83` describes. It is amortised, not gone.
- **`agents.ids()` walks all 1367 entries** on every `forRepo`, i.e. once per
  repo per scan. Cheap per call, but it is 551 scans × 7 repos × 1367 entries.
  The registry has no retention policy at all.

## 3. The land-specific cost: a 10-second sentence

`landing.subject` — 17 calls, **mean 9 940 ms**, max 24 866 ms. Underneath it
`quick.model` runs at 7 074 ms mean over 35 calls, with 5 failures (the failures
are the expensive ones: a refused provider is a full round trip before the walk
tries the next rung).

To be precise about what this does and does not block:
`describeLandingInBackground` (`landed-subject.ts:196`) is genuinely
fire-and-forget, so the land's *response* does not wait for it. But the
sentence is what fills the commit box, so the user's actual experience of
"land, then commit" includes a ~10 s wait with a "writing…" chip. And the pass
itself is not free to the rest of the daemon:

- `claimedDiff` calls `agentOrigins.forRepo` per repo — the same expiry
  re-derivation as above, on a background task.
- On success it calls `publishRuntimeChange("landings")`, which triggers a
  **workspace-wide rescan** (`git.scan`: 646 ms mean, 30.7 s max).

Separately, the land itself has two sequential fan-outs that are fine on small
deltas and quadratic-feeling on large ones:

- `landAgent` (`agents/land.ts:323`) iterates `entry.repos` **sequentially**,
  each iteration taking that repo's lock.
- `classifyDelta` (`agents/land.ts:156`) probes **each change individually**,
  in series: one `git diff --binary` plus one or two `git apply --check` per
  changed file. A 50-file delta that fails the atomic check is 100–150
  sequential git spawns. It is only reached on a conflicting land, but
  `outstandingConflicts` re-runs the identical classifier on *every read* of a
  conflicted agent's diff route.

## 4. The scan's fixed overhead

Per repo per scan, `scanRepo` fires roughly 11 git spawns. Five of them are
`remoteState` (`git/remote.ts:35`): `remote`, `branch --show-current`,
`for-each-ref` for upstream — plus `remote -v` and `rev-parse --git-dir` from
adjacent readers. Those five account for 3 032 of the 5 205 slow `git.run`
lines. Almost all of what they return is repo *configuration* that changes on
the order of days, not the 646 ms it costs to re-read every scan.

`git.discover` runs the full repo-discovery walk on every scan too: 551 walks,
142 ms mean, 12 s max, for a repo set that changed maybe twice all day.

## Recommendations

Ordered by expected user-visible win per unit of work.

### A. Take attribution off the commit's response path — small, immediate

`scanRepo`'s own comment already grants that attribution "decorates the rows,
it isn't the rows", and it already degrades to `{}` on failure. When `scanRepo`
is called from the commit route, skip `agentOrigins.forRepo` entirely and let
the panel's next scan supply the chips. The rows the user just committed
disappear on the response; the chips arrive a beat later.

This removes ~156 sequential git spawns from the critical path of every commit
in the busiest repo. Expected: the 7.3 s commit mean drops to roughly the cost
of `commitIndex` plus one `status` — sub-second on an unloaded loop.

### B. Batch the expiry read — one spawn instead of N

`committedSince` asks "which paths did history touch between `landedHead` and
`head`" once per landing. Every landing shares `head`, and every `landedHead`
is an ancestor of it on the same line. So one

```
git log --format=%H -z --name-only --no-renames <oldestLandedHead>..<head>
```

yields every commit's path set in a single spawn; per-landing answers are
suffix unions over that walk, computed in memory. N spawns → 1.

Failing that, at minimum give the `forRepo` loop bounded concurrency (the
`UNTRACKED_READ_CONCURRENCY` pattern already in `git/changes.ts:279`). N
sequential round trips → N/8.

### C. Persist the `spent` / `settled` memos

Both are documented as one-way doors: once history has absorbed every path a
landing put in the tree, no later act can un-absorb it. That is exactly the
property that makes a memo safe to write down. Persisting them beside the
registry removes the post-restart cliff (1028 landings re-derived on the first
scan) without changing a single verdict.

### D. Prune the registry

1326 archived conversations and 1144 landings are retained with no policy. A
landing whose claim is spent *and* whose agent has been archived for N days
carries no information any surface reads — the chip is gone, the branch is
parked, the paths are committed. Dropping `landedTip`/`landedHead` from those
entries (or the entries themselves) makes attribution proportional to active
work rather than to everything the sandbox has ever done.

### E. Cache `remoteState`'s config half

Split it: `remote`, `remote -v` and the branch's configured remote are
configuration — cache them per repo, invalidated on the verbs that can change
them (`fetch`, `push`, `pull`, `createBranch`, `checkout`) plus a generous TTL.
Only ahead/behind needs to be live, and that is the one `for-each-ref`. Five
spawns per repo per scan → one. On seven repos and 551 scans that is ~15 000
spawns saved.

Same treatment for `git.discover`: the repo set is already watched for other
reasons; a scan should read a memo, not re-walk the tree.

### F. Deal with the memory pressure — the biggest win, and the least local

902 MB of the daemon swapped out, a 4.71 GB high-water mark against a 4.5 GB
heap limit, `old_space` permanently full, GC bursts to 3 s. This is what turns a
2 ms git read into a 700 ms one and a 200 ms commit into a 7 s one, and no
amount of git tuning will touch it.

Visible holders worth auditing, from the resource series:

- `agentOrigins.pathCharacters: 51 351 541` — **51 MB of path strings** in the
  attribution memo alone. Recommendation D shrinks this directly.
- `conversationTranscriptSearch`: 1359 conversations, 11.5 MB of text, in-process.
- `globalHandles: 1 028 168`.
- The iq engine worker and the provider SDK streams share the address space.

Two structural options, in rough order of leverage:

1. **Move the memory-heavy readers out of the daemon process.** The forker
   already establishes the pattern and the reasoning (`exec.ts:74`): keep the
   process that serves the control plane small. Transcript search and the iq
   engine are the two obvious candidates.
2. **Bound the caches by bytes, not by entry count.** Every cache here is
   bounded by cardinality ("proportional to the unspent landings"), which is a
   proxy that failed — 534 spans became 51 MB of strings.

## Summary table

| Change | Path affected | Effort | Expected win |
| --- | --- | --- | --- |
| A. Skip attribution in commit response | commit | Small | 7.3 s → sub-second commit |
| B. Batch expiry into one spawn | commit, scan | Medium | ~156 spawns → 1 |
| C. Persist spent/settled memos | first scan after restart | Small | removes 10–20 s cliff |
| D. Prune registry landings | scan, land, commit | Medium | attribution ∝ active work |
| E. Cache remoteState config | every scan | Small | ~15 000 spawns saved |
| F. Reduce daemon RSS | **everything** | Large | removes the multi-second floor |

A and E are cheap and independent. B and C are contained. D and F are the ones
that change the shape of the problem rather than its constant.
