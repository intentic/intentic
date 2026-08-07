# @intentic/ext-activity

The audit feed: what happened across the systems this sandbox is connected to, as one timeline.

## Responsibilities

- Pull events from every connected provider the workspace monitors.
- Group them into **episodes** — a burst of related events read as one thing that happened, rather than forty rows.
- Let the reader narrow to one source without losing the shared time axis.

## Key files

- [src/episodes.ts](src/episodes.ts) — the grouping rule: what makes several events one episode.
- [src/useActivity.ts](src/useActivity.ts) — fetching and merging the sources into a single feed.
- [src/ActivityTimeline.vue](src/ActivityTimeline.vue) — the timeline itself.
- [src/SourceFilter.vue](src/SourceFilter.vue) — who called, as a picker in the feed's filter bar.
- [src/extension.ts](src/extension.ts) — activation, off the public capability facts.

## How it fits

A **section of the sandbox hub**, beside Logs — reached from the sandbox chip at the top of the rail, not from a
rail tile of its own. The rail is a column of unlabelled squares aimed at from muscle memory, and a tile earns one
of those seats by being somewhere you go constantly or by being able to tell you something happened. This feed can
do neither: what it holds is a level, not an edge, so a badge on it would be lit permanently and therefore say
nothing. What genuinely wants you is already surfaced where it can be acted on — a failed automation run sits on
its automation's row, a wake held for approval is a card on the fleet board. This is the whole record, read
afterwards, on your own initiative.

Capability-driven, not repo-driven. The feed surfaces when a monitored provider is connected, detected purely
from the public capability facts — a workspace with no connectors has nothing to show and gets no section.

## Conventions & gotchas

- Episodes are derived on read, never stored. The grouping is a presentation decision, and freezing it would mean
  a better rule could not be applied to history that already exists.
