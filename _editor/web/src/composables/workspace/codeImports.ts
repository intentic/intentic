import type * as Monaco from "monaco-editor-core";
import { isBlank, leadToken, scopedAs, type Token, walkTokens } from "./codeTokens";

/* Which lines of a file are its imports — the part of a diff that useLayout.skipImports scrolls past.
 *
 * A diff opens on its first change, and in most files that change is the import list: an added symbol, a moved
 * specifier, a path rewritten by a rename. It is real, it is never why the file was opened, and it costs the
 * reader a scroll on every file of every review. Knowing which lines are imports is what lets the diff land
 * below them instead (DiffView) — the lines are still there to scroll up to, nothing is hidden.
 *
 * What counts as an import comes off the same TextMate grammar the comment strip reads (codeTokens), so one rule
 * covers every language we ship highlighting for rather than a table of per-language regexes to drift.
 *
 * The rule is the line's FIRST non-blank token: some grammars scope the whole statement (`meta.import.ts` spans a
 * multi-line import and its continuation lines with it), others only the keyword, and the lead token is the one
 * they agree on. It is also what keeps `const url = import.meta.url` and C#'s `using var x = f()` out — both
 * carry an import-ish scope somewhere, neither opens with one.
 *
 * What no grammar scopes is the INSIDE of a bracketed import: Go's `import ( … )` lists bare strings and
 * Python's `from x import ( … )` bare names, both tokenized as ordinary code. So a bracket the statement leaves
 * open carries it onto the lines below, counted over code tokens only — a bracket inside a string opens nothing. */

/* The scope families that name an import, each annotated with the languages that produce it (verified against
 * the grammars we ship, not guessed). Matched as a dotted prefix, which is what keeps SCSS's `@include` — a
 * mixin call, and real code — out of `meta.include`: its scope is `meta.at-rule.include.scss`. */
const IMPORT_SCOPES = [
    `meta.import`, // ts, js, java, kotlin, swift — and the ts/js embedded in vue, svelte, astro
    `keyword.control.import`, // python, go, php's require/require_once
    `meta.use`, // rust, php
    `meta.include`, // php
    `meta.preprocessor.include`, // c, c++
    `meta.require`, // ruby
    `meta.at-rule.import`, // css, scss
    `meta.at-rule.use`, // scss
    `keyword.other.directive.using`, // c# — its using STATEMENT scopes as keyword.control.context.using
];

const OPENING = `([{`;
const CLOSING = `)]}`;

const opensImport = (token: Token): boolean => IMPORT_SCOPES.some((family) => scopedAs(token.scopes, family));

// Brackets this line leaves open. Strings and comments are skipped, so `import "a(b"` closes nothing it never
// opened, and an untokenized line (undefined) can only be read as opening nothing.
const openedBy = (line: string, tokens: readonly Token[] | undefined): number => {
    let depth = 0;
    for (const token of tokens ?? []) {
        if (scopedAs(token.scopes, `string`) || scopedAs(token.scopes, `comment`)) {
            continue;
        }
        for (const char of line.slice(token.startIndex, token.endIndex)) {
            if (OPENING.includes(char)) {
                depth += 1;
            }
            if (CLOSING.includes(char)) {
                depth -= 1;
            }
        }
    }
    return depth;
};

// The 1-based lines of `text` that are import statements. Empty for a language we ship no grammar for, or a file
// the walk gave up on: the caller then has nothing to skip, which is how a diff reads without the preference.
export const importLines = async (text: string, lang: string | undefined): Promise<ReadonlySet<number>> => {
    const imports = new Set<number>();
    let open = 0;
    const walked = await walkTokens(text, lang, (line, tokens, index) => {
        const lead = tokens === undefined ? undefined : leadToken(line, tokens);
        if (lead === undefined) {
            return; // blank, or a line too long to tokenize — neither an import nor the end of one
        }
        if (open === 0 && !opensImport(lead)) {
            return;
        }
        imports.add(index + 1);
        open = Math.max(0, open + openedBy(line, tokens));
    });
    return walked ? imports : new Set();
};

// One side of a diff, as the hunk scan reads it: its lines as the pane holds them, and which of them are imports.
export type ImportSide = { lines: readonly string[]; imports: ReadonlySet<number> };

// What one side lost or gained in a hunk, each line paired with whether the scan called it an import. Monaco
// reports an `end` of 0 where the hunk doesn't touch this side at all — a pure insertion has no original lines.
const hunkLines = (side: ImportSide, start: number, end: number): { text: string; isImport: boolean }[] => {
    const lines: { text: string; isImport: boolean }[] = [];
    if (end === 0) {
        return lines; // untouched — and the start it pairs with is the line the change sits AFTER, not a line of it
    }
    for (let line = start; line <= end; line += 1) {
        lines.push({ text: side.lines[line - 1] ?? ``, isImport: side.imports.has(line) });
    }
    return lines;
};

// A hunk nobody opened the file for: every line it touched, on both sides, is an import or blank. One of them has
// to BE an import, so a hunk of pure blank-line churn still stops the scroll — this skips imports, not everything
// a reader might have found uninteresting.
const importsOnly = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): boolean => {
    const lines = [
        ...hunkLines(before, change.originalStartLineNumber, change.originalEndLineNumber),
        ...hunkLines(after, change.modifiedStartLineNumber, change.modifiedEndLineNumber),
    ];
    return lines.some((line) => line.isImport) && lines.every((line) => line.isImport || isBlank(line.text));
};

// Which hunk a diff should open on: the first that changes something other than an import — or, when every hunk
// is imports, the first of them, since the file then has nothing else to show. Undefined if nothing changed.
export const firstChangeBeyondImports = (
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => changes.find((change) => !importsOnly(change, before, after)) ?? changes[0];
