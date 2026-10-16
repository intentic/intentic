import { asciiJson } from "./powershell.js";

describe("asciiJson", () => {
    test("leaves nothing past ASCII, and reads back as the same text", () => {
        const text = JSON.stringify({ value: "probe-Ünïcödé-€-😀-+^%~(){}[]\u007f" });
        const escaped = asciiJson(text);
        expect(/[^\u0000-~]/u.test(escaped)).toBe(false);
        expect(JSON.parse(escaped)).toEqual(JSON.parse(text));
    });

    test("writes a character past U+FFFF as its two UTF-16 units", () => {
        expect(asciiJson('"😀"')).toBe('"\\ud83d\\ude00"');
    });
});
