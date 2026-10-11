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

const length = (text: string): number => [...text].length;

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
        return `     ${paint(pen, `${heading} ${what.padEnd(column)}`, DIM)}   ${command}`;
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
        return meta === "" ? `  ${glyph(pen, item.tone)}  ${item.name}` : `  ${glyph(pen, item.tone)}  ${item.name.padEnd(column)}   ${paint(pen, meta, DIM)}`;
    });
};

export const plainItemLines = (items: readonly Item[]): string[] => items.map((item) => plainRowLine(item.tone, item.name, item.meta ?? ""));

/** A report's sub-heading. */
export const sectionLines = (pen: Pen, title: string): string[] => ["", `     ${paint(pen, title, DIM)}`];

export const plainSectionLines = (title: string): string[] => ["", `${title}:`];

/** Facts as key and value, keys dim in one column. */
export const fieldLines = (pen: Pen, fields: readonly Footnote[]): string[] => {
    const column = Math.max(0, ...fields.map(([key]) => length(key)));
    return fields.map(([key, value]) => `     ${paint(pen, key.padEnd(column), DIM)}   ${value}`);
};

export const plainFieldLines = (fields: readonly Footnote[]): string[] => fields.map(([key, value]) => `${key}: ${value}`);

/** A neutral one-line outcome: an empty report, a cancelled question. */
export const quietLine = (pen: Pen, sentence: string): string => `  ${glyph(pen, "skip")}  ${paint(pen, sentence, DIM)}`;

export const CANCELLED = "Cancelled. Nothing changed.";

/** A question: the question in bold, then what answering yes does, before the reader is asked. */
export const questionLines = (pen: Pen, question: string, consequence = ""): string[] => {
    const lines = [`  ${paint(pen, pen.glyphs.ask, CYAN)}  ${paint(pen, question, BOLD)}`];
    if (consequence !== "") {
        for (const paragraph of consequence.split("\n")) {
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
    const [first = "", ...rest] = message.split("\n");
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
        return meta === "" ? `  ${number}  ${name}` : `  ${number}  ${name.padEnd(column)}   ${paint(pen, meta, DIM)}`;
    });
};
