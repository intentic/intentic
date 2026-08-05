# @intentic/ext-automations

Standing instructions that start an agent turn on their own — on a schedule, or when something outside happens.

An automation is the difference between an agent you talk to and an employee that shows up. It pairs a trigger (a
cron expression, or a listener a connector provides) with the prompt to run when it fires.

## Responsibilities

- Compose an automation: its trigger, its prompt, and which agent runs it.
- Translate a schedule into something a person can read back before they save it.
- Offer recipes — the automations most workspaces want, pre-written.
- Install the doorbell widget, the automation whose trigger is a visitor on your website.

## Key files

- [src/useAutomations.ts](src/useAutomations.ts) — the list, and the writes that change it.
- [src/cronSchedule.ts](src/cronSchedule.ts) — schedule parsing and the plain-language sentence it renders as.
- [src/listenerSources.ts](src/listenerSources.ts) — which non-time triggers exist, from the connectors that are on.
- [src/recipes.ts](src/recipes.ts) — the pre-written automations, and what each is for.
- [src/useAutomationForm.ts](src/useAutomationForm.ts) — the composer's state and its validation.

## How it fits

Automations are native to every sandbox — there is no capability to enable — so the view detects
unconditionally and the rail tile is permanent.

## Conventions & gotchas

- A trigger fires a TURN, not a script. What happens next is the agent's judgement against the prompt, which is
  why an automation stays useful when the thing it reacts to changes shape.
