import { expect, test } from "vitest";
import { fileSearch, filesVerbHits, fuzzyScore } from "./files.js";

const PATHS = ["alpha/src/widget.ts", "alpha/src/registry.ts", "beta/app.py", "notes.md"];

test("fuzzyScore: substring beats subsequence, basename beats dir match", () => {
    expect(fuzzyScore("widget", "alpha/src/widget.ts")!).toBeGreaterThan(fuzzyScore("wdgt", "alpha/src/widget.ts")!);
    expect(fuzzyScore("zzz", "notes.md")).toBeUndefined();
});

test("fileSearch ranks fuzzy matches and supports exact globs", () => {
    const fuzzy = fileSearch("widget", PATHS, false);
    expect(fuzzy[0]?.path).toBe("alpha/src/widget.ts");
    expect(fuzzy[0]?.tags[0]?.kind).toBe("fuzzy");

    const glob = fileSearch("**/*.py", PATHS, true);
    expect(glob.map((hit) => hit.path)).toEqual(["beta/app.py"]);
});

// An empty pattern used to be a usage error on stderr, which `2>/dev/null` turned into an empty answer: the
// agent asked "does a file like this exist" and read the silence as no.
test("filesVerbHits answers a pattern-less `iq files` with the whole tree, not with nothing", () => {
    const all = filesVerbHits("", PATHS, false);
    expect(all.map((hit) => hit.path)).toEqual(PATHS.toSorted());
    expect(all.every((hit) => hit.line === 1)).toBe(true);
    expect(all[0]?.tags[0]?.kind).toBe("path");
});

test("filesVerbHits defers to fileSearch whenever a pattern was given", () => {
    expect(filesVerbHits("widget", PATHS, false)).toEqual(fileSearch("widget", PATHS, false));
    expect(filesVerbHits("**/*.py", PATHS, true)).toEqual(fileSearch("**/*.py", PATHS, true));
});

test("fileSearch is deterministic on score ties", () => {
    const a = fileSearch("re", PATHS, false).map((hit) => hit.path);
    const b = fileSearch("re", PATHS.toReversed(), false).map((hit) => hit.path);
    expect(a).toEqual(b);
});
