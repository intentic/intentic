# @intentic/scaffold

The starter files a new intentic workspace gets, shared by the two programs that create one.

Both the CLI's `init` and the sandbox daemon bring workspaces into existence, and they must produce the same
skeleton. This package is that skeleton, plus the render-and-parse of `deploy.config.ts`'s managed region — the
block the tooling owns inside a file the user also edits.

## Responsibilities

- Lay out the intent repo: what files a fresh workspace starts with.
- Render and re-parse the managed region of `deploy.config.ts` without disturbing what the user wrote around it.
- Inject a template into a workspace, and know what a template is.
- Run git operations a scaffold needs, including forking a starting point.
- Take inventory of the secrets a scaffolded workspace will need.

## Key files

- [src/intent-repo.ts](src/intent-repo.ts) — the skeleton itself.
- [src/deploy-config.ts](src/deploy-config.ts) — the managed region: rendering it, and reading it back out of a
  file someone has edited around.
- [src/workspace-layout.ts](src/workspace-layout.ts) — where things go.
- [src/inject-template.ts](src/inject-template.ts) / [src/template-manifest.ts](src/template-manifest.ts) — what a
  template is, and applying one.
- [src/secret-inventory.ts](src/secret-inventory.ts) — which secrets a workspace will be asked for.

## How it fits

Shared by `_apps/cli` and `_apps/sandbox`. Its whole reason for being a package rather than a directory in either
one is that a workspace created two ways must be the same workspace.

## Conventions & gotchas

- The managed region round-trips. `deploy-config.ts` must be able to read back what it wrote even after a user has
  reformatted the file around it, which is why parsing is tested against edited fixtures rather than its own output.
- The git and template paths are covered by integration tests against real temp trees, because their failure modes
  are filesystem and process failures rather than logic ones.
