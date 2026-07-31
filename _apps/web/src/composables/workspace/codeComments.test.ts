// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { stripComments } from "./codeComments";

// The @intentic-app/ui barrel that carries useHighlighter reaches window.matchMedia (useDevice) at import — hence
// jsdom plus the stub jsdom itself doesn't ship. Nothing under test touches the DOM.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

// Against the real TypeScript grammar — the point of going through Shiki is that the comment spans are the
// tokenizer's, so a test with a hand-rolled fake grammar would be testing nothing.

describe(`stripComments`, () => {
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

        expect(await stripComments(source, `typescript`)).toEqual({
            // The trailing comment goes with the line it sits on; the one wedged inside the call stays, because
            // cutting it would splice the statement. Blank lines survive — except the one left behind by a
            // removed block, which collapses into the blank already there.
            text: [`const a = 1;`, ``, `const b = f(/* n */ 2);`].join(`\n`),
            lines: [4, 5, 8],
        });
    });

    it(`keeps indented code whose comment trails it, and drops indented comment lines whole`, async () => {
        const source = [`function f() {`, `    // explain`, `    return 1; // the answer`, `}`].join(`\n`);

        expect(await stripComments(source, `typescript`)).toEqual({
            text: [`function f() {`, `    return 1;`, `}`].join(`\n`),
            lines: [1, 3, 4],
        });
    });

    it(`empties a file that is nothing but comments`, async () => {
        expect(await stripComments([`// one`, `// two`].join(`\n`), `typescript`)).toEqual({ text: ``, lines: [] });
    });

    it(`leaves comment-looking text inside a string alone`, async () => {
        const source = [`const url = "https://example.com"; // a link`, `const hash = "# not a comment";`].join(`\n`);

        expect(await stripComments(source, `typescript`)).toEqual({
            text: [`const url = "https://example.com";`, `const hash = "# not a comment";`].join(`\n`),
            lines: [1, 2],
        });
    });

    it(`makes a comment-only edit vanish — the whole reason the diff is computed on the stripped text`, async () => {
        const before = [`// old wording`, `const a = 1;`].join(`\n`);
        const after = [`// new wording, at length`, ``, `const a = 1;`].join(`\n`);

        const left = await stripComments(before, `typescript`);
        const right = await stripComments(after, `typescript`);
        expect(left?.text).toBe(right?.text);
    });

    it(`declines the whole job for a language we ship no grammar for`, async () => {
        expect(await stripComments(`# hi`, undefined)).toBeUndefined();
        expect(await stripComments(`# hi`, `not-a-language`)).toBeUndefined();
    });

    it(`follows the grammar into another language's comment syntax`, async () => {
        const source = [`# a shell note`, `echo hi  # trailing`].join(`\n`);

        expect(await stripComments(source, `bash`)).toEqual({ text: `echo hi`, lines: [2] });
    });
});
