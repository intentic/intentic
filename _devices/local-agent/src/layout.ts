// The terminal design system's shapes as pure functions: text in, lines out, no clock and no stream. ui.ts draws
// through these, and so does ic's ui.rs through its twin; both are held to _shared/sandbox-run/src/terminal-layout.fixture.json,
// so a person sees the same layout whichever binary is talking. The rules are docs/ops/cli-output-protocol.md.

export interface Glyphs {
    readonly ok: string;
    readonly fail: string;
    readonly warn: string;
    readonly skip: string;
    readonly ask: string;
    readonly spinner: readonly string[];
}

export const UNICODE: Glyphs = { ok: "✓", fail: "✗", warn: "!", skip: "·", ask: "?", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] };
// Windows consoles without virtual-terminal processing print the Unicode set as mojibake.
export const ASCII: Glyphs = { ok: "+", fail: "x", warn: "!", skip: "-", ask: "?", spinner: ["|", "/", "-", "\\"] };

// \u001b escapes, never a literal control byte, or git/grep/diff treat the file as binary.
export const DIM = "\u001b[2m";
export const BOLD = "\u001b[1m";
export const GREEN = "\u001b[32m";
export const RED = "\u001b[31m";
export const YELLOW = "\u001b[33m";
export const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** What every shape needs to know about the screen it is drawn on. */
export interface Pen {
    readonly colour: boolean;
    readonly glyphs: Glyphs;
    readonly width: number;
}

/** The verdict a glyph carries. */
export type Tone = "ok" | "fail" | "warn" | "skip";

/** One row of a report: a verdict, the thing, and a dim half-sentence about it. */
export interface Item {
    readonly tone: Tone;
    readonly name: string;
    readonly meta?: string | undefined;
}

/** A footnote on a finished run: what it does, and the command that does it. */
export type Footnote = readonly [what: string, command: string];

/* HOW MANY TERMINAL CELLS A STRING TAKES, which is what every column below is counted in: a CJK ideograph or an
emoji takes two, a combining mark or a zero-width joiner none, a colour escape none. Code points would undercount the
first and overcount the second, and a line counted short is a line the terminal wraps. The tables are a compact cut of
Unicode 15.1 (East Asian Wide/Fullwidth; nonspacing, enclosing and format marks in the scripts a name or a message is
likely to carry), identical to ui.rs's and held there by the fixture's `widths` case. */
const WIDE: readonly number[] = [
    0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe,
    0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
    0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa,
    0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755,
    0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55,
    0x2e80, 0x3029, 0x302e, 0x303e, 0x3041, 0x3096, 0x309b, 0x3247, 0x3250, 0x4dbf, 0x4e00, 0xa4c6, 0xa960, 0xa97c,
    0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe3,
    0x16ff0, 0x1b2fb, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f320,
    0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0,
    0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e,
    0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5,
    0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7f0,
    0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1faf8, 0x20000, 0x3fffd,
];
const ZERO: readonly number[] = [
    0x0300, 0x036f, 0x0483, 0x0489, 0x0591, 0x05bd, 0x05bf, 0x05bf, 0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7, 0x05c7,
    0x0610, 0x061a, 0x061c, 0x061c, 0x064b, 0x065f, 0x0670, 0x0670, 0x06d6, 0x06dc, 0x06df, 0x06e4, 0x06e7, 0x06e8,
    0x06ea, 0x06ed, 0x0711, 0x0711, 0x0730, 0x074a, 0x07a6, 0x07b0, 0x07eb, 0x07f3, 0x07fd, 0x07fd, 0x0816, 0x0819,
    0x081b, 0x0823, 0x0825, 0x0827, 0x0829, 0x082d, 0x0859, 0x085b, 0x0890, 0x089f, 0x08ca, 0x08e1, 0x08e3, 0x08ff,
    0x0e31, 0x0e31, 0x0e34, 0x0e3a, 0x0e47, 0x0e4e, 0x1160, 0x11ff, 0x1ab0, 0x1ace, 0x1dc0, 0x1dff, 0x200b, 0x200f,
    0x202a, 0x202e, 0x2060, 0x206f, 0x20d0, 0x20f0, 0x302a, 0x302d, 0x3099, 0x309a, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f,
    0xfeff, 0xfeff, 0xe0001, 0xe01ef,
];
const inTable = (table: readonly number[], point: number): boolean => {
    let low = 0;
    let high = table.length / 2 - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (point < table[middle * 2]!) {
            high = middle - 1;
        } else if (point > table[middle * 2 + 1]!) {
            low = middle + 1;
        } else {
            return true;
        }
    }
    return false;
};

/** Cells one code point takes: 0 for a control character or a zero-width mark, 2 for a wide one, 1 otherwise. */
export const charWidth = (point: number): number => {
    if (point < 0x20 || (point >= 0x7f && point < 0xa0)) {
        return 0;
    }
    if (point < 0x300) {
        return 1;
    }
    return inTable(ZERO, point) ? 0 : inTable(WIDE, point) ? 2 : 1;
};

/** A CSI escape (colour, cursor): drawn as nothing, and never cut in half. The same grammar as ui.rs's `escape_at`. */
const ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

/** Cells `text` takes on a terminal, escapes included as nothing. */
export const displayWidth = (text: string): number => {
    let cells = 0;
    for (const part of text.replace(ESCAPE, "")) {
        cells += charWidth(part.codePointAt(0)!);
    }
    return cells;
};

const length = displayWidth;

/** `text` followed by spaces up to `column` cells (padEnd counts UTF-16 units, which misaligns anything astral). */
const padTo = (text: string, column: number): string => `${text}${" ".repeat(Math.max(0, column - length(text)))}`;

/** Text as one line: every control character (a newline, a tab, a carriage return) becomes a space; an escape stays. */
export const clean = (text: string): string => text.replace(new RegExp(`${ESCAPE.source}|[\\u0000-\\u001f\\u007f-\\u009f]`, "gu"), (found) => (found.length > 1 ? found : " "));

/**
 * Clips to `limit` cells, marking the cut; used only on the repainted line, which must not wrap. Never cuts inside an
 * escape or a character, and keeps the escapes past the cut, so a colour reset still lands.
 */
export const truncate = (text: string, limit: number): string => {
    if (length(text) <= limit) {
        return text;
    }
    if (limit <= 1) {
        return "";
    }
    let kept = "";
    let cells = 0;
    let cut = false;
    const escapes: string[] = [];
    for (const [at, piece] of text.split(new RegExp(`(${ESCAPE.source})`, "u")).entries()) {
        if (at % 2 === 1) {
            if (cut) {
                escapes.push(piece);
            } else {
                kept += piece;
            }
            continue;
        }
        for (const part of piece) {
            const cost = charWidth(part.codePointAt(0)!);
            if (cut || cells + cost > limit - 1) {
                cut = true;
                break;
            }
            kept += part;
            cells += cost;
        }
    }
    return `${kept}…${escapes.join("")}`;
};

/** Lines as Rust's `str::lines` reads them: a `\r` before a `\n` is part of the break, and a trailing break adds no line. */
const splitLines = (text: string): string[] => {
    if (text === "") {
        return [];
    }
    const parts = text.split("\n");
    const lines = parts.map((line, at) => (at < parts.length - 1 ? line.replace(/\r$/u, "") : line));
    return text.endsWith("\n") ? lines.slice(0, -1) : lines;
};

export const paint = (pen: Pen, text: string, code: string): string => (pen.colour && text !== "" ? `${code}${text}${RESET}` : text);

const glyph = (pen: Pen, tone: Tone): string => {
    switch (tone) {
        case "ok":
            return paint(pen, pen.glyphs.ok, GREEN);
        case "fail":
            return paint(pen, pen.glyphs.fail, RED);
        case "warn":
            return paint(pen, pen.glyphs.warn, YELLOW);
        case "skip":
            return paint(pen, pen.glyphs.skip, DIM);
    }
};

/** The column word a plain log has always used for each verdict; only the failure shouts. */
const plainWord = (tone: Tone): string => {
    switch (tone) {
        case "ok":
            return "ok  ";
        case "fail":
            return "FAIL";
        case "warn":
            return "warn";
        case "skip":
            return "skip";
    }
};

/** Wraps text to at most `width`; a word longer than the line overflows rather than breaking a URL or a name. */
export const wrap = (text: string, width: number): string[] => {
    if (width < 20) {
        return [text];
    }
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/u).filter((part) => part !== "")) {
        if (current === "") {
            current = word;
        } else if (length(current) + 1 + length(word) <= width) {
            current = `${current} ${word}`;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current !== "") {
        lines.push(current);
    }
    return lines.length === 0 ? [""] : lines;
};

/** Spaces that push `right` to the line's last usable column (width - 1, so nothing wraps); none when there is nothing on the right. */
const gap = (pen: Pen, left: number, right: number): string => (right === 0 ? "" : " ".repeat(Math.max(1, pen.width - 1 - left - right)));

/** The header of a flow or a report: the title, a dim version stamp on the right, and one dim scope line. */
export const headingLines = (pen: Pen, title: string, stamp?: string, scope?: string): string[] => {
    const head =
        stamp === undefined || stamp === ""
            ? `  ${paint(pen, title, BOLD)}`
            : `  ${paint(pen, title, BOLD)}${gap(pen, 2 + length(title), length(stamp))}${paint(pen, stamp, DIM)}`;
    const lines = ["", head];
    if (scope !== undefined && scope !== "") {
        for (const part of wrap(scope, pen.width - 3)) {
            lines.push(`  ${paint(pen, part, DIM)}`);
        }
    }
    lines.push("");
    return lines;
};

/** The scope line a flow promises when it has nothing more specific to say. */
export const planSummary = (steps: number, seconds: number): string => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${steps} step${steps === 1 ? "" : "s"}, roughly ${minutes} minute${minutes === 1 ? "" : "s"}.`;
};

/** A step or an action that has finished, with how long it took on the right. `ordinal` is set for a flow's numbered steps. */
export const settledLine = (pen: Pen, tone: Tone, ordinal: number | undefined, label: string, took: string): string => {
    const number = ordinal === undefined ? "" : `${String(ordinal).padStart(2)}  `;
    const left = 5 + length(number) + length(label);
    const shown = ordinal === undefined ? "" : `${paint(pen, String(ordinal).padStart(2), DIM)}  `;
    return `  ${glyph(pen, tone)}  ${shown}${label}${gap(pen, left, length(took))}${paint(pen, took, DIM)}`;
};

/**
 * The one repainted line: spinner, the step's ordinal (a flow's) or none (an action's), its label, a dim detail, and the
 * time on the right. It must never reach the last column, or the terminal wraps it and every later carriage return
 * lands a row late; so it is one line (control characters become spaces) cut to `width - 1` cells, the detail first and
 * then the label, and the time is dropped when not even that fits.
 */
export const liveLine = (pen: Pen, spinner: string, ordinal: number | undefined, label: string, detail: string, took: string): string => {
    const number = ordinal === undefined ? "" : `${String(ordinal).padStart(2)}  `;
    const budget = pen.width - 1;
    const lead = 4 + length(spinner) + length(number);
    const right = lead + length(took) + 1 > budget ? "" : clean(took);
    const room = Math.max(0, budget - lead - (right === "" ? 0 : length(right) + 1));
    const shownLabel = truncate(clean(label), room);
    const middle = detail === "" ? "" : truncate(`  ·  ${clean(detail)}`, room - length(shownLabel));
    const shownNumber = ordinal === undefined ? "" : `${paint(pen, String(ordinal).padStart(2), DIM)}  `;
    const head = `  ${paint(pen, spinner, CYAN)}  ${shownNumber}${shownLabel}${paint(pen, middle, DIM)}`;
    return right === "" ? head : `${head}${" ".repeat(room - length(shownLabel) - length(middle))} ${paint(pen, right, DIM)}`;
};

/** The end of a flow: one bold verdict and the run's whole duration. */
export const verdictLines = (pen: Pen, tone: Tone, verdict: string, took: string): string[] => [
    "",
    `  ${glyph(pen, tone)}  ${paint(pen, verdict, BOLD)}${gap(pen, 5 + length(verdict), length(took))}${paint(pen, took, DIM)}`,
];

/** The commands a reader will want later: labels dim and aligned, the command itself in body colour so it reads as copyable. */
export const footnoteLines = (pen: Pen, footnotes: readonly Footnote[]): string[] => {
    const column = Math.max(0, ...footnotes.map(([what]) => length(what)));
    return footnotes.map(([what, command], at) => {
        const heading = (at === 0 ? "later" : "").padEnd(6);
        return `     ${paint(pen, `${heading} ${padTo(what, column)}`, DIM)}   ${command}`;
    });
};

/** A verdict under the running step (a check, a requirement); dim, indented under the step. */
export const rowLines = (pen: Pen, tone: Tone, name: string, note = ""): string[] => {
    const body = note === "" ? name : `${name} — ${note}`;
    return wrap(body, pen.width - 10).map((part, at) =>
        at === 0 ? `        ${glyph(pen, tone)} ${paint(pen, part, DIM)}` : `          ${paint(pen, part, DIM)}`,
    );
};

/** The same verdict for a log: the aligned word column `ic` has always written. */
export const plainRowLine = (tone: Tone, name: string, note = ""): string => `  ${plainWord(tone)}  ${name}${note === "" ? "" : ` — ${note}`}`;

/** A report's rows: glyph, name in one aligned column, and a dim note. */
export const itemLines = (pen: Pen, items: readonly Item[]): string[] => {
    const column = Math.max(0, ...items.map((item) => length(item.name)));
    return items.map((item) => {
        const meta = item.meta ?? "";
        return meta === "" ? `  ${glyph(pen, item.tone)}  ${item.name}` : `  ${glyph(pen, item.tone)}  ${padTo(item.name, column)}   ${paint(pen, meta, DIM)}`;
    });
};

export const plainItemLines = (items: readonly Item[]): string[] => items.map((item) => plainRowLine(item.tone, item.name, item.meta ?? ""));

/** A report's sub-heading. */
export const sectionLines = (pen: Pen, title: string): string[] => ["", `     ${paint(pen, title, DIM)}`];

export const plainSectionLines = (title: string): string[] => ["", `${title}:`];

/** Facts as key and value, keys dim in one column. */
export const fieldLines = (pen: Pen, fields: readonly Footnote[]): string[] => {
    const column = Math.max(0, ...fields.map(([key]) => length(key)));
    return fields.map(([key, value]) => `     ${paint(pen, padTo(key, column), DIM)}   ${value}`);
};

export const plainFieldLines = (fields: readonly Footnote[]): string[] => fields.map(([key, value]) => `${key}: ${value}`);

/** A neutral one-line outcome: an empty report, a cancelled question. */
export const quietLine = (pen: Pen, sentence: string): string => `  ${glyph(pen, "skip")}  ${paint(pen, sentence, DIM)}`;

export const CANCELLED = "Cancelled. Nothing changed.";

/** A question: the question in bold, then what answering yes does, before the reader is asked. */
export const questionLines = (pen: Pen, question: string, consequence = ""): string[] => {
    const lines = [`  ${paint(pen, pen.glyphs.ask, CYAN)}  ${paint(pen, question, BOLD)}`];
    if (consequence !== "") {
        for (const paragraph of splitLines(consequence)) {
            for (const part of wrap(paragraph, pen.width - 6)) {
                lines.push(`     ${paint(pen, part, DIM)}`);
            }
        }
    }
    return lines;
};

/** A message for a stop: what did not happen, why, and the one thing to do. `stopLines` lays it out. */
export const explain = (headline: string, problem?: string, fix?: string): string =>
    [headline, problem === undefined ? undefined : `   problem: ${problem}`, fix === undefined ? undefined : `   fix:     ${fix}`]
        .filter((line) => line !== undefined)
        .join("\n");

/** The stop block: a red headline, then any `problem:`/`fix:` pairs with their labels dim and their values in one column. */
export const stopLines = (pen: Pen, message: string): string[] => {
    const [first = "", ...rest] = splitLines(message);
    const lines = ["", ...wrap(first, pen.width - 6).map((part, at) => `${at === 0 ? `  ${glyph(pen, "fail")}  ` : "     "}${paint(pen, part, RED)}`)];
    for (const raw of rest) {
        const trimmed = raw.trimEnd();
        if (trimmed === "") {
            lines.push("");
            continue;
        }
        const indent = trimmed.length - trimmed.trimStart().length;
        const body = trimmed.trimStart();
        const split = body.indexOf(": ");
        const label = split > 0 ? body.slice(0, split).trimEnd() : "";
        if (indent > 0 && (label === "problem" || label === "fix")) {
            // "problem:" is the wider label; padding to it puts both values in one column, however long the remedy.
            const padded = `${label}:`.padEnd(9);
            const column = indent + 2 + padded.length;
            for (const [at, part] of wrap(body.slice(split + 2), pen.width - column - 1).entries()) {
                lines.push(at === 0 ? `  ${" ".repeat(indent)}${paint(pen, padded, DIM)}${part}` : `${" ".repeat(column)}${part}`);
            }
            continue;
        }
        for (const [at, part] of wrap(body, pen.width - indent - 4).entries()) {
            lines.push(`  ${" ".repeat(at === 0 ? indent : indent + 3)}${part}`);
        }
    }
    lines.push("");
    return lines;
};

/** A numbered list to pick from. */
export const pickLines = (pen: Pen, items: readonly Footnote[]): string[] => {
    const column = Math.max(0, ...items.map(([name]) => length(name)));
    return items.map(([name, meta], at) => {
        const number = paint(pen, String(at + 1).padStart(2), CYAN);
        return meta === "" ? `  ${number}  ${name}` : `  ${number}  ${padTo(name, column)}   ${paint(pen, meta, DIM)}`;
    });
};
