import { expect, test } from "vitest";
import { estimateTokens, sizeLabel } from "./format.js";

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
