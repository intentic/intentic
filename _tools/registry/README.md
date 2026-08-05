# @intentic/registry-scan

The nightly job behind the [extension registry](seed/README.md). Published to npm because it runs from a
GitHub Action inside a public repository this monorepo does not contain — `npx --yes @intentic/registry-scan`
is the whole install step there.

The file format it reads and writes lives in [`@intentic/registry`](../../_libs/registry), which the daemon
and the site's gallery use too, so all three agree by construction rather than by three copies of a zod
schema staying in step.

## What it does, and what it refuses to do

Scanning GitHub for a topic is **discovery**. Merging a pull request is the **decision**. Keeping those apart
is the entire design: a topic is a public namespace anybody can join, so a job that listed what it found
would publish the first malicious repository to tag itself — and the alternative, a submission form on the
site, is a login, a spam queue and an admin panel standing in for a git commit.

So each run:

1. Searches `topic:intentic-extension`.
2. Refreshes stars and last-push for **already-listed** entries into `registry.generated.json`, including the
   listings the topic search never returned (a listing that arrived by pull request has no obligation to
   carry the topic, and dropping its stars for that would rank it below newcomers for no reason).
3. For each **unlisted** repo whose `intentic-extension.json` parses, materialises a proposal: a complete
   candidate `marketplace.json` with one entry added, plus the pull request's title and body.
4. Emits warnings for everything it skipped, into the job summary.

It never lists, delists, or changes a trust level. A repository that went briefly private should come back to
its listing, not to a deletion.

The one rule it enforces by itself is identity. The listing key is `publisher.name` read from the manifest —
[`extensionIdOf`](../../_libs/extension-api/src/manifest.ts) — so a repository that copies somebody else's
manifest collides with their existing listing and is refused here rather than arriving as a pull request that
looks legitimate.

## Layout

| Path | What it is |
| --- | --- |
| [src/scan.ts](src/scan.ts) | The decision logic, pure and fully unit-tested against a fake reader. |
| [src/github.ts](src/github.ts) | The four REST reads, behind an interface so the above needs no network. |
| [src/cli.ts](src/cli.ts) | The IO: read the checkout, write the facts file and the proposal directories. |
| [seed/](seed) | What the registry repository itself contains — the curated file, the author-facing README, and the workflow that calls this. |

`seed/` is a starting point, not a synced copy: push it once to create the registry repository, then it lives
its own life over there. The one coupling that matters is the workflow's `npx` line, which is why this
package is published.

## Running it against a checkout

```sh
GITHUB_TOKEN=… REGISTRY_DIR=/path/to/registry-checkout node dist/cli.js
```

`SCANNED_AT` overrides the timestamp so a re-run against a fixed input produces a fixed output. A token is
required — the search and contents endpoints are rate-limited to approximately nothing without one.

## Key files

- [src/scan.ts](src/scan.ts) — finding extensions and resolving each to a sha.
- [src/github.ts](src/github.ts) — the API half.
- [src/outputs.ts](src/outputs.ts) — what the job writes.
- [src/cli.ts](src/cli.ts) — the entry point the nightly job runs.
