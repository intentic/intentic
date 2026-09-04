---
title: "One worktree per agent, and why the count stops mattering"
description: "Running several coding agents at once fails on shared state long before it fails on model quality. A git worktree each is the boundary that fixes it."
date: 2026-09-04
tags: ["engineering"]
---

The first thing that breaks when you run two coding agents on one repository is not the model. It is the
working tree. Both agents read the same files, both edit them, and the second one to write wins. You find out
when the tests fail for a reason neither agent did.

## The usual workarounds do not scale past two

The obvious fix is to take turns: let one agent finish before starting the next. That works, and it also
throws away the reason you wanted several agents. The next fix is branches, which is closer — but a branch is
a pointer, not an isolated directory. Two agents on two branches in one clone still share one checkout, one
`node_modules`, and one set of dirty files.

What you actually need is for each agent's edits to be invisible to every other agent until you say
otherwise.

## A worktree is that boundary, and git already has it

`git worktree` gives one repository several checked-out directories, each on its own branch, sharing one
object store. Two agents in two worktrees cannot see each other's uncommitted work. They can both run the
test suite. Neither can leave the other's tree dirty.

That is the arrangement intentic uses: every agent gets a sandbox, and inside it a worktree of its own. The
practical consequence is that the number of agents stops being a thing you have to think about. Ten agents in
ten worktrees interfere with each other exactly as much as one does, which is not at all.

## What moves the cost somewhere else

Isolation is the easy half. The hard half is that ten finished changes now need reviewing, and merging them
is where the conflicts you avoided earlier come back. They come back in a better place — a diff you are
reading, rather than a test failure you are debugging — but they do come back.

So the thing worth optimising is not how many agents you can start. It is how quickly you can read what one
finished and decide. That is a different problem to the one most tooling is solving, and it is the one that
binds once isolation is handled.
