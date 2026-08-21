# @intentic/lsp

An agent-native CLI over the native TypeScript compiler: project-wide rename, and diagnostics.

`lsp rename <file> <symbol> <newName>` and `lsp diag <file...>`. Despite the name it is **not** a language-server
host: every question is answered by a fresh run of the native compiler (`@typescript/native-preview`, the Go
port of TypeScript), which parses the file's tsconfig project, answers, and exits. TypeScript and JavaScript only.

**Nothing stays resident.** This package used to keep a warm JS-compiler daemon per view of the tree: ~1 GB of
LanguageService held through a 15-minute idle window, times one per concurrent agent worktree, which made it the
largest steady memory cost on a busy box. The native compiler checks a package-sized project cold in 0.1–2s: at
or below what the daemon answered in warm through its socket: so the daemon, its unix-socket protocol, and its
cold-start races are simply gone. What bursts of edits still need is not residency but restraint: the client
single-flights concurrent asks per project and pools every ask that arrives mid-run into ONE trailing rerun
(the rerun is mandatory: a queued ask exists because an edit just landed, so the in-flight answer is stale for
it by construction).

**It refuses rather than guesses.** A tsconfig whose `extends` chain cannot be resolved, or a program whose type
foundations (@types, global types) did not load, makes the compiler report phantom errors on healthy code:
confident, specific, and wrong. Every surface here treats that as *unanswerable*: the check returns the file as
`unavailable` with the reason, the CLI prints `unavailable: <reason>` and exits 2, and rename declines instead of
renaming the subset of usages a blind program can see. One refusal is native-era new: the native compiler does
not auto-include @types from PARENT node_modules directories the way the JS one does, so a program tripping over
missing node globals while an ancestor `node_modules/@types` exists is refused: the caller's own toolchain
would have loaded them, and relaying the errors would gaslight it. "Checked, and clean" and "could not check"
are never conflated.

**.vue imports go unchecked, not falsely broken.** Resolving `.vue` modules is the Vue toolchain's job
(vue-tsc); the checker drops the module-shape errors those imports produce and keeps every other diagnostic in
the file real: the same silence the old engine bought by shimming them to `any`, without writing into anyone's
tree.

**A caller can run the check where it could not stand itself.** An isolated turn's node_modules are empty mount
points on disk with the installed tree bound in only inside the turn's namespace, so a checker outside resolves
nothing at all. The caller supplies a placement (`CheckPlacement` in [src/checker.ts](src/checker.ts)) that
wraps the compiler's argv (an `nsenter` into the turn) and the check runs in the namespace's own names,
answering in the paths the agent uses. The sandbox's post-edit hook is the caller that needs it.

Rename is the one question the batch compiler cannot answer, so it holds one short conversation with the native
compiler's language server (`tsgo --lsp`), anchors the symbol by name via the server's own document outline
(falling back to a lexical scan the server vets position by position), applies the returned workspace edit, and
tears the server down.

**The CLI is a dependency island**, baked onto the sandbox image's PATH
([_sandbox/sandbox/Dockerfile](../../_sandbox/sandbox/Dockerfile)) and advertised to the coding agent through a
gated skill file ([settings/skills](../../_sandbox/sandbox/src/settings)). The one library surface is
`@intentic/lsp/client` (node builtins only: the compiler runs in the spawned process, never in the importer's
heap), which the sandbox daemon uses for post-edit diagnostics feedback.

## Key files

- [src/checker.ts](src/checker.ts): one compiler run over one project; refusal and .vue semantics live here.
- [src/client.ts](src/client.ts), the asking side: grouping by project, single-flight, the trailing rerun.
- [src/rename.ts](src/rename.ts): project-wide rename over one short `tsgo --lsp` conversation.
- [src/report.ts](src/report.ts): what a check can say, and the parser that reads the compiler's output.
- [src/cli.ts](src/cli.ts): the entry point.
