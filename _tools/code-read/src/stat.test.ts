import type { CodeAnalysis } from "./analysis.js";
import { codeLineStat, lineStat, rememberAnalyses } from "./stat.js";
import { analyze } from "./grammars.js";

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

        // The caller shows git's own numbers instead: the same fallback an unstrippable file takes.
        expect(lineStat(before, after)).toBeUndefined();
    });
});

// Against the real TypeScript grammar, for the same reason codeAnalysis is: the whole point of going through
// Shiki is that the comment spans are the tokenizer's.
describe(`codeLineStat`, () => {
    it(`reports nothing at all for a change that is only comments: the row's whole reason to say so`, async () => {
        const before = [`// old wording`, `const a = 1;`].join(`\n`);
        const after = [`// new wording, at some length`, `// and a second line of it`, `const a = 1;`].join(`\n`);

        expect(await codeLineStat(before, after, `a.ts`, analyze)).toEqual({ additions: 0, deletions: 0 });
    });

    it(`counts the code in a change that is mostly prose`, async () => {
        const before = [`const a = 1;`].join(`\n`);
        const after = [`/* a paragraph`, ` * about what`, ` * this does */`, `const a = 1;`, `const b = 2;`].join(`\n`);

        // Four of the five added lines are comment; git would call this +4.
        expect(await codeLineStat(before, after, `a.ts`, analyze)).toEqual({ additions: 1, deletions: 0 });
    });

    it(`counts a trailing comment's line as changed only when its code changed`, async () => {
        expect(await codeLineStat(`const a = 1; // why`, `const a = 1; // a better why`, `a.ts`, analyze)).toEqual({ additions: 0, deletions: 0 });
        expect(await codeLineStat(`const a = 1; // why`, `const a = 2; // why`, `a.ts`, analyze)).toEqual({ additions: 1, deletions: 1 });
    });

    it(`declines a file it has no grammar to strip, so the caller keeps git's numbers`, async () => {
        expect(await codeLineStat(`one`, `two`, `notes.unknownext`, analyze)).toBeUndefined();
    });

    it(`follows the grammar into another language's comment syntax`, async () => {
        const before = [`# a shell note`, `echo hi`].join(`\n`);
        const after = [`# a different note`, `echo hi`, `echo bye`].join(`\n`);

        expect(await codeLineStat(before, after, `run.sh`, analyze)).toEqual({ additions: 1, deletions: 0 });
    });
});

describe(`rememberAnalyses`, () => {
    // An analyzer that answers with the text itself and says what it was asked, in order.
    const counting = () => {
        const asked: string[] = [];
        const answer = (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => {
            asked.push(`${lang}:${text}`);
            return Promise.resolve({ code: { text, lines: [] }, imports: [] });
        };
        return { asked, answer };
    };

    it(`reads a side it has already read only once, so a recount tokenizes just the side that moved`, async () => {
        const { asked, answer } = counting();
        const remembered = rememberAnalyses(answer, 1_000);

        await codeLineStat(`const a = 1;\n`, `const a = 2;\n`, `a.ts`, remembered);
        await codeLineStat(`const a = 1;\n`, `const a = 3;\n`, `a.ts`, remembered);

        expect(asked).toEqual([`typescript:const a = 1;\n`, `typescript:const a = 2;\n`, `typescript:const a = 3;\n`]);
    });

    it(`reads a text again under another language, and after its reading was dropped for room`, async () => {
        const { asked, answer } = counting();
        const remembered = rememberAnalyses(answer, 8);

        await remembered(`aaaa`, `ts`);
        await remembered(`aaaa`, `js`);
        await remembered(`bbbb`, `js`);
        await remembered(`cccc`, `js`);
        await remembered(`aaaa`, `js`);

        // Eight characters hold two texts: `cccc` pushed `aaaa` out, so the last ask is a fresh read.
        expect(asked).toEqual([`ts:aaaa`, `js:aaaa`, `js:bbbb`, `js:cccc`, `js:aaaa`]);
    });

    it(`keeps the text it was just asked for even when that alone is over budget`, async () => {
        const { asked, answer } = counting();
        const remembered = rememberAnalyses(answer, 2);

        await remembered(`long text`, `ts`);
        await remembered(`long text`, `ts`);

        expect(asked).toEqual([`ts:long text`]);
    });

    it(`does not keep a reading that failed`, async () => {
        let calls = 0;
        const remembered = rememberAnalyses(() => {
            calls += 1;
            return Promise.reject(new Error(`grammar gone`));
        }, 1_000);

        await expect(remembered(`x`, `ts`)).rejects.toThrow(`grammar gone`);
        await expect(remembered(`x`, `ts`)).rejects.toThrow(`grammar gone`);
        expect(calls).toBe(2);
    });
});
