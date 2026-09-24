import { fuzzyRanker, fuzzyScore, rankByFuzzy } from "./fuzzy.js";

test("a substring beats a subsequence over the same path", () => {
    expect(fuzzyScore("widget", "alpha/src/widget.ts")!).toBeGreaterThan(fuzzyScore("wdgt", "alpha/src/widget.ts")!);
});

test("a basename hit beats a directory hit, and a shorter path beats a longer one", () => {
    expect(fuzzyScore("src", "alpha/src/widget.ts")!).toBeLessThan(fuzzyScore("widget", "alpha/src/widget.ts")!);
    expect(fuzzyScore("widget", "a/widget.ts")!).toBeGreaterThan(fuzzyScore("widget", "alpha/beta/gamma/widget.ts")!);
});

test("boundary-aligned and consecutive hits beat scattered ones", () => {
    // `fp` opens two words in fuzzy/paths.ts; in `affixups.ts` the same letters sit mid-word.
    expect(fuzzyScore("fp", "fuzzy/paths.ts")!).toBeGreaterThan(fuzzyScore("fp", "affixups.ts")!);
});

test("a camelCase hump counts as a boundary, which is why the original case is read and not the lowered one", () => {
    expect(fuzzyScore("fs", "fuzzyScore.ts")!).toBeGreaterThan(fuzzyScore("fs", "fuzzysecond.ts")!);
});

test("no match, an empty needle, and a needle longer than the path are all undefined, never 0", () => {
    expect(fuzzyScore("zzz", "notes.md")).toBeUndefined();
    expect(fuzzyScore("", "notes.md")).toBeUndefined();
    expect(fuzzyScore("notes.md.extra", "notes.md")).toBeUndefined();
});

test("a subsequence score stays within 0..1, while a substring score may pass 1 on purpose", () => {
    // The substring branch is deliberately uncapped so path length still separates two otherwise equal hits; a
    // caller that SHOWS the number (iq's `fuzzy` tag) clamps it, and one that only ranks by it must not.
    expect(fuzzyScore("wdgt", "alpha/src/widget.ts")!).toBeLessThanOrEqual(1);
    expect(fuzzyScore("wdgt", "alpha/src/widget.ts")!).toBeGreaterThan(0);
    expect(fuzzyScore("notes", "notes.md")!).toBeGreaterThan(1);
});

const CORPUS = [
    "_sandbox/sandbox/src/sessions/store.ts",
    "_sandbox/sandbox/src/sessions/search.ts",
    "_editor/web/src/App.vue",
    "sand/box.md",
    "README.md",
];

test("a ranker answers every keystroke exactly as a fresh ranking would, through backspace, case and a new collection", () => {
    const rank = fuzzyRanker();
    const typed = ["s", "sa", "san", "sand", "sa", "SAND", "sandb", "sandbox/se", "x", "xs"];
    for (const needle of typed) {
        expect(rank(needle, CORPUS)).toEqual(rankByFuzzy(needle, CORPUS));
    }
    const grown = [...CORPUS, "sandy/beach.ts"];
    expect(rank("sandb", grown)).toEqual(rankByFuzzy("sandb", grown));
});

test("a ranker scores only the last answer's paths while the query grows over the same collection", () => {
    let walked = 0;
    const paths = Object.assign([...CORPUS], {
        *[Symbol.iterator](this: string[]) {
            for (const path of Array.prototype.values.call(this)) {
                walked += 1;
                yield path;
            }
        },
    });
    const rank = fuzzyRanker();
    rank("s", paths);
    expect(walked).toBe(CORPUS.length);
    rank("sa", paths);
    rank("san", paths);
    expect(walked).toBe(CORPUS.length);
    rank("s", paths);
    expect(walked).toBe(CORPUS.length * 2);
});
