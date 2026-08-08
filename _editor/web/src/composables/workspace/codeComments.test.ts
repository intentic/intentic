import { describe, expect, it } from "vitest";
import { analyzeCode, modelLineOf } from "./codeAnalysis";

// Against the real TypeScript grammar — the point of going through Shiki is that the comment spans are the
// tokenizer's, so a test with a hand-rolled fake grammar would be testing nothing.

describe(`comment analysis`, () => {
    it(`drops comment lines and keeps the source line of everything left`, async () => {
        const source = [
            `/* header`, //          1
            ` * lines */`, //        2
            ``, //                   3
            `const a = 1; // why`, // 4
            ``, //                   5
            `// a note`, //          6
            ``, //                   7
            `const b = f(/* n */ 2);`, // 8
        ].join(`\n`);

        expect((await analyzeCode(source, `typescript`))?.code).toEqual({
            // The trailing comment goes with the line it sits on; the one wedged inside the call stays, because
            // cutting it would splice the statement. Blank lines survive — except the one left behind by a
            // removed block, which collapses into the blank already there.
            text: [`const a = 1;`, ``, `const b = f(/* n */ 2);`].join(`\n`),
            lines: [4, 5, 8],
        });
    });

    it(`keeps indented code whose comment trails it, and drops indented comment lines whole`, async () => {
        const source = [`function f() {`, `    // explain`, `    return 1; // the answer`, `}`].join(`\n`);

        expect((await analyzeCode(source, `typescript`))?.code).toEqual({
            text: [`function f() {`, `    return 1;`, `}`].join(`\n`),
            lines: [1, 3, 4],
        });
    });

    it(`empties a file that is nothing but comments`, async () => {
        expect((await analyzeCode([`// one`, `// two`].join(`\n`), `typescript`))?.code).toEqual({ text: ``, lines: [] });
    });

    it(`leaves comment-looking text inside a string alone`, async () => {
        const source = [`const url = "https://example.com"; // a link`, `const hash = "# not a comment";`].join(`\n`);

        expect((await analyzeCode(source, `typescript`))?.code).toEqual({
            text: [`const url = "https://example.com";`, `const hash = "# not a comment";`].join(`\n`),
            lines: [1, 2],
        });
    });

    it(`makes a comment-only edit vanish — the whole reason the diff is computed on the stripped text`, async () => {
        const before = [`// old wording`, `const a = 1;`].join(`\n`);
        const after = [`// new wording, at length`, ``, `const a = 1;`].join(`\n`);

        const left = await analyzeCode(before, `typescript`);
        const right = await analyzeCode(after, `typescript`);
        expect(left?.code.text).toBe(right?.code.text);
    });

    it(`declines the whole job for a language we ship no grammar for`, async () => {
        expect(await analyzeCode(`# hi`, undefined)).toBeUndefined();
        expect(await analyzeCode(`# hi`, `not-a-language`)).toBeUndefined();
    });

    it(`follows the grammar into another language's comment syntax`, async () => {
        const source = [`# a shell note`, `echo hi  # trailing`].join(`\n`);

        expect((await analyzeCode(source, `bash`))?.code).toEqual({ text: `echo hi`, lines: [2] });
    });
});

// The way back: the file viewer jumps to a line of the FILE (a content-search hit, the scroll position it holds
// across the toggle), and the view it lands in is short by every comment above it.
describe(`modelLineOf`, () => {
    // The stripped view of a 6-line file whose lines 1, 2 and 5 were comments.
    const lines = [3, 4, 6];

    it(`lands on the view's own line for a line that survived`, () => {
        expect(modelLineOf(lines, 3)).toBe(1);
        expect(modelLineOf(lines, 4)).toBe(2);
        expect(modelLineOf(lines, 6)).toBe(3);
    });

    it(`lands on the code a removed comment introduces`, () => {
        expect(modelLineOf(lines, 1)).toBe(1); // the header comment ⇒ the first line of code under it
        expect(modelLineOf(lines, 5)).toBe(3);
    });

    it(`stops at the end for a line past everything kept`, () => {
        expect(modelLineOf(lines, 99)).toBe(3);
        // A view with nothing in it still has to name a line — Monaco has no line 0.
        expect(modelLineOf([], 1)).toBe(1);
    });
});
