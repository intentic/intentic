import { useHighlighter } from "@intentic/ui/highlighter";
import type * as Monaco from "monaco-editor-core";
import { describe, expect, it } from "vitest";
import { analyzeCode } from "./codeAnalysis";
import { firstChangeBeyondImports, type ImportSide } from "./codeImports";

// Against the real grammars — the point of reading TextMate scopes is that the answer is the tokenizer's, so a
// test with a hand-rolled fake grammar would be testing nothing. The languages below are the ones whose import
// syntax the scope families were derived from, and the traps are the lines that LOOK like imports to a regex.

/* The grammar is COMPILED first, so that the walk under test is not the one paying for it. The tokenizer compiles
 * a rule's regexes the first time a line reaches them, once per language per session — C++'s come to ~0.6s on an
 * idle machine against ~4ms a line once compiled — and that compile is charged to the walk's hang guard
 * (codeTokens' TIME_BUDGET). On a runner busy enough, the guard is what fires: the walk abandons the file, and the
 * empty set it hands back reads here as the grammar's ANSWER rather than as a busy machine. That is exactly how
 * the C++ case below failed on CI, where every package's suite runs at once and a walk measures ~10× an idle one.
 * The warm-up runs the same lines through the same grammar under no limit at all — the 0 the tokenizer reads as
 * unbounded — so the walk that follows spends only the per-line cost these assertions are about. */
const lines = async (source: readonly string[], lang: string): Promise<ReadonlySet<number>> => {
    const grammar = (await useHighlighter().ensureLang(lang))?.getLanguage(lang);
    if (grammar !== undefined) {
        // Carried, like the walk's own stack — a line inside an open statement reaches rules a fresh one doesn't.
        let stack: Parameters<typeof grammar.tokenizeLine>[1] = null;
        for (const line of source) {
            stack = grammar.tokenizeLine(line, stack, 0).ruleStack;
        }
    }
    return new Set((await analyzeCode(source.join(`\n`), lang))?.imports ?? []);
};

describe(`import analysis`, () => {
    it(`takes a multi-line import whole, and stops at the code below it`, async () => {
        const source = [
            `import { ref, type Ref, watch } from "vue";`, // 1
            `import {`, //                                    2
            `    createTerminalSession,`, //                   3
            `} from "./sessions";`, //                         4
            ``, //                                             5
            `const a = ref(1);`, //                            6
            `const url = import.meta.url;`, //                 7
        ];

        expect(await lines(source, `typescript`)).toEqual(new Set([1, 2, 3, 4]));
    });

    it(`reads the imports inside a Vue SFC's script block`, async () => {
        const source = [`<script setup lang="ts">`, `import { ref } from "vue";`, `const a = ref(1);`, `</script>`];

        expect(await lines(source, `vue`)).toEqual(new Set([2]));
    });

    it(`carries a bracketed import onto the lines the grammar leaves as plain code`, async () => {
        // Go's import block lists bare strings and Python's bare names — neither is scoped as an import, so the
        // unclosed bracket is the only thing that says those lines are still the statement above them.
        const go = [`package main`, ``, `import (`, `    "os"`, `    m "math"`, `)`, ``, `func main() {}`];
        expect(await lines(go, `go`)).toEqual(new Set([3, 4, 5, 6]));

        const python = [`from x import (`, `    a,`, `    b,`, `)`, `import os`, ``, `x = 1`];
        expect(await lines(python, `python`)).toEqual(new Set([1, 2, 3, 4, 5]));
    });

    // Six grammars compiled from cold in one test, C++ among them, is seconds of real work rather than the
    // milliseconds every other test here spends — and the suite-wide timeout is sized for the milliseconds. Its
    // own budget, then, big enough that only a hang reaches it on a runner shared with every other suite.
    it(`covers the other languages we ship a grammar for`, async () => {
        expect(await lines([`use std::collections::HashMap;`, `pub fn main() {}`], `rust`)).toEqual(new Set([1]));
        expect(await lines([`package a;`, `import java.util.List;`, `class A {}`], `java`)).toEqual(new Set([2]));
        expect(await lines([`import Foundation`, `class A {}`], `swift`)).toEqual(new Set([1]));
        expect(await lines([`require "json"`, `class A; end`], `ruby`)).toEqual(new Set([1]));
        expect(await lines([`#include <vector>`, `int main() {}`], `cpp`)).toEqual(new Set([1]));
        expect(await lines([`@import "./base.css";`, `.a { color: red; }`], `css`)).toEqual(new Set([1]));
    }, 60_000);

    it(`leaves alone the lines that only LOOK like imports`, async () => {
        // A C# using STATEMENT is a scoped resource, not a directive; SCSS's @include invokes a mixin; Ruby's
        // `include` mixes a module into a class. All three would fall to a regex over the first word.
        const csharp = [`using System;`, `class A {`, `    void m() { using var x = f(); }`, `}`];
        expect(await lines(csharp, `csharp`)).toEqual(new Set([1]));

        const scss = [`@use "sass:math";`, `.a {`, `    @include button;`, `}`];
        expect(await lines(scss, `scss`)).toEqual(new Set([1]));

        const ruby = [`require "json"`, `module A`, `  include Comparable`, `end`];
        expect(await lines(ruby, `ruby`)).toEqual(new Set([1]));
    });

    it(`finds nothing to skip in a language we ship no grammar for`, async () => {
        expect(await lines([`import os`], `not-a-language`)).toEqual(new Set());
        expect((await analyzeCode(`import os`, undefined))?.imports ?? []).toEqual([]);
    });
});

// A hunk as Monaco reports it. An END of 0 is how it says a side wasn't touched: `hunk(0, 0, 4, 4)` is a pure
// insertion at line 4 of the modified file, `hunk(4, 4, 3, 0)` a deletion of original line 4, after modified 3.
const hunk = (originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number): Monaco.editor.ILineChange => ({
    originalStartLineNumber: originalStart,
    originalEndLineNumber: originalEnd,
    modifiedStartLineNumber: modifiedStart,
    modifiedEndLineNumber: modifiedEnd,
    charChanges: undefined,
});

const sideOf = async (source: readonly string[]): Promise<ImportSide> => ({
    lines: source,
    imports: await lines(source, `typescript`),
});

describe(`firstChangeBeyondImports`, () => {
    // The file from the report: an import gains a symbol at the top, and the change worth reading is far below.
    const before = [`import { a } from "./a";`, `import { b } from "./b";`, ``, `const x = 1;`, `const y = 2;`];
    const after = [`import { a, c } from "./a";`, `import { b } from "./b";`, ``, `const x = 1;`, `const y = 3;`];

    it(`passes over an import-only hunk and lands on the code change`, async () => {
        const changes = [hunk(1, 1, 1, 1), hunk(5, 5, 5, 5)];

        expect(firstChangeBeyondImports(changes, await sideOf(before), await sideOf(after))).toBe(changes[1]);
    });

    it(`opens on the first change when every hunk is imports — there is nothing else to show`, async () => {
        const changes = [hunk(1, 1, 1, 1), hunk(2, 2, 2, 2)];

        expect(firstChangeBeyondImports(changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`stops on a hunk that adds an import AND the code under it`, async () => {
        // One hunk, because the two changed lines are adjacent — skipping it would hide a real change.
        const grown = [`import { a } from "./a";`, `import { c } from "./c";`, `const x = 2;`];
        const changes = [hunk(2, 2, 2, 3)];

        expect(firstChangeBeyondImports(changes, await sideOf([`import { a } from "./a";`, `const x = 1;`]), await sideOf(grown))).toBe(changes[0]);
    });

    it(`counts a blank line pulled out with an import as part of that import hunk`, async () => {
        // Deleting the last import of a group takes the blank line after it; the hunk is still only imports.
        const trimmed = [`import { a } from "./a";`, `const x = 1;`];
        const changes = [hunk(2, 3, 1, 0), hunk(5, 5, 3, 3)];

        expect(firstChangeBeyondImports(changes, await sideOf(before), await sideOf(trimmed))).toBe(changes[1]);
    });

    it(`stops on blank-line churn — the preference skips imports, not everything dull`, async () => {
        const changes = [hunk(3, 3, 3, 0)];

        expect(firstChangeBeyondImports(changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`reads an insertion at the very top of a file — where Monaco reports the untouched side as line 0`, async () => {
        const grown = [`import { c } from "./c";`, ...before];
        const changes = [hunk(0, 0, 1, 1), hunk(4, 4, 5, 5)];

        expect(firstChangeBeyondImports(changes, await sideOf(before), await sideOf(grown))).toBe(changes[1]);
    });

    it(`has nowhere to land when nothing changed`, () => {
        expect(firstChangeBeyondImports([], { lines: [], imports: new Set() }, { lines: [], imports: new Set() })).toBeUndefined();
    });
});
