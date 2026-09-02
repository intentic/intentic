# @intentic/code-read

How the product reads source code: which grammar a path is tokenized with, which of its lines are comment, and
how big a change is once those are out of it.

## Responsibilities

- Resolve a path to a Shiki grammar, once, so the colours, the comment-free diff and the counts beside it cannot
  disagree about what a file is.
- Walk a file's TextMate tokens a line at a time, and answer the two structural questions a review asks of that
  walk: which lines are comment, and which are imports.
- Count a change with the comments stripped from both sides, the +/− every review row shows.

## Key files

- [src/langs.ts](src/langs.ts): the grammar table, a map of lazy `@shikijs/langs` imports keyed by Shiki language
  id, plus `ShikiLang` (the ids, as a type) and the list Vite pre-bundles. The import specifiers must stay
  literal: the bundler reads them to decide which grammar chunks to emit.
- [src/lang-for-path.ts](src/lang-for-path.ts): extension and filename tables, the dockerfile/.env/ignore
  specials, the shebang fallback VSCode uses for extensionless scripts, and the size cap past which nothing is
  tokenized at all.
- [src/tokens.ts](src/tokens.ts): the walk. Takes its grammars from the caller (`Grammars`), which is the seam
  between the two sides below.
- [src/analysis.ts](src/analysis.ts): one walk, two answers, the comment-free source and the import lines.
- [src/stat.ts](src/stat.ts): `lineStat` (a minimal diff's two counts, from one longest-common-subsequence pass)
  and `codeLineStat` (the same, with both sides stripped first).
- [src/grammars.ts](src/grammars.ts): a Shiki core for a process with no screen. The daemon's; the app does not
  use it.

## How it fits

A changed file is read twice in this product, on two sides of the wire, and both readings come from here.

The **daemon** counts it when it builds a change list ([git/code-counts.ts](../../_sandbox/sandbox/src/git/code-counts.ts)),
so the +/− a review row shows is final the first time the reader sees it. That is the whole reason this package
exists as a package: the app used to compute those counts itself, from the diffs as they happened to be fetched,
which meant a badge changed under whoever was reading it and a list sorted by size re-sorted on the click that
selected a row.

The **app** renders it: the diff surface strips the comments out of both sides before Monaco sees them, and lands
the diff below the imports. It supplies the renderer's own Shiki core as the `Grammars` source, because those
grammars are already loaded to colour the file — a second core would compile and hold every one of them again.

The two must agree to the line, or a row's badge describes a diff its pane is not showing. They agree because it
is the same walk over the same table, resolved by the same rule; the only thing either side brings is where the
grammar comes from.

## Conventions & gotchas

- Nothing here imports a framework, and nothing reaches for a global core. A caller passes `Grammars` in.
- A partial answer is never returned. If the grammar is missing or the walk is abandoned (the budget in
  `tokens.ts`), `analyzeCode` answers `undefined` and every caller falls back to git's own numbers, which for
  such a file are the honest reading anyway.
- Lines are counted the way git counts them: a trailing newline terminates the last line, it does not begin
  another. Getting that wrong reads as one phantom added line on every file whose other side is empty.
- Adding a language is two edits: a row in `langs.ts` and an extension in `lang-for-path.ts`. The `ShikiLang`
  type is what stops a surface naming a grammar this build does not ship.
