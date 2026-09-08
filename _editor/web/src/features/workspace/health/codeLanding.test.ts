import { useHighlighter } from "@intentic/ui/highlighter";
import type * as Monaco from "monaco-editor-core";
import { describe, expect, it } from "vitest";
import { analyzeInApp } from "../files/appGrammars";
import { landingChange, type ImportSide } from "./codeLanding";

// Tests against real grammars, not a hand-rolled fake, so the answer comes from the tokenizer itself. The
// languages below are picked for import syntax that could trip a naive regex.

// Compiles the grammar before the walk, so first-use regex compilation isn't charged to the walk's own
// hang-guard budget (TIME_BUDGET in codeTokens); an uncompiled grammar under load can silently return an empty set.
const lines = async (source: readonly string[], lang: string): Promise<ReadonlySet<number>> => {
    const grammar = (await useHighlighter().ensureLang(lang))?.getLanguage(lang);
    if (grammar !== undefined) {
        // Carried like the walk's own stack; a line inside an open statement reaches rules a fresh line wouldn't.
        let stack: Parameters<typeof grammar.tokenizeLine>[1] = null;
        for (const line of source) {
            stack = grammar.tokenizeLine(line, stack, 0).ruleStack;
        }
    }
    return new Set((await analyzeInApp(source.join(`\n`), lang))?.imports ?? []);
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
        // Go's import block lists bare strings, Python's bare names; only the bracket marks those lines as import.
        const go = [`package main`, ``, `import (`, `    "os"`, `    m "math"`, `)`, ``, `func main() {}`];
        expect(await lines(go, `go`)).toEqual(new Set([3, 4, 5, 6]));

        const python = [`from x import (`, `    a,`, `    b,`, `)`, `import os`, ``, `x = 1`];
        expect(await lines(python, `python`)).toEqual(new Set([1, 2, 3, 4, 5]));
    });

    // Six cold grammar compiles (C++ among them) cost real seconds; the timeout is sized for a hang, not the normal
    // cost.
    it(`covers the other languages we ship a grammar for`, async () => {
        expect(await lines([`use std::collections::HashMap;`, `pub fn main() {}`], `rust`)).toEqual(new Set([1]));
        expect(await lines([`package a;`, `import java.util.List;`, `class A {}`], `java`)).toEqual(new Set([2]));
        expect(await lines([`import Foundation`, `class A {}`], `swift`)).toEqual(new Set([1]));
        expect(await lines([`require "json"`, `class A; end`], `ruby`)).toEqual(new Set([1]));
        expect(await lines([`#include <vector>`, `int main() {}`], `cpp`)).toEqual(new Set([1]));
        expect(await lines([`@import "./base.css";`, `.a { color: red; }`], `css`)).toEqual(new Set([1]));
    }, 60_000);

    it(`leaves alone the lines that only LOOK like imports`, async () => {
        // A C# `using` statement is a resource, SCSS's `@include` a mixin, Ruby's `include` mixes in a module.
        const csharp = [`using System;`, `class A {`, `    void m() { using var x = f(); }`, `}`];
        expect(await lines(csharp, `csharp`)).toEqual(new Set([1]));

        const scss = [`@use "sass:math";`, `.a {`, `    @include button;`, `}`];
        expect(await lines(scss, `scss`)).toEqual(new Set([1]));

        const ruby = [`require "json"`, `module A`, `  include Comparable`, `end`];
        expect(await lines(ruby, `ruby`)).toEqual(new Set([1]));
    });

    it(`finds nothing to skip in a language we ship no grammar for`, async () => {
        expect(await lines([`import os`], `not-a-language`)).toEqual(new Set());
        expect((await analyzeInApp(`import os`, undefined))?.imports ?? []).toEqual([]);
    });
});

// A hunk as Monaco reports it; an end of 0 means that side wasn't touched, e.g. hunk(0, 0, 4, 4) is a pure
// insertion at line 4.
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

describe(`landing past the imports`, () => {
    // Import gains a symbol at the top; the change worth reading is further down.
    const before = [`import { a } from "./a";`, `import { b } from "./b";`, ``, `const x = 1;`, `const y = 2;`];
    const after = [`import { a, c } from "./a";`, `import { b } from "./b";`, ``, `const x = 1;`, `const y = 3;`];

    it(`passes over an import-only hunk and lands on the code change`, async () => {
        const changes = [hunk(1, 1, 1, 1), hunk(5, 5, 5, 5)];

        expect(landingChange(`imports`, changes, await sideOf(before), await sideOf(after))).toBe(changes[1]);
    });

    it(`opens on the first change when every hunk is imports, there is nothing else to show`, async () => {
        const changes = [hunk(1, 1, 1, 1), hunk(2, 2, 2, 2)];

        expect(landingChange(`imports`, changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`stops on a hunk that adds an import AND the code under it`, async () => {
        // One hunk, because the two changed lines are adjacent; skipping it would hide a real change.
        const grown = [`import { a } from "./a";`, `import { c } from "./c";`, `const x = 2;`];
        const changes = [hunk(2, 2, 2, 3)];

        expect(landingChange(`imports`, changes, await sideOf([`import { a } from "./a";`, `const x = 1;`]), await sideOf(grown))).toBe(changes[0]);
    });

    it(`counts a blank line pulled out with an import as part of that import hunk`, async () => {
        // Deleting the last import of a group takes the blank line after it; the hunk is still only imports.
        const trimmed = [`import { a } from "./a";`, `const x = 1;`];
        const changes = [hunk(2, 3, 1, 0), hunk(5, 5, 3, 3)];

        expect(landingChange(`imports`, changes, await sideOf(before), await sideOf(trimmed))).toBe(changes[1]);
    });

    it(`stops on blank-line churn: the preference skips imports, not everything dull`, async () => {
        const changes = [hunk(3, 3, 3, 0)];

        expect(landingChange(`imports`, changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`reads an insertion at the very top of a file, where Monaco reports the untouched side as line 0`, async () => {
        const grown = [`import { c } from "./c";`, ...before];
        const changes = [hunk(0, 0, 1, 1), hunk(4, 4, 5, 5)];

        expect(landingChange(`imports`, changes, await sideOf(before), await sideOf(grown))).toBe(changes[1]);
    });

    it(`has nowhere to land when nothing changed`, () => {
        expect(landingChange(`imports`, [], { lines: [], imports: new Set() }, { lines: [], imports: new Set() })).toBeUndefined();
    });
});

describe(`landing on the biggest change`, () => {
    // Small edit near the top, big block below; line numbers match since the block replaces rather than inserts.
    const before = [
        `import { a } from "./a";`, //  1
        ``, //                          2
        `const x = 1;`, //              3
        `const y = 2;`, //              4
        `const z = 3;`, //              5
        `const w = 4;`, //              6
    ];
    const after = [
        `import { a, c } from "./a";`, // 1
        ``, //                            2
        `const x = 2;`, //                3
        `const y = 20;`, //               4
        `const z = 30;`, //               5
        `const w = 40;`, //               6
    ];

    it(`skips a smaller earlier change for the heaviest block in the file`, async () => {
        const changes = [hunk(3, 3, 3, 3), hunk(4, 6, 4, 6)];

        expect(landingChange(`biggest`, changes, await sideOf(before), await sideOf(after))).toBe(changes[1]);
    });

    it(`never lands on imports, however many lines of them changed`, async () => {
        // A rename rewriting a whole import block is the largest hunk in the file and the least worth reading.
        const renamedBefore = [`import { a } from "./a";`, `import { b } from "./b";`, `import { c } from "./c";`, ``, `const x = 1;`];
        const renamedAfter = [`import { a } from "../a";`, `import { b } from "../b";`, `import { c } from "../c";`, ``, `const x = 2;`];
        const changes = [hunk(1, 3, 1, 3), hunk(5, 5, 5, 5)];

        expect(landingChange(`biggest`, changes, await sideOf(renamedBefore), await sideOf(renamedAfter))).toBe(changes[1]);
    });

    it(`falls back to the first hunk when every change is an import`, async () => {
        const changes = [hunk(1, 1, 1, 1)];

        expect(landingChange(`biggest`, changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`gives a tie to the earlier hunk: equal targets, less of the file left behind`, async () => {
        const changes = [hunk(3, 3, 3, 3), hunk(4, 4, 4, 4)];

        expect(landingChange(`biggest`, changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`does not let blank lines pad a hunk into the biggest one`, async () => {
        // Left is four lines, three blank; right is two lines of real code. The denser hunk wins.
        const padded = [`const a = 1;`, ``, ``, ``, `const b = 2;`, `const c = 3;`];
        const tightened = [`const a = 9;`, ``, ``, ``, `const b = 8;`, `const c = 7;`];
        const changes = [hunk(1, 4, 1, 4), hunk(5, 6, 5, 6)];

        expect(landingChange(`biggest`, changes, await sideOf(padded), await sideOf(tightened))).toBe(changes[1]);
    });

    it(`has nowhere to land when nothing changed`, () => {
        expect(landingChange(`biggest`, [], { lines: [], imports: new Set() }, { lines: [], imports: new Set() })).toBeUndefined();
    });
});

describe(`landing on top`, () => {
    const before = [`import { a } from "./a";`, `const x = 1;`, `const y = 2;`];
    const after = [`import { a, c } from "./a";`, `const x = 1;`, `const y = 3;`];

    it(`takes Monaco's own answer, import list and all`, async () => {
        const changes = [hunk(1, 1, 1, 1), hunk(3, 3, 3, 3)];

        expect(landingChange(`top`, changes, await sideOf(before), await sideOf(after))).toBe(changes[0]);
    });

    it(`has nowhere to land when nothing changed`, () => {
        expect(landingChange(`top`, [], { lines: [], imports: new Set() }, { lines: [], imports: new Set() })).toBeUndefined();
    });
});
