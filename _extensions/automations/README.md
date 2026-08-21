# @intentic/ext-automations

Standing instructions that start an agent turn on their own: on a schedule, or when something outside happens.

An automation is the difference between an agent you talk to and an employee that shows up. It pairs a trigger (a
cron expression, or a listener a connector provides) with the prompt to run when it fires.

## Responsibilities

- Compose an automation: its trigger, its prompt, which agent runs it, and which persona it runs as.
- Draw every trigger and every starting template from the daemon's catalogue, owning the name of no integration.
- Translate a schedule into something a person can read back before they save it.
- Install the front desk widget, the automation whose trigger is a visitor on your website.

## Key files

- [src/useAutomations.ts](src/useAutomations.ts): the list, and the writes that change it.
- [src/catalog.ts](src/catalog.ts): the daemon's catalogue, and what this browser adds to it (what is connected).
- [src/cronSchedule.ts](src/cronSchedule.ts): schedule parsing and the plain-language sentence it renders as.
- [src/useAutomationForm.ts](src/useAutomationForm.ts): the composer's state and its validation.

## How it fits

Automations are native to every sandbox (there is no capability to enable) so the view detects
unconditionally and the rail tile is permanent.

**This package is the surface, not the vocabulary.** What can wake an agent, and what is worth starting from,
are served together by the daemon (`GET /automations/catalog`): its own sources, the website widget and CI,
whose endpoints it holds: merged with what every installed pack declares (`contributes.listener`,
`contributes.automationTemplates`). `POST /automations` validates against that same merge, so the picker cannot
offer a trigger the daemon would refuse.

Both halves used to live here, as two hand-written tables naming CI, Komodo, Sentry, Stripe, email and every
chore in the book: with the daemon keeping a second copy of the source list to validate against. That made
this page the file you edited when a pack you had nothing to do with gained a trigger, and made the two lists a
disagreement waiting for whichever was edited second.

## Conventions & gotchas

- A trigger fires a TURN, not a script. What happens next is the agent's judgement against the prompt, which is
  why an automation stays useful when the thing it reacts to changes shape.
- "Runs as" is one choice covering three things: whose accounts the wake may speak through, what it may do, and
  where in the workspace it works. It is a persona, edited on the Personas page, so the same bounds apply to the
  chat, the workflow and the Front Desk that name the same card. Naming none keeps the full toolbox and reaches no
  account; naming one that has been deleted gets neither, which is why the picker keeps an orphaned pin visible
  rather than rendering blank. "Narrow this one job further" is raw tool names on top of the card, and only ever
  narrower: it cannot hand back a shelf the persona switched off.
- A Front Desk that names no persona is saved onto the seeded read-only one. It is the single automation a
  stranger drives with nobody watching, so it is the one whose bounds cannot be left to the prompt's wording;
  an owner who deliberately points it at a card with more powers keeps that choice.
- Two ways to keep a hand on the wheel, and they compose: `requireApproval` holds every fire for the owner's
  click, while `holdForSeconds` holds it under a visible countdown and the daemon starts it itself once the
  timer passes on a quiet fleet: cancel and start-now stay one click away the whole time. When both are set,
  approval wins.
- Enablement is a narrow mutation, while an edit starts from the complete stored record. Switching or editing a
  row therefore preserves webhook identity, disabled state, provider-owned settings and security restrictions.
- "Run now" answers "I wrote a 3 a.m. cron and cannot try it", so it exists for the triggers you would otherwise
  have to wait for or forge: and NOT on a chat listener, whose whole prompt is a brief about handling the
  messages riding with the fire. By hand there are none, so the button could only ever produce an agent asking
  where the events went, while its turn held the automation against the real mention queued behind it. Testing
  a listener means sending the bot a message, which exercises the entire path. The daemon refuses it too, so
  the row's missing button is a rule rather than a decoration.
- The dependency fix chore ("Fix what a dependency change broke") exists only as a template. No row is added
  until the owner picks it; its fires then carry a 60-second hold. Approved drafts are published directly by
  the daemon at their due time rather than through an automation.
- A source outlives the pack that supplied it and a template does not, which reads like an inconsistency until
  you ask what each one is for. A source has to keep naming the trigger of an automation already standing on it,
  so a switched-off pack keeps its row and the picker simply declines to offer it. A template is something you
  have not made yet, and offering one from a pack that is off would offer to create a row that cannot fire.
- A pack names its glyph as an open string, because neither the wire contract nor the manifest schema may depend
  on the UI kit to spell one. The cast happens once, where the two vocabularies meet; an unknown name renders
  the icon set's own fallback rather than nothing.
