# Read what changed without reading code

As someone who does not write code, I want to see what a change did to my document the way a word processor shows tracked changes, so that I can judge it without learning what a diff is.

I open a What's new row. It lists the files that changed at that point, and I press the one I wrote most of. For a document, the two versions show as one text with what was added underlined and what was removed struck through, paragraph by paragraph. A control on the bar switches to the code view if I ever want it. The developer's default is the code view, mine is the prose one.

## Acceptance criteria

- [ ] Opening a What's new row lists the files that changed at that point, each with a mark for added, changed or removed
- [ ] Pressing a markdown file opens it in the workspace's diff tab, in the prose reading, when the audience is "I don't write code"
- [ ] In the prose reading, added words are marked as insertions and removed words as deletions, and unchanged paragraphs read plainly
- [ ] The diff bar offers Prose and Code for a markdown file, and the choice is kept for the next markdown diff
- [ ] A developer's audience opens the same file in the code diff by default
