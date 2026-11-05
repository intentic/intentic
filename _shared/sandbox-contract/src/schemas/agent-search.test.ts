import { indexOfTerm, searchable, searchTermOf } from "./agent-search.js";

// Spaces are part of what was asked for: trimmed away, " ui " could only ever mean "ui", inside "build" and "quit" too.
test("a term keeps its spaces at the ends and folds a run of them to one", () => {
    expect(searchTermOf(" ui ")).toBe(" ui ");
    expect(searchTermOf("fix  the\tbug ")).toBe("fix the bug ");
});

test("spaces never count toward the floor", () => {
    expect(searchable("ui")).toBe(true);
    expect(searchable(" a ")).toBe(false);
    expect(searchable("   ")).toBe(false);
});

// A line's own ends read as spaces, so asking for the word still finds it where a line opens or closes with it.
test("a spaced term finds the whole word, the line's own ends counting as spaces", () => {
    expect(indexOfTerm("rebuild the ui panel", " ui ")).toBe(11);
    expect(indexOfTerm("rebuild the quiet panel", " ui ")).toBe(-1);
    expect(indexOfTerm("ui first", " ui ")).toBe(0);
    expect(indexOfTerm("make a ui", " ui ")).toBe(6);
    expect(indexOfTerm("build", "ui")).toBe(1);
});
