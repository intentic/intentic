import { decodeUtf16Window, UTF16_PROBE, utf16ByBom, type Utf16 } from "./utf16-text.js";

const LE_BOM = [0xff, 0xfe];
const BE_BOM = [0xfe, 0xff];

// A file's bytes as Windows writes them: the BOM, then each code unit.
const fileOf = (text: string, encoding: Utf16 = "utf-16le"): Uint8Array => {
    const le = Buffer.from(text, "utf16le");
    const body = encoding === "utf-16le" ? le : Buffer.from(le).swap16();
    return Uint8Array.from([...(encoding === "utf-16le" ? LE_BOM : BE_BOM), ...body]);
};

// What a reader asking for `limit` bytes from `from` is handed, probe and all.
const windowOf = (file: Uint8Array, from: number, limit: number, encoding: Utf16 = "utf-16le") => {
    const probe = Math.min(from, UTF16_PROBE);
    return decodeUtf16Window(file.subarray(from - probe, Math.min(from + limit, file.length)), probe, from, file.length, encoding);
};

// The file this exists for: C:\Users\<user>\Documents\desktop.ini, which read as UTF-8 was NULs and opened as binary.
const DESKTOP_INI = "\r\n[.ShellClassInfo]\r\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21770\r\nIconIndex=-235\r\n";

test("a BOM names the UTF-16 behind it, and anything else is not UTF-16", () => {
    expect(utf16ByBom(fileOf("a"))).toBe("utf-16le");
    expect(utf16ByBom(fileOf("a", "utf-16be"))).toBe("utf-16be");
    expect(utf16ByBom(Buffer.from("[.ShellClassInfo]"))).toBeUndefined();
    expect(utf16ByBom(Uint8Array.from([0xef, 0xbb, 0xbf]))).toBeUndefined();
    expect(utf16ByBom(new Uint8Array())).toBeUndefined();
});

test("desktop.ini reads whole as its text, without the BOM, from offset 0", () => {
    const file = fileOf(DESKTOP_INI);
    expect(windowOf(file, 0, file.length)).toEqual({ content: DESKTOP_INI, offset: 0, bytes: file.length });
    const be = fileOf(DESKTOP_INI, "utf-16be");
    expect(windowOf(be, 0, be.length, "utf-16be").content).toBe(DESKTOP_INI);
});

test("windows through a big file cut on whole lines and together read the file once", () => {
    const text = Array.from({ length: 40 }, (_, line) => `line ${line} ${"é𝄞".repeat(line % 5)}\n`).join("");
    const file = fileOf(text);
    let read = "";
    let from = 0;
    while (from < file.length) {
        const window = windowOf(file, from, 101);
        expect(window.offset).toBe(from);
        read += window.content;
        from = window.offset + window.bytes;
    }
    expect(read).toBe(text);
});

test("a tail read from an odd byte starts at the next whole line", () => {
    const file = fileOf("first\nsecond\nthird\n");
    const window = windowOf(file, file.length - 13, 13);
    expect(window.content).toBe("third\n");
    expect(window.offset + window.bytes).toBe(file.length);
});

test("a window with no line to cut on never splits a surrogate pair", () => {
    const file = fileOf("𝄞𝄞𝄞𝄞");
    const window = windowOf(file, 0, 8);
    expect(window.content).toBe("𝄞");
    expect(window.bytes).toBe(6);
});
