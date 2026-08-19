# @intentic/workspace-ignore

The workspace attention filter: what the tree grays and lazy-loads, and what ordinary workspace search skips.

It combines a conservative junk denylist (`node_modules`, `.git`, build output), dedicated predicates for
Chromium login profiles, agent worktrees and the reference shelf, and the accumulated `.gitignore` rules the
repos themselves declare. Durable browser artifacts live separately at `.intentic/records/artifacts/browser/`, so they
remain ordinary visible files rather than being mistaken for profile churn.

## Responsibilities

- Answer whether a path is ignored for the file tree and ordinary workspace content search.
- Keep machine-generated subtrees out of eager recursive walks without turning the filter into an access rule.

## Key files

- [src/index.ts](src/index.ts) — the scope, and the layered decision.
- [src/constants.ts](src/constants.ts) — the floor and the denylist, spelled out.
- [src/index.test.ts](src/index.test.ts) — the layer-precedence cases, which are the whole correctness story.

## How it fits

Depended on by the daemon and by `iq`. It is not a security boundary: protected file routes and IQ's own
credential/session/artifact exclusion floor enforce those concerns independently.

## Conventions & gotchas

- Browser profiles and agent worktrees stay ignored even when a nested `.gitignore` would otherwise include
  them. The files remain readable on demand; ignored means out of focus, not inaccessible.
