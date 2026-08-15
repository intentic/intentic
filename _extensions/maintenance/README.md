# @intentic/ext-maintenance

The chore book: what this workspace is owed, why, and the evidence behind each answer.

A chore is a standing question about a repository — are the dependencies pinned, is anything undocumented, has
the documentation drifted from the code — with a cadence, an applicability gate, and a verdict backed by facts
the daemon computed rather than by a model's impression.

## Responsibilities

- Assess every chore against the current signals and say which are due.
- Show the evidence behind a verdict, including for the chores that are clear, and say how old that evidence is.
- Run a chore as an agent turn, and keep the history of what those runs found.
- Carry a badge for what is due, and let a chore be snoozed without being forgotten.

## Key files

- [src/useChores.ts](src/useChores.ts) — the book, assessed against the daemon's signals.
- [src/runs.ts](src/runs.ts) — a chore run's shape and its history.
- [src/attention.ts](src/attention.ts) — the badge, and what it stays quiet about.
- [src/RepoScope.vue](src/RepoScope.vue) — scoping the list to one repository without fragmenting the surface.
- [src/extension.ts](src/extension.ts) — activation, and three decisions that could each have gone the other way.

## How it fits

The chore definitions themselves are **not** here — they are in `@intentic/sandbox-contract` (`src/chores/`),
because both the daemon and the browser must agree on what a chore is. This package is the surface.

**One rail tile, workspace-wide, always present.** Workspace-wide because the question is "what is this workspace
owed", answered across repos. An AREA rather than an event tile, because the book, the history, the evidence and
the snooze controls all exist whether or not anything is due — a surface that only exists while something is
wrong cannot be visited to check that nothing is. The badge carries the signal; the tile carries the place.

It activates on ANY repository and deliberately not on evidence of a problem: gating it on something being due
would mean the first time an owner sees this surface is the first time it has bad news.

## Conventions & gotchas

- A cleared chore still shows its evidence. "Nothing is due" is a claim, and a claim you cannot inspect is one you
  cannot trust.
- Every row says how old its measurement is, and a chore whose evidence predates its last turn is `stale` rather
  than due — the probes refresh on a daily-to-weekly TTL, so an hour after a run the numbers on the row describe a
  tree that no longer exists. A stale row keeps its evidence, drops the claim, and offers a re-measure instead of a
  second turn.
- The page's own Refresh **re-reads**, it does not re-measure. Measuring again costs a subprocess and minutes, so
  it stays a decision made on the row that needs it.
