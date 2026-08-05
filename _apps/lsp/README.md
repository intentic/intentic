# @intentic/lsp

An **agent-native TypeScript CLI** over the TS language service — `lsp rename <file> <symbol> <newName>`
(project-wide rename) and `lsp diag <file...>` (syntactic + semantic diagnostics). Despite the name it is
**not** a language-server host: nothing connects to it over LSP. TypeScript/JavaScript only.

**It refuses rather than guesses.** A tsconfig whose `extends` chain cannot be resolved, or a program whose
type foundations (`@types`, global types) did not load, makes TypeScript fall back to decade-old defaults and
report phantom errors — `Map` unknown, `node:path` unresolvable — on healthy code. Every surface here treats
that as *unanswerable*: the daemon returns the file as `unavailable` with the reason, the CLI prints
`… unavailable: <reason>` and exits 2, and rename declines instead of renaming the subset of usages a blind
program can see. "Checked, and clean" and "could not check" are never conflated.

**One daemon per view of the tree.** The resident daemon's socket is keyed on the root's identity (`dev:ino`),
not its path — an isolated worktree that mounts its own tree over the same path gets its own daemon that
actually sees that tree, instead of sharing one that answers about different files by the same name.

`.vue` imports resolve through a built-in shim as `any`: unchecked here (that is vue-tsc's job) rather than
falsely reported as missing modules.

**The CLI is a dependency island**, baked onto the sandbox image's PATH
([_apps/sandbox/Dockerfile](../sandbox/Dockerfile)) and advertised to the coding agent through a gated skill
file ([settings/skills](../sandbox/src/settings)). The one library surface is `@intentic/lsp/client`
(node-builtins only, no compiler in the importer's heap), which the sandbox daemon uses for post-edit
diagnostics feedback.
