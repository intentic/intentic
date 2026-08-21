# Review an agent's changes and land them

As the person who is accountable for what ends up on main, I want to read everything an agent wrote as one reviewable body of changes and then apply it in one move, so that reviewing is a scan rather than an archaeology dig through a transcript.

I open the agent from its card. Its changed files are listed on the left and the diff of whichever file I am on renders beside them: the shape every code review has, because the job is scanning fast enough to decide. I tick files off as I read them, so a thirty-file change has a place to stop and resume. When I am satisfied I land it, and the agent's work becomes part of my workspace.

Landing is all-or-nothing by default: if some of it no longer applies, I want to be told which files and why, with my own tree left exactly as it was, rather than discovering half a change.

## Acceptance criteria

- [ ] Opening an agent that has written files shows a list of its changed files with the diff of the selected one beside it
- [ ] Each row shows the file's path and how much it changed, and files are grouped by repository when the agent touched more than one
- [ ] A file can be marked as reviewed, and the panel shows how many of the total have been
- [ ] Moving to the next and previous file works without leaving the review
- [ ] Landing applies the agent's changes to the main workspace, and the workspace's own file tree then shows them
- [ ] When part of the change cannot apply, the panel names the files that refused and the reason, and the workspace is left unchanged
- [ ] Discarding an agent's work asks for confirmation first, and afterwards the main workspace is unchanged
