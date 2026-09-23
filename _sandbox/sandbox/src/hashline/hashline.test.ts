import { test, expect } from "bun:test";
import { applyEdit, fileAnchor, renderForEdit, renderForRead } from "./hashline.js";

// Pull the anchor and the `<tag> <n>│<text>` rows out of a view (a read, or an edit's answer), the way the model would
// when composing an edit; anything else, like the "…" between an answer's windows, is not a row.
const parseView = (rendered: string) => {
    const [header = "", ...rest] = rendered.split("\n");
    const rows = rest.flatMap((row) => {
        const match = /^(\w{4}) (\d+)│(.*)$/s.exec(row);
        return match === null ? [] : [{ tag: match[1] ?? "", line: Number(match[2]), text: match[3] ?? "" }];
    });
    return {
        anchor: /^anchor (\w+)/.exec(header)?.[1] ?? "",
        header,
        rows,
        tags: rows.map((row) => row.tag),
        lines: rows.map((row) => row.line),
        tagOf: (line: number): string => rows.find((row) => row.line === line)?.tag ?? "",
    };
};

const FILE = "line one\nline two\nline three\n";
const CRLF = "line one\r\nline two\r\nline three\r\n";

// `row 1` … `row <count>`, each line terminated.
const numbered = (count: number): string[] => Array.from({ length: count }, (_, i) => `row ${i + 1}`);
const fileOf = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");

test("read reports the current anchor and one tag per line", () => {
    const { anchor, header, tags } = parseView(renderForRead(FILE));
    expect(anchor).toBe(fileAnchor(FILE));
    expect(header).toBe(`anchor ${fileAnchor(FILE)} · lines 1-3 of 3: pass this anchor and the line tags to hashline_edit`);
    expect(tags).toHaveLength(3);
});

test("a ranged read shows only its lines, under the whole-file anchor and with the tags a full read gives them", () => {
    const full = parseView(renderForRead(FILE));
    const ranged = parseView(renderForRead(FILE, { offset: 2, limit: 1 }));
    expect(ranged.header).toBe(
        `anchor ${fileAnchor(FILE)} · lines 2-2 of 3: pass this anchor and the line tags to hashline_edit; the rest: hashline_read with offset 3`,
    );
    expect(ranged.rows).toEqual([{ tag: full.tagOf(2), line: 2, text: "line two" }]);
});

test("a read with no limit stops at 2000 lines and says where the rest starts", () => {
    const file = fileOf(numbered(2500));
    const view = parseView(renderForRead(file));
    expect(view.header).toBe(
        `anchor ${fileAnchor(file)} · lines 1-2000 of 2500: pass this anchor and the line tags to hashline_edit; the rest: hashline_read with offset 2001`,
    );
    expect(view.lines.at(-1)).toBe(2000);
});

test("long lines end a read early, yet a read always shows at least one line", () => {
    const wide = `${"a".repeat(60_000)}\n${"b".repeat(60_000)}\n`;
    expect(parseView(renderForRead(wide)).lines).toEqual([1]);
    expect(parseView(renderForRead(wide, { offset: 2 })).lines).toEqual([2]);
    expect(parseView(renderForRead("c".repeat(150_000))).lines).toEqual([1]);
});

test("an offset past the end says how many lines there are", () => {
    expect(renderForRead(FILE, { offset: 4 })).toBe(`anchor ${fileAnchor(FILE)} · 3 lines, none from offset 4`);
});

test("an empty file reads as such", () => {
    expect(renderForRead("")).toBe(`anchor ${fileAnchor("")} · 0 lines: pass this anchor to hashline_edit\n(empty file)`);
});

test("replace swaps a single tagged line and preserves the rest + trailing newline", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "replace", from: tags[1] as string, lines: ["LINE TWO"] }]).content).toBe("line one\nLINE TWO\nline three\n");
});

test("replace across a tag range collapses the range to the new lines", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "replace", from: tags[0] as string, to: tags[1] as string, lines: ["merged"] }]).content).toBe(
        "merged\nline three\n",
    );
});

test("delete removes the tagged line", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "delete", from: tags[1] as string }]).content).toBe("line one\nline three\n");
});

test("insert places lines after a tag", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "insert", after: tags[0] as string, lines: ["inserted"] }]).content).toBe(
        "line one\ninserted\nline two\nline three\n",
    );
});

test("insert with the ^ anchor prepends at the top of the file", () => {
    const { anchor } = parseView(renderForRead(FILE));
    expect(applyEdit(FILE, anchor, [{ op: "insert", after: "^", lines: ["header"] }]).content).toBe("header\nline one\nline two\nline three\n");
});

test("multiple disjoint ops apply together without shifting each other", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    const result = applyEdit(FILE, anchor, [
        { op: "replace", from: tags[0] as string, lines: ["ONE"] },
        { op: "delete", from: tags[2] as string },
    ]);
    expect(result.content).toBe("ONE\nline two\n");
});

test("a file with no trailing newline stays that way", () => {
    const noNewline = "a\nb";
    const { anchor, tags } = parseView(renderForRead(noNewline));
    expect(applyEdit(noNewline, anchor, [{ op: "replace", from: tags[1] as string, lines: ["B"] }]).content).toBe("a\nB");
    expect(applyEdit(noNewline, anchor, [{ op: "insert", after: tags[1] as string, lines: ["c"] }]).content).toBe("a\nb\nc");
});

test("a CRLF file reads without its carriage returns and tags like its LF twin, under an anchor of its own", () => {
    const view = parseView(renderForRead(CRLF));
    expect(view.rows).toEqual(parseView(renderForRead(FILE)).rows);
    expect(view.anchor).toBe(fileAnchor(CRLF));
    expect(view.anchor).not.toBe(fileAnchor(FILE));
});

test("lines an edit writes into a CRLF file end in CRLF", () => {
    const { anchor, tags } = parseView(renderForRead(CRLF));
    const edit = applyEdit(CRLF, anchor, [
        { op: "replace", from: tags[1] as string, lines: ["LINE TWO"] },
        { op: "insert", after: tags[2] as string, lines: ["four", "five"] },
    ]);
    expect(edit.content).toBe("line one\r\nLINE TWO\r\nline three\r\nfour\r\nfive\r\n");
});

test("replacing a CRLF line with its own text changes no byte", () => {
    const { anchor, tags } = parseView(renderForRead(CRLF));
    expect(applyEdit(CRLF, anchor, [{ op: "replace", from: tags[1] as string, lines: ["line two"] }]).content).toBe(CRLF);
});

test("a CRLF file without a final newline gains none", () => {
    const file = "a\r\nb";
    const { anchor, tags } = parseView(renderForRead(file));
    expect(applyEdit(file, anchor, [{ op: "replace", from: tags[1] as string, lines: ["B", "C"] }]).content).toBe("a\r\nB\r\nC");
});

test("in a mixed file, kept lines keep their own ending and written lines take the majority's", () => {
    const mixed = "one\r\ntwo\r\nthree\n";
    const { anchor, tags } = parseView(renderForRead(mixed));
    expect(applyEdit(mixed, anchor, [{ op: "insert", after: tags[0] as string, lines: ["new"] }]).content).toBe("one\r\nnew\r\ntwo\r\nthree\n");
});

test("a written string holding a line break becomes separate lines in the file's ending", () => {
    const { anchor, tags } = parseView(renderForRead(CRLF));
    expect(applyEdit(CRLF, anchor, [{ op: "replace", from: tags[0] as string, lines: ["a\nb"] }]).content).toBe("a\r\nb\r\nline two\r\nline three\r\n");
});

test("an edit answers with the new anchor and two lines around each change, not the whole file", () => {
    const file = fileOf(numbered(50));
    const read = parseView(renderForRead(file));
    const edit = applyEdit(file, read.anchor, [
        { op: "replace", from: read.tagOf(10), lines: ["ten"] },
        { op: "delete", from: read.tagOf(40) },
    ]);
    const rendered = renderForEdit(edit);
    const answer = parseView(rendered);
    expect(answer.header).toBe(
        `anchor ${fileAnchor(edit.content)} · 49 lines: edit applied. Below, each change with up to 2 lines either side and their current tags; every line not shown kept its tag, so pass this anchor to the next hashline_edit without re-reading.`,
    );
    // The deletion shows the lines now either side of the gap: old 38, 39, 41 and 42.
    expect(answer.rows.map((row) => `${row.line}│${row.text}`)).toEqual([
        "8│row 8",
        "9│row 9",
        "10│ten",
        "11│row 11",
        "12│row 12",
        "38│row 38",
        "39│row 39",
        "40│row 41",
        "41│row 42",
    ]);
    expect(rendered.split("\n").filter((line) => line === "…")).toHaveLength(1);
});

test("changes whose windows touch share one stretch", () => {
    const file = fileOf(numbered(20));
    const read = parseView(renderForRead(file));
    const edit = applyEdit(file, read.anchor, [
        { op: "replace", from: read.tagOf(5), lines: ["five"] },
        { op: "replace", from: read.tagOf(10), lines: ["ten"] },
    ]);
    const rendered = renderForEdit(edit);
    expect(parseView(rendered).lines).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rendered).not.toContain("…");
});

test("an edit that empties the file says so", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    const edit = applyEdit(FILE, anchor, [{ op: "delete", from: tags[0] as string, to: tags[2] as string }]);
    expect(edit.content).toBe("");
    expect(renderForEdit(edit)).toBe(`anchor ${fileAnchor("")} · 0 lines: edit applied\n(empty file)`);
});

test("every tag a fresh read would give is in the edit's answer or unchanged from the read before it", () => {
    const file = fileOf(numbered(50));
    const before = parseView(renderForRead(file));
    const edit = applyEdit(file, before.anchor, [
        { op: "insert", after: "^", lines: ["top"] },
        { op: "replace", from: before.tagOf(20), to: before.tagOf(22), lines: ["twenty"] },
        { op: "delete", from: before.tagOf(50) },
    ]);
    const known = new Set([...before.tags, ...parseView(renderForEdit(edit)).tags]);
    expect(parseView(renderForRead(edit.content)).tags.filter((tag) => !known.has(tag))).toEqual([]);
});

test("a second edit chains on the first one's answer: its tags near the change, the read's everywhere else", () => {
    const lines = numbered(50);
    const file = fileOf(lines);
    const read = parseView(renderForRead(file));
    const first = applyEdit(file, read.anchor, [{ op: "replace", from: read.tagOf(10), lines: ["ten"] }]);
    const answer = parseView(renderForEdit(first));
    // Line 9's tag hashed its old neighbour, so only the answer's tag for it still resolves.
    expect(() => applyEdit(first.content, answer.anchor, [{ op: "delete", from: read.tagOf(9) }])).toThrow(/unknown line tag/);
    const second = applyEdit(first.content, answer.anchor, [
        { op: "replace", from: answer.tagOf(9), lines: ["nine"] },
        { op: "delete", from: read.tagOf(30) },
    ]);
    expect(second.content).toBe(fileOf([...lines.slice(0, 8), "nine", "ten", ...lines.slice(10, 29), ...lines.slice(30)]));
});

test("a stale anchor is rejected before any change", () => {
    expect(() => applyEdit(FILE, "deadbeef", [{ op: "delete", from: "0000" }])).toThrow(/stale edit/);
});

test("an unknown tag is rejected", () => {
    const { anchor } = parseView(renderForRead(FILE));
    expect(() => applyEdit(FILE, anchor, [{ op: "delete", from: "zzzz" }])).toThrow(/unknown line tag/);
});

test("overlapping ranges are rejected", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(() =>
        applyEdit(FILE, anchor, [
            { op: "replace", from: tags[0] as string, to: tags[2] as string, lines: ["all"] },
            { op: "replace", from: tags[1] as string, lines: ["x"] },
        ]),
    ).toThrow(/overlapping/);
});

test("an insert anchored inside a replaced range is rejected", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(() =>
        applyEdit(FILE, anchor, [
            { op: "replace", from: tags[0] as string, to: tags[1] as string, lines: ["x"] },
            { op: "insert", after: tags[1] as string, lines: ["y"] },
        ]),
    ).toThrow(/an insert is anchored to a line inside a replaced\/deleted range/);
});

test("two inserts after one line are rejected", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(() =>
        applyEdit(FILE, anchor, [
            { op: "insert", after: tags[0] as string, lines: ["x"] },
            { op: "insert", after: tags[0] as string, lines: ["y"] },
        ]),
    ).toThrow(/two inserts anchored after the same line/);
});

test("a range that ends before it starts is rejected", () => {
    const { anchor, tags } = parseView(renderForRead(FILE));
    expect(() => applyEdit(FILE, anchor, [{ op: "delete", from: tags[2] as string, to: tags[0] as string }])).toThrow(/is before its start/);
});
