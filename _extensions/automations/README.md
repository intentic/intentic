# @intentic/ext-automations

Standing instructions that start an agent turn on their own — on a schedule, or when something outside happens.

An automation is the difference between an agent you talk to and an employee that shows up. It pairs a trigger (a
cron expression, or a listener a connector provides) with the prompt to run when it fires.

## Responsibilities

- Compose an automation: its trigger, its prompt, which agent runs it, and which persona it runs as.
- Derive live trigger choices from installed listener contributions rather than owning provider knowledge.
- Translate a schedule into something a person can read back before they save it.
- Offer recipes — the automations most workspaces want, pre-written.
- Install the doorbell widget, the automation whose trigger is a visitor on your website.

## Key files

- [src/useAutomations.ts](src/useAutomations.ts) — the list, and the writes that change it.
- [src/cronSchedule.ts](src/cronSchedule.ts) — schedule parsing and the plain-language sentence it renders as.
- [src/listenerSources.ts](src/listenerSources.ts) — which non-time triggers exist, from the connectors that are on.
- [src/useListenerSources.ts](src/useListenerSources.ts) — installed listener declarations joined to connected capabilities.
- [src/recipes.ts](src/recipes.ts) — the pre-written automations, and what each is for.
- [src/useAutomationForm.ts](src/useAutomationForm.ts) — the composer's state and its validation.

## How it fits

Automations are native to every sandbox — there is no capability to enable — so the view detects
unconditionally and the rail tile is permanent.

## Conventions & gotchas

- A trigger fires a TURN, not a script. What happens next is the agent's judgement against the prompt, which is
  why an automation stays useful when the thing it reacts to changes shape.
- "Runs as" is one choice covering three things — whose accounts the wake may speak through, what it may do, and
  where in the workspace it works. It is a persona, edited on the Personas page, so the same bounds apply to the
  chat, the workflow and the Doorbell that name the same card. Naming none keeps the full toolbox and reaches no
  account; naming one that has been deleted gets neither, which is why the picker keeps an orphaned pin visible
  rather than rendering blank. "Narrow this one job further" is raw tool names on top of the card, and only ever
  narrower — it cannot hand back a shelf the persona switched off.
- A Doorbell that names no persona is saved onto the seeded read-only one. It is the single automation a
  stranger drives with nobody watching, so it is the one whose bounds cannot be left to the prompt's wording;
  an owner who deliberately points it at a card with more powers keeps that choice.
- Two ways to keep a hand on the wheel, and they compose: `requireApproval` holds every fire for the owner's
  click, while `holdForSeconds` holds it under a visible countdown and the daemon starts it itself once the
  timer passes on a quiet fleet — cancel and start-now stay one click away the whole time. When both are set,
  approval wins.
- Enablement is a narrow mutation, while an edit starts from the complete stored record. Switching or editing a
  row therefore preserves webhook identity, disabled state, provider-owned settings and security restrictions.
- Two automations arrive seeded, each defined once in the contract and offered again as a recipe only after the
  owner deletes it: the dependency fix chore ("Fix what a dependency change broke"), enabled with a 60-second
  hold, and the drafts publisher ("Publish approved drafts"), which the daemon also fires by id the instant a
  draft is approved and due — its cron is only the sweep for future-dated drafts and dropped fires.
