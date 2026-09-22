import { test, expect } from "bun:test";
import { fuzzyScore } from "./fuzzy.js";

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
