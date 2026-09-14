# Go back

As someone who does not write code, I want to undo the last change from the panel that lists it, so that a wrong turn costs one press and no vocabulary.

A change I asked for made the homepage worse. In the project's Versions panel I open its row, which lists the files that changed, and press Go back to this. The panel says what will happen in plain words and asks once. After I confirm, the files are as they were before that change, a new row says the files were restored, and the row I went back from is still there above it.

## Acceptance criteria

- [ ] Every Versions row offers "Go back to this", which asks for confirmation in plain words before doing anything
- [ ] After confirming, the project's files are as they stood before that point, and the tree reflects it
- [ ] The panel gains a row saying the files were restored, and keeps the rows for what came before and after
- [ ] Nothing about the git branches or the sandbox's secrets changes
