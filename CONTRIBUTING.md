# Contributing

How to set up, build and test the intentic monorepo, and which checks a change meets between your editor and a release.

```mermaid
flowchart LR
    edit["your change"] --> land["lands on the main tree"]
    land --> commit["commit<br/>commitlint reports"]
    commit --> push["push<br/>nothing runs"]
    push --> ci(["CI on the fleet<br/>the push check and the verify groups"])
    ci --> main["main"]
    main --> release["release once it passes"]
```

## Set up

1. Install Node and pnpm at the versions `package.json` pins (`engines`, `packageManager`). The Rust crates (`_sandbox/ic`, `_sandbox/netd`, `_devices/win-launcher`, the desktop app's `src-tauri`) need cargo. The database, the sandbox image and the e2e tiers need Docker.
2. `pnpm install`. Its `prepare` script points git at `.githooks/`, which holds the commit-msg hook. It reports what commitlint finds and never refuses.
3. `pnpm build`, `pnpm test`, `pnpm typecheck` and `pnpm lint` cover the workspace; `pnpm --filter @intentic/<name> test` covers one package.
4. `pnpm dev` starts Postgres, the api, the web editor and the site. `pnpm build:sandbox` builds the sandbox image locally.

## The checks

| Command | What it measures | When it runs |
| --- | --- | --- |
| `pnpm verify` | the whole repository, the way CI's verify groups do | by hand, when you ask for it |
| `pnpm verify:push` | the push check over a range of commits: the checks with tidiness counted only where the range added it, the assertion ratchet, lint of the files it changed; by hand also the manifest and lockfile lockstep and rustfmt | CI's `quick` job, on every push; by hand, the branch against its upstream |

No check refuses a land, a commit or a push. The commit-msg hook prints what commitlint finds and git goes on either way, and nothing runs at a push. Nothing runs after a land but a dependency install, so the whole repository is measured by CI, on the pushed commit: its `quick` job type-checks what the push changed and runs the push check within minutes, and the verify groups build and test the rest. By hand, `pnpm verify:push` exits non-zero on a finding. CI builds only branches in this repository: a pull request from a fork runs nothing until a maintainer reads it and pushes its branch here ([the fork boundary](docs/ops/ci-runner.md)). When main's CI fails, the sandbox gives the failure one fix agent ([sandbox.md](docs/architecture/sandbox.md#when-mains-ci-fails)).

## Commits

- Conventional Commits, checked by [`commitlint.config.ts`](commitlint.config.ts): `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style` or `revert`. The subject may open with a code identifier but not in Title Case.
- A `Release-Note:` trailer is one line a user would notice; it becomes a bullet under the release's "What's new".
- A `!` after the type with a `Breaking-Note:` trailer declares a break. CI fails a branch whose narrowed wire contract arrives without one ([COMPATIBILITY.md](COMPATIBILITY.md)).
- A weakened test needs a `test!:` subject or a `Test-Note:` trailer saying why. Without one, CI's push check fails it.
- A change to a stored document's shape ships with its conversion; the rules are in [COMPATIBILITY.md](COMPATIBILITY.md#stored-data).
- The rules for docs and tests, and the gates that read every edit, are in [AGENTS.md](AGENTS.md).

## Documentation

- A package's `README.md` changes in the same commit as the code that made it wrong.
- How the system fits together goes in `docs/architecture/`, runbooks for the machinery around the code in `docs/ops/`; [docs/README.md](docs/README.md) says where each kind of page belongs.
- User-facing documentation is the site's, under `_site/site/src/pages/docs/`.

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in an issue. Contributions are under the [MIT licence](LICENSE).
