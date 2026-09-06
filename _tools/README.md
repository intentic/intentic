# Plumbing

Shared config and test harnesses, plus repo-wide maintainer scripts and non-package seeds for external repos.
Nothing here is product; a package lives here when every group needs it (`tsconfig`, `constants`, `testing`)
or when it exists for CI and release alone.

Two directories carry the commands rather than the code. [checks/](checks) is every gate that reads the
checkout and nothing else, listed once in its manifest and run everywhere that list is read.
[scripts/](scripts) is everything else this repository runs around the code — verifying, building, publishing,
and standing machines up — grouped by who it serves, one family per directory, with the shared decisions in
`scripts/lib`. Each has a README naming every file in it.

[nav/](nav) measures what this repository costs an *agent* to read — tokens spent locating and opening a
symbol — and gates a decomposition against removing a public export or moving a frozen contract file.
[`nav/structure-stats.mjs`](nav/structure-stats.mjs) is its sibling one level up: what FINDING a file costs,
mined from the agent transcripts (listings, failed reads, packages touched per session).

## What each entry is

Four kinds live here, and the difference matters because it decides whether a change to one can break a user.
**Shipped** is published to npm and depended on by product code. **Double** stands in for something real
during a test and never ships. **Harness** runs the product against itself. **Plumbing** has no package.json
at all: it is scripts this repository runs on itself.

| kind         | entries                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **shipped**  | [base](base), [code-read](code-read), [constants](constants), [registry-scan](registry-scan), [testing](testing), [tsconfig](tsconfig) |
| **double**   | [fake-model](fake-model), [fake-upstream](fake-upstream)                                                                  |
| **harness**  | [e2e](e2e), [onboarding](onboarding), [desktop-smoke](desktop-smoke), [desktop-smoke-windows](desktop-smoke-windows), [localhost-https](localhost-https), [examples](examples), [extension-example](extension-example), [dind-host](dind-host) |
| **plumbing** | [checks](checks), [scripts](scripts), [nav](nav), [oxlint](oxlint), [ci-base](ci-base), [ci-desktop](ci-desktop), [selfhost](selfhost) |

`extension-example` and `registry-scan/seed` are **seeds**: directories copied OUT of this repository into
somebody else's project, which is why their imports and their relative links resolve there rather than here
(the checks know: `MAY_SPELL_A_ROOT` in `checks/path-literals.mjs`, `COPIED_OUT` in `checks/md-links.mjs`).

## Moving a directory

`scripts/build/move-files.mjs` is the tool a layout change is made of: `git mv` plus every module specifier the
move invalidated — in the moved file, in every importer, and in the owning package's `exports` targets, with
each file's own import style kept. It does not touch config path literals (tsconfig references, vite aliases,
Dockerfile COPY, a check's baseline key); those are a `rg` sweep, because each is a decision. Its own tests run
under `node --test` from `pnpm verify`.

```bash
echo '[{"from":"_sandbox/sandbox/src/agent/turn-plan.ts","to":"_sandbox/sandbox/src/agent/run/turn-plan.ts"}]' > /tmp/moves.json
node _tools/scripts/build/move-files.mjs /tmp/moves.json --dry-run   # prints every specifier it would rewrite
```
