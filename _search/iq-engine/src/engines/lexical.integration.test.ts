import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rgSearch } from "./lexical.js";

// Pins the spans the lexical engine reports for a match, not which lines match. Dispatch-level tests cover the verb;
// this covers offsets nothing above can reconstruct.

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
    expect(line?.text.slice(span?.start, span?.end)).toBe("hardware");
});

test("case-insensitive by default: a capital in the pattern does not narrow the search", async () => {
    // ripgrep's smart case would make this pattern case-sensitive, the opposite of the documented default.
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
    // Same pattern as literal and regex, asserted directly, rather than inferred from a phrase's match count.
    expect(await search("you .nstall", {})).toHaveLength(1);
    expect(await search("you .nstall", { literal: true })).toHaveLength(0);
    // The wildcard stands in for the 'w', so "Ownership" and "ownership" both hit.
    expect(await search("o.nership", {})).toHaveLength(2);
});

test("a file with more matches than the cap reports the cap AND that it is one", async () => {
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

// Every path here is in `allowed`; a path missing from the result means ripgrep never read it, not that the post-filter
// removed it.
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

// The scan ceiling: two units (maxHits, maxFiles) because a panel pages in two; the ceiling flag marks a stopped-early
// count as a floor.
describe("the scan ceiling", () => {
    let tree: string;
    // Three files of 40 matching lines each, so a 50-hit cap lands inside the second file.
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
        // The 50th hit lands in b.md; the scan finishes that file rather than half-show it, stopping at c.md's
        // boundary.
        expect(result.hits).toHaveLength(80);
        expect(result.hits.filter((hit) => hit.path === "a.md")).toHaveLength(40);
        expect(result.hits.filter((hit) => hit.path === "b.md")).toHaveLength(40);
        expect(result.hits.some((hit) => hit.path === "c.md")).toBe(false);
        // Whole files only, so nothing here is a partially-shown file: `capped` stays about the per-file cap.
        expect([...result.capped]).toEqual([]);
    });

    test("a ceilinged scan answers the same question the same way twice", async () => {
        // Without --sort path, ripgrep's parallel scan order is otherwise thread scheduling, nondeterministic.
        const [first, second] = [await scan({ maxHits: 50 }), await scan({ maxHits: 50 })];
        expect(first.hits).toEqual(second.hits);
    });

    test("maxFiles stops the scan at whole files", async () => {
        const result = await scan({ maxFiles: 2 });
        expect(result.hits).toHaveLength(80);
        expect(result.ceiling).toBe(true);
        expect([...new Set(result.hits.map((hit) => hit.path))]).toEqual(["a.md", "b.md"]);
    });

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
    // rg may hand back a single line up to 1 MB; every span still has to land on the word.
    const dense = "dense.md";
    await writeFile(join(root, dense), `— ${Array.from({ length: 4_000 }, () => "ä needle").join(" ")}`);
    const started = Date.now();
    const found = await rgSearch({ root, pattern: "needle", allowed: new Set([dense]), literal: true });
    const line = found.hits[0]!;
    expect(line.spans!.length).toBeGreaterThan(0);
    expect(line.spans!.every((span) => line.text.slice(span.start, span.end) === "needle")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
});
