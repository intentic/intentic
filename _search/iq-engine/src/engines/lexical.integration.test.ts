import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rgSearch } from "./lexical.js";

// What the lexical engine reports ABOUT a match, as opposed to which lines match: the spans a client marks. The
// dispatch-level tests cover the verb; these cover the offsets, which nothing above this file can reconstruct.

let root: string;
const allowed = new Set(["lines.md"]);

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-lexical-"));
    await writeFile(
        join(root, "lines.md"),
        ["own its own sandbox", "Ownership — own the machine, hardware you install", "ownership is the trust foundation"].join("\n"),
    );
});
afterAll(() => rm(root, { recursive: true, force: true }));

const search = async (pattern: string, options: { literal?: boolean; word?: boolean; caseSensitive?: boolean } = {}) =>
    (await rgSearch({ root, pattern, allowed, ...options })).hits;

test("every occurrence on a line comes back, not just the first", async () => {
    const hits = await search("own", { literal: true });
    const first = hits.find((hit) => hit.line === 1);
    expect(first?.spans).toEqual([
        { start: 0, end: 3 },
        { start: 8, end: 11 },
    ]);
});

test("spans index the string, not its bytes: a match after an em dash lands on the word", async () => {
    const hits = await search("hardware", { literal: true });
    const line = hits.find((hit) => hit.line === 2);
    const span = line?.spans?.[0];
    expect(span).toBeDefined();
    expect(line?.text.slice(span?.start, span?.end)).toBe("hardware");
});

test("case-insensitive by default: a capital in the pattern does not narrow the search", async () => {
    // ripgrep's smart case would have made this pattern case-SENSITIVE, which is the documented default's
    // opposite and not what a search box's Aa switch off means.
    const hits = await search("Own", { literal: true });
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
});

test("caseSensitive matches the pattern's own case", async () => {
    const hits = await search("Own", { literal: true, caseSensitive: true });
    expect(hits.map((hit) => hit.line)).toEqual([2]);
});

test("word matches whole words only", async () => {
    const hits = await search("own", { literal: true, word: true });
    expect(hits.map((hit) => hit.line)).toEqual([1, 2]);
});

test("literal takes a regex metacharacter as itself", async () => {
    expect(await search("you install", { literal: true })).toHaveLength(1);
    /* THE SAME PATTERN BOTH WAYS, which is the contrast this test is named for and now asserts in both
     * directions rather than one. As a regex the `.` is any character and finds the line; as a literal it is a
     * full stop, and no line carries one.
     *
     * It reads the corpus for its metacharacter rather than assuming a phrase, because that is exactly how this
     * broke: the fixture used to say "hardware you own" and the pattern was `you .wn`, and the commit that
     * rewrote the lines updated the literal assertion above and left this one expecting two matches for a
     * phrase no line contained any more. Asserting the literal side too means the next corpus edit takes both
     * halves with it or fails loudly. */
    expect(await search("you .nstall", {})).toHaveLength(1);
    expect(await search("you .nstall", { literal: true })).toHaveLength(0);
    // And across lines: the wildcard stands in for the 'w', so "Ownership" and "ownership" both hit.
    expect(await search("o.nership", {})).toHaveLength(2);
});

test("a file with more matches than the cap reports the cap AND that it is one", async () => {
    // The count a panel shows has to be a count or a floor, never a floor presented as a count. 60 matching
    // lines against a cap of 50: 50 come back, and the file is named as having had more.
    const many = "wide.md";
    await writeFile(join(root, many), Array.from({ length: 60 }, (_, index) => `needle ${index}`).join("\n"));
    const found = await rgSearch({ root, pattern: "needle", allowed: new Set([many]), literal: true });
    expect(found.hits).toHaveLength(50);
    expect([...found.capped]).toEqual([many]);
});

test("a file that stops exactly at the cap is not reported as capped", async () => {
    const exact = "exact.md";
    await writeFile(join(root, exact), Array.from({ length: 50 }, (_, index) => `needle ${index}`).join("\n"));
    const found = await rgSearch({ root, pattern: "needle", allowed: new Set([exact]), literal: true });
    expect(found.hits).toHaveLength(50);
    expect([...found.capped]).toEqual([]);
});

/* WHAT THE SCANNER IS ASKED TO WALK, which is a different question from what it is allowed to report.
 *
 * Every path here is in `allowed`, so the post-filter would let all of them through: anything missing from a
 * result is missing because ripgrep never read it. That is the whole point of the assertion, because the bug
 * these guard was exactly a subtree the sweep discarded and the scanner read anyway, at a cost of 1.4 GB of
 * output and 67 seconds on a two-letter query. */
describe("the prune list", () => {
    let tree: string;
    const everything = new Set(["top.md", "refs/shelf.md", "myrepo/refs/nested.md", "repo/.claude/worktrees/copy/dup.md"]);
    const found = async (options: { ignored?: boolean } = {}) =>
        (await rgSearch({ root: tree, pattern: "needle", literal: true, allowed: everything, ...options })).hits.map((hit) => hit.path);

    beforeAll(async () => {
        tree = await mkdtemp(join(tmpdir(), "iq-prune-"));
        for (const path of everything) {
            await mkdir(join(tree, path, ".."), { recursive: true });
            await writeFile(join(tree, path), "needle\n");
        }
    });
    afterAll(() => rm(tree, { recursive: true, force: true }));

    test("the reference shelf is not walked, and a repo's own refs/ still is", async () => {
        const paths = await found();
        expect(paths).not.toContain("refs/shelf.md");
        expect(paths).toContain("myrepo/refs/nested.md");
        expect(paths).toContain("top.md");
    });

    test("agent worktrees are not walked: a throwaway checkout would duplicate every file in its repo", async () => {
        expect(await found()).not.toContain("repo/.claude/worktrees/copy/dup.md");
    });

    test("--ignored lifts both, because the sweep admits both under it", async () => {
        expect(await found({ ignored: true })).toEqual([...everything].toSorted());
    });
});

/* THE SCAN'S CEILING. Two units because a panel pages in two units, and the flag because a count that stopped
 * early is a floor and has to say so. */
describe("the scan ceiling", () => {
    let tree: string;
    // Three files of 40 matching lines each, so a 50-hit ceiling has to land INSIDE the second one.
    const ceilingFiles = new Set(["a.md", "b.md", "c.md"]);

    beforeAll(async () => {
        tree = await mkdtemp(join(tmpdir(), "iq-ceiling-"));
        for (const name of ceilingFiles) {
            await writeFile(join(tree, name), Array.from({ length: 40 }, (_, index) => `needle ${index}`).join("\n"));
        }
    });
    afterAll(() => rm(tree, { recursive: true, force: true }));

    const scan = (ceiling: { maxHits?: number; maxFiles?: number }) =>
        rgSearch({ root: tree, pattern: "needle", literal: true, allowed: ceilingFiles, ...ceiling });

    test("an uncapped scan reads everything and says its total is exact", async () => {
        const result = await scan({});
        expect(result.hits).toHaveLength(120);
        expect(result.ceiling).toBe(false);
    });

    test("maxHits stops at the next file boundary, so no file comes back half-read", async () => {
        const result = await scan({ maxHits: 50 });
        expect(result.ceiling).toBe(true);
        /* 80, not 50: the 50th hit lands inside b.md, and cutting THERE would hand back a file showing 10 of
         * its 40 matches, which reads as a file that has 10. Worse, the caller pages by whole files, so its
         * next page would start at c.md and b.md's other 30 would be in no page at all. So b.md is finished
         * and the scan stops at c.md's boundary. The overshoot is bounded by MAX_PER_FILE. */
        expect(result.hits).toHaveLength(80);
        expect(result.hits.filter((hit) => hit.path === "a.md")).toHaveLength(40);
        expect(result.hits.filter((hit) => hit.path === "b.md")).toHaveLength(40);
        expect(result.hits.some((hit) => hit.path === "c.md")).toBe(false);
        // Whole files only, so nothing here is a partially-shown file: `capped` stays about the per-file cap.
        expect([...result.capped]).toEqual([]);
    });

    test("a ceilinged scan answers the same question the same way twice", async () => {
        // Without --sort path this is thread scheduling, and a search box that shows two different result sets
        // for one query is worse than a slow one.
        const [first, second] = [await scan({ maxHits: 50 }), await scan({ maxHits: 50 })];
        expect(first.hits).toEqual(second.hits);
    });

    test("maxFiles stops the scan at whole files", async () => {
        const result = await scan({ maxFiles: 2 });
        expect(result.hits).toHaveLength(80);
        expect(result.ceiling).toBe(true);
        expect([...new Set(result.hits.map((hit) => hit.path))]).toEqual(["a.md", "b.md"]);
    });

    /* A NARROWED search is handed the surviving paths instead of the tree, so that narrowing it makes it
     * faster rather than merely smaller. These are the sweep's own entries, so the list can never admit what
     * `allowed` would not. */
    test("an explicit path list is the only thing walked", async () => {
        const result = await rgSearch({ root: tree, pattern: "needle", literal: true, allowed: ceilingFiles, paths: ["b.md"] });
        expect([...new Set(result.hits.map((hit) => hit.path))]).toEqual(["b.md"]);
    });

    test("an empty path list is answered without a scan, not read as the whole tree", async () => {
        const result = await rgSearch({ root: tree, pattern: "needle", literal: true, allowed: ceilingFiles, paths: [] });
        expect(result.hits).toEqual([]);
        expect(result.ceiling).toBe(false);
    });
});

test("offsets convert in one pass however many of them a line carries", async () => {
    // Regression: the conversion decoded the whole byte prefix per span, so a match-dense non-ASCII line was
    // quadratic, and rg is allowed to hand us a 1 MB one. Every span still has to land on the word.
    const dense = "dense.md";
    await writeFile(join(root, dense), `— ${Array.from({ length: 4_000 }, () => "ä needle").join(" ")}`);
    const started = Date.now();
    const found = await rgSearch({ root, pattern: "needle", allowed: new Set([dense]), literal: true });
    const line = found.hits[0]!;
    expect(line.spans!.length).toBeGreaterThan(0);
    expect(line.spans!.every((span) => line.text.slice(span.start, span.end) === "needle")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
});
