# @intentic/lsp

An **agent-native TypeScript CLI** over the TS language service — `lsp rename <file> <symbol> <newName>`
(project-wide rename) and `lsp diag <file...>` (syntactic + semantic diagnostics). Despite the name it is
**not** a language-server host: nothing connects to it over LSP. TypeScript/JavaScript only.

**It is a dependency island.** No workspace package imports `@intentic/lsp`; it is a standalone `bin`
baked onto the sandbox image's PATH ([_apps/sandbox/Dockerfile](../sandbox/Dockerfile)) and advertised to
the coding agent through a gated skill file ([settings/skills](../sandbox/src/settings)). Keep it that way —
do not import this package into app or daemon code.
