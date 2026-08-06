# @intentic/ext-acceptance

User stories written in plain language, run against the real app by an agent, and reported back as pass or fail.

A story is a promise about the product — "a visitor can sign in and land on their workspace". This extension is
where those promises are written, where a run is started against a live dev server, and where the evidence comes
back. The agent drives a real browser; nothing here asserts against a mock.

## Responsibilities

- Author and store stories, and keep them where a diff can review them.
- Start a run against one or more target URLs, watch it, retry sessions that were refused, and show what it found.
- Carry a rail badge when a completed failure or block is new, and stay quiet after that finding is acknowledged.

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
- **A repo is green when something ANSWERS, whoever started it** — and the heading's chip therefore cannot assume
  it owns the dev server. Each address carries the terminal it is actually served from, so the chip opens that
  one; an address served from outside the box's terminals says "no terminal" instead of offering one that has
  never existed. Only a start still installing points at the panel's own session, where by definition it is.
- Runs are evidence, not documents: they are point-in-time and live under `.intentic/`, unlike the architecture
  pages, which are maintained artifacts that belong in the repo. A manifest keeps the exact story text and
  criteria, target addresses, project testing notes, provider and model that shaped its sessions. Editing a story
  therefore retires the old verdict from the current stories list without changing the historical report.
- Every selected story is read again when the run starts. The list deliberately prefetches only its first 200
  files, but that display bound never turns an unreadable or stale file into an agent prompt.
- A run is discoverable before its sessions are launched. Fan-out refusals are recorded per story while the
  successful sessions continue; Retry uses that run's saved story, address and testing notes rather than today's
  workspace state.
- `result.json` is untrusted agent output. It becomes a verdict only when the complete shape is present and every
  authored criterion appears verbatim and in order. Report images are resolved only from a flat `shots/*.png`
  path inside that story's own run directory.
- Opening Acceptance acknowledges the failed and blocked results that exist at that moment, not the age of their
  run. A failure that finishes after the view closes is still new and lights the badge on the next scan.
- A registered session that DIED is a first-class outcome, not a blank. It writes no verdict and no report, so
  both surfaces read its standing from the fleet instead (`storyStanding`, and the session's own `failure`
  sentence on the row).
