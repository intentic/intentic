import { describe, expect, it } from "vitest";
import { codeLineStat, lineStat } from "./codeStat";

describe(`lineStat`, () => {
    it(`counts the lines a minimal diff would report`, () => {
        const before = [`a`, `b`, `c`].join(`\n`);
        const after = [`a`, `B`, `c`, `d`].join(`\n`);

        // b → B is one of each; d is an addition on its own.
        expect(lineStat(before, after)).toEqual({ additions: 2, deletions: 1 });
    });

    it(`reports nothing for two identical sides`, () => {
        expect(lineStat(`a\nb`, `a\nb`)).toEqual({ additions: 0, deletions: 0 });
    });

    it(`counts a whole file on the side that has one`, () => {
        expect(lineStat(``, `a\nb\nc`)).toEqual({ additions: 3, deletions: 0 });
        expect(lineStat(`a\nb\nc`, ``)).toEqual({ additions: 0, deletions: 3 });
    });

    it(`sees a move as the lines it moved, not as the whole file`, () => {
        const before = [`one`, `two`, `three`, `four`].join(`\n`);
        const after = [`two`, `three`, `four`, `one`].join(`\n`);

        expect(lineStat(before, after)).toEqual({ additions: 1, deletions: 1 });
    });

    it(`gives up rather than pay for two large sides with nothing in common`, () => {
        const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join(`\n`);
        const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join(`\n`);

        // The caller shows git's own numbers instead — the same fallback an unstrippable file takes.
        expect(lineStat(before, after)).toBeUndefined();
    });
});

// Against the real TypeScript grammar, for the same reason codeAnalysis is: the whole point of going through
// Shiki is that the comment spans are the tokenizer's.
describe(`codeLineStat`, () => {
    it(`reports nothing at all for a change that is only comments — the row's whole reason to say so`, async () => {
        const before = [`// old wording`, `const a = 1;`].join(`\n`);
        const after = [`// new wording, at some length`, `// and a second line of it`, `const a = 1;`].join(`\n`);

        expect(await codeLineStat(before, after, `a.ts`)).toEqual({ additions: 0, deletions: 0 });
    });

    it(`counts the code in a change that is mostly prose`, async () => {
        const before = [`const a = 1;`].join(`\n`);
        const after = [`/* a paragraph`, ` * about what`, ` * this does */`, `const a = 1;`, `const b = 2;`].join(`\n`);

        // Four of the five added lines are comment; git would call this +4.
        expect(await codeLineStat(before, after, `a.ts`)).toEqual({ additions: 1, deletions: 0 });
    });

    it(`counts a trailing comment's line as changed only when its code changed`, async () => {
        expect(await codeLineStat(`const a = 1; // why`, `const a = 1; // a better why`, `a.ts`)).toEqual({ additions: 0, deletions: 0 });
        expect(await codeLineStat(`const a = 1; // why`, `const a = 2; // why`, `a.ts`)).toEqual({ additions: 1, deletions: 1 });
    });

    it(`declines a file it has no grammar to strip, so the caller keeps git's numbers`, async () => {
        expect(await codeLineStat(`one`, `two`, `notes.unknownext`)).toBeUndefined();
    });

    it(`follows the grammar into another language's comment syntax`, async () => {
        const before = [`# a shell note`, `echo hi`].join(`\n`);
        const after = [`# a different note`, `echo hi`, `echo bye`].join(`\n`);

        expect(await codeLineStat(before, after, `run.sh`)).toEqual({ additions: 1, deletions: 0 });
    });
});
