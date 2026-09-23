import { fileSearch, filesVerbHits } from "./files.js";

const PATHS = ["alpha/src/widget.ts", "alpha/src/registry.ts", "beta/app.py", "notes.md"];

// The scorer itself is @intentic/base/fuzzy's, tested there; what is this engine's is the tag, the clamp and the glob.
test("fileSearch ranks fuzzy matches, clamps the tagged score, and supports exact globs", () => {
    const fuzzy = fileSearch("widget", PATHS, false);
    expect(fuzzy[0]?.path).toBe("alpha/src/widget.ts");
    expect(fuzzy[0]?.tags[0]?.kind).toBe("fuzzy");
    // A substring hit scores above 1 by design; the tag a reader sees is clamped to two decimals in 0..1.
    const tag = fuzzy[0]?.tags[0];
    expect(tag?.kind === "fuzzy" ? tag.score : undefined).toBe(1);

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
