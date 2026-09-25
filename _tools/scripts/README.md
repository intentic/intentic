# scripts

Repo-wide maintainer scripts: the verify checks, builds, releases, image and platform publishing, and CI helpers, started from root `package.json` scripts, git hooks and workflows.

```mermaid
flowchart LR
    land["land on the main tree"] -->|"pnpm verify"| scripts(["_tools/scripts"])
    push["git push<br/>pre-push hook"] -->|"verify:push --advisory"| scripts
    hand["by hand"] -->|"pnpm verify:turn"| scripts
    ci["CI workflows"] --> scripts
    semrel["semantic-release<br/>.releaserc.json"] --> scripts
    scripts --> out["GitHub Release · npm · images<br/>stores · platform deploy"]
```

- Three verify scripts, and none of them holds back a land, a commit or a push. `verify` is the check work gets: the sandbox runs it on the main tree after every land, in the background. It first writes what a machine decides (`verify/fixers.mjs`: cargo fmt on the crates the land touched, each failing check's `fix`, and the contract lock when the land changed the contract), then runs the whole repo and records its verdict per tree (`lib/tree-verdict.mjs`). A red run's report names `verify/rerun-units.mjs`, which re-runs only the failing tests in another tree. `verify:push` runs the cheap tiers. From the pre-push hook (`--advisory`) it reports and exits 0. By hand it exits non-zero on a finding and replays the recorded verdict for the same tree, leaving an unmeasured tree to CI unless given `--suite`. `verify:turn` judges only what a branch touched against its main-line base (checks, lint on changed files, the assertion ratchet, and typecheck plus tests over the affected packages), and runs only when someone asks for it.
- Every verify script runs each independent step and prints all failures in one digest at the end of its output (`lib/steps.mjs`).
- A release is semantic-release on `main`: `release-prepare.sh` checks the artifacts CI built, then `publish-github.sh`, `release-images.sh` and `ship-stable.sh`, which moves `stable` last. `rollback-stable.sh`, run from the manual `rollback.yml` workflow, moves it back.
- Versions are stamped in CI only (`release/set-versions.sh`); the repository keeps `0.0.0`. `lib/packages.sh` is the one list of published npm packages.

## Layout

| Directory | What lives there |
| --- | --- |
| [verify/](verify) | `verify`, `verify:push` and `verify:turn`, the fixers, affected packages, failure units, re-runs of flaky and failing tests, test worker sizing |
| [release/](release) | semantic-release hooks, npm, GitHub, Microsoft Store and Chrome Web Store publishing, stable promotion and rollback |
| [build/](build) | cross-compiled binaries (`ic`, machine agents, Windows launcher), signing, declaration emit, output cleaning, `move-files.mjs` |
| [image/](image) | sandbox image trees and Dockerfile composition, image publish, smoke tests, multi-arch manifests, tag promotion |
| [platform/](platform) | api and web image release, the platform and ingress deploys |
| [desktop/](desktop) | desktop installer builds and install/update checks, `try-onboarding.mjs` |
| [ci/](ci) | git hooks, runner setup, provider CLI installs, CI failure audit, SDLC scoreboard |
| [engines/](engines) | agent engine version pins and the bumper behind `engines.yml` |
| [lib/](lib) | shared shell and JS helpers: repo root, git, GitHub, registry retries, the publish set, gate steps |
| [fonts.mjs](fonts.mjs) | downloads the served webfonts and writes their `@font-face` rules |

## Commands

```sh
pnpm verify               # the whole repo; the sandbox runs it after every land
pnpm verify:push          # the push check; the pre-push hook runs it with --advisory
pnpm verify:turn          # optional: what this branch touched since main
pnpm build:sandbox        # a local sandbox image, intentic-sandbox:dev
pnpm try:onboarding       # rehearse the Windows onboarding from this branch
pnpm ci:audit             # group recent CI failures by step
```
