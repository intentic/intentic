# automations

The Automations rail view, where the owner creates, edits and watches the agent's wake-ups: a trigger, an optional guard and the prompt the agent wakes with.

```mermaid
flowchart LR
    catalog["GET /automations/catalog<br/>daemon triggers + pack templates"] --> view(["automations"])
    view -->|"upsert · enable · run"| routes["Daemon /automations"]
    routes --> config[".intentic/config/automations.json"]
    scheduler["Daemon scheduler<br/>schedule · webhook · listener · workspace"] --> config
    scheduler --> runs["automation-runs.json"]
    runs --> view
```

- Runs in the browser, compiled into the web bundle. The daemon fires every automation and records its runs ([src/automations](../../_sandbox/sandbox/src/automations)); this view only reads and writes the definitions through the `/automations` routes.
- Names no integration itself. The trigger picker and template gallery come from one catalogue read, which merges the daemon's own triggers with the listener sources and `automationTemplates` of every enabled extension. An automation whose extension is gone degrades to a generic, still-editable source.
- Schedules are edited as a structured form ([cronSchedule.ts](src/cronSchedule.ts)) that composes and parses cron. Webhook and Visitor chat automations hand over what to paste after saving: the tokened URL or the site snippet.
- Two lenses on one list, remembered per browser. **List** is home: every trigger kind with its state and controls. **Calendar** is one week on the reader's own clock, for the questions that span rows: what wakes when, what piles onto the same night, what ran and failed. Only `schedule` and `once` automations are placed on it, and the rest are named under the grid. The past comes from the run ledger, the future from the cron read in the zone the daemon fires it in, and a rule firing more than six times a day becomes one bar in a lane above the grid. Clicking a slot opens its run, edit and switch controls; clicking free time starts a one-time wake there. A narrow pane gets the same week as an agenda.
- Held wakes (`requireApproval`, `holdForSeconds`) belong to [approvals](../approvals), so this view carries no badge.

## Key files

- [src/AutomationsView.vue](src/AutomationsView.vue) — the page: standing rows, chores, offers and inline editing.
- [src/useAutomations.ts](src/useAutomations.ts) — queries and mutations over the daemon's automation routes.
- [src/catalog.ts](src/catalog.ts) — the trigger and template catalogue, with connected-state per capability.
- [src/useAutomationForm.ts](src/useAutomationForm.ts) — one form for create and edit; `load` and `build` round-trip.
- [src/AutomationComposer.vue](src/AutomationComposer.vue) — the inline composer and template gallery.
- [src/AutomationEditor.vue](src/AutomationEditor.vue) — one automation's edit form, shared by the row's drawer and the calendar.
- [src/calendarModel.ts](src/calendarModel.ts) — the calendar's week as a pure function of the list, the clock and the zone; overlap layout.
- [src/AutomationCalendar.vue](src/AutomationCalendar.vue) — the week grid, its lane and its agenda; [src/CalendarPeek.vue](src/CalendarPeek.vue) is the card a slot opens.

## Commands

```sh
pnpm --filter @intentic/ext-automations test
```
