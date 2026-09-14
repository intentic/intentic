# Ask for a change and see it happen

As someone who does not write code, I want to ask my assistant for a change and find it applied, with a line saying what it did, so that the work reads like a colleague's note rather than a code review.

From the Project page I ask, in chat, for a pricing section on the site. The assistant works on its own. When it finishes, its change is already in the project (the rules from the arrival card), and the Project page's What's new gains a row for it: the sentence drafted for the change on top, "You asked: …" underneath, and the time. Pressing See it opens the site running, with the section on it.

## Acceptance criteria

- [ ] With the two rules on, a clean turn's changes are in the project without a Ready card appearing
- [ ] What's new shows a new row for the turn, headed by the drafted sentence when one was written, with the prompt beneath it
- [ ] The row's time reads relative ("3 minutes ago") and the rows are grouped under Today, Yesterday, then dates
- [ ] See it opens the Preview area on this project's own running target
- [ ] With the version rule on, `git log` in the project shows a commit whose subject is the drafted sentence
