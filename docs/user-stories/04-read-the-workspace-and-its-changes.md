# Read the workspace, and see what changed in it

As someone who has just been handed work by several agents, I want one place that shows the files
and one that shows the deltas, so that "what does this code look like" and "what did today do to it"
are two clicks, not two tools.

I open the workspace. Every repository under it is in the tree; opening a file opens it as a tab, and
my tabs are still there when I come back to the browser tomorrow. The changes view is the same
workspace addressed by delta instead of by path: every modified file, grouped by repository, with its
diff on selection. Searching finds a file by its name and a line by its content, so I do not have to
remember where something lives to go to it.

## Acceptance criteria

- [ ] The workspace shows a file tree of the repositories under it, and directories expand and collapse
- [ ] Opening a file from the tree opens it as a tab and shows its contents
- [ ] The open tabs are still open after a full page reload
- [ ] The changes view lists every modified file, grouped by repository, with how much each changed
- [ ] Selecting a changed file shows its diff, with the old and new content distinguishable
- [ ] Searching by a filename finds the file, and searching by a phrase inside a file finds that file
- [ ] A binary or image file opens as a preview rather than as unreadable text
