# @intentic/tsconfig

Shared **TypeScript base configurations** for the monorepo. Every workspace package extends these so compiler options stay consistent in one place. A private package (not published).

## Responsibilities

- Provide the base `tsconfig`(s) that `_libs/*` and `_apps/*` extend via `"extends": "@intentic/tsconfig/..."`.
- Centralize strictness, module/target, and the `@intentic/src` export-condition setup that lets workspace imports resolve to source.

## How it fits

A leaf dev dependency of every package — no runtime code. Change compiler-wide behavior here; individual packages keep only their `include`/`outDir`/references.

## Conventions & gotchas

- Editing a base config affects the whole repo — verify a full `pnpm build` after changes.
