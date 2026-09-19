# Why the tidy job is always red

> Every run of `nightly.yml`'s `tidy` job since it began refusing, 2026-09-06 to 2026-09-19, read from the job
> logs rather than from memory. Narrower sibling of [`ci-failure-audit.md`](ci-failure-audit.md), which asks the
> same question of the whole pipeline. This one asks why ONE job, whose entire content is checks that run in
> 2.5 seconds and need no install, failed more often than it passed.
>
> Run numbers, job ids and commit hashes are given so any claim can be re-read at source.

## The number

The job first refused on run #39 (2026-09-06) and has run 24 times since. **It failed 14 of them.** Counted by
tree rather than by run — several runs measure the same commit — it failed on 14 of the 20 distinct commits it
read. It has never been green on more than two consecutive scheduled nights.

| Check | Failures it appears in |
| --- | --- |
| `layout` | 13 of 14 |
| `paths` | 8 of 14 |
| `daemon-boundaries` | 4 |
| `peer-deps` | 3 |
| `tailwind` | 2 |
| `buttons` | 2 |
| `invariant-registry` | 1 |

`layout` is in every failure but one (#44, job 102381063145). Nothing else is close. Any account of this job's
fragility that is not mostly an account of `layout` is the wrong account.

## What `layout` kept finding

The fan-out rule refuses a directory holding more than 30 files a reader reads, ratcheted per directory in
`_tools/checks/baselines/layout.json`. Here is every fan-out finding the job printed, by run:

| Run | Date | Directories |
| --- | --- | --- |
| #43 | 09-08 | `_platform/api/src/sandbox/hosted` 33 (allowed 31) · `_sandbox/sandbox/src/agent/run` 33 · `_site/site/src/components` 38 (allowed 36) |
| #54 | 09-12 | `.../sandbox/devices` 31 · `sandbox-contract/src/schemas` 52 (allowed 51) |
| #55 | 09-13 | `.../sandbox/overview` 31 |
| #57 | 09-14 | `sandbox-contract/src/schemas` 52 (allowed 51) |
| #58 | 09-14 | `_platform/api/src/sandbox/hosted` 33 · `schemas` 52 (allowed 51) |
| #59 | 09-15 | `design-system` 31 · `workspace/files` 33 · `sandbox/src/auth` 33 · `schemas` 49 (allowed 48) |
| #60 | 09-16 | `chat/transcript` 31 · `sandbox/devices` 31 · `capabilities` 41 (allowed 39) · `schemas` 44 (allowed 43) |
| #62 | 09-16 | `workspace/changes` 32 |
| #67 | 09-18 | `workspace/explorer` 33 · `workspace/files` 31 · `workspace/viewers` 38 · `contracts` 42 (allowed 41) · `schemas` 42 (allowed 41) |
| #69 | 09-19 | `agents/board` 34 · `sandbox/devices` 31 · `capabilities/handlers` 37 (allowed 35) · `contracts` 43 (allowed 42) · `schemas` 43 (allowed 42) |

Two shapes, and nothing else. A directory that crossed 30 and now holds 31 to 34. Or a baseline entry exceeded
by one or two. In thirteen nights the job never once found a directory that had grown by a lot.

`_shared/sandbox-contract/src/schemas` is in seven of these ten. Its baseline entry, read from the history of
the file it lives in, went **51 → 48 → 43 → 41 → 42 → 43** across five commits in twelve days — `32e3663459`,
`bf01472822`, `a7dff2bb68`, `63aac5f126` and the one that first recorded it, `cbba5f625e`. Somebody split that
directory from 52 entries down to 41, in four separate refactors, and it was back over the line before the
fortnight was out. The rule was obeyed repeatedly and obeying it did not help.

## Root cause 1: nothing measures the tree that becomes main

Three gates read these checks. None of them reads the tree the job reads.

| Gate | Tree it measures | What tidy does there |
| --- | --- | --- |
| edit (`.intentic/checks.json`) | the one file just written | refuses, scoped checks only |
| turn (`verify-turn.mjs`) | one agent's worktree, against that worktree's own HEAD | refuses the lines the turn's diff added |
| push (`verify-push.mjs`) | the pushed tree | **nothing** — it ran `--tidy=warn` |
| nightly `tidy` | main | refuses, with nobody attached |

Every commit on main is authored by `intentic <agent@intentic.dev>` — the last sixty, all of them. Each was
written in a worktree of its own and measured against that worktree's HEAD. **The tree an agent is measured on
is not a tree that ever becomes main.** Between the two lies every other conversation's work, and the push,
which was the one moment holding both the combined tree and a person, waved tidiness through by configuration.

So the first thing to read main with tidy refusing was a scheduled job, hours later, printing anchors that
belonged to a commit a day or two old.

## Root cause 2: a counting rule does not compose across worktrees

This is why `layout` and not the others.

`paths`, `tailwind`, `buttons` judge a LINE. A bad line is bad in any tree, so measuring one worktree in
isolation gives the same verdict as measuring the union. Those rules compose.

`layout`'s fan-out counts a DIRECTORY, and a count is a property of the tree, not of anyone's diff. Two turns
that each add one file to a directory of thirty are each correct in their own worktree and over the limit the
moment both land. Neither could have seen it; neither did anything wrong; and the gate that finally says so is
addressed to nobody.

The `--allow` escape makes it worse rather than better. Two worktrees that each record the same directory write
the *same number* into the baseline, so git sees no conflict and merges both cleanly — the tree lands at 44 with
a baseline asserting 43. The check's own comment anticipates the hand-edit hazard; what it did not anticipate is
that the automated form has it too.

The asymmetry underneath: `writesBaselines()` is `CI === undefined && !isLinkedWorktree()`. **Every agent works
in a linked worktree**, so the ratchet's self-tightening half only ever runs in the owner's primary checkout,
while its loosening half is a flag a human has to know about. It tightens where nobody works and must be
loosened by hand where everybody does.

## Root cause 3: an exact-count ratchet on directories that are indexes

`contracts/` holds one `*.contract.ts` per wire group. `schemas/` holds one module per wire group.
`capabilities/handlers/` holds one `*.handler.ts` per `CapabilityKind`, and `registry.ts` is a total map, so a
missing one is a compile error. Their size is the number of surfaces the product has.

The fan-out rule measures scrolling: thirty modules whose roles you cannot guess is a listing you must read
before you can act. That premise is simply false for these three. Nobody lists `contracts/` — an agent that
wants the secrets contract opens `secrets.contract.ts`. The cost the rule exists to prevent is not present,
and the number it records is a treadmill: one bump per surface added, forever. The four splits of `schemas`
are what obeying it looks like.

## Root cause 4: the upstream gate fires and the line lands anyway

Eight of the fourteen failures are `paths`, which is per-line, scoped, and therefore run at the edit moment on
the single file being written. Run #69's finding was
`_sandbox/sandbox/src/workspace/files/workspace-thumbnail.integration.test.ts:8`. Running the scoped check on
that one file today reproduces it exactly, and the check ends with:

> In the file just edited. Fix it here, or it is found on main by `nightly.yml`'s tidy job, where no turn can be
> sent back for it.

The file was created whole in `79360e0667` (2026-09-19 00:20), an agent commit whose subject is about something
else entirely ("window tiles and tree rows to render only what's visible"). The gate knew, said so in the right
file at the right moment, and the line reached main seven hours later.

What this proves is that the check is right and reachable. **What it does not prove is why the line landed** —
whether the turn gate was not run against that edit, ran and was not binding on the land, or ran and its verdict
was overridden. That is the one finding here that needs a look at the land path rather than at a check, and it
is left open below.

## Root cause 5: a gate nobody can act on teaches that red means nothing

The job's own comment records this about its first ten runs and prescribes the fix: move the refusal to where
there is an author. That was done for per-line rules and it worked for them. It was never done for the rule
that causes 13 of 14 failures, because that rule has no per-line form — and so the lesson the comment warns
about was taught anyway, for thirteen more nights.

## What changed

Applied in the commit carrying this document.

**1. The `paths` finding.** `workspace-thumbnail.integration.test.ts` now derives its cache directory from the
same state-table entry the module under test builds its own from (`stateRelPath(".intentic/local/cache/",
"thumbnails")`), so the two cannot drift and neither spells a root.

**2. `layout` stops counting index directories.** `INDEX_DIRS` in
[`layout.mjs`](../../_tools/checks/layout.mjs) names the three, each with the set it mirrors, and the fan-out
rule skips them. Named rather than numbered, so nothing has to be bumped when the product gains a surface. An
entry whose directory drops under the limit is reported for retirement; an entry whose directory is *gone* fails
the check, so a rename cannot leave an exemption standing over nothing. The three baseline numbers are deleted.

**3. Three feature directories split, by what the files do.** These are the ones where the rule's premise does
hold, so they are fixed rather than excused — and split with headroom rather than to 29, which is how they came
back last time.

| Directory | Before | Moved out | After |
| --- | --- | --- | --- |
| `_editor/web/src/features/agents/board` | 34 | `session/` (9), `cards/` (8) | 17 |
| `_editor/web/src/features/sandbox/devices` | 31 | `runners/` (6), `health/` (3) | 22 |
| `_editor/web/src/features/chat/models` | 31 | `run-settings/` (8), `host/` (4) | 19 |

Clusters were read off the intra-directory import graph, not guessed. `chat/models` was at 29 on `d17fcc965`
and 31 by the time this was written: tomorrow night's failure was already in the tree, in a commit nobody had
pushed yet.

**It happened again while this was being written.** Two commits landed on the branch mid-audit —
`be4e7c732` and `3f78d1fde` — and the first took `sandbox-contract/src/schemas` from 43 files to 44. Under the
old rule that is tonight's red, for the eighth time, one file over a number somebody recorded eleven days ago.
Under `INDEX_DIRS` nothing happened and nobody had to be told. That is the whole difference the change is for,
observed rather than argued.

**4. The push refuses what the push adds.** [`verify-push.mjs`](../../_tools/scripts/verify/verify-push.mjs) no
longer runs `--tidy=warn` and walks away. It takes the checks' verdicts as data, refuses every `code` failure as
before, and for `tidy` failures snapshots the merge-base the push departs from, runs the same checks there, and
refuses only the findings the range ADDED. What was already standing is named and charged to nobody, which is
the distinction the turn gate already draws and the reason it is safe to refuse here at all.

The snapshot machinery moved out of `verify-turn.mjs` into
[`check-snapshot.mjs`](../../_tools/scripts/verify/check-snapshot.mjs) so both gates run the identical
comparison; `turn-findings.mjs` was already free of any assumption about which commit is the base, and its
helpers are named for that now (`judgeAgainstBase`, `blindAtBase`).

This is the structural fix. The push is the first tree that becomes main and the last one with somebody standing
next to it.

## Still open

**A. Why did the edit-moment gate not hold `79360e0667`?** Root cause 4 establishes that the check fires
correctly on that file today. Whether the turn gate ran, and whether a red turn verdict can be landed anyway, is
a question about the land path. Until it is answered, the per-line half of this job's failures is unexplained
and the push gate above is what catches them.

**B. `--write-baseline` launders.** `63aac5f126` wrote seven baseline entries in one commit — three raised, four
new — the morning after run #67, which is the signature of adopting every finding at once rather than recording
one. The flag's own comment calls it "the blunt instrument" and warns that running it from a worktree commits
every other conversation's drift; that is what it did. `--allow` exists for the legitimate one-at-a-time case.
Recommend removing `--write-baseline`, or refusing it outside the primary checkout.

**C. A tidy failure should name the commit.** The job prints an anchor; finding the commit behind it is a manual
`git log -S`. `ci-audit.mjs` already reads job logs on this runner, and the tidy job already has the checkout.
Attributing each finding to the commit that introduced it turns "somebody" into "that commit", which is the
difference between a report and an action.

**D. 30 is a cliff, not a budget.** A directory at 30 is fine and a directory at 31 stops a job. Whoever writes
the 31st file is not more at fault than whoever wrote the 30th, and the fix at that moment is always the same
arbitrary two-file move. Consider warning from 30 and refusing at some distance above it, so a directory has
room to be split deliberately instead of by whoever arrives first. The push gate makes this cheaper to try: a
refusal there is addressed to a person, so the threshold can be honest about what it wants.
