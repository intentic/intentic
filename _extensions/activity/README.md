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
- [src/extension.ts](src/extension.ts) — activation, off the public capability facts.

## How it fits

Capability-driven, not repo-driven. The feed surfaces when a monitored provider is connected, detected purely
from the public capability facts — a workspace with no connectors has nothing to show and gets no tile.

## Conventions & gotchas

- Episodes are derived on read, never stored. The grouping is a presentation decision, and freezing it would mean
  a better rule could not be applied to history that already exists.
