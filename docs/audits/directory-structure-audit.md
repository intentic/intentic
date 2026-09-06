# What this tree cost an agent to work in

Measured 2026-09-06 over 1,862 agent conversations (2026-07-27 → 2026-09-06) from the daemon's own transcript
corpus, plus the tree itself. This is the evidence behind the layout rules in
[docs/architecture/conventions.md](../architecture/conventions.md) and the check that enforces them
([`_tools/checks/layout.mjs`](../../_tools/checks/layout.mjs)); re-run the corpus half with
[`_tools/nav/structure-stats.mjs`](../../_tools/nav/structure-stats.mjs) and the tree half with
`node _tools/nav/run.mjs measure`.

## What the sessions said

1,718 of the 1,862 conversations did real code work (≥3 reads and searches). Per Claude session, the median:
**37 tool calls before the first edit**, **8.4 directory listings**, **4 packages and 8 directories read**
(p90: 9 and 19). 87% of them hit at least one failed lookup.

| cost | what it looked like |
| --- | --- |
| **flat directories** | `_editor/web` listed 313 times, 29 of those answering with more than 4,000 characters; `_sandbox/sandbox/src/agent` held 159 files, `composables/chat` 109, the wire contract's `src/` 96 loose ones beside its subdirectories |
| **twin names** | 84 sessions read both `src/agent/` and `src/agents/`; `chatSurface.ts` existed twice in the web app with different exports; `index.ts` ×52, `invariant.ts` ×20, `host.ts` ×18, `agent.ts` ×5 |
| **work is a vertical slice** | the top co-read pairs were `_editor/web + _sandbox/sandbox` (459 sessions), `sandbox + sandbox-contract` (377), `web + sandbox-contract` (360) — while the tree was arranged by layer, so one feature meant four directories in three packages |
| **dead names outlive the rename** | `_apps/` and `_libs/` were removed on 2026-08-09 and were still typed 89 times in the month after; failed `Read`s were dominated by paths under them |
| **the naming rule was already broken** | 41 of 98 packages disagreed with "a package's directory name is its unscoped npm name", and one repository published under three npm scopes |
| **entry documents too big to read** | `ARCHITECTURE.md` at 1,226 lines was opened in 37 sessions and read whole in 10, always truncated; `_sandbox/sandbox/README.md` at 1,204 lines was the most-read document in the corpus after the wire schemas |

## What the tree said, before and after

`node _tools/nav/run.mjs compare _tools/nav/baselines/pre-overhaul.json _tools/nav/baselines/post-overhaul.json`:

- tokens an agent pays to open a symbol's defining file, p90: **10,663 → 9,809 (−8.0%)**
- the same over every first-party import in the suite: **24.1M → 22.1M (−8.5%)**
- the biggest directory under any package's `src/`: **159 files → 51** (and that one is the wire contract's
  schemas, one file per wire group, deliberately left flat)
- code lines, import edges and cycles: unchanged within a percent — this moved files, it did not rewrite them

The corpus half cannot move until agents have worked in the new tree: the numbers above were taken from
sessions that ran against the old one. Re-run `structure-stats.mjs --since <the landing date>` a fortnight
later and compare listings-per-session, failed reads and stale-name mentions against
`_tools/nav/baselines/structure-pre.json`.
