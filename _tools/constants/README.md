# @intentic/constants

The ports, paths and image references the daemon, the CLIs and the desktop app all have to agree on.

## Responsibilities

- Name every shared constant once, so no two programs can disagree about where something is.

## Key files

- [src/index.ts](src/index.ts) — the whole package.

## How it fits

The bottom of the dependency graph: it imports nothing and almost everything imports it. A port number that lives
in two files is a port number that will eventually be two different numbers, which is the entire argument for
this package existing.

## Conventions & gotchas

- If a constant is used by exactly one package, it belongs in that package. This is for the ones that cross a
  boundary.
