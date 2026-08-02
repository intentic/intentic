# Watch it come up, and be let in the moment it does

As someone who has just run the command in another window, I want the browser to notice on its own and open my workspace, so that the last step of setup is not me refreshing a page and wondering whether it worked.

The final step is a live gate. It says it is waiting, it says what will happen when the wait ends, and it ends by itself — the sandbox announces itself when it starts and the workspace opens. There is nothing to press: the page re-asks the platform every few seconds on its own, so a button offering to do that again would buy no time and would only make pressing it look like progress.

The wait also says which wait it is, because there are two and they are nothing alike. Until my machine redeems the setup code, nothing is happening anywhere and the page says so plainly — an idle status light, not a spinner. Once it has been redeemed, the sandbox really is being built and the spinner is honest.

When the wait is not going well, the page says so rather than spinning. A platform it cannot reach is a different problem from a sandbox that has not started, and I need to know which one I have before I go looking at Docker. If nothing has reached us at all after a while, it says the likeliest reason out loud — that the command is still on my clipboard — and offers it to me again. And once I do have a workspace, the way back into it is on this page too — a returning user who wandered here should not be trapped in setup.

## Acceptance criteria

- [ ] The final step says it is waiting and explains that the workspace opens by itself when the sandbox reports in
- [ ] Before the command has been redeemed anywhere, the step says nothing is running yet and shows no spinner
- [ ] Once the setup code has been redeemed, the step says so and reports that the sandbox is being built
- [ ] After a while with nothing redeemed, the step says the command has to be run in a terminal and offers it for copying again
- [ ] No manual re-check control is offered, since the page already polls on its own
- [ ] When the platform cannot be reached, the step says so instead of continuing to look like it is waiting
- [ ] The wait does not require reloading the page: leaving the page open is enough for it to progress
- [ ] A user who already owns a sandbox is offered a way back to the workspace from setup
- [ ] A user who owns no sandbox is not offered that way back, since it would only return them here
- [ ] Reloading the page mid-setup keeps me on the same sandbox's setup rather than starting a blank one
