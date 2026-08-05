import { expect, test } from "vitest";
import { applyEdit, fileAnchor, renderForRead } from "./hashline.js";

// Pull the anchor + per-line tags out of a hashline_read view, the way the model would when composing an edit.
const parseRead = (rendered: string): { anchor: string; tags: string[] } => {
    const [header, ...rows] = rendered.split("\n");
    return {
        anchor: /^anchor (\w+)/.exec(header ?? "")?.[1] ?? "",
        tags: rows.map((row) => row.slice(0, row.indexOf(" "))),
    };
};

const FILE = "line one\nline two\nline three\n";

test("read reports the current anchor and one tag per line", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(anchor).toBe(fileAnchor(FILE));
    expect(tags).toHaveLength(3);
});

test("replace swaps a single tagged line and preserves the rest + trailing newline", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "replace", from: tags[1] as string, lines: ["LINE TWO"] }])).toBe("line one\nLINE TWO\nline three\n");
});

test("replace across a tag range collapses the range to the new lines", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "replace", from: tags[0] as string, to: tags[1] as string, lines: ["merged"] }])).toBe(
        "merged\nline three\n",
    );
});

test("delete removes the tagged line", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "delete", from: tags[1] as string }])).toBe("line one\nline three\n");
});

test("insert places lines after a tag", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "insert", after: tags[0] as string, lines: ["inserted"] }])).toBe(
        "line one\ninserted\nline two\nline three\n",
    );
});

test("insert with the ^ anchor prepends at the top of the file", () => {
    const { anchor } = parseRead(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "insert", after: "^", lines: ["header"] }])).toBe("header\nline one\nline two\nline three\n");
});

test("multiple disjoint ops apply together without shifting each other", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    const result = applyEdit(FILE, anchor, [
        { op: "replace", from: tags[0] as string, lines: ["ONE"] },
        { op: "delete", from: tags[2] as string },
    ]);
    expect(result).toBe("ONE\nline two\n");
});

test("a file with no trailing newline stays that way", () => {
    const noNewline = "a\nb";
    const { anchor, tags } = parseRead(renderForRead(noNewline));
    expect(applyEdit(noNewline, anchor, [{ op: "replace", from: tags[1] as string, lines: ["B"] }])).toBe("a\nB");
});

test("a stale anchor is rejected before any change", () => {
    expect(() => applyEdit(FILE, "deadbeef", [{ op: "delete", from: "0000" }])).toThrow(/stale edit/);
});

test("an unknown tag is rejected", () => {
    const { anchor } = parseRead(renderForRead(FILE));
    expect(() => applyEdit(FILE, anchor, [{ op: "delete", from: "zzzz" }])).toThrow(/unknown line tag/);
});

test("overlapping ranges are rejected", () => {
    const { anchor, tags } = parseRead(renderForRead(FILE));
    expect(() =>
        applyEdit(FILE, anchor, [
            { op: "replace", from: tags[0] as string, to: tags[2] as string, lines: ["all"] },
            { op: "replace", from: tags[1] as string, lines: ["x"] },
        ]),
    ).toThrow(/overlapping/);
});
