# Why workspace text search was slower than VSCode

**Fixed.** The diagnosis is kept as written; what was built and what it measures
now are at the end, in "What was done".

Measured on this box, 2026-08-23, 16 cores, warm page cache, against the live
`/work` tree (3.1 GB `intentic`, 270 MB `extensions`, **14 GB `refs/`**). Every
figure below comes from running ripgrep with the daemon's own argument list and
draining its output through the daemon's own parse loop
(`_search/iq-engine/src/engines/lexical.ts`), not from reading code.

Scope: the explorer's **Text** scope (`/workspace` → search box → Text), which
is `GET /workspace/search?mode=find` → `services.iq.run` → `rgSearch`. The same
ripgrep call sits under the **Smart** scope's lexical arm, under `refs`/`sym`,
and under every `iq` call an agent makes, so everything here is shared.

## The headline

The engine hands ripgrep a job **37× larger than the answer needs**, then throws
away 97% of what comes back. Three independent causes, all in the same function:

1. **The reference shelf is searched on every query.** The sweep excludes
   `refs/`; ripgrep is never told. It reads all 14 GB, emits JSON for every
   match, and the post-filter drops 100% of it.
2. **There is no global hit ceiling and no early kill.** The route keeps 1 000
   hits / 300 files, but the scan always runs to completion. VSCode caps at
   20 000 and kills the child process the moment the cap is hit.
3. **The "files to include" field never reaches ripgrep.** It is applied
   in-memory to the sweep's entries, so narrowing a search does not make it
   faster. VSCode passes includes and excludes to ripgrep as `-g` globs.

Causes 1 and 2 fix *different* queries and you need both: the cap rescues broad
queries (they reach 1 000 hits in milliseconds), the prune rescues rare ones
(the cap is never reached, so the walk is the entire cost).

## Measurements

Time from spawn to last byte parsed, and the megabytes of ripgrep JSON the
daemon parses to produce the answer.

| query | today | + global cap (1 000) | + shelf prune | both |
| --- | --- | --- | --- | --- |
| `te` (2 chars — the state the box passes through on the way to every longer query) | **67 309 ms** / 1 375 MB | 119 ms | 268 ms / 42.7 MB | **8 ms** |
| `workspace` (common word) | **17 300 ms** / 95.6 MB | 14 ms | 33 ms / 4.1 MB | **10 ms** |
| `useWorkspaceSearch` (rare identifier, 10 hits) | **9 572 ms** / 0 MB | 9 572 ms | 57 ms | **23 ms** |

The `te` and `workspace` rows for "today" include cold-cache effects from the
first pass; the `useWorkspaceSearch` row is the honest steady-state number,
because it produces almost no output — **9.6 seconds of pure directory walking
for a query with ten hits.**

Files ripgrep walks, same argument list:

| ignore strategy | files walked |
| --- | --- |
| today (`--no-ignore`, shelf included) | **173 785** |
| shelf pruned | 4 686 |
| shelf pruned + per-directory `.gitignore` honoured | 4 648 |
| ripgrep's own default ignore handling | **73** ← see the trap below |

And the discard rate, for `te`: ripgrep reports 154 590 files and 4 336 577 JSON
lines (1.38 GB); after the `allowed` post-filter, 4 578 files and 124 455 matches
survive. **97% of the events the daemon parses are thrown away.**

## 1. The reference shelf is searched on every keystroke

`sweep()` (`_search/iq-engine/src/workspace/scan.ts:44`) rejects a path when
`IgnoreScope.isIgnored` says so, and that predicate
(`_sandbox/workspace-ignore/src/index.ts:39`) rejects four things:

| the sweep rejects | ripgrep is told | how |
| --- | --- | --- |
| `IGNORED_DIRS` (dir names) | ✅ | `-g '!**/<dir>'` per entry |
| browser profiles, agent worktrees | ✅ | `DENIED_GLOBS` (under `.intentic`) |
| **the reference shelf (`refs/`)** | ❌ | nothing |
| **per-directory `.gitignore` layers** | ❌ | cancelled by `--no-ignore` |

`rgSearch` builds its prune list from `IGNORED_DIRS` + `.git` + `DENIED_GLOBS`
(`lexical.ts:112-125`). `REFERENCE_DIR` is in neither, and it is not in
`/work/.gitignore` either, so nothing stops the walk. On this workspace that one
missing glob is the whole 37×.

### The trap: do not fix this by dropping `--no-ignore`

Letting ripgrep do its own ignore handling collapses the walk to **73 files**,
because the root repo excludes the nested repos through `.git/info/exclude`
(the root is versioned with `--separate-git-dir`). That is exactly the failure
the comment at `lexical.ts:121` warns about: *"a workspace whose code sits under
a locally-excluded directory answered `files`/`ask` normally while every `find`
returned zero."* The comment is right and the flag must stay in spirit.

The precise version is to replace one blunt flag with four narrow ones, so
ripgrep's ignore model becomes *exactly* the sweep's — `.gitignore` files inside
the tree, nothing else:

```
--no-ignore-exclude --no-ignore-global --no-ignore-parent --no-ignore-dot
```

Measured above: 4 648 files, no collapse. This is a bonus, not the headline
(38 files here), but it removes the drift between the two ignore models for free
and matters in a workspace with large untracked build output.

### Prune with globs, not with a path list

The obvious alternative — hand ripgrep the sweep's admitted paths as arguments,
making the post-filter a no-op — is **slower**, measured:

| query | glob prune | 4 686 explicit paths (246 KB of argv) |
| --- | --- | --- |
| `te` | 117 ms | 168 ms |
| `workspace` | 20 ms | 107 ms |
| `useWorkspaceSearch` | 12 ms | 17 ms |

It also breaks down at the sweep's 100 000-file ceiling (~6 MB of argv). Use
globs.

### Correctness constraints on the prune

- **The prune must be a superset of what the sweep admits, never narrower.** It
  is an optimisation; the `allowed` post-filter stays the authority. A prune
  that is too aggressive silently loses files, which is the worst failure this
  search has.
- **It must be conditional on `includeIgnored`**, exactly as `IGNORED_DIRS`
  already is (`lexical.ts:115`). With the switch on, the sweep admits the shelf,
  so the prune has to lift with it.

## 2. No global ceiling, and nothing kills the scan

`GUI_SEARCH_HITS = 1_000` / `GUI_SEARCH_FILES = 300`
(`_sandbox/sandbox/src/workspace/workspace.routes.ts:30`) are applied by
`renderList` (`_search/iq-engine/src/render/list.ts`) **after** the full result
set exists. `MAX_PER_FILE = 50` caps one file's contribution; nothing caps the
total. So `te` builds 124 455 hits to show 1 000.

VSCode's parser counts results, sets `hitLimit` at `DEFAULT_MAX_SEARCH_RESULTS`
(20 000), and calls `cancel()` — which kills the ripgrep child
(`refs/vscode/src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts:103,327`).

Two things to get right when adding this:

- **The displayed total becomes a floor.** "124 455 matches" becomes "1 000+".
  The panel already models this: `partial` exists precisely because
  `MAX_PER_FILE` truncates and "a caller that reports a total has to say the
  total is a floor" (`lexical.ts:9`). Extending it to a global cap is
  consistent, and it is the trade VSCode already makes. **This is the one
  user-visible consequence in this document.**
- **"Load more" re-runs the scan.** The cursor is an offset and nothing is
  spooled — "the continuation re-runs the verb and slices at the offset"
  (`list.ts:15`). So the cap has to be `offset + page`, not a constant, or page
  two comes back empty.

## 3. The include field does not narrow the scan

The route reads the field with `includeGlobs` and puts the result in
`request.scope.globs` / `notGlobs` (`workspace.routes.ts:147`). `dispatch` feeds
those to `filterScope` over the sweep's entries (`dispatch.ts:868`), and the
result only shapes the `allowed` set. `rgBase` (`dispatch.ts:534-540`) carries
`root`, `allowed`, `ignored`, `rgPath`, `signal` — **no globs**. Ripgrep still
walks everything.

VSCode does the opposite: `-g '!*'` plus one `-g` per include pattern
(`ripgrepTextSearchEngine.ts:423-442`), so narrowing is the user's fastest
lever. Passing `scope.globs`/`notGlobs` through as `-g` args is a few lines, and
the in-memory filter stays the authority (same superset rule as above).

## 4. One-shot delivery, where VSCode streams

VSCode reports every match through a `Progress` callback as ripgrep emits it
(`ripgrepTextSearchEngine.ts:90`); the tree fills in and the count ticks up
while the scan is still running, so first paint is tens of milliseconds
regardless of repo size. Here the full set is built, sorted, grouped, paged, and
returned as one JSON body.

After fixes 1–3 the scan is 8–25 ms, so streaming stops being necessary. Keep
it as a later option (NDJSON or SSE on the same route), not part of this work.

## What is *not* the problem

Ruled out by inspection, so nobody re-investigates them:

- **Transport.** The browser calls the daemon directly, with a loopback
  shortcut when the sandbox is on this machine (`sandboxClient.ts`). A 1 000-hit
  page is a few hundred KB.
- **Cancellation.** It works end to end: the query function consumes TanStack's
  signal, so switching keys cancels the fetch; the route threads `signal` into
  `iq.run`; the engine client forwards `{type:"abort"}` across the process
  boundary (`host/client.ts:161`); the child aborts its controller
  (`host/child.ts:106`) and `spawn` kills ripgrep. Keystroke bursts do not pile
  up.
- **Per-query sweep.** The resident engine keeps the sweep in memory and
  revalidates on a worker thread; `run()` awaits only the first sweep
  (`index.ts:402`). Building the `allowed` set is ~4 700 strings, low
  milliseconds.
- **Debounce.** 150 ms (`useWorkspaceSearch.ts:37`), comparable to VSCode's.

## Shared floor, worth knowing

Two things make every measurement above worse in practice, and neither is a
search bug:

- The daemon's own `perf` summary at 21:42 reports `http.request` **mean
  1 222 ms** over 5 088 requests, 610 flagged slow, worst 145 s on
  `/workspace/tree`. Long-lived streams inflate that mean, but the same
  event-loop floor diagnosed in `land-commit-performance-analysis.md` sits under
  the search route too.
- The engine's host process (`host/child.js`) was at **94% CPU** for its whole
  uptime, working the embedding backlog. It competes for CPU and page cache with
  the searches it also serves.

## What was done

Measured through the resident engine, driven exactly as the route drives it
(`verb: find`, `literal`, a 1 000-hit / 300-file list page), median of five runs
on the same box:

| query | before | after | |
| --- | --- | --- | --- |
| `te` | 67 309 ms | **16 ms** | ~4 200× |
| `workspace` | 17 300 ms | **22 ms** | ~790× |
| `useWorkspaceSearch` | 9 572 ms | **43 ms** | ~220× |
| `createResidentEngine` | — | 46 ms | |

1. **The prune list moved into the ignore model** as `scannerPruneGlobs`
   (`_sandbox/workspace-ignore/src/constants.ts`), derived from the same
   branches `isIgnored` tests, and `rgSearch` consumes it. That closed two blind
   spots, not one: the reference shelf and agent worktrees. The shelf glob is
   root-anchored (`!/refs`) to match `isReferencePath`'s first-segment rule, so
   a repo's own `refs/` stays ordinary content. Its test asserts the *claim* —
   every subtree `isIgnored` rejects by rule is prunable — rather than a list of
   strings, because a list is what drifted.
2. **A scan ceiling that kills the child**, in both units a page is measured in
   (`RgOptions.maxHits` / `maxFiles`), applied only to a list caller's first
   page. With a ceiling the scan is also `--sort path`, without which "which
   1 000 of 124 455 hits" is decided by thread scheduling and one query shows
   two different result sets. Sorting costs ripgrep its parallelism and, with
   the shelf pruned, that is 5–38 ms.
3. **A narrowed search is handed its surviving paths** as the scan's arguments
   instead of the whole tree. They are the sweep's own filtered entries, so no
   glob dialect gets translated into ripgrep's and the optimisation cannot
   admit less than `allowed` does.

Two things the implementation got right that the plan had only in outline:

- **The ceiling stops on a file boundary, not on the hit that reached it.** A
  mid-file cut hands back a file showing 10 of its 40 matches — which reads as a
  file that has 10 — and because the caller pages by whole files, the other 30
  would land in no page at all. The overshoot is bounded by `MAX_PER_FILE`.
- **`truncated` had to learn about the ceiling.** It was derived from the group
  count alone, so a ceilinged scan that returned every file it read looked like
  a last page, and the panel's Load-more vanished while matches remained. The
  first test written for this caught exactly that.

Also: `WorkspaceSearchResults.vue` now marks the FILE count as a floor too. A
ceiling bounds both numbers, and a "+" on the matches beside a bare file count
would claim the one thing that is never true — that we know exactly how many
files matched but not how many lines.

**Not done, deliberately.** The agent-facing text path (`iq find`, `iq q`) gets
no ceiling. Its page is a token budget, so nothing knows where to stop before
the search runs; and measured, the sort a ceiling requires costs a narrow query
more than the ceiling saves it (12 ms → 38 ms on a rare identifier, the shape
agents search for most). With the shelf pruned its worst case is 268 ms.

## Still open

- **`includeIgnored` is the slow path now, and by a wide margin: measured
  63 s.** The switch is honest — it does reach the shelf — but it pays twice
  for it: `dispatch` runs a fresh full `sweep(root, true)` inline (stat every
  file in 14 GB, per keystroke) *and* the prune globs lift, so the scan walks
  all of it too. Nothing here made that worse; it is now simply the only place
  the old cost still lives. The fix is in the sweep, not the scanner.
- **Streaming.** Unchanged from the analysis above: at 16–46 ms a scan, first
  paint is no longer the thing that matters.
- **The shared floor.** `http.request` mean 1 222 ms, engine host at 94% CPU.
  Both still sit under this route and neither is a search bug.

## Verification

`_search/iq-engine` 193 tests pass, including the new guards: the shelf and
worktrees are walked only under `--ignored`; a nested `refs/` always is; a
ceilinged scan is byte-identical across runs; no file comes back half-read; a
scoped find returns exactly the unscoped hits for the files in scope; and a
ceilinged page plus the page after it are one continuous result with no overlap.
`_search/iq-bench` reports p50 latency per arm for the agent-facing paths.
