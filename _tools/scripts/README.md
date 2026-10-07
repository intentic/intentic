# scripts

Repo-wide maintainer scripts: the verify checks, builds, releases, image and platform publishing, and CI helpers, started from root `package.json` scripts, the commit-msg hook and workflows.

```mermaid
flowchart LR
    hand["by hand"] -->|"pnpm verify"| scripts(["_tools/scripts"])
    worktree["a worktree<br/>before its land"] -->|"fixers.mjs"| scripts
    turn["an isolated turn<br/>about to stop"] -->|"verify-turn.mjs"| scripts
    ci["CI workflows"] -->|"verify:push --base, in the quick job"| scripts
    semrel["semantic-release<br/>.releaserc.json"] --> scripts
    scripts --> out["GitHub Release · npm · images<br/>stores · platform deploy"]
```

- The machine fixers run on a conversation's own worktree before its land, so what they write rides that land:
  `node _tools/scripts/verify/fixers.mjs --worktree <dir> --paths a,b` (or `--paths-file <file>`, or `--since <rev>`)
  runs rustfmt on the touched crates, tightens the baselines the change beat, and rewrites the contract lock and the
  stored shapes when the change reached their sources. Each is idempotent. It prints `{"ran":[…],"wrote":[…]}` and
  exits 0. Nothing runs them on the main tree unasked.
- Three verify scripts, and none of them holds back a turn, a land, a commit or a push. `verify` measures the whole
  repository the way CI's verify groups do, when someone runs it by hand, and applies no fixer. `verify:push` is the
  push check: CI's `quick` job runs it on every push (`--base <sha>`, the commit the push is measured against), and by
  hand it measures the branch against its upstream. It runs the checks with a `tidy` finding counted only when the
  range added it, the assertion ratchet over the range's test files and the linter over the files it changed, and by
  hand also the manifest/lockfile lockstep and rustfmt on the crates it touched; it exits non-zero on a finding.
  `verify/verify-turn.mjs` is the turn check, this repository's `turn` entry in `.intentic/checks.json`: the sandbox runs
  it once as an isolated turn is about to stop and says what it printed back to the model. It runs every check the
  manifest lists on the working tree, files nobody has added to git yet included, and prints only what the change added
  against where HEAD left `main` (or `--base <sha>`), `code` checks judged that way too, so a failure main already
  carries is charged to no conversation, and neither is a finding that only followed its file to a new path (git's rename detection pairs them). It exits 1 on an added finding, and 0 when there is none or it cannot judge, a fault of its own included. The throwaway worktree it checks the base out in is taken back however the run ends; the next run sweeps the ones a killed run left.
  What a change brought in is read one way (`verify/measure-change.mjs`: oxlint's lines, and the checks judged against
  the change's base with its `Allow:` trailers, which excuse a tidy finding and never a code one).
- `verify` waits for the sandbox's heavy slot however it is started (`lib/heavy-slot.mjs`), and sizes its workers and
  task counts to the memory free when they start (`verify/test-workers.mjs`). Every bun test process, in `suites` and
  in the re-runs of failures alone, is held under a memory ceiling (`lib/memory-ceiling.mjs`) that kills and names a
  runaway suite. On the CI fleet `suites` takes its workers from the host's test memory pool instead
  (`lib/test-memory-pool.mjs`): one-GiB flock slots every job on the box draws from. A band of them is kept for the
  gate jobs, a job can be capped, and a big suite that finds the pool short waits a bounded time for room. On CI
  `suites` also ends a bun that reported every file and never exited (`lib/bun-progress.mjs`), keeping its verdict.
- `verify/changed-packages.mjs` names the packages whose own files a push changed, which CI's `quick` job
  typechecks. Unlike turbo's `[base...HEAD]`, a changed lockfile or root `package.json` does not make that every
  package.
- `verify/clock-suites.mjs` is CI's `verify-clocks`: the test files whose text touches dates, zones or crons, run in
  UTC+14 and UTC-11. `lib/seed-buildinfo.mjs` starts the web's vue-tsc from a sibling worktree's build info, and on the
  fleet from the last passing check's (`TSBUILDINFO_SHARE_DIR`).
- Every verify script runs each independent step and prints all failures in one digest at the end of its output (`lib/steps.mjs`).
- A release is semantic-release on `main`: `release-prepare.sh` checks the artifacts CI built, then `publish-github.sh`, `release-images.sh` and `ship-stable.sh`, which moves `stable` last. `rollback-stable.sh`, run from the manual `rollback.yml` workflow, moves it back and marks the release it left withdrawn (a pre-release whose notes open with `Withdrawn: <reason>`, which sandboxes running it are told).
- Versions are stamped in CI only (`release/set-versions.sh`); the repository keeps `0.0.0`. `lib/packages.sh` is the one list of published npm packages.

## Layout

| Directory | What lives there |
| --- | --- |
| [verify/](verify) | `verify`, `verify:push` and the turn check, the fixers, affected packages, failure units, re-runs of flaky and failing tests, test worker sizing |
| [release/](release) | semantic-release hooks, npm, GitHub, Microsoft Store and Chrome Web Store publishing, stable promotion and rollback |
| [build/](build) | cross-compiled binaries (`ic`, machine agents, Windows launcher), signing, declaration emit, output cleaning, `move-files.mjs` |
| [image/](image) | sandbox image trees and Dockerfile composition, image publish, smoke tests, multi-arch manifests, tag promotion |
| [platform/](platform) | api and web image release, the platform and ingress deploys |
| [db/](db) | the check `db:up` and `db:reset` run before migrating (`verify-target.mjs`): that `DATABASE_URL` reaches the compose service's own Postgres |
| [desktop/](desktop) | desktop installer builds and install/update checks, `try-onboarding.mjs` |
| [ci/](ci) | git hooks, runner setup, provider CLI installs, CI failure audit, SDLC scoreboard |
| [engines/](engines) | agent engine version pins and the bumper behind `engines.yml` |
| [lib/](lib) | shared shell and JS helpers: repo root, git, GitHub, registry retries, the publish set, gate steps |
| [fonts.mjs](fonts.mjs) | downloads the served webfonts and writes their `@font-face` rules |

## Commands

```sh
pnpm verify               # the whole repo, the way CI's verify groups measure it
pnpm verify:push          # the push check, the branch against its upstream; CI's quick job runs it with --base
pnpm build:sandbox        # a local sandbox image, intentic-sandbox:dev
pnpm try:onboarding       # rehearse the Windows onboarding from this branch
pnpm ci:audit             # group recent CI failures by step
```
