# @intentic/constants

The ports, paths and image references the daemon, the CLIs and the desktop app all have to agree on.

## Responsibilities

- Name every shared constant once, so no two programs can disagree about where something is.
- Find the monorepo root, and a package's own root, by looking for them rather than by counting directories.

## Key files

- [src/index.ts](src/index.ts) — the constants themselves: ports, the fixed directory layouts, legal and origin
  values. Isomorphic, imported by browser code, so nothing here may touch `node:fs`.
- [src/node.mjs](src/node.mjs) — `repoRoot()` and `packageRoot()`, behind the `@intentic/constants/node`
  subpath. Node-only, and hand-written JavaScript rather than compiled TypeScript.

## How it fits

The bottom of the dependency graph: it imports nothing and almost everything imports it. A port number that lives
in two files is a port number that will eventually be two different numbers, which is the entire argument for
this package existing. The same argument covers the directory layouts — `/work`, `/history`, `.intentic`,
`/opt/intentic` — which were previously typed out by hand across dozens of files with nothing linking the copies.

The two root-finders answer the other half of that problem. Code used to locate the repo root by counting how
deep it sat (`../..`, `../../..`, `../../../..`), a number correct only for the file's current depth and checked
by nothing. Walking up to a marker has no such coupling, so a file can move anywhere and still resolve.

## Conventions & gotchas

- If a constant is used by exactly one package, it belongs in that package. This is for the ones that cross a
  boundary.
- `src/node.mjs` is plain JavaScript with a hand-written `.d.mts` **on purpose**. Its earliest callers run before
  anything is built — the prepass is what performs the build, and the byte and path checks run ahead of it — so a
  helper importable only from `dist/` is one they cannot import at all, which is how a second copy of the walk
  gets written. It is also why the root `package.json` depends on this package: without that link, scripts under
  `_tools/scripts/` cannot resolve it by name.
- **Extensions cannot import this package** — the boundary rule (`.oxlintrc.json`, `_extensions/README.md`) allows
  them only the SDK halves and `@intentic/sandbox-contract`, so an extension can't couple itself to app or engine
  internals. That rule stands; the contract package re-exports the four layout constants so extensions can still
  name a location instead of spelling it. One definition, reached by two paths.
- `WORKSPACE_ROOT` and `HISTORY_ROOT` are **defaults, not laws**. The daemon takes both as overridable config and
  an isolated turn re-points them, so code holding a `Config` must read the config value. The constants are what
  that config defaults to, and what code with no config in reach can still name correctly.
- Prefer the daemon's own `statePath()` over joining `STATE_DIR` by hand wherever it is reachable — it is typed
  against the table of state files, so it catches a name the table doesn't declare. `STATE_DIR` is for callers
  outside that table.
