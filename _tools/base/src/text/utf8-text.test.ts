import { isUtf8, trimUtf8Window } from "./utf8-text.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("a window at both of the file's ends keeps every byte", () => {
    expect(trimUtf8Window(bytes("one\ntwo"), true, true)).toEqual({ start: 0, end: 7 });
});

test("away from the file's ends, a window is cut on whole lines", () => {
    // Opened mid-line ("ne\n" is the partial line), closed mid-line ("th" is cut off).
    expect(trimUtf8Window(bytes("ne\ntwo\nth"), false, false)).toEqual({ start: 3, end: 7 });
});

test("one long line with no newline is cut on a character boundary, never inside one", () => {
    const text = bytes("aé€"); // a(1) é(2) €(3)
    // The last character is cut after its first byte: the window ends before it.
    expect(trimUtf8Window(text.subarray(0, 4), true, false)).toEqual({ start: 0, end: 3 });
    // A window entered on a continuation byte starts at the next lead byte.
    expect(trimUtf8Window(text.subarray(2), false, true)).toEqual({ start: 1, end: 4 });
});

test("isUtf8 passes UTF-8 and fails Latin-1", () => {
    expect(isUtf8(bytes("café ✓"))).toBe(true);
    // "café" as Latin-1: 0xe9 alone is not UTF-8.
    expect(isUtf8(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBe(false);
});
