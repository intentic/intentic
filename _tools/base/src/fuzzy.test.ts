import { fuzzyRanker, fuzzyScore, rankByFuzzy, topByFuzzy } from "./fuzzy.js";

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
    // caller that SHOWS the number clamps it, and one that only ranks by it must not.
    expect(fuzzyScore("wdgt", "alpha/src/widget.ts")!).toBeLessThanOrEqual(1);
    expect(fuzzyScore("wdgt", "alpha/src/widget.ts")!).toBeGreaterThan(0);
    expect(fuzzyScore("notes", "notes.md")!).toBeGreaterThan(1);
});

test.each([
    [18, 0.34555252833478634],
    [19, 0.3371275466893039],
    [20, 0.32872208436724565],
])("pins the subsequence score as the gap and the path grow, with %i padding characters", (padding, score) => {
    expect(fuzzyScore("ab", `a${"x".repeat(padding)}/b`)).toBe(score);
});

test("every whitespace- or comma-separated term must match, in any order", () => {
    const path = "test/smoke/src/main.ts";
    expect(fuzzyScore("smoke main.ts", path)).toBe(0.9421052631578948);
    expect(fuzzyScore("main.ts smoke", path)).toBe(fuzzyScore("smoke main.ts", path));
    expect(fuzzyScore("smoke, main", path)).toBe(fuzzyScore("smoke main", path));
    expect(fuzzyScore("smoke nope", path)).toBeUndefined();
    expect(fuzzyScore("   ", path)).toBeUndefined();
});

test("the best alignment is found, not the first: a decoy letter ahead of the word starts changes nothing", () => {
    // A greedy walk takes the decoy `f` in `aaf` and scores a scattered match; the alignment on f-uzzy and p-aths wins.
    expect(fuzzyScore("fp", "aaf/fuzzy-paths.ts")).toBe(fuzzyScore("fp", "aaa/fuzzy-paths.ts"));
    expect(fuzzyScore("fp", "aaa/fuzzy-paths.ts")).toBe(0.5907910341555976);
});

test("a hit in the file's own name beats one in its folders, however much shorter the folders' path is", () => {
    expect(fuzzyScore("widget", "src/components/widget.ts")).toBe(1.0533333333333332);
    expect(fuzzyScore("widget", "w/widget/a.ts")).toBe(0.8251724137931035);
});

test("in the name, the name's start beats a word's start, which beats mid-word, whatever the lengths", () => {
    expect(fuzzyScore("store", "src/store.ts")).toBe(1.0683928571428571);
    expect(fuzzyScore("store", "src/session-store.ts")).toBe(1.0144444444444445);
    expect(fuzzyScore("store", "src/sessionstore.ts")).toBe(0.9957142857142857);
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
    const typed = ["s", "sa", "san", "sand", "sa", "SAND", "sandb", "sandbox/se", "x", "xs", " ", " s", "store ", "store s", "store se", "st,", "st,r"];
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

// Paths a limited ranking has to choose among: contiguous hits that fill the cut, and scattered ones whose alignment it
// must work out only when they could still make it.
const MANY = Array.from({ length: 400 }, (_, index) => `pkg-${index % 7}/src/${["store", "stream", "sorted", "session-tree", "s-t-o-r-e"][index % 5]}/file${index}.ts`);

test.each([
    ["store", 10],
    ["stre", 10],
    ["sxt", 5],
    ["s t", 25],
    ["store file1", 3],
    ["sxt", 0],
])("a limited ranking of %j answers the full ranking's first %i, scores and all", (needle, limit) => {
    const full = rankByFuzzy(needle, MANY);
    expect(topByFuzzy(needle, MANY, limit)).toEqual({ ranked: full.slice(0, limit), matched: full.length });
});

test("a limited ranker answers every keystroke as a fresh limited ranking would", () => {
    const rank = fuzzyRanker();
    for (const needle of ["s", "st", "sto", "store", "store ", "store f", "store fi", "sx", "sxt"]) {
        expect(rank(needle, MANY, 7)).toEqual(topByFuzzy(needle, MANY, 7).ranked);
    }
});
