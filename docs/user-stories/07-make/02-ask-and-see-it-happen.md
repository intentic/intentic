# Ask for a change and see it happen

As someone who does not write code, I want to ask my assistant for a change and find it applied, with a way to see the result, so that the work reads like a colleague's note rather than a code review.

From the Projects dashboard I open my site, which shows only that project's files. In chat I ask for a pricing section. The assistant works on its own. When it finishes, its change is already in the project (the rules from the arrival card), the Versions panel beside the files has a new row for it, and See it opens the site running with the section on it.

## Acceptance criteria

- [ ] With the two rules on, a clean turn's changes are in the project without a Ready card appearing
- [ ] The workspace's Versions panel (Restore points for a developer) shows a new row for the turn, titled by the prompt
- [ ] The dashboard names the site as one that can be looked at running, and its See it link opens the Preview area on this project's own target
- [ ] With the version rule on, `git log` in the project shows a commit whose subject is the drafted sentence
