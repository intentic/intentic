# The development pipeline, end to end

> Every automated step between an agent's edit and a shipped release, read on 2026-09-08 at `b8f3bf2e3`.
> Numbers come from `/history/activity.jsonl` (7.7 days, 2026-08-31 to 2026-09-08), the daemon's turn
> diagnostics (200 turns, 7 days), the GitHub Actions API (the last 60 completed runs, the last 33 pushes to
> `main`), `git log` (30 days), and the scripts run here. Sibling of [ci-audit.md](ci-audit.md) (the shape
> of `.github/`), [ci-failure-audit.md](ci-failure-audit.md) (why runs go red) and the workspace's
> `harness-gates-audit.md` (the gates inside a turn, 2026-09-02). This one asks whether the chain is right as a
> whole: does each stage do a job no other stage does, and where does the owner's time go.

## Status

Applied on 2026-09-08, in the session that wrote this, with the owner keeping two things as they were: lands
stay uncommitted (finding 3's "land as a commit" is not done) and every push to main still cuts a release
(finding 6's train is not done).

- **The land verify** (finding 1, corrected below): the Land button now queues the same whole-repository
  `pnpm verify` the auto-land does (`agents/land/verify-landed.ts`, both doors).
- **The push gate** (finding 2): `tree-verdict.mjs` keeps the newest twenty verdicts, keyed by the working tree
  or a pushed commit's tree; `verify-push.mjs` replays one and otherwise leaves the suite to CI, saying so.
  `--suite` runs it. Tiers 1 and 2 are unchanged.
- **One image build per push** (finding 5): `images` and `images-arm64` wait for the release call and run only
  when it released nothing; `release-images.sh` moves `latest` and `core-latest` onto the released halves.
- **The fix agents** (findings 7 and 8): `pipeline-fix` and `pre-push-fix` open on Claude, then Codex, then
  Gemini; a run role steps over a provider whose last three turns died (`agent/models/role-model-health.ts`);
  `POST /ci/fix` refuses a run whose every failure is a runner-owned step, naming the step, unless forced
  (`@intentic/constants/ci-infra-steps`, shared with `ci-audit.mjs`).
- **`verify-ui-edits`** (finding 9): rules take `when.sample`; this one fires on a quarter of turns, and every
  follow-up now records what the model did with it (`rule.followup_outcome`: edits, looks, commands).
- **The scoreboard** (finding 12): `pnpm sdlc:scoreboard`, one row per day over the daemon's records, the git log
  and the CI API.
- **The Stop for every runtime** (finding 11): the daemon runs the `turn.ending` command rules after a turn on a
  runtime with no Stop hook, records the verdict for the land decision, and sends the findings as the follow-up
  turn; the end-of-turn note reaches every runtime.
- **The remote cache** (finding 4): `remoteCache.enabled` on, the three variables handed to every job,
  `_tools/turbo-cache` as the server to run on the fleet host. Inert until the owner sets them.

**Finding 1 was half wrong, and the scoreboard shows which half.** The install failures were 4, 55, 143, 16 and 1 on
2026-08-31 through 2026-09-05 and none since: the 2026-09-02 reconciler fix worked, and the "28 a day" was that
storm averaged over the week. What kept the land verify to a dozen runs was the other half: the Land button, which
most lands go through since no `agent.finished` rule allows auto-landing, never queued it. That is the part fixed
here.

## Verdict

Every stage on its own is well built. The checks registry, the turn check scoped to the affected closure, the fork
boundary, the supply chain posture and the verify split by release group are each better than most teams ship, and each
carries the incident that justified it. The chain they form is not designed as a chain. Three things about
it cost more than any single gate:

1. **The stage the design leans on is mostly not running.** The whole-repository `pnpm verify` after a land
   only runs when a land triggers a dependency install and that install ends `ready`. 219 of 224 installs in
   7.7 days ended "still stale: checks not run". The land verify ran 12 times against roughly 400 lands, and 7
   of the 12 were red. So the push gate, meant to replay a land verdict in seconds, runs the full suite on
   the owner's clock nearly every time, and the reader that sees a whole tree first is CI, an hour later.
2. **Every gate after the turn measures the union of 42 worktrees.** Lands arrive as uncommitted changes in
   one shared working tree. The push gate hashes that tree, so a verdict is stale the moment anyone lands.
   A refusal at the push names nobody, and the fix is a `fix: lock` or `fix: ci` commit by the owner: 29
   lockfile fix commits and 14 `fix: ci` commits in 30 days. The push gate refused 73 attempts in the week
   that saw about 50 pushes reach GitHub.
3. **The same work runs several times by policy rather than once by cache.** Typecheck and tests run at the
   Stop (closure), at the push (whole repo), and in CI (three overlapping groups). A releasing push builds
   the sandbox image twice, in parallel, on the same fleet: `images` and `release / images-amd64` each took
   45.7 minutes in the last green run, and their arm64 twins 6 minutes each. That is 52 of the run's 181
   job-minutes spent producing bytes the other job also produced.

The road is bumpy because the middle of it is missing and the two ends are each compensating for that. Fix
the middle and the ends get cheap.

## The chain as it runs

| Moment | Runs | Scope | Cost | In 7.7 days |
|---|---|---|---|---|
| Per edit (Claude only) | `lint-edit.mjs`, `bytes-edit.mjs`, lsp diagnostics | the file | under 3 s | silent when clean |
| Stop, `pnpm verify:turn` | 27 checks, lint on changed files, emit, `turbo typecheck test` on the affected closure | turn's diff | 1 s + 1 s + 2 to 15 min, queued 2 at a time | 193 turns sent back, 45 held |
| Stop, built-ins | `verify-ui-edits` (a model turn plus a browser), `verify-removals`, `verify-tests` | turn's diff | a model turn | 109 and 19 sent back |
| Land | `pnpm verify` (whole repo), only after an install that ends `ready` | main tree | 2.5 to 15 min | ran 12 times, 7 red |
| Commit | commitlint | the message | ms | quiet |
| Push (app rule, then git hook) | checks, assertion ratchet, lockstep, lint, `cargo fmt`, then typecheck + build + test unless a fresh verdict exists | the working tree | seconds, then 2.5 to 15 min | 73 refused, ~50 passed |
| CI on `main` | preflight, 3 verify groups, providers, migrations, desktop, images, release | the commit | median 66 min wall, 181 job-min | 5 green of 24 completed |
| After CI | `pipeline-fix` and `pre-push-fix` chores spawn a fix conversation | the failure | a model turn | 33 turns, 7 timed out |

The repository these run on: 92 workspace packages, 1,329 test files (329 integration), 1,602 commits in 30
days from one owner plus agents, 5 merge commits, 77 release tags. 43 worktrees are checked out right now.

## Where the time and the refusals go

**At the push.** 73 `rule.blocked_push` events in 7.7 days against 33 pushes that reached GitHub in the
last 5 days (6.6 a day). Even allowing for the app's check and the git hook logging one attempt twice, the
gate refuses roughly as often as it passes. The 2026-09-02 audit counted 65 refusals in 20 days. The rate
has tripled since.

**In CI.** Of the last 33 pushes to `main`: 19 red, 5 green, 8 cancelled, 1 running. Median wall clock 66
minutes, p90 82, one run at 614. The 2026-09-02 audit reported 19 red per hundred. Most of the new red is
not code: 6 of the 17 failed runs in the last 60 died in `Set up job` (the fleet was down), one died in
`pnpm-setup` across all 8 jobs, and 9 failures were nightly tiers. `ci-audit.mjs` puts 61% of job failures
in jobs no local gate can reach.

**In the turn.** 321 continuations across 868 turns. `verify-turn` accounts for 193, `verify-ui-edits` for
109. Of 128 turns that edited files in the last 7 days, 59 (46%) ended `unproven`: nothing checked the
work, mostly because the runtime was not Claude Code or the turn died on a rate limit.

**In the owner's commits.** 209 of 1,602 commits have subjects of 15 characters or fewer. `fix: lock` 15,
`fix: ci` 14, `fix: pnpm-lock` 7, `fix: test`/`fix: tests` 12, `fix: pnpm` 5. 28 commits change only
`pnpm-lock.yaml`. 15 touch `_tools/checks/baselines/`. These are the cost of gates that fire on state no
single change produced.

**In fleet minutes.** One green releasing run: 181 job-minutes for 73 minutes of wall clock. The critical
path is `plan` (1 min), `images-amd64` (46 min), `publish` (19 min). The verify groups that the push gate
duplicates locally take 4.5 to 6.9 minutes each.

## Findings

### 1. The land verify is chained behind the dependency reconciler, which is failing 28 times a day

`main.ts` calls `queueVerify` only from `services.dependencies.subscribe`, the coordinator's "install this
project" event. `verify-deps.ts` then runs the check only if `workspaceSetup` reports the project `ready`
after the install. Two consequences:

- A land that leaves the installed tree current (most lands) does not trigger a check of the whole repository at
  all. "Every land queues `pnpm verify`" (AGENTS.md, the 2026-09-02 audit) describes the intent, not the
  wiring.
- When a land does trigger an install, the reconciler reports the project still stale 219 times out of 224,
  and the check is skipped with "checks not run". This is the same message, at the same rate, that the
  2026-09-02 audit listed as its fifth finding and asked to be root-caused. It has not been.

The result is 12 whole repository verdicts in a week, 5 green. Everything downstream was designed on the
assumption that this verdict exists and is usually green: the push gate replays it, CI is meant to confirm
it, the `ci-fix` chore is meant to be rare.

Do: treat the reconciler as the first bug. Find why `workspaceSetup` reads the project as unready after a
completed install (its readiness probe against what pnpm wrote), and stop an install from re-running when
its predecessor ended the same way within the hour. Then decouple the verify from the install: queue it
from the land itself, coalesced per tree, and run the install only when the manifest or lockfile changed.

### 2. The push gate does the land's job, on the owner's clock

`verify-push.mjs` is written to replay a `verify` verdict and run only the build. With finding 1, a fresh
verdict almost never exists, so tier 3 runs typecheck, build and test on the working tree, 2.5 to 15
minutes, while the owner waits. The pre-push-fix chore then spawns a conversation to fix whatever it found.

Two properties make the replay rarer still. The verdict is keyed by a hash of the whole working tree,
including uncommitted files, so any land between the verify and the push invalidates it. And the verdict
file holds one entry: a `push` verdict overwrites the `verify` verdict, and the next `verify` overwrites
that.

Do, once finding 1 is fixed: bind the verdict to the tree being pushed (the commit's tree, or the working
tree at commit time), keep the last several verdicts rather than one, and let tier 3 fall back to CI when no
verdict exists rather than blocking. Tiers 1 and 2 (seconds) stay as they are. If a red push must not reach
`main`, that is what branch protection or a merge queue is for, and neither costs the owner 15 minutes.

### 3. Gates measure the union of every conversation's work

42 agent worktrees land into one working tree. The owner commits that tree in batches (about 7.5 commits
per push) and pushes. From the land onward, every gate measures everyone's changes at once:

- A `tidy` check goes red on a directory another conversation made one file too full. The 2026-09-02
  audit's answer was to stop tidy checks from refusing pushes, which was right, and it also means those
  rules are now enforced a day later by a nightly job and a chore.
- The lockstep check refuses a push because the reconciler rewrote `pnpm-lock.yaml` under a
  `package.json` someone else committed. `verify-push.mjs` carries a special case for the one block pnpm
  rewrites on every command.
- A test another turn broke fails the push. `verify:turn` can attribute a failure to HEAD, the push gate
  attributes nothing.

The daemon already does most of a merge queue's work at the land: it rebases the worktree, reconciles the
lockfile, and (in intent) verifies the tree. What it does not do is commit. Making each land a commit, with
the message the `commit-message` model role already writes, would give every later gate a unit to name,
make the push verdict replayable (the working tree equals HEAD between lands), and turn the owner's job from
integrator into reviewer. Whether the owner reviews before or after the commit is a product decision. The
uncommitted delta as the review surface can stay: land as a commit on the conversation's own branch, and let
the owner's "accept" fast-forward `main`.

### 4. One suite, four runs, three trees

Typecheck and tests run at the Stop on the closure, at the push on the whole working tree, and in CI as
three groups whose closures overlap on every shared package. `emit-declarations.mjs` compiles every
emitting package's dist at the Stop, again at the push, again in CI's `pnpm prepass`, and `turbo run
build` then builds the same packages once more. The Stop and the push run in the sandbox against
`/history/gits/.turbo`, CI against `/ci-cache/turbo`, and the two caches do not meet (`remoteCache.enabled:
false`).

Turbo hashes inputs, so a task the sandbox already ran on the same inputs is a cache replay in CI if the
cache is shared. A self-hosted remote cache on the fleet host, written by CI and read by both, makes CI's
verify groups a replay of seconds for trees the land already measured, and the push gate's tier 3 a replay. The
repository's own supply-chain argument applies in one direction: an artifact written by a sandbox agent and
read by the release job is the poisoned-cache path `ci.yml` warns about. CI-writes, sandbox-reads has no
such edge and still removes the duplicate compile at every push.

### 5. Every releasing push builds the sandbox image twice

Run 34000187045 (green, 2026-09-06): `images` 45.7 min and `release / images-amd64` 45.7 min, started
within a minute of each other, on the same fleet, from the same commit. `images-arm64` and `release /
sandbox-arm64` did the same on hosted arm runners. The comment in `ci.yml` says "the version-tagged image
is the release job's", which is the intent. The desktop jobs already avoid exactly this duplication by
skipping when `needs.release.outputs.version` is set. The image jobs can only read that output after the whole
release call finishes.

Do: move `release-plan.mjs` into `ci.yml` as its own one-minute job that both `images*` and `release`
need. `images*` run when the plan says no release, `release` builds the version-stamped image when it says
one. Same coverage, one build per push, one runner slot back in a six-slot wave whose widest tier is six.

The 46 minutes themselves are the critical path of every release and worth a profile of their own:
`prepare-image-trees.sh` (a cached turbo build plus `pnpm deploy` prunes), a buildx build with registry
cache, a push of about 1.5 GB, and a boot smoke. The 2026-08 audit measured the prune at 1m26s. Where the
other 40 minutes go is not written down anywhere.

### 6. Every push is a release candidate

semantic-release runs on every push to `main`. 77 tags in 30 days, 2.6 a day. Each one is a 20-minute
Linux desktop build, a Windows cross-build and install cycle on the single Windows machine, the image
build, and a 19-minute publish. On 2026-09-08 three pushes arrived at 11:28, 11:34 and 11:48, each started
a full pipeline, and all three were cancelled at 67 to 70 minutes. On 2026-09-07 one run took 254 minutes.

`stable` only moves on green, so users are protected. The cost is elsewhere: a red `main` blocks the next
release until fixed, so every code red becomes a release incident and spawns a `ci-fix` conversation, and
the fleet spends its day on release artifacts for commits that will be superseded within the hour.

A release train (at most one release every N hours, or on a manual dispatch, from the newest green
commit) keeps continuous `latest` images and per-push verification and removes the release build from
most pipelines. Median push gap is 84 minutes, so a 3-hour train would cut release builds by about two
thirds. This is a product decision as much as a pipeline one.

### 7. Most CI red is the fleet, and the fixers are spawned for it anyway

The fleet is one Linux host with six runner processes and one Windows machine. When the host is down,
every push is red at `Set up job`, and `pipeline-fix` starts a conversation to fix code that is fine.
`ci-audit.mjs` already classifies `Set up job` and its siblings as `infra`. The chore does not read that
classification.

Do: have the chore skip infra failures and raise a fleet alert instead, and add a heartbeat on the runner
processes. Consider a GitHub-hosted fallback for the three verify groups (cold, they would take 10 to 15
minutes) so a fleet outage degrades to slow rather than red.

### 8. The fix agents run first on the provider that times out

`pipeline-fix` and `pre-push-fix` list Gemini first. Of the fix agents' 33 turns in 7 days, 7 ended "Google turn
timed out waiting for OpenCode" and 4 were cancelled by hand. A fixer that fails adds a red conversation to
a red pipeline. Put a provider that completes first, or gate the role on the provider's recent success rate,
which the turn diagnostics already record.

### 9. `verify-ui-edits` is the second largest source of continuations and still unmeasured

109 continuations in 7.7 days, each a model turn plus a browser session. The 2026-09-02 audit asked for
two weeks of recording whether the second look changed anything. Nothing records it. Until it does, sample
it (one turn in five) or turn it off.

### 10. The lockfile is the single most repeated manual repair

29 lockfile fix commits and 28 commits that change only the lockfile in 30 days, after `lockfile-reconcile.ts` landed. The
remaining writers are the reconciler's installs in the main tree (the `packageManagerDependencies` block
that `verify-push.mjs` special-cases) and Renovate's automerged bumps landing while the local `main` holds
other lockfile edits. Check whether pnpm's `managePackageManagerVersions` setting stops the block rewrite,
make the land the only writer of the lockfile, and treat the fix-commit count as the metric to drive to
zero.

### 11. A third of turns have no in-turn gate

The per-edit hooks and the Stop check run on Claude Code turns. Cursor, Gemini, Kimi and Codex ran 263 of
868 turns and get their first reader at the land (which, per finding 1, is mostly the push). This was the
first finding of the 2026-09-02 audit and is unchanged. The `unproven` count (59 of 128 editing turns) is
its measurement.

### 12. The numbers moved between audits and nothing said so

The three prior audits each computed their figures by hand for one day. Between 2026-09-02 and 2026-09-08
the CI green rate on `main` went from about 80% to about 20%, the push refusal rate tripled, and the land
verify all but stopped running. None of that was visible without recomputing. `ci-audit.mjs` runs nightly
and covers CI. A second script over `activity.jsonl` and the turn diagnostics, run beside it, would put the
whole chain on one page: pushes attempted and refused, lands and land verdicts, CI green rate and wall
clock, releases, fix commits, unproven turns. Each of the findings above is a line on that page.

## What to keep

- `_tools/checks/`: one manifest, 27 checks, 1.1 s, no install, the `code`/`tidy` split and the ratchet
  rule. This is the model for every other gate.
- `verify-turn.mjs`: closure scoping, attribution against HEAD, every reader reports before the digest.
- The fork boundary, digest-pinned actions, actionlint and zizmor in preflight, provenance end to end,
  CodeQL and Scorecard off the fleet.
- Three verify groups as reusable-workflow calls, per-job cargo target directories, the bind-mounted
  `/ci-cache`, the per-SHA concurrency group.
- The migrations job, the image boot smoke, the sign-in smoke after a platform roll.
- `ci-audit.mjs` and the incident-attached comments in the workflow files.
- The assertion ratchet, commitlint, the lockfile reconcile at land.

## Target shape

| Moment | Runs | Scope | Budget | On red |
|---|---|---|---|---|
| Per edit, any runtime | lint, bytes, diagnostics | files the call wrote | under 3 s | told in the tool result |
| Stop, any runtime | checks, lint, closure typecheck and test | turn's diff | under 3 min | one follow-up, then hold |
| Land | rebase, lockfile, closure check, commit | the land, as a commit | minutes, off the model's clock | hold the branch, seed a fix turn |
| Push | tiers 1 and 2, replay the land verdict by commit tree | the commits | seconds | refuse |
| CI | preflight, verify groups off a shared turbo cache, images once, release on a train | the commit | verify in minutes, release on schedule | fix chore for code, alert for fleet |

## Order of work

1. Root-cause `deps.install_failed` and decouple the land verify from the install (finding 1). Medium
   effort, and everything below depends on the land verdict existing.
2. Reorder or gate the fix agents' model roles (finding 8) and skip infra failures in `pipeline-fix` (finding
   7). Small.
3. Hoist `plan` into `ci.yml` and run the image build once per push (finding 5). Small, saves 52
   job-minutes and a runner slot per release.
4. Sample or disable `verify-ui-edits` until its outcome is recorded (finding 9). Trivial.
5. The scoreboard script (finding 12). Small, and it decides what comes after.
6. Verdicts keyed by commit tree, several kept, push tier 3 non-blocking when no verdict exists (finding
   2). Medium.
7. Land as a commit (finding 3). Large, and the one that changes how the owner works. Decide it with the
   scoreboard's first two weeks in hand.
8. Shared turbo remote cache, CI-writes and sandbox-reads (finding 4). Medium, mostly configuration.
9. Release train (finding 6). Small to build, a product decision to make.
10. Runtime-agnostic per-edit and Stop hooks (finding 11). Large, and already specified in the 2026-09-02
    audit.
