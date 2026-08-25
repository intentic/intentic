# @intentic/ext-workflows

Multi-step agent work, designed as a graph and run as one thing.

Where an automation is one trigger and one prompt, a workflow is a sequence: steps that fan out, feed each other,
and converge: designed on a canvas, saved, and then run with its progress visible per step.

## Responsibilities

- Design a workflow on a canvas: steps, their order, and what each one is asked to do.
- Keep a draft separate from the saved thing, so an unfinished edit is never what runs.
- Pin each run to one immutable snapshot across every workspace repository, with candidate branches held for
  downstream comparison instead of auto-landed into the workspace.
- Run one, and show where it is, step by step, including per-step spend ceilings and complete response artifacts.
- Offer templates for the workflows most workspaces want, including anonymous multi-model attempts, independent
  evaluation, and a verified synthesis step.
- Declare a release gate on a design: the token-authed webhook a CI pipeline calls with what it knows, answered
  pass / fail / blocked off one declared output field. The designer's gate panel and the card's badge both show
  the URL and a paste-ready CI step.

## Key files

- [src/workflowDraft.ts](src/workflowDraft.ts): the draft/saved split, and what editing does to it.
- [src/workflowDag.ts](src/workflowDag.ts): steps and dependencies as a layout the canvas can draw.
- [src/workflowEdit.ts](src/workflowEdit.ts): the edit operations, as pure functions over a draft.
- [src/templates.ts](src/templates.ts): the pre-built workflows, and what each is for.
- [src/useWorkflows.ts](src/useWorkflows.ts): the list, and the runs against it.
- [src/runsQuery.ts](src/runsQuery.ts): the run ledger, named once for the page and the badge, and what counts as
  still working.
- [src/attention.ts](src/attention.ts): the badge, filled while nothing here is on screen.

## How it fits

Like automations, workflows are native to every sandbox (no capability to enable) so the view detects
unconditionally: the area exists everywhere, which is what makes `/ext/workflows`, the More list, the mobile menu
and the palette's "Go to Workflows" work.

**The rail seats the tile while a run is in flight**, and otherwise keeps it behind the More menu
(`core-views/registry.ts` holds the rule). A run is minutes to hours of fan-out that somebody started and walked
away from, so a tile that appears exactly while one is working is the way back to the graph; a designer between
visits is not worth one of the nine seats a laptop's rail has. The badge is `neutral`: runs working are an
inventory, not a debt. Runs that ended BADLY are deliberately not counted, "unacknowledged" is the only honest
form of that claim and there is nowhere here to acknowledge one yet; meanwhile a failed run's steps are agent
conversations, so the fleet carries that news.

## Conventions & gotchas

- The edit operations are pure functions over a draft, which is what makes them testable without a canvas and
  what keeps undo honest.
- Creating and updating are explicit operations. New designs and template copies receive fresh UUID-backed ids,
  so a stale browser cannot silently overwrite an existing workflow.
- A model pin is the complete runtime choice: provider, model, account, and harness. Leaving it unpinned inherits
  the workspace's normal unattended model. A step can separately act as a persona; without one it keeps the
  unattended default: full tools, no logged-in accounts.
- The gate's webhook token is minted by the daemon on first save and kept across every later edit, so the URL a
  pipeline was taught survives renames and re-pointed fields. Removing the gate revokes it; a future gate gets a
  new one.
- The run ledger keeps all active runs and the newest 50 ended runs. Long step responses live under
  `.intentic/workflow-runs/<run>/<step>.md`; the ledger stores only a bounded preview.
