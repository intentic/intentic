# @intentic/perf

Performance checks that count work instead of timing it, each judged from one run against a baseline checked in here.

A count either matches the baseline or it has moved, so there is nothing to average and no retry budget to tune.

Two tracks:

| track          | what it counts                                                                           | where                                      | baseline                                         |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `perf:instr`   | instructions executed by a pure-JS hot path (Valgrind `I refs`, `node --predictable`)    | Node, under Valgrind                       | [baselines/instr.json](baselines/instr.json)     |
| `perf:browser` | Vue renders, V8 function calls, layouts, style recalcs and DOM mutations per interaction | the real editor (`_site/demo`) in Chromium | [baselines/browser.json](baselines/browser.json) |

```sh
pnpm perf:instr                      # judge every scenario against the baseline
pnpm perf:instr --only fuzzy-rank    # one scenario
pnpm perf:instr --runs 3             # measure each three times and print the spread (checks the instrument)
pnpm perf:instr --update             # re-record; commit the baseline diff together with the change that caused it
pnpm perf:browser                    # same flags
```

A failure means the checked-in numbers no longer describe the code, in either direction. A regression fails,
and so does an improvement: if an improvement is not recorded, the next regression can use up the slack
unnoticed. When the change is intended, re-record the baseline. The baseline diff in the pull request is then
the record of what the change cost or saved.

## Instruction counts

`src/instr/counted-process.ts` runs one scenario in one of two phases. `setup` imports the code and builds the input.
`full` does the same and then runs the work once. Both phases run under
`valgrind --tool=cachegrind --cache-sim=no` and the scenario's count is `full − setup`. Process startup, module
loading and fixture building are counted in both phases, so they cancel out.

Why the count repeats from run to run:

- **`--predictable`** moves V8's compiler and GC threads onto the main thread. Without it the same toy workload
  measured 410M, 489M and 694M instructions over three runs. With it, the same three runs landed within
  **one part per million** of each other.
- **`--predictable-gc-schedule` and fixed heap sizes.** By default V8 sizes its heap from the host's RAM. Fixing
  the sizes means the GC schedule is the same on every machine.
- **A drained, collected heap before the work.** Setup does I/O, and V8's foreground tasks run wherever wall
  time puts them. Without this step every scenario's count also included collecting setup's garbage, 1% to 16%
  of the total, and `code-lines` jumped by 0.13% between two runs depending on where that GC landed. The counted process
  now drains one event-loop turn and calls `gc()` before the work, in both phases.
- **Generated inputs.** Every fixture is generated from a fixed seed (`src/instr/fixtures.ts`). None of them
  reads the checkout, so a new file in the repository cannot move a count.
- **A fixed environment for the child**: `PATH`, `LANG=C.UTF-8` and `TZ=UTC`, and nothing else.

Measured spread over three runs of each scenario: **0.8 to 12 ppm**. The tolerance is **0.5%**, over 400
times the worst of that. A real change to a hot path moves its count by far more than that. Injecting
`localeCompare` into `rankByFuzzy`'s tie-break moved `fuzzy-rank` by **+12.60%**.

| scenario          | production path                                                                           | work                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `code-lines`      | the review row's comment-free line counts: `codeLineStat` (`@intentic/code-read`)         | Shiki tokenizes both sides of a 40-function `.ts` file |
| `ignore-walk`     | the workspace walk's ignore check: `IgnoreScope.isIgnored` (`@intentic/workspace-ignore`) | 8,000 paths under two `.gitignore` layers              |
| `fuzzy-rank`      | quick-open ranking: `rankByFuzzy` (`@intentic/base/fuzzy`)                                | 20 keystrokes, each re-ranking 20,000 paths            |
| `transcript-fold` | the daemon's per-frame fold: `TranscriptFold.apply` (`@intentic/sandbox-contract`)        | a 900-call turn of 14,400 frames                       |
| `transcript-rows` | reading a stored transcript back: `JSON.parse` + `TranscriptRowSchema.safeParse`          | 20 settled 150-call turns                              |

`code-lines` and `ignore-walk` were named in
[the sandbox performance analysis](../../docs/audits/sandbox-performance-analysis.md) as two of the synchronous
paths behind the daemon's event-loop freezes. `transcript-rows` is the row parse from
[the session search analysis](../../docs/audits/session-search-performance-analysis.md).

**Adding a scenario.** Add a file to `src/instr/scenarios/` that exports `scenario: Scenario`. The CLI finds it
by its file name. `setup` returns the work. The work must throw when its result is wrong, so that a count can
never come from work that stopped early (`code-lines` checks that Shiki did not run out of its time budget).
Keep the work between about 50M and 3G instructions: Valgrind runs at about 1/50 of native speed.

**What the count depends on.** The baseline records the Node version, the V8 flags, the Valgrind version, the
architecture and the CPU model. A change to Node, the flags or the architecture changes the code being counted,
so the run is refused and must be re-recorded. A different CPU is reported but still judged. glibc and V8 pick
code paths by CPU feature (Valgrind hides AVX-512 and passes the rest through). The worst case is a host with
none of those features. Turning off every optional V8 feature (AVX, AVX2, FMA3, BMI, LZCNT, POPCNT, SSE4) moved
`fuzzy-rank` by 0.80%. Turning off glibc's AVX, AVX2, BMI2, ERMS and FSRM paths moved it by 1.26%.
`transcript-rows` moved by under 0.14% either way. Two modern x86-64 hosts differ by much less than that. The
checkout's path counts too: module URLs contain it, so it shifts the heap's layout. Renaming the probe script
moved a 61M-instruction scenario by 0.21%, and moved the 1.5G `fuzzy-rank` by 0.001%. That is why scenarios
are sized well above 100M instructions. Record the baseline on the host, and at the path, that judges it.

Valgrind is Linux-only. On macOS or Windows, run the bench inside a sandbox or in CI.

## Browser counts

Chromium has no instruction counter. It does have several counts that follow from what the code does rather than
from how long it took. `perf:browser` starts `_site/demo` (the real editor on fake data) with its own Vite, on a
free port and with `--force`, so neither a port-mirrored server nor a stale pre-bundle can stand in for this tree.
It then counts, per interaction:

| metric                                                | source                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vue.renders`, `vue.mounts`, `vue.render:<Component>` | Vue's devtools hook (`component:added`, and `component:updated` only when the instance's own subtree changed); a component is named once it re-renders twice in a window |
| `v8.calls`, `v8.calls.app`                            | V8 precise coverage with call counts, taken at the window's edges; `.app` is the editor's own source, excluding Vue, other dependencies and the demo's fake backend      |
| `blink.layouts`, `blink.styleRecalcs`                 | CDP `Performance.getMetrics` (`LayoutCount`, `RecalcStyleCount`)                                                                                                         |
| `dom.records`, `dom.added`, `dom.removed`             | a `MutationObserver` over the whole document                                                                                                                             |

Why the counts repeat:

- **Time only moves when the harness moves it.** Playwright's clock is paused at a fixed instant before the first
  document. It advances in 100 ms steps, and its timers run back to back inside one step rather than as separate
  real tasks, so a frame cannot fall between two of them.
- **Every step ends in the same flush.** After each input or clock step the page is forced through style and
  layout, then waits two real frames (the real `requestAnimationFrame`, captured before the clock replaced it).
  This repeats until three flushes in a row start no request. Whatever an input dirtied is therefore laid out
  here, once, and not wherever a compositor frame happened to land.
- **Nothing else varies.** Each run uses a fresh browser context with a fixed viewport, locale, time zone,
  colour scheme and reduced motion. `Math.random` and `crypto` are seeded, and the demo's recording and
  extension list are pinned.

Every metric of every scenario read identically across 3 and then 5 fresh contexts, with one exception.
`agents-cold` loads the app's modules over the network while it renders, so how many frames its layouts fall
into depends on when each module arrives. One run in eight laid out 46 times instead of 44, with identical DOM
mutations. That scenario keeps every count except layouts and style recalcs.

| scenario              | interaction                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `agents-cold`         | load `/demo/agents` into an empty document and let it settle                              |
| `agents-idle`         | 15 s of nothing on the fleet board, where a running card arms the shared clock (`useNow`) |
| `agents-to-workspace` | press the rail's Workspace tile: a route switch between two heavy views                   |
| `chat-typing`         | type 20 characters into a titled chat's composer with four chats open                     |
| `workspace-open-file` | open `README.md` from the workspace file tree                                             |
| `appearance-dark`     | switch Appearance from System to Dark: a restyle of the whole document                    |

`agents-idle` and `chat-typing` replay the interactions from
[the UI re-render analysis](../../docs/audits/ui-rerender-analysis.md). Reverting its `useNow` fix, so that every
consumer reads the shared clock again, failed `agents-idle` on `v8.calls` (+4.08%) and `v8.calls.app` (+1.85%).
Every render, layout and DOM count stayed the same. The analysis measured that bug as wasted triggers rather than
redraws, and only a call count can see those.

The counts are exact, so the tolerance is zero. The Chromium and Playwright versions, the viewport and the
platform are binding. The Vue version is recorded for reference. Playwright's version matters beyond Chromium's:
the paused clock is driven through its internal `__pwClock` controller.

## Key files

- [src/baseline.ts](src/baseline.ts): judges a run against a baseline, or re-records it; both tracks share it.
- [src/instr/counted-process.ts](src/instr/counted-process.ts): the process Valgrind counts, in its setup and full phases.
- [src/instr/scenarios/](src/instr/scenarios): one file per instruction-count scenario, found by name.
- [src/browser/session.ts](src/browser/session.ts): the fresh context, the paused clock and the flush that makes a window's counts exact.
- [src/browser/page-probe.ts](src/browser/page-probe.ts): the page-side counters: Vue's hook, the mutation observer, the seeded randomness.
- [src/browser/scenarios.ts](src/browser/scenarios.ts): the interactions the browser counts are taken over.
