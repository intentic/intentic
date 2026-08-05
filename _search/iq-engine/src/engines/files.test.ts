import { expect, test } from "vitest";
import { fileSearch, fuzzyScore } from "./files.js";

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

test("fileSearch is deterministic on score ties", () => {
    const a = fileSearch("re", PATHS, false).map((hit) => hit.path);
    const b = fileSearch("re", PATHS.toReversed(), false).map((hit) => hit.path);
    expect(a).toEqual(b);
});
