import { readFile } from "node:fs/promises";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Rich Text Format: the words, their paragraphs, and a table's cells kept apart. Formatting is dropped — markdown
   is what an agent reads, not what the document looked like. */

// Groups holding the file's own bookkeeping rather than its text. Anything marked `\*\word` is skipped too, which
// is the rule RTF is built on: a reader that does not know a destination must skip all of it.
const SKIPPED = new Set([
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "listtable",
    "listoverridetable",
    "rsidtbl",
    "generator",
    "filetbl",
    "themedata",
    "colorschememapping",
    "datastore",
    "latentstyles",
    "xmlnstbl",
    "pgdsctbl",
    "revtbl",
    "header",
    "headerl",
    "headerr",
    "headerf",
    "footer",
    "footerl",
    "footerr",
    "footerf",
    "object",
    "objdata",
    "do",
    "shp",
    "nonshppict",
    "bkmkstart",
    "bkmkend",
    "fldinst",
    "xe",
    "tc",
    "upr",
]);

const BREAKS = new Set(["par", "line", "sect", "page", "row", "nestrow"]);
const LITERALS: Record<string, string> = { "\\": "\\", "{": "{", "}": "}", "~": " ", "_": "-" };

const decoder = new TextDecoder("windows-1252");

interface Frame {
    skip: boolean;
    ignorable: boolean;
}

interface Reader {
    readonly out: string[];
    line: string;
    bytes: number[];
    /** Fallback characters still to be dropped: what follows a \u escape for readers that cannot show it. */
    drop: number;
}

const flushBytes = (reader: Reader): void => {
    if (reader.bytes.length > 0) {
        reader.line += decoder.decode(new Uint8Array(reader.bytes));
        reader.bytes = [];
    }
};

const endLine = (reader: Reader): void => {
    flushBytes(reader);
    const text = reader.line.replaceAll(/[ \t]+/g, " ").trim();
    reader.line = "";
    if (text !== "") {
        reader.out.push(text);
    }
};

// Whether this word puts the reader inside a group it must ignore: the file's own bookkeeping, or a destination
// marked \\* that this reader does not know.
const enterSkip = (word: string, frame: Frame): boolean => {
    if (frame.skip) {
        return true;
    }
    if (word === "*") {
        frame.ignorable = true;
        return true;
    }
    if (frame.ignorable || SKIPPED.has(word)) {
        frame.skip = true;
        frame.ignorable = false;
        return true;
    }
    return false;
};

const appendCodePoint = (reader: Reader, value: number | undefined): void => {
    const code = value === undefined ? 0 : value < 0 ? value + 0x10000 : value;
    reader.line += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    reader.drop = 1;
};

// Characters RTF writes as control words rather than as themselves; dropped, a document loses its dashes and
// quotation marks, and a table's em dash for "no value" vanishes from the cell.
const CHARACTERS: Record<string, string> = {
    emdash: "—",
    endash: "–",
    lquote: "‘",
    rquote: "’",
    ldblquote: "“",
    rdblquote: "”",
    bullet: "•",
    emspace: " ",
    enspace: " ",
    qmspace: " ",
};

const WORDS: Record<string, (reader: Reader, value: number | undefined) => void> = {
    cell: (reader) => void (reader.line += " | "),
    nestcell: (reader) => void (reader.line += " | "),
    tab: (reader) => void (reader.line += "\t"),
    u: (reader, value) => appendCodePoint(reader, value),
    ...Object.fromEntries(Object.entries(CHARACTERS).map(([word, text]) => [word, (reader: Reader) => void (reader.line += text)])),
};

const applyWord = (word: string, value: number | undefined, reader: Reader, frame: Frame): void => {
    if (enterSkip(word, frame)) {
        return;
    }
    flushBytes(reader);
    if (BREAKS.has(word)) {
        endLine(reader);
        return;
    }
    WORDS[word]?.(reader, value);
};

// A \u escape is followed by the characters a reader that cannot show it would print instead; they are not text.
const dropOne = (reader: Reader): boolean => {
    if (reader.drop <= 0) {
        return false;
    }
    reader.drop -= 1;
    return true;
};

const write = (reader: Reader, frame: Frame, text: string): void => {
    if (frame.skip || dropOne(reader)) {
        return;
    }
    flushBytes(reader);
    reader.line += text;
};

const appendChar = (char: string, reader: Reader, frame: Frame): void => {
    // A line break inside an RTF file is formatting OF THE FILE, and carries nothing.
    if (char === "\r" || char === "\n") {
        return;
    }
    write(reader, frame, char);
};

// Sticky, so a control word is read where it stands: slicing the rest of the file at every backslash would make
// reading a six-megabyte document quadratic.
const CONTROL = /([a-zA-Z]+)(-?\d+)? ?/y;
const HEX = 16;

const readEscape = (source: string, position: number, reader: Reader, frame: Frame): number => {
    const next = source[position + 1] ?? "";
    const literal = LITERALS[next];
    if (literal !== undefined) {
        write(reader, frame, literal);
        return position + 2;
    }
    if (next === "'") {
        const byte = Number.parseInt(source.slice(position + 2, position + 4), HEX);
        if (!frame.skip && !dropOne(reader) && Number.isFinite(byte)) {
            reader.bytes.push(byte);
        }
        return position + 4;
    }
    CONTROL.lastIndex = position + 1;
    const match = CONTROL.exec(source);
    if (match === null) {
        // A control symbol with no meaning here (\- \: \|): the backslash and one character are consumed.
        return position + 2;
    }
    applyWord(match[1] ?? "", match[2] === undefined ? undefined : Number(match[2]), reader, frame);
    return position + 1 + match[0].length;
};

const ROOT: Frame = { skip: false, ignorable: false };

/** The text of an RTF document, one entry per paragraph; exported for the tests. */
export const rtfParagraphs = (source: string): string[] => {
    const reader: Reader = { out: [], line: "", bytes: [], drop: 0 };
    const stack: Frame[] = [{ ...ROOT }];
    let position = 0;
    while (position < source.length) {
        const frame = stack.at(-1) ?? ROOT;
        const char = source[position] ?? "";
        if (char === "\\") {
            position = readEscape(source, position, reader, frame);
            continue;
        }
        position += 1;
        if (char === "{") {
            stack.push({ skip: frame.skip, ignorable: false });
            continue;
        }
        if (char === "}") {
            flushBytes(reader);
            stack.pop();
            continue;
        }
        appendChar(char, reader, frame);
    }
    endLine(reader);
    return reader.out;
};

export const rtfDeriver: Deriver = {
    name: "rtf",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const source = (await readFile(absPath)).toString("latin1");
        const paragraphs = rtfParagraphs(source);
        return { markdown: paragraphs.join("\n\n"), notes: paragraphs.length === 0 ? ["no text in this document"] : [] };
    },
};
