import { aroundChanges, lineDiff } from "./line-diff.js";

// An update's review shows what changed and a little around it, so a one-line fix in a long script reads as one line.

test("an update reads as the lines it adds and removes, in order", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
        { kind: "same", text: "a" },
        { kind: "added", text: "B" },
        { kind: "removed", text: "b" },
        { kind: "same", text: "c" },
        { kind: "added", text: "d" },
    ]);
});

test("unchanged runs far from a change fold into one line", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const shown = aroundChanges(lineDiff(before, after)!);
    expect(shown.filter((line) => line === "fold")).toHaveLength(2);
    expect(shown.filter((line) => line !== "fold" && line.kind !== "same").map((line) => line !== "fold" && line.text)).toEqual(["line ten", "line 10"]);
});

test("versions too long to compare here are left to be shown whole", () => {
    const long = Array.from({ length: 2100 }, (_, index) => String(index)).join("\n");
    expect(lineDiff(long, `${long}\nmore`)).toBeUndefined();
});
