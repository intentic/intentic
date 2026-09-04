# The maintainer scripts

Everything this repository runs *around* the code: what gates a push, what builds an artifact, what publishes
one, and what stands a machine up to check it afterwards. Nothing here is product, and nothing here is a
workspace package — these are commands, run by CI, by a git hook, by semantic-release, or by a person.

## Responsibilities

- Give every runnable script exactly one home, named for **who it serves** rather than what it is written in.
- Keep the shared decisions in [lib/](lib), sourced and never executed, so a rule this repository makes lives
  in one file instead of six copies that drift.
- Stay runnable by hand. Every script here is a command someone can type; the ones that need a credential say
  so and stand down without one, rather than failing halfway.

## The families

A script's directory is what it is FOR. That is not filing: `_tools/scripts/verify/affected.mjs` derives CI's
`desktop`, `images` and `platform` triggers from these directory names, so moving a script between them changes
which jobs a push starts — and it asserts each one exists rather than silently matching nothing.

### [lib/](lib) — sourced, never run

| | |
|---|---|
| [repo-root.sh](lib/repo-root.sh) | the monorepo root, **found** rather than counted (`repo_root`) |
| [packages.sh](lib/packages.sh) | `PUB` / `VERSIONED`: the first-party release set, in topological order |
| [github.sh](lib/github.sh) | the GitHub REST calls a release makes: releases, assets, `make_latest`, the `stable` tag |
| [registry-retry.sh](lib/registry-retry.sh) | which failed **image push** is worth a second attempt, and which must fail at once |
| [npm-publish-retry.sh](lib/npm-publish-retry.sh) | the same judgment for an **npm publish** the transparency log dropped |
| [desktop-artifacts.sh](lib/desktop-artifacts.sh) | what a desktop artifact is CALLED, for everything that builds, verifies or ships one |
| [dind-host.sh](lib/dind-host.sh) | a clean Docker-in-Docker host to run a user's setup on (`start_dind_host`, `in_host`) |
| [git.mjs](lib/git.mjs) | `git`, `changedPaths`, `isLinkedWorktree` — one spawn wrapper with the buffer a release range needs |
| [steps.mjs](lib/steps.mjs) | the step runner the three verify tiers share: every reader speaks, then one digest |
| [tree-verdict.mjs](lib/tree-verdict.mjs) | one measurement per tree, keyed by content, shared across checkouts |

### [verify/](verify) — the gates

| | |
|---|---|
| [verify.mjs](verify/verify.mjs) | `pnpm verify`: the whole repository, after every land, off every model's clock |
| [verify-turn.mjs](verify/verify-turn.mjs) | `pnpm verify:turn`: the affected closure, when a turn tries to end |
| [verify-push.mjs](verify/verify-push.mjs) | `pnpm verify:push` and the pre-push hook: what CI would say, said before the push leaves |
| [affected.mjs](verify/affected.mjs) | which parts of the repo a push touched — CI's `changes` job, walked off the package graph |
| [assertion-ratchet.mjs](verify/assertion-ratchet.mjs) | a test file may get stronger by itself and weaker only on purpose |
| [check-migrations.sh](verify/check-migrations.sh) | applied migrations are immutable, new ones can run on a database that has rows |
| [lint-workflows.sh](verify/lint-workflows.sh) | actionlint + zizmor over `.github`, at pinned bytes |

The checkout-only gates are next door, in [`_tools/checks`](../checks), listed once in its manifest and run by
all three tiers above.

### [build/](build) — compile an artifact

| | |
|---|---|
| [emit-declarations.mjs](build/emit-declarations.mjs) | every emitted package's `dist`, with `tsgo -b`, so tests and typecheck read something current |
| [clean-outputs.mjs](build/clean-outputs.mjs) | the only way this repo may throw away a `dist`, a `generated` or a `node_modules` |
| [build-ic.sh](build/build-ic.sh) | the `ic` host CLI, cross-compiled for five targets |
| [build-agent-binaries.sh](build/build-agent-binaries.sh) | a machine-side agent, compiled to a single binary per target |
| [build-win-launcher.sh](build/build-win-launcher.sh) | the Windows launcher stub, and the PE-subsystem byte that makes it worth having |
| [sign-windows.sh](build/sign-windows.sh) | Authenticode, from Linux, for everything a user's PC downloads |

### [desktop/](desktop) — the installers

| | |
|---|---|
| [build-desktop.sh](desktop/build-desktop.sh) | every installer (deb / rpm / AppImage / NSIS) plus the updater manifest |
| [stage-desktop-scripts.sh](desktop/stage-desktop-scripts.sh) | the launcher scripts the bundlers pick up, taken from the COMMIT |
| [verify-desktop-bundle.sh](desktop/verify-desktop-bundle.sh) | what an installer actually contains — archive inspection, seconds, no Docker |
| [verify-desktop-install.sh](desktop/verify-desktop-install.sh) | install them on a clean machine and prove they run |
| [verify-desktop-setup.sh](desktop/verify-desktop-setup.sh) | the shipped `connect.sh` brings a sandbox up on a clean Docker host |
| [verify-desktop-update.sh](desktop/verify-desktop-update.sh) | the app moves itself onto a published release, signature and all |

### [image/](image) — the sandbox images

| | |
|---|---|
| [prepare-image-trees.sh](image/prepare-image-trees.sh) | the payload, compiled and pruned OUTSIDE Docker |
| [compose-image-dockerfile.mjs](image/compose-image-dockerfile.mjs) | the core Dockerfile with a profile's feature packs spliced in |
| [publish-images.sh](image/publish-images.sh) | build + push, per arch, per profile, to every registry |
| [merge-image-manifests.sh](image/merge-image-manifests.sh) | stitch the two per-arch halves into one multi-arch tag |
| [promote-image-tag.sh](image/promote-image-tag.sh) | point a tag at an image that is already published — no bytes moved |
| [smoke-image.sh](image/smoke-image.sh) | boot the image that is about to ship and make it prove it is alive |
| [verify-images-public.mjs](image/verify-images-public.mjs) | the one check that runs logged OUT: a user can pull these |
| [verify-update-survival.sh](image/verify-update-survival.sh) | update, rollback, and a failed update all keep the user's files |

### [platform/](platform) — the hosted API and web

| | |
|---|---|
| [docker-release.sh](platform/docker-release.sh) | each app's `docker:release` task, with a content-addressed skip |
| [deploy-platform.sh](platform/deploy-platform.sh) | roll the Komodo stack, and WAIT for it to come back healthy |

### [release/](release) — cutting one

Ordered the way a release runs them:

| | |
|---|---|
| [release-plan.mjs](release/release-plan.mjs) | the version, computed before anything is built |
| [set-versions.sh](release/set-versions.sh) | stamp it onto every first-party package (transient, CI-only) |
| [release-prepare.sh](release/release-prepare.sh) | semantic-release `prepareCmd`: assert every artifact exists and is the one that was verified |
| [publish-github.sh](release/publish-github.sh) | the GitHub Release, its notes, and every installer attached to it |
| [release-images.sh](release/release-images.sh) | the version and `stable` image tags — pure manifest work |
| [ship-stable.sh](release/ship-stable.sh) | the last step: the `stable` tag and the `latest` flag the whole world follows |
| [mark-release-cut.sh](release/mark-release-cut.sh) | record that a release ACTUALLY happened, for the steps that publish what it cut |
| [dispatch-publish.sh](release/dispatch-publish.sh) | start the publish workflows a tag push can never start |
| [publish-npm.sh](release/publish-npm.sh) | the npm closure, with provenance — and `--interactive` for a maintainer repairing one |
| [publish-action.sh](release/publish-action.sh) | sync the built GitHub Action to its own public repository |
| [publish-webstore.mjs](release/publish-webstore.mjs) | upload and submit the browser extension |
| [attach-provenance.sh](release/attach-provenance.sh) | the build-provenance bundle, as a Release asset |
| [post-release-discord.mjs](release/post-release-discord.mjs) | announce it, but only when a user would notice |
| [rollback-stable.sh](release/rollback-stable.sh) | un-ship one: put `stable` back where it was, in one command |
| [discord-community-setup.mjs](release/discord-community-setup.mjs) | one-time: the channel and webhook the announcement posts through |

### [ci/](ci) — the machines and the pipeline itself

| | |
|---|---|
| [githooks.mjs](ci/githooks.mjs) | point git at `.githooks`, on every install, on every platform |
| [ci-audit.mjs](ci/ci-audit.mjs) | which gate to build next: the failing steps of the last N runs, grouped and counted |
| [install-provider-clis.sh](ci/install-provider-clis.sh) | the provider CLIs the conformance tier drives, at the versions the packs pin |
| [mobile-android-sdk.sh](ci/mobile-android-sdk.sh) | hand Bubblewrap an Android SDK it will accept |
| [setup-windows-runner.ps1](ci/setup-windows-runner.ps1) | provision the Windows runner — the one thing the pipeline cannot do for itself |
| [setup-wsl-fleet.ps1](ci/setup-wsl-fleet.ps1) | make the Linux fleet come back on its own after a reboot |

## How it fits

Four things run these, and each reaches a different subset:

- **the git hook and the app's push rule** → `verify/verify-push.mjs`, which runs the checks, the ratchet and
  the suite;
- **the daemon**, after every land → `verify/verify.mjs`, and at every turn's end → `verify/verify-turn.mjs`;
- **`.github/workflows`** → most of `build/`, `desktop/`, `image/`, `platform/` and `ci/`, plus
  `verify/affected.mjs` as the DAG root that decides which of them run at all;
- **semantic-release** (`.releaserc.json`) → `release/`, in the order the table above lists.

Two rules hold the directory together. A shared decision goes in `lib/` and is sourced, never copied — the
GitHub API calls, the retry judgments, the artifact names and the repo root were each spelled five or six
times before that was true. And anything a script asserts about the world gets a detector that FAILS rather
than one that skips: `affected.mjs` checks the directories its triggers name, `_tools/checks/publish-retry.mjs`
replays the failures the retry lists were written for, and `_tools/checks/release-headings.mjs` holds the
release-body headings in step across the writer and its three parsers.
