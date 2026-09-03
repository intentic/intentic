# Compatibility

What "breaking" means in this repository, in one place: for contributors, for CI, and for the site page that
says it to users ([intentic.dev/docs/updates](https://intentic.dev/docs/updates/)). The user-facing promises
are the contract; everything here is the machinery that keeps them true.

## The promises (the circle)

1. **The user's files are never touched by an update.** `/work` and `/history` survive update, rollback, and
   rebuild. Drilled nightly against real published images: `_tools/scripts/verify-update-survival.sh`.
2. **Updates are offered, never forced.** The update card (`/info`'s `latest`/`updateAvailable`) is
   non-blocking; nothing recreates a sandbox without the owner acting.
3. **The worst outcome of an update is the sandbox the user already had.** The recreate engine parks the old
   container, health-gates the new one, and restores on failure (`_sandbox/ic/src/sandbox/recreate.rs`);
   rollback stays one command. Also drilled nightly.
4. **Breaking changes arrive declared.** A change that removes or alters something users rely on lands as a
   `type!:` commit carrying a `Breaking-Note: <what stops working and what to do instead>` trailer. That
   sentence travels to the Release's `## Breaking changes` section, the changelog's Breaking badge, and the
   update card's warning: which withholds the update command until the user acknowledges it.
5. **A bad release can be un-shipped.** A release ships the moment its pipeline goes green: the `stable`
   images (`release-images.sh`) and the GitHub "latest" flag every download link follows (`ship-stable.sh`)
   move inside that same publish, so what CI proved is what users get. Putting stable back onto an earlier
   version is one command, `rollback-stable.sh` (the Rollback workflow); the rolled-back release stays
   published, so anything pinned to that exact version keeps working.

## The surfaces the promises cover

- **The wire contract**: every schema `@intentic/sandbox-contract` exports, snapshotted in its
  `contract.lock.json`. The lock regenerates with `pnpm --filter @intentic/sandbox-contract lock` and must be
  committed with the change (its test fails otherwise); the `contract-shrink` check (`_tools/checks/`) refuses a push whose lock **lost or
  changed** an existing surface with no declared break in the range, and prints the exact declaring commit to
  paste. Additions pass freely: every persisted reader parses loosely. Declarations normally never reach the
  push gate at all: the landing drafter detects a shrinking lock mechanically
  (`_sandbox/sandbox/src/git/contract-shrink.ts`) and forces the `!` marker and a `Breaking-Note:` into the
  drafted message the commit box files.
- **User-persisted state under `.intentic/`**: never read strictly, never migrated. An unreadable file falls
  back, is reported (`manifest-problems.ts`), and after a rollback is explained as "written by a newer
  intentic" via the forward-only stamp (`store/newest-run.ts`) rather than as damage. Per the repo's own rules:
  recognition, no migration logic.
- **The release-body headings**, `## Breaking changes` and `## What's new` are parsed, not prose: written by
  `publish-github.sh`, read back by the daemon's update card and the site's changelog. Prepass invariant 5
  keeps the three spellings in step.
- **Download links**: `releases/latest/download/*` and the site's links follow the GitHub "latest" flag,
  which only promotion moves. The agent installers resolve that same flag first — `releases/latest` redirects
  to `…/tag/vX.Y.Z` — and then fetch `releases/download/v<tag>/*`, so a part file can only ever be resumed
  against the release it started from. Both URL shapes are load-bearing, and the redirect is what joins them.

## What is deliberately outside the circle

UI layout, internal behavior, defaults for unset settings, the deploy engine's own config surface (the engine
is not the product: its runtime story is `guarded-update.ts`), and anything additive. Change these freely;
give them a `Release-Note:` when a user would notice.

## The moment of flip

Until real users exist, breaking freely is policy (see CLAUDE.md): but *declared* breaking, so the habit,
the tooling, and the user-facing warning path all exist on day one of the first real user.
