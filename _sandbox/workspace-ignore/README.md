# @intentic/workspace-ignore

What the workspace refuses to show, index or sync — a security floor first, tidiness second.

Three layers, in order of authority: a **security floor** that cannot be turned off (secrets, `.git` internals,
browser profiles), a **junk denylist** for the things nobody wants to see (`node_modules`, build output), and the
accumulated `.gitignore` rules the repos themselves declare.

## Responsibilities

- Answer "is this path ignored, and by which layer" for the file tree, the search index and the sync agent.
- Keep the security floor non-negotiable, whatever a `.gitignore` says.

## Key files

- [src/index.ts](src/index.ts) — the scope, and the layered decision.
- [src/constants.ts](src/constants.ts) — the floor and the denylist, spelled out.
- [src/index.test.ts](src/index.test.ts) — the layer-precedence cases, which are the whole correctness story.

## How it fits

Depended on by the daemon (file tree, sync) and by `iq` (what gets indexed). A single answer, so a file hidden
from the tree is also absent from search results and never leaves the box.

## Conventions & gotchas

- **A `.gitignore` cannot un-ignore the floor.** A repo that lists `!.env` does not get its secrets served. That
  ordering is the reason this is a package instead of a call to a gitignore library.
