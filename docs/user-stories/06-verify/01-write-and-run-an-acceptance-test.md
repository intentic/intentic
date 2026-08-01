# Write a promise down, and have it tested for you

As someone who keeps re-checking the same flows by hand after every change, I want to write what the product promises once and have agents walk it through the running app, so that "does sign-in still work" is answered by a report rather than by me clicking.

Writing one has to be cheaper than not bothering. In the Acceptance area I type a title into the row at the end of a group and press Enter — the story exists, as a markdown file in the repository it belongs to, and its row is already open for the criteria. Each criterion is a line; Enter opens the next one. Nothing asks me to save, because the file in the repo is the story. Stories that belong together live in a subdirectory, and that subdirectory is a group in the list; naming one in the composer is how a new group comes into being.

Then I run it. Each story becomes one isolated agent session that opens the app in a real browser, walks every criterion, screenshots what it saw, and writes a verdict. Groups are also how a run knows where to point: one address per group, so a repository serving both a marketing site and an app can have each group aimed at its own server in the same run. Afterwards the list itself carries the answer — every story row shows where that promise currently stands.

## Acceptance criteria

- [ ] The Acceptance area lists every repository that can hold stories, its stories grouped by subdirectory, and each story's criteria count
- [ ] Typing a title into a group's composer row and pressing Enter creates the story in that group and opens its row for editing
- [ ] Typing a name with a `group/` prefix creates the story in that subdirectory, and the row shows the file it is about to create as I type
- [ ] Pressing Enter in a criterion opens the next criterion, without reaching for the mouse
- [ ] There is no save step: closing the story and reopening it shows the criteria I typed
- [ ] The story is a markdown file in that repository's `docs/user-stories/`, and the workspace tree shows it
- [ ] Run offers an address per story group, prefilled from that repository's running dev server when there is one
- [ ] A group can be pointed at a different address from another group of the same repository, and both run together
- [ ] An address a group was last run against is offered again the next time, rather than being re-typed
- [ ] Starting a run creates one agent session per selected story, and they appear on the Agents board
- [ ] When a run finishes, each story's row shows that run's verdict, and the run's report opens with a per-criterion result
- [ ] The run's report names the address each group of stories was walked against
