import { analyzeCode } from "./analysis.js";
import { grammars } from "./grammars.js";
import { highlightLangFor } from "./lang-for-path.js";
import { type CodeCount, codeLineStat, lineStat } from "./stat.js";

// codeLineStat tokenizes a change's unchanged stretches once and may skip the tail; its answer must be exactly what the
// full walk of both sides gives, for any edit. Edits are drawn from lines that move the walk's state: block comments
// left open, comments inside strings, blanks after removed comments, and a final newline come and gone.

const reference = async (before: string, after: string, path: string): Promise<CodeCount | undefined> => {
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === `` ? before : after);
    const [old, now] = await Promise.all([analyzeCode(before, lang, grammars), analyzeCode(after, lang, grammars)]);
    if (old === undefined || now === undefined) {
        return undefined;
    }
    const stat = lineStat(old.code.text, now.code.text);
    return stat === undefined ? { dissimilar: true as const } : { stat };
};

// Seeded, so a failure names a case that replays.
const random = (seed: number): (() => number) => {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
};

const VOCABULARY: Record<string, readonly string[]> = {
    "a.ts": [
        `const a = 1;`,
        `function f() {`,
        `}`,
        `return x;`,
        `const b = 2; // why`,
        `// a note`,
        `/* opens a block`,
        ` * inside it`,
        ` */`,
        `/** one-line doc */`,
        `const s = "// not a comment";`,
        "const t = `/* nor this`;",
        "const u = `",
        "`;",
        ``,
        `   `,
    ],
    "run.sh": [`echo hi`, `# a note`, `x=1 # why`, `cat <<'EOF'`, `# inside a heredoc`, `EOF`, ``, `if true; then`, `fi`],
    "notes.md": [`# Title`, `Some prose.`, `<!-- hidden`, `still hidden -->`, "```ts", `// code comment`, "```", ``, `- item`],
};

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

const edited = (next: () => number, lines: readonly string[], vocabulary: readonly string[]): string[] => {
    const out = [...lines];
    for (let edits = 1 + Math.floor(next() * 4); edits > 0; edits--) {
        const at = Math.floor(next() * (out.length + 1));
        const kind = next();
        if (kind < 0.4) {
            out.splice(at, 0, pick(next, vocabulary));
        } else if (kind < 0.7 && out.length > 0) {
            out.splice(Math.min(at, out.length - 1), 1);
        } else if (out.length > 0) {
            out[Math.min(at, out.length - 1)] = pick(next, vocabulary);
        }
    }
    return out;
};

const text = (next: () => number, lines: readonly string[]): string => lines.join(`\n`) + (next() < 0.5 ? `\n` : ``);

describe(`codeLineStat`, () => {
    for (const [path, vocabulary] of Object.entries(VOCABULARY)) {
        it(`answers exactly what the full walk of both sides does, for any edit of ${path}`, async () => {
            for (let seed = 1; seed <= 150; seed++) {
                const next = random(seed);
                const base = Array.from({ length: 5 + Math.floor(next() * 40) }, () => pick(next, vocabulary));
                const before = text(next, base);
                const after = text(next, edited(next, base, vocabulary));
                expect({ seed, stat: await codeLineStat(before, after, path, grammars) }).toEqual({ seed, stat: await reference(before, after, path) });
            }
        });
    }

    // A tail of nothing but comments keeps no code, so the file's final newline falls to whichever middle ends it: one
    // side's empty last line is that newline, the other's blank of spaces is a line.
    it(`answers the full walk when the shared tail keeps no code and the middles end on different blanks`, async () => {
        for (const ending of [``, `\n`]) {
            const before = [`const a = 1;`, ``, `// end`].join(`\n`) + ending;
            const after = [`const a = 1;`, `   `, `// end`].join(`\n`) + ending;
            expect(await codeLineStat(before, after, `a.ts`, grammars)).toEqual(await reference(before, after, `a.ts`));
        }
        for (let seed = 1; seed <= 150; seed++) {
            const next = random(seed);
            const code = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(next, [`const a = 1;`, `f();`, ``, `   `]));
            const trailer = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(next, [`// end`, `/* end */`, ``]));
            const before = text(next, [...code, ...trailer]);
            const after = text(next, [...edited(next, code, [`const a = 1;`, ``, `   `, `// mid`]), ...trailer]);
            expect({ seed, stat: await codeLineStat(before, after, `a.ts`, grammars) }).toEqual({ seed, stat: await reference(before, after, `a.ts`) });
        }
    });

    it(`answers the full walk for an added file, a deleted one, and one that did not change`, async () => {
        const file = [`/* a header`, ` */`, `const a = 1; // why`, ``, `// end`].join(`\n`);
        for (const [before, after] of [
            [``, file],
            [file, ``],
            [file, file],
        ] as const) {
            expect(await codeLineStat(before, after, `a.ts`, grammars)).toEqual(await reference(before, after, `a.ts`));
        }
    });
});
