import { expect, test } from "vitest";
import { clamp, escapeHtml, estimateTokens, plural, sizeLabel } from "./format.js";

test("whole bytes below a kilobyte, one decimal above", () => {
    expect(sizeLabel(0)).toBe("0 B");
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(1023)).toBe("1023 B");
    expect(sizeLabel(1024)).toBe("1.0 KB");
    expect(sizeLabel(1536)).toBe("1.5 KB");
});

test("binary units under decimal names, up to GB", () => {
    expect(sizeLabel(1024 ** 2)).toBe("1.0 MB");
    expect(sizeLabel(1024 ** 3)).toBe("1.0 GB");
});

// Past GB the label stops climbing rather than reaching for a unit nobody has intuition for: 4 TB reads as
// the four-figure GB count it is.
test("a size past the largest unit keeps counting in it", () => {
    expect(sizeLabel(4 * 1024 ** 4)).toBe("4096.0 GB");
});

test("a token is about four characters, rounded up so nothing reads as free", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
});

test("plural: singular when count is 1, auto-suffixed otherwise", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(5, "file")).toBe("5 files");
});

test("plural: sibilant endings get -es", () => {
    expect(plural(2, "match")).toBe("2 matches");
    expect(plural(2, "box")).toBe("2 boxes");
    expect(plural(2, "blitz")).toBe("2 blitzes");
    expect(plural(2, "brush")).toBe("2 brushes");
    expect(plural(2, "branch")).toBe("2 branches");
});

test("plural: explicit many overrides auto-inflection", () => {
    expect(plural(1, "advisory", "advisories")).toBe("1 advisory");
    expect(plural(3, "advisory", "advisories")).toBe("3 advisories");
    expect(plural(2, "dependency", "dependencies")).toBe("2 dependencies");
});

test("escapeHtml: replaces all five HTML-active characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
});

test("escapeHtml: passes through safe text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
});

test("clamp: constrains value to [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
});
