# Contributing

How to set up, build and test the intentic monorepo, and which checks a change meets between your editor and a release.

```mermaid
flowchart LR
    edit["your change"] --> land["lands on the main tree"]
    land --> verify["pnpm verify<br/>whole repository, after the land"]
    land --> commit["commit<br/>commitlint reports"]
    commit --> push(["pnpm verify:push<br/>pre-push hook reports"])
    push --> ci["CI on the fleet"]
    ci --> main["main"]
    main --> release["release on green"]
```

## Set up

1. Install Node and pnpm at the versions `package.json` pins (`engines`, `packageManager`). The Rust crates (`_sandbox/ic`, `_sandbox/front`, `_devices/win-launcher`, the desktop app's `src-tauri`) need cargo. The database, the sandbox image and the e2e tiers need Docker.
2. `pnpm install`. Its `prepare` script points git at `.githooks/`, which holds the commit-msg and pre-push hooks. Both report what they find and never refuse.
3. `pnpm build`, `pnpm test`, `pnpm typecheck` and `pnpm lint` cover the workspace; `pnpm --filter @intentic/<name> test` covers one package.
4. `pnpm dev` starts Postgres, the api, the web editor and the site. `pnpm build:sandbox` builds the sandbox image locally.

## The checks

| Command | What it measures | When it runs |
| --- | --- | --- |
| `pnpm verify` | the whole repository, the way CI's verify groups do. After a land it first applies rustfmt, each failing check's `fix` and a regenerated contract lock | after every land, on the main tree, in the background |
| `pnpm verify:push` | checks, the ratchet, manifest and lockfile lockstep, lint, rustfmt; by hand it also replays a recorded typecheck, build and test verdict, or runs them with `--suite` | the pre-push hook, which reports and never refuses |

No check refuses a land, a commit or a push. The commit-msg hook prints what commitlint finds, the pre-push hook prints what `verify-push.mjs` finds, and git goes on either way. By hand, `pnpm verify:push` exits non-zero on a finding. A red `pnpm verify` is sent to the conversation that landed the work or to a fresh one, and [sandbox.md](docs/architecture/sandbox.md) says how it decides. CI still runs everything on the pushed commit. It builds only branches in this repository: a pull request from a fork runs nothing until a maintainer reads it and pushes its branch here ([the fork boundary](docs/ops/ci-runner.md)).

## Commits

- Conventional Commits, checked by [`commitlint.config.ts`](commitlint.config.ts): `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style` or `revert`. The subject may open with a code identifier but not in Title Case.
- A `Release-Note:` trailer is one line a user would notice; it becomes a bullet under the release's "What's new".
- A `!` after the type with a `Breaking-Note:` trailer declares a break. The push reports a narrowed wire contract that arrives without one ([COMPATIBILITY.md](COMPATIBILITY.md)).
- A weakened test needs a `test!:` subject or a `Test-Note:` trailer saying why. Without one, the push reports it and the check after the land counts it as a failure.
- A change to a stored document's shape ships with its conversion; the rules are in [COMPATIBILITY.md](COMPATIBILITY.md#stored-data).
- The rules for docs and tests, and the gates that read every edit, are in [AGENTS.md](AGENTS.md).

## Documentation

- A package's `README.md` changes in the same commit as the code that made it wrong.
- How the system fits together goes in `docs/architecture/`, runbooks for the machinery around the code in `docs/ops/`; [docs/README.md](docs/README.md) says where each kind of page belongs.
- User-facing documentation is the site's, under `_site/site/src/pages/docs/`.

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in an issue. Contributions are under the [MIT licence](LICENSE).
