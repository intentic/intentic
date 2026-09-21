# @intentic/ext-automations

Standing instructions that start an agent turn on their own: on a schedule, at one named moment, or when something
outside happens.

An automation is the difference between an agent you talk to and an employee that shows up. It pairs a trigger (a
cron expression, or a listener a connector provides) with the prompt to run when it fires.

## Responsibilities

- Compose an automation: its trigger, its prompt, which agent runs it, and which persona it runs as.
- Draw every trigger and every starting template from the daemon's catalogue, owning the name of no integration.
- Translate a schedule into something a person can read back before they save it.
- Install the visitor chat widget, the automation whose trigger is a visitor on your website.

## Key files

- [src/useAutomations.ts](src/useAutomations.ts): the list, and the writes that change it.
- [src/catalog.ts](src/catalog.ts): the daemon's catalogue, and what this browser adds to it (what is connected).
- [src/cronSchedule.ts](src/cronSchedule.ts): schedule parsing and the plain-language sentence it renders as.
- [src/useAutomationForm.ts](src/useAutomationForm.ts): the composer's state and its validation.

## How it fits

Automations are native to every sandbox (there is no capability to enable) so the view detects unconditionally:
the area exists everywhere, which is what makes `/ext/automations`, the More list, the mobile menu and the
palette's "Go to Automations" work.

**A tile on the rail is a separate question, and the app answers it.** The rail seats a tile while it has
something to say and keeps the rest behind its More menu (`core-views/registry.ts`). This extension has nothing to
say on its own: the one thing here that ever needed the owner, a wake held for approval, is a decision of exactly
the Approvals page's shape (a prepared thing waiting for a yes, then carried out precisely), so that page lists the
held wakes, offers approve / reject / start now / cancel, and its tile carries the count. Automations therefore
lives in More unless pinned, which is right for a shelf you author once and leave alone.

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
  chat, the workflow and the Visitor chat that name the same card. Naming none keeps the full toolbox and reaches no
  account; naming one that has been deleted gets neither, which is why the picker keeps an orphaned pin visible
  rather than rendering blank. "Narrow this one job further" is raw tool names on top of the card, and only ever
  narrower: it cannot hand back a shelf the persona switched off.
- A Visitor chat that names no persona is saved onto the seeded read-only one. It is the single automation a
  stranger drives with nobody watching, so it is the one whose bounds cannot be left to the prompt's wording;
  an owner who deliberately points it at a card with more powers keeps that choice.
- Two ways to keep a hand on the wheel, and they compose: `requireApproval` holds every fire for the owner's
  click, while `holdForSeconds` holds it under a visible countdown and the daemon starts it itself once the
  timer passes on a quiet fleet: cancel and start-now stay one click away the whole time, on the Approvals page.
  When both are set, approval wins.
- "Decide per person who it answers" (`senders`) is the third hand on the wheel, and the only one that knows
  who is writing. It is offered only on a source whose pack declared `automation.sender`, the promise that
  `author.id` is an identity the service vouches for; the Visitor chat keeps its own `access` and the daemon
  refuses rules anywhere else. Rules match ids and groups (a Discord role), never display names, which anyone
  can change to. Each rule names the persona its people get, blank meaning no persona: the full toolbox
  reaching no account, the same agent the owner talks to themselves. Everyone else is ignored, held, or
  answered as configured. The daemon keys a channel's conversation by the persona a sender resolved to
  (`sessions/thread-sessions.ts`), so two people it answers as different agents never share a wake or a
  session; the "seen recently" chips come from `GET /automations/senders/{provider}`, a roster of everyone who
  reached the automation's filters, admitted or not, which is how a stranger gets named after the fact.
- Enablement is a narrow mutation, while an edit starts from the complete stored record. Switching or editing a
  row therefore preserves disabled state, provider-owned settings and security restrictions. The webhook token
  is not on the record at all: the daemon keeps it with the door (its secrets store), attaches it to the listed
  summary (`webhookToken`, `ingestKey`) for a maintainer or the owner only, and keeps it across every re-post; a
  row's **Rotate** mints a new one and retires the old URL at once.
- "Run now" answers "I wrote a 3 a.m. cron and cannot try it", so it exists for the triggers you would otherwise
  have to wait for or forge: and NOT on a chat listener, whose whole prompt is a brief about handling the
  messages riding with the fire. By hand there are none, so the button could only ever produce an agent asking
  where the events went, while its turn held the automation against the real mention queued behind it. Testing
  a listener means sending the bot a message, which exercises the entire path. The daemon refuses it too, so
  the row's missing button is a rule rather than a decoration.
- The dependency fix chore ("Fix what a dependency change broke") exists only as a template. No row is added
  until the owner picks it; its fires then carry a 60-second hold. Approved posts are carried out by the
  daemon's approvals executor at their due time rather than through an automation.
- The dreaming session is the one offer whose subject is this SANDBOX rather than a repository: it reads the
  sessions that have been run here and changes one thing about how the next ones will go (a persona, a
  capability to ask for, an image step, a mechanism against a repeated correction). Its schedule carries a bar,
  `afterSessions: 30`, so its row spends most nights saying "12 of 30 sessions since the last wake", and that is
  the automation working: a pattern is what survives thirty sessions, so the cron only asks and the daemon's
  own count answers, then hands the sessions it counted to the turn under its prompt. The count starts from the
  conversation the row's own last fire opened rather than from its run history, because a run history is capped
  and a job that skips for three weeks would otherwise forget it had ever run
  (`sandbox/src/automations/scheduler.ts`, the sessions gate). The bar is a field of any schedule, beside the
  clock in the form and on the row's trigger phrase.
- A one-time wake (`once`) is the trigger that cannot afford the poll window. A cron is read forward from the last
  poll, so an occurrence that came due while the sandbox was down is simply never fired: it has another one coming.
  A one-time wake has nothing behind it, so the tick fires an overdue one at the first opportunity and tells the turn
  how late it is, in a note under the prompt, so a reminder passed on to a person says which of the two times it
  means. The rest of it follows from firing exactly once: the daemon switches the automation off AS it fires (before,
  not after, so a daemon that dies mid-wake cannot repeat it), the switch cannot re-arm one whose moment has passed,
  and an interrupted fire still resumes at boot because that switch was thrown by the fire rather than by the owner
  (`scheduler.ts`, `resumable`). It is also the one trigger that pushes a notification when it finishes: every other
  kind is already answering somebody who is listening, or is a chore nobody asked to hear each run of.
- The moment itself is stored as an instant, not a wall-clock time and a zone, and the composer resolves the
  reader's own clock at save. A one-time wake therefore means the same thing on any machine.

**A schedule cannot do that, and says so instead.** A cron is a wall-clock rule: `43 20 * * *` is not a moment, it is
20:43 on *some* clock, and which one is not written in it. The daemon runs in a UTC container, so an unzoned cron used
to be read as UTC — an automation set for 20:43 fired at 22:43 for an owner in Warsaw, and every screen showed a
plausible number for the wrong moment. Now:

- A schedule trigger carries `tz`, an IANA zone. Absent, it follows the sandbox's own `timezone` setting (Settings →
  Agent → Clock); absent that, UTC. One setting therefore moves every chore that never asked for something else.
- The first browser to open a workspace offers its zone, and the daemon takes it only while it has none — so a
  colleague opening the same workspace from another country cannot move anybody's chores.
- The badge names the zone whenever the reader is not on that clock ("Daily 20:43 Europe/Warsaw"), and the composer's
  next-runs preview is evaluated in the zone the **daemon** will fire in rather than the browser's, which is what made
  the original bug invisible: the one screen built to prove the schedule was right was confirming it.
- **A wake nothing is awake for still does not fire on time.** A hosted machine stops itself after a quiet window and
  only a visit brings it back, so the watchdog now asks the manifest what is due (`system/idle-stop.ts`, and
  `nextWakeAt` here): anything landing inside that window holds the machine up, the way an armed watch already does.
  Anything further out is slept through and fires late, saying so, because keeping a machine awake all night for one
  nightly chore costs more than the chore. Under a day, the `watch` tools an agent arms mid-turn are the better
  instrument anyway: they wake the conversation that asked, rather than opening a new one.
- A source outlives the pack that supplied it and a template does not, which reads like an inconsistency until
  you ask what each one is for. A source has to keep naming the trigger of an automation already standing on it,
  so a switched-off pack keeps its row and the picker simply declines to offer it. A template is something you
  have not made yet, and offering one from a pack that is off would offer to create a row that cannot fire.
- A pack names its glyph as an open string, because neither the wire contract nor the manifest schema may depend
  on the UI kit to spell one. The cast happens once, where the two vocabularies meet; an unknown name renders
  the icon set's own fallback rather than nothing.
