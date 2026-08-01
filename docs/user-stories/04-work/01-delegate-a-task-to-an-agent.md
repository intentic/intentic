# Delegate a task without giving up your working tree

As someone with a checkout I am in the middle of, I want to hand a task to an agent and carry on typing in my own editor, so that the agent's edits never appear in my tree until I have read them.

This is the first thing the product is for, and the first thing a new user should get to do — everything before it was setup. I open the Agents board. It is a kanban of three lanes — **Attention**, **Active**, **Finished** — because the board's whole job is routing me to the agents that need me. I press **New agent**, a fresh conversation opens with the caret already in its composer, and I describe the task the way I would describe it to a colleague.

From then on the card is the thing I watch. It works on its own branch in its own worktree, so nothing it writes touches the tree I am editing; it moves itself between lanes as its turn runs and settles; and while it works it says what it is doing right now, so "is it stuck or is it thinking" is answerable without opening the transcript.

## Acceptance criteria

- [ ] The Agents board shows the three lanes Attention, Active and Finished, and a New agent action
- [ ] Pressing New agent opens an empty conversation with the caret already in its composer, without a page reload
- [ ] Sending the first message puts that conversation on the board as its own card, in the Active lane while its turn runs
- [ ] The card names a branch of its own (`agent/…`), not the branch the workspace is on
- [ ] The card's title becomes a short name derived from the task instead of staying "New agent"
- [ ] The card says which agent and model it is running, so a fleet on several providers is readable at a glance
- [ ] While the turn runs the card shows the agent's current activity, and it updates without reloading the page
- [ ] When the turn settles the card moves to Finished on its own, and stays on the board rather than disappearing
