# Write a promise down, and have it tested for you

As someone who keeps re-checking the same flows by hand after every change, I want to write what the product promises once and have agents walk it through the running app, so that "does sign-in still work" is answered by a report rather than by me clicking.

Writing one has to be cheaper than not bothering. In the Acceptance area I type a title into the row at the end of the list and press Enter — the story exists, as a markdown file in the repo it belongs to, and its row is already open for the criteria. Each criterion is a line; Enter opens the next one. Nothing asks me to save, because the file in the repo is the story.

Then I run it. Each story becomes one isolated agent session that opens the app in a real browser, walks every criterion, screenshots what it saw, and writes a verdict. Afterwards the list itself carries the answer: every story row shows where that promise currently stands.

## Acceptance criteria

- [ ] The Acceptance area lists every repository that can hold stories, and each story's criteria count
- [ ] Typing a title into the composer row and pressing Enter creates the story and opens its row for editing
- [ ] Pressing Enter in a criterion opens the next criterion, without reaching for the mouse
- [ ] There is no save step: closing the story and reopening it shows the criteria I typed
- [ ] The story is a markdown file in that repository's `docs/user-stories/`, and the workspace tree shows it
- [ ] Run offers an address per repository, prefilled from that repository's running dev server when there is one
- [ ] Starting a run creates one agent session per selected story, and they appear on the Agents board
- [ ] When a run finishes, each story's row shows that run's verdict, and the run's report opens with a per-criterion result
