# @intentic/workspace-setup

Which dependency manager a project needs, worked out from the names of its manifest and lockfile.

## Responsibilities

- Map a set of filenames to the install command a project wants — and nothing else.

## Key files

- [src/index.ts](src/index.ts) — the whole package: names in, manager out.
- [src/index.test.ts](src/index.test.ts) — the ambiguous cases, which are the only interesting ones.

## How it fits

Pure and browser-safe, which is the point: the drop-a-folder UI needs to say "this looks like a pnpm project"
before anything has been uploaded, and the daemon needs the same answer to actually run the install. One
function, two callers, no disagreement.

## Conventions & gotchas

- It reads NAMES, never file contents. That is what keeps it pure, browser-safe and instant — and it is why a
  project with a misleading lockfile gets a misleading answer, which is the right trade for a first guess the
  user can correct.
