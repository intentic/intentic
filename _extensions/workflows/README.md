# @intentic/ext-workflows

Multi-step agent work, designed as a graph and run as one thing.

Where an automation is one trigger and one prompt, a workflow is a sequence: steps that fan out, feed each other,
and converge — designed on a canvas, saved, and then run with its progress visible per step.

## Responsibilities

- Design a workflow on a canvas: steps, their order, and what each one is asked to do.
- Keep a draft separate from the saved thing, so an unfinished edit is never what runs.
- Run one, and show where it is, step by step.
- Offer templates for the workflows most workspaces want.

## Key files

- [src/workflowDraft.ts](src/workflowDraft.ts) — the draft/saved split, and what editing does to it.
- [src/workflowDag.ts](src/workflowDag.ts) — steps and dependencies as a layout the canvas can draw.
- [src/workflowEdit.ts](src/workflowEdit.ts) — the edit operations, as pure functions over a draft.
- [src/templates.ts](src/templates.ts) — the pre-built workflows, and what each is for.
- [src/useWorkflows.ts](src/useWorkflows.ts) — the list, and the runs against it.

## How it fits

Like automations, workflows are native to every sandbox — no capability to enable — so the view detects
unconditionally.

## Conventions & gotchas

- The edit operations are pure functions over a draft, which is what makes them testable without a canvas and
  what keeps undo honest.
