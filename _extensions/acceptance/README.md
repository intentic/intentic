# @intentic/ext-acceptance

User stories written in plain language, run against the real app by an agent, and reported back as pass or fail.

A story is a promise about the product — "a visitor can sign in and land on their workspace". This extension is
where those promises are written, where a run is started against a live dev server, and where the evidence comes
back. The agent drives a real browser; nothing here asserts against a mock.

## Responsibilities

- Author and store stories, and keep them where a diff can review them.
- Start a run against a target URL, watch it, and show what it found.
- Carry a rail badge when a run has news, and stay quiet when it does not.

## Key files

- [src/stories.ts](src/stories.ts) — what a story IS, and where it is kept.
- [src/runs.ts](src/runs.ts) — a run's shape and lifecycle: started, watched, reported.
- [src/brief.ts](src/brief.ts) — the instruction handed to the agent that drives the browser; this is where run quality actually lives.
- [src/useTargets.ts](src/useTargets.ts) — which URL a run points at, and how a dev server becomes one.
- [src/attention.ts](src/attention.ts) — the badge, and what it declines to light up for.
- [src/extension.ts](src/extension.ts) — activation, and the argument for one workspace-wide tile.

## How it fits

**One tile, not one per repo.** A product is rarely one repository — testing "sign in" may mean the web app and
the API in the same run — so the area is workspace-wide and the repo is a dimension inside it (a story's home, a
run's target), not the thing that addresses it.

It activates on `hasPanel` as well as on stories already existing. Gating it on stories alone would mean a
workspace with none can never reach the surface that writes the first one; "there is an app here that could be
tested" is the honest evidence for offering the area.

## Conventions & gotchas

- A story is prose, not a script. The agent reads it and decides how to drive the app, which is what lets a story
  survive a redesign that would have broken a selector.
- Runs are evidence, not documents: they are point-in-time and live under `.intentic/`, unlike the architecture
  pages, which are maintained artifacts that belong in the repo.
- A session that DIED is a first-class outcome, not a blank. It writes no verdict and no report, so both surfaces
  read its standing from the fleet instead (`storyStanding`, and the session's own `failure` sentence on the
  row): a run refused on its first request — a spent plan, a seat with Claude Code switched off — otherwise
  reported itself as a run nobody had started.
