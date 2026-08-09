# @intentic/lsp

An agent-native CLI over the TypeScript language service: project-wide rename, and diagnostics.

`lsp rename <file> <symbol> <newName>` and `lsp diag <file...>`. Despite the name it is **not** a language-server
host — nothing connects to it over LSP. TypeScript and JavaScript only.

**It refuses rather than guesses.** A tsconfig whose `extends` chain cannot be resolved, or a program whose
type foundations (`@types`, global types) did not load, makes TypeScript fall back to decade-old defaults and
report phantom errors — `Map` unknown, `node:path` unresolvable — on healthy code. Every surface here treats
that as *unanswerable*: the daemon returns the file as `unavailable` with the reason, the CLI prints
`… unavailable: <reason>` and exits 2, and rename declines instead of renaming the subset of usages a blind
program can see. "Checked, and clean" and "could not check" are never conflated.

**One daemon per view of the tree.** The resident daemon's socket is keyed on the root's identity (`dev:ino`),
not its path — an isolated worktree that mounts its own tree over the same path gets its own daemon that
actually sees that tree, instead of sharing one that answers about different files by the same name.

*Per view, and exactly one.* Starting one costs a whole-monorepo parse, so the socket does not exist for
seconds after the spawn — long enough that a burst of edits (a turn fanning out subagents) used to start a
service each, every one of them a ~1 GB program and all but one unreachable. Two rules close that: the client
warms a root once and later askers wait on that same warm-up, and a daemon that finds someone already answering
at its socket stands down instead of unlinking it and binding over the top. A socket nobody answers on is the
only one treated as stale.

**A caller can put the service somewhere it cannot stand itself.** Identity keying cuts both ways: because the
name is not in it, one directory named differently on either side of a mount boundary yields one socket. So a
caller outside a mount namespace can find — or start, through a wrapper it supplies — a daemon *inside* it, and
ask in that namespace's own names (`DiagnoseOptions.service` in [src/client.ts](src/client.ts)). This is not a
nicety: an isolated turn's `node_modules` are empty mount points on disk with the installed tree bound in only
for the turn, so a checker started outside resolves nothing at all. The sandbox's post-edit hook is the caller
that needs it.

`.vue` imports resolve through a built-in shim as `any`: unchecked here (that is vue-tsc's job) rather than
falsely reported as missing modules.

**The CLI is a dependency island**, baked onto the sandbox image's PATH
([_sandbox/sandbox/Dockerfile](../../_sandbox/sandbox/Dockerfile)) and advertised to the coding agent through a gated skill
file ([settings/skills](../../_sandbox/sandbox/src/settings)). The one library surface is `@intentic/lsp/client`
(node-builtins only, no compiler in the importer's heap), which the sandbox daemon uses for post-edit
diagnostics feedback.

## Key files

- [src/rename.ts](src/rename.ts) — project-wide rename, and what it refuses to do.
- [src/diag.ts](src/diag.ts) — syntactic and semantic diagnostics.
- [src/project.ts](src/project.ts) — resolving a tsconfig into a program; where "refuse rather than guess" lives.
- [src/daemon.ts](src/daemon.ts) — the warm process that makes a second call fast.
- [src/cli.ts](src/cli.ts) — the entry point.
