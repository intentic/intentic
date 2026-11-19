# Checks and CI: what runs on your work, and what holds it back (nothing)

You decide when the work is done: nothing sends you back, and no check holds a land, a commit or a push.

- A repository's per-edit checks run on each file you write and answer in that edit's result. On a loop with no hook
  after a tool call, they run on the files its edits touched as the turn ends instead.
- When an isolated turn is about to stop, a repository's `turn` checks run once on what it changed and what they find
  is said back to you once, on every loop (Claude Code from its Stop hook, Codex from its gate's stop, any other loop
  as one more prompt): fix what is yours, or say why not. Never after a run that failed or was stopped.
- After the land only a dependency install runs, when the land moved a manifest.
- CI checks what the owner commits and pushes, and when main's CI fails one fix agent (the `ci-fix-<repo>-<run>`
  conversation) is sent every failure until it passes, while **Repair main when its CI fails** (Sandbox ▸ Agent ▸
  Finishing) is on. The **Pipelines** view shows it (`editor.md`). A job the CI runners failed rather than the code (a
  self-hosted runner that lost its connection or was shut down, no runner taking the job, a runner-owned step, a full
  disk) starts no agent: a run only they failed has its failed jobs re-run once and the owner is told which runner, on
  which machine, did what; failing on the runners again is left to the owner. A job past its time limit with no step of
  its own failing is re-run once first too, and goes to the agent if it fails again. In a run the code failed as well,
  the agent gets the code's failures and is told which jobs were the runners' and why.

So run the checks you judge worth running while you work, scoped to what you changed: the test files that cover it and
a typecheck of what you changed (`lsp diag --changed`), never the whole repository (`pnpm test`, `pnpm typecheck`,
`pnpm verify`, an unfiltered `turbo run`) nor a full typecheck that takes minutes and gigabytes (a Vue app's
`vue-tsc`), since several conversations share the machine and CI runs those on push. A failure in code you did not touch may be main's own, and
it is not yours to chase unless your task is about it. Your card records whether a check passed after your last edit;
`mcp__diagnostics__turns` with `only: "unproven"` lists the turns that changed code and ran no check after their last
edit, or whose last check failed. Those runs take turns with every other conversation's in one queue that also picks
cargo's jobs and waits for memory; what its lines mean, a project's own heavy scripts, and timing runs:
`heavy-commands.md`.

**Is a failing test yours?** A test command's failed run (cargo test or nextest, bun test; vitest, jest, pytest and go
test best-effort) ends with a digest: each failing test with its first panic or error line, the counts, and per failure
`also fails at main@<sha> (seen <when>)`, `new: passes at main@<sha>` or `new: not seen failing at main@<sha>`. Every
test run is recorded, and one on a clean tree at a main commit is that commit's baseline: your first run in a fresh
worktree, before any edit, is one, and so is `base run <command>` where `base` is installed. Where none is recorded the
digest says which command makes one. Read the digest instead of piping the run through `grep` or running main yourself;
the full output stays retrievable with `retrieve-output`. `agents ci` lists what those baselines saw fail beside CI's
failures. cargo's compiler output comes with its errors first and each repeated warning folded to one line.

## A repository's own checks: `<repo>/.intentic/checks.json`

What THAT repository asks to have run on its own code: a list of `{when: "edit" | "turn", run: "<command>"}`, run in the
repository itself: `"edit"` on each file as it is written (`{file}` is its path), `"turn"` once as an isolated turn is
about to stop, said back to the agent when it fails. `"land"` is retired: a declaration naming it parses and runs
nothing. Tracked in the repository, so it travels with a clone; inert until the owner switches it on (Sandbox ▸ Agent ▸
Tools ▸ **Checks after edits**, or the repo's own row in the tree). A check added or rewritten afterwards waits for the
owner again; the ones they agreed to keep running. Propose one as an ordinary diff; never expect a check you just wrote
to run this turn.
