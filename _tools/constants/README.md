# @intentic/constants

The ports, paths and image references the daemon, the CLIs and the desktop app all have to agree on.

## Responsibilities

- Name every shared constant once, so no two programs can disagree about where something is.
- Find the monorepo root, and a package's own root, by looking for them rather than by counting directories.

## Key files

- [src/index.ts](src/index.ts), the constants themselves: ports, the fixed directory layouts, legal and origin
  values, and the install-script table. Isomorphic, imported by browser code, so nothing here may touch `node:fs`.
- [src/node.mjs](src/node.mjs): `repoRoot()` and `packageRoot()`, behind the `@intentic/constants/node`
  subpath. Node-only, and hand-written JavaScript rather than compiled TypeScript.
- [src/assertion-measure.mjs](src/assertion-measure.mjs), [src/contract-shrink.mjs](src/contract-shrink.mjs),
  [src/control-bytes.mjs](src/control-bytes.mjs) and [src/mirror-roots.mjs](src/mirror-roots.mjs): the four
  judgments the repository's checkout gates (`_tools/checks/`) and the daemon both make, kept as one copy each.
  Hand-written JavaScript for the same reason `node.mjs` is: a gate that runs before `pnpm install` imports them
  by relative path, and the daemon imports them as subpaths of this package.

## How it fits

The bottom of the dependency graph: it imports nothing and almost everything imports it. That is also what
makes it the home of the few pure judgments a pre-install script and the daemon have to share: anything else
they could both import would need an install to resolve. `mirror-roots.mjs` is the clearest case of that: the
set of directories an isolated turn overlays is the daemon's business (`agents/isolation.ts` mounts them), and
whether a build script may `rm -rf` one of them is a checkout gate's business, and the two answers have to be
the same answer or a name added to one is a directory the other stops protecting. A port number that lives
in two files is a port number that will eventually be two different numbers, which is the entire argument for
this package existing. The same argument covers the directory layouts: `/work`, `/history`, `.intentic`,
`/opt/intentic`: which were previously typed out by hand across dozens of files with nothing linking the copies.

The two root-finders answer the other half of that problem. Code used to locate the repo root by counting how
deep it sat (`../..`, `../../..`, `../../../..`), a number correct only for the file's current depth and checked
by nothing. Walking up to a marker has no such coupling, so a file can move anywhere and still resolve.

## Conventions & gotchas

- If a constant is used by exactly one package, it belongs in that package. This is for the ones that cross a
  boundary.
- `INSTALL_SCRIPTS` is the vanity path → asset table for `intentic.dev/connect` and its siblings, and it crosses
  the widest boundary in here: the **app** writes those URLs into the one-liners it hands out, the **site
  worker** is what answers them, and the **site's own pages** link to them so a reader can check a script before
  running it. Three hand-synced lists in three packages meant a renamed script served the site's 404 page into
  somebody's `sh`. Use `installScriptUrl()` / `installScriptPath()` rather than joining the parts: two vanity
  paths (`/rebuild`, `/update`) deliberately serve one script, so neither half is derivable from the other.
- `src/node.mjs` is plain JavaScript with a hand-written `.d.mts` **on purpose**. Its earliest callers run before
  anything is built (the prepass is what performs the build, and the byte and path checks run ahead of it) so a
  helper importable only from `dist/` is one they cannot import at all, which is how a second copy of the walk
  gets written. It is also why the root `package.json` depends on this package: without that link, scripts under
  `_tools/scripts/` cannot resolve it by name.
- **The name only resolves once `pnpm install` has run**, because a bare specifier is looked up through
  `node_modules`. The two callers that run before any install: `_tools/checks/run.mjs`, which the `pre-push`
  hook and the CI `preflight` job invoke on a bare checkout: therefore import `../constants/src/node.mjs` by
  path. Same file, same single copy of the walk, no install required. Everything that runs after the install
  imports it by name.
- **Extensions cannot import this package**: the boundary rule (`.oxlintrc.json`, `_extensions/README.md`) allows
  them only the SDK halves and `@intentic/sandbox-contract`, so an extension can't couple itself to app or engine
  internals. That rule stands; the contract package re-exports the four layout constants so extensions can still
  name a location instead of spelling it. One definition, reached by two paths.
- `WORKSPACE_ROOT` and `HISTORY_ROOT` are **defaults, not laws**. The daemon takes both as overridable config and
  an isolated turn re-points them, so code holding a `Config` must read the config value. The constants are what
  that config defaults to, and what code with no config in reach can still name correctly.
- Prefer the daemon's own `statePath()` over joining `STATE_DIR` by hand wherever it is reachable: it is typed
  against the table of state files, so it catches a name the table doesn't declare. `STATE_DIR` is for callers
  outside that table.
