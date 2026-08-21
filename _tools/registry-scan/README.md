# @intentic/registry-scan

The nightly job behind the [extension registry](seed/README.md). Published to npm because it runs from a
GitHub Actions inside a public repository this monorepo does not contain. The workflows invoke an exact npm
version from the `REGISTRY_SCAN_VERSION` repository variable; a moving package tag is not allowed inside the
admission boundary.

The file format it reads and writes lives in [`@intentic/registry`](../../_sandbox/registry), which the daemon
and the site's gallery use too, so all three agree by construction rather than by three copies of a zod
schema staying in step.

## What it does, and what it refuses to do

Scanning GitHub for a topic is **discovery**. Merging a pull request is the **decision**. Keeping those apart
is the entire design: a topic is a public namespace anybody can join, so a job that listed what it found
would publish the first malicious repository to tag itself: and the alternative, a submission form on the
site, is a login, a spam queue and an admin panel standing in for a git commit.

So each run:

1. Searches `topic:intentic-extension`.
2. Refreshes stars and last-push for **already-listed** entries into `registry.generated.json`, including the
   listings the topic search never returned (a listing that arrived by pull request has no obligation to
   carry the topic, and dropping its stars for that would rank it below newcomers for no reason).
3. For each **unlisted** repo, resolves the default branch to a commit first, then reads the manifest and bundle
   only at that sha. It proposes a complete candidate `marketplace.json` only when both parse/load there.
4. Emits warnings for everything it skipped, into the job summary.

It never lists, delists, or changes a trust level. A repository that went briefly private should come back to
its listing, not to a deletion.

Those are proposal checks, not admission. The protected `extension admission` workflow runs on each executable
source/review change and accepts one executable subject per pull request. `audit` refuses unpinned, unsafe-host,
or escaping-path targets. A disposable no-secrets job fetches the exact source and runs Trivy's
dependency, secret, and misconfiguration scanners. Only then does the intentic agent gate receive an adversarial
brief covering browser globals/egress, server/process credentials, agent hooks and MCP, bin shadowing,
image/environment fragments, dependencies, binaries and source-versus-dist. It treats repository content as
untrusted and forbids executing author code. Either automated check failing, blocking, or remaining unjudged
fails admission.

A pass runs `attest`, which records both run identities against the exact repository, sha and subdirectory. That
push changes the PR head, so branch protection evaluates both checks again on the attested commit. Unchanged
metadata may reuse evidence for the same immutable subject; a changed repository, sha or path, unblocking, or an
edit to the record reruns admission. After a policy or scanner upgrade, untouched stale rows remain disabled by
the official registry resolver; touching one schedules just that source, so the catalogue can be refreshed one
pull request at a time. The privileged jobs fetch only the candidate marketplace JSON; exact source is checked
out solely on the disposable deterministic runner and is never executed.

Identity is also enforced mechanically. The listing key is `publisher.name` read from the manifest:
[`extensionIdOf`](../../_sandbox/extension-api/src/manifest.ts): so a repository that copies somebody else's
manifest collides with their existing listing and is refused here rather than arriving as a pull request that
looks legitimate.

## Layout

| Path | What it is |
| --- | --- |
| [src/scan.ts](src/scan.ts) | The decision logic, pure and fully unit-tested against a fake reader. |
| [src/audit.ts](src/audit.ts) | Diff-to-check policy and source-bound attestation. |
| [src/github.ts](src/github.ts) | The four REST reads, behind an interface so the above needs no network. |
| [src/cli.ts](src/cli.ts) | The IO: read the checkout, write the facts file and the proposal directories. |
| [seed/](seed) | What the registry repository itself contains: the curated file, the author-facing README, and the workflow that calls this. |

`seed/` is a starting point, not a synced copy: push it once to create the registry repository, then it lives
its own life over there. The one coupling that matters is the workflow's `npx` line, which is why this
package is published.

## Running it against a checkout

```sh
GITHUB_TOKEN=… REGISTRY_DIR=/path/to/registry-checkout node dist/cli.js
node dist/cli.js audit --base /path/to/base.json --candidate /path/to/candidate.json
node dist/cli.js attest --base /path/to/base.json --candidate /path/to/candidate.json --run-id GATE_RUN --scan-run-id WORKFLOW_RUN
```

`SCANNED_AT` overrides the timestamp so a re-run against a fixed input produces a fixed output. A token is
required: the search and contents endpoints are rate-limited to approximately nothing without one.

## Key files

- [src/scan.ts](src/scan.ts): finding extensions and resolving each to a sha.
- [src/audit.ts](src/audit.ts): identifying executable changes and preparing the intentic gate.
- [src/github.ts](src/github.ts): the API half.
- [src/outputs.ts](src/outputs.ts): what the job writes.
- [src/cli.ts](src/cli.ts): the entry point the nightly job runs.
