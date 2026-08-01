import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rgSearch } from "./lexical.js";

// What the lexical engine reports ABOUT a match, as opposed to which lines match: the spans a client marks. The
// dispatch-level tests cover the verb; these cover the offsets, which nothing above this file can reconstruct.

let root: string;
const allowed = new Set(["lines.md"]);

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-lexical-"));
    await writeFile(
        join(root, "lines.md"),
        ["own its own sandbox on hardware you own", "Ownership — hardware you own, tools you install", "ownership is the trust foundation"].join(
            "\n",
        ),
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
        { start: 36, end: 39 },
    ]);
});

test("spans index the string, not its bytes — a match after an em dash lands on the word", async () => {
    const hits = await search("hardware", { literal: true });
    const line = hits.find((hit) => hit.line === 2);
    const span = line?.spans?.[0];
    expect(span).toBeDefined();
    expect(line?.text.slice(span?.start, span?.end)).toBe("hardware");
});

test("case-insensitive by default — a capital in the pattern does not narrow the search", async () => {
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
    expect(await search("you own,", { literal: true })).toHaveLength(1);
    expect(await search("you .wn", {})).toHaveLength(2);
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

test("offsets convert in one pass however many of them a line carries", async () => {
    // Regression: the conversion decoded the whole byte prefix per span, so a match-dense non-ASCII line was
    // quadratic — and rg is allowed to hand us a 1 MB one. Every span still has to land on the word.
    const dense = "dense.md";
    await writeFile(join(root, dense), `— ${Array.from({ length: 4_000 }, () => "ä needle").join(" ")}`);
    const started = Date.now();
    const found = await rgSearch({ root, pattern: "needle", allowed: new Set([dense]), literal: true });
    const line = found.hits[0]!;
    expect(line.spans!.length).toBeGreaterThan(0);
    expect(line.spans!.every((span) => line.text.slice(span.start, span.end) === "needle")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
});
