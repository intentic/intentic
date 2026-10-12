import { clip } from "./format.js";

describe("clip", () => {
    test("an email subject reaches the terminal as one line without the escapes it carried", () => {
        expect(clip("Invoice\u001b]0;pwned\u0007 due\r\nnow", 80)).toBe("Invoice]0;pwned due now");
        expect(clip("abc\u202etxt.exe", 80)).toBe("abctxt.exe");
    });

    test("a cut is marked and stays within the width", () => {
        const clipped = clip("one two three four", 10);
        expect(clipped).toBe("one two t…");
        expect(clipped.length).toBeLessThanOrEqual(10);
        expect(clip("short", 10)).toBe("short");
    });
});
