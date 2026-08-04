# Contributing

Issues and pull requests are welcome. For anything larger than a bug fix, open an issue before you write the
code — it costs you nothing and it is the only way to find out early that something is already in flight.

For security problems, do not open an issue — see [SECURITY.md](SECURITY.md).

## Getting the tree running

```sh
pnpm install
pnpm typecheck        # the gate — emits declarations first, needs no build
pnpm verify           # typecheck, then test
```

Requires **Node 24** and **pnpm 11**, both pinned in `engines`. To run the platform locally (Postgres, the api,
the browser workspace), see **Develop locally** in the [README](README.md).

## How work is checked

- **`pnpm verify` is the gate.** It is `pnpm typecheck` and then `pnpm test` — under a minute for all 45
  packages from a cold cache. Both emit every dependency's dist with `tsgo -b` first
  (`_tools/scripts/prepass.mjs`), so neither needs `pnpm build`. It is also what CI decides `main`'s health on,
  so a green run here is a green run there.
- **Edit `src/` directly.** Workspace packages expose an `@intentic/src` export condition, so cross-package
  imports resolve to source — no build step sits between editing a lib and running a dependent test.
- **Tests are co-located:** `*.test.ts` (unit), `*.integration.test.ts` (temp trees, subprocesses, real git —
  a 60s budget instead of the 5s hang detector), and gated `*.e2e.test.ts` (real infra, opt-in).
- **Tests are type-checked too**, by `pnpm typecheck` rather than by `pnpm build`. A package that emits to
  `dist` excludes `*.test.ts` from its build config and re-includes it in `tsconfig.test.json`.
- Every package has its own README with what it is responsible for and where to start reading.

## House rules

[AGENTS.md](AGENTS.md) holds the editing rules every change follows, and they are stricter than most:
no legacy or compatibility shims, no re-exports or aliases, let errors propagate rather than wrapping them,
prefer `undefined` over `null`, early returns for edge cases. A change that reads like the code around it is a
change that gets merged quickly.

Commits follow [Conventional Commits](https://www.conventionalcommits.org) — `commitlint.config.ts` enforces
it, and `semantic-release` derives the version and the release notes from it, so the prefix you choose decides
what ships.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the platform / sandbox / workspace split, the ownership and trust
model, the extension system, and the agent-facing tooling. For the shorter, picture-led version — one page per
package — read [docs/architecture/repo.md](docs/architecture/repo.md).

## Extensions

If what you want to build is a capability rather than a change to the core, you probably want an extension
instead — see [`intentic/extension-example`](https://github.com/intentic/extension-example) for the reference
implementation and [`intentic/registry`](https://github.com/intentic/registry) for listing it.
