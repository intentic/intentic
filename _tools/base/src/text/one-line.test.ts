import { oneLine } from "./one-line.js";

describe("oneLine", () => {
    it("flattens every kind of line break and space run to one space, and trims", () => {
        expect(oneLine("  first\r\nsecond\tthird\u2028fourth\u00a0 fifth  ")).toBe("first second third fourth fifth");
    });

    // ESC and BEL act on a terminal that prints them; a bidi override makes a label read backwards.
    it("removes control and format characters, ESC, BEL and bidi overrides among them", () => {
        expect(oneLine("\u001b[31mred\u0007 \u202egnp.exe\u202c zero\u200bwidth")).toBe("[31mred gnp.exe zerowidth");
    });

    it("keeps the result within max, the ellipsis included", () => {
        const cut = oneLine("a".repeat(100), 10);

        expect(cut).toBe(`${"a".repeat(9)}…`);
        expect(cut.length).toBe(10);
    });

    it("leaves text that fits as it is, and cuts silently when asked", () => {
        expect(oneLine("short", 5)).toBe("short");
        expect(oneLine("a".repeat(20), 8, { ellipsis: false })).toBe("a".repeat(8));
        expect(oneLine("abcdef", 4, { ellipsis: "..." })).toBe("a...");
    });

    it("never splits a surrogate pair at the cut", () => {
        const cut = oneLine("ab😀😀😀", 4);

        expect(cut).toBe("ab…");
        expect(cut.length).toBeLessThanOrEqual(4);
        expect(oneLine("ab😀😀", 4, { ellipsis: false })).toBe("ab😀");
        expect(oneLine("a😀b", 2, { ellipsis: false })).toBe("a");
    });

    it("does not leave a space before the ellipsis, and has no ceiling unless given one", () => {
        expect(oneLine("one two three", 5)).toBe("one…");
        expect(oneLine("x".repeat(10_000))).toHaveLength(10_000);
    });
});
