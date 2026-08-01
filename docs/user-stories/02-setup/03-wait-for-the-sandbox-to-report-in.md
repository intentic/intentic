# Watch it come up, and be let in the moment it does

As someone who has just run the command in another window, I want the browser to notice on its own and open my workspace, so that the last step of setup is not me refreshing a page and wondering whether it worked.

The final step is a live gate. It says it is waiting, it says what will happen when the wait ends, and it ends by itself — the sandbox announces itself when it starts and the workspace opens. There is a Check now for the impatient, which is a courtesy rather than the mechanism.

When the wait is not going well, the page says so rather than spinning. A platform it cannot reach is a different problem from a sandbox that has not started, and I need to know which one I have before I go looking at Docker. And once I do have a workspace, the way back into it is on this page too — a returning user who wandered here should not be trapped in setup.

## Acceptance criteria

- [ ] The final step says it is waiting and explains that the workspace opens by itself when the sandbox reports in
- [ ] A Check now action re-checks immediately and shows that it is checking
- [ ] When the platform cannot be reached, the step says so instead of continuing to look like it is waiting
- [ ] The wait does not require reloading the page: leaving the page open is enough for it to progress
- [ ] A user who already owns a sandbox is offered a way back to the workspace from setup
- [ ] A user who owns no sandbox is not offered that way back, since it would only return them here
- [ ] Reloading the page mid-setup keeps me on the same sandbox's setup rather than starting a blank one
