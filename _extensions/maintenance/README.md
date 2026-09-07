# @intentic/ext-maintenance

The chore book: what this workspace is owed, why, and the evidence behind each answer.

A chore is a standing question about a repository: are the dependencies pinned, is anything undocumented, has
the documentation drifted from the code: with a cadence, an applicability gate, and a verdict backed by facts
the daemon computed rather than by a model's impression.

## Responsibilities

- Assess every chore against the current signals and say which are due.
- Show the evidence behind a verdict, including for the chores that are clear, and say how old that evidence is.
- Run a chore as an agent turn, and keep the history of what those runs found.
- Carry a badge for what is due, and let a chore be snoozed without being forgotten.

## Key files

- [src/useChores.ts](src/useChores.ts): the book, assessed against the daemon's signals.
- [src/runs.ts](src/runs.ts): a chore run's shape and its history.
- [src/attention.ts](src/attention.ts): the badge, and what it stays quiet about.
- [src/ScopeNote.vue](src/ScopeNote.vue): what this repository was not asked, and why, under the list.
- [src/extension.ts](src/extension.ts): activation, and three decisions that could each have gone the other way.

## How it fits

The chore definitions themselves are **not** here: they are in `@intentic/sandbox-contract` (`src/chores/`),
because both the daemon and the browser must agree on what a chore is. This package is the surface.

**One rail tile, workspace-wide.** Workspace-wide because the question is "what is this workspace owed", answered
across repos, rather than one tile per repository fragmenting one list into five.

It activates on ANY repository and deliberately not on evidence of a problem: gating the AREA on something being
due would mean the first time an owner sees this surface is the first time it has bad news.

**Activating is not the same as holding a seat.** The rail seats this tile while the badge has something to
report and lists it in its More menu otherwise (`core-views/registry.ts` holds the rule). The old argument for a
permanent tile, that a surface which only exists while something is wrong cannot be visited to check that nothing
is, still stands: it is answered by More, by `view.maintenance` in the palette, and by pinning the tile, none of
which cost the column a silent seat on every workspace.

## Conventions & gotchas

- A cleared chore still shows its evidence. "Nothing is due" is a claim, and a claim you cannot inspect is one you
  cannot trust.
- Every row says how old its measurement is, and a chore whose evidence predates its last turn is `stale` rather
  than due: the probes refresh on a daily-to-weekly TTL, so an hour after a run the numbers on the row describe a
  tree that no longer exists. A stale row keeps its evidence, drops the claim, and offers a re-measure instead of a
  second turn.
- A row says whether anyone has already answered it, not just what the evidence found. A turn that concluded
  against a row's exact evidence (`choreAnswer`, digest-checked) puts a `reported` / `acted` mark on the collapsed
  row; while that answer stands the row loses its warning tint, sorts under the rows nobody has looked at, and is
  left out of every count on the page — the tab badge, the group headings, the rail column, which is finally the
  same definition the tile badge has always used. Demoted, never hidden: it keeps its place, its evidence and its
  verbs, and the button that starts a second turn says "Run it again". A chore whose cadence has lapsed still
  shows what was concluded last time but goes back to full weight, because the lapse is the book asking again.
- The page's own Reload **re-reads**, it does not re-measure. Measuring again costs a subprocess and minutes, so
  it is a decision made on the row that needs it: every chore resting on a probe carries its own Re-measure, and
  that is the only place the page asks for one.
- What was left out is a footnote, not a banner. Chores with no subject here, probes this repository cannot run
  and tools that broke are counted in one line under the list and expand to the causes; how fresh a measurement
  is rides on the row it decides, beside the numbers it qualifies.
