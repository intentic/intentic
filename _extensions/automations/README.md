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
- Two ways to keep a hand on the wheel, and they compose: `requireApproval` holds every fire for the owner's
  click, while `holdForSeconds` holds it under a visible countdown and the daemon starts it itself once the
  timer passes on a quiet fleet — cancel and start-now stay one click away the whole time. When both are set,
  approval wins.
- One automation arrives seeded: the dependency fix chore ("Fix what a dependency change broke"), enabled with a
  60-second hold, defined once in the contract's chore book and offered again as a recipe only after the owner
  deletes it.
