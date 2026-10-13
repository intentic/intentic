// How a long reply becomes several chat messages without breaking what it says: a cut lands on a paragraph, then a
// line, then a space when one is near, and a code block cut in two is closed at the end of one message and reopened,
// language and all, at the start of the next, so neither half renders as prose. Shared by every gateway's posts.

// An opening or closing fence: three or more backticks or tildes, indented at most three spaces; an opener may carry an
// info string (the language).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface OpenFence {
    // The run that closes it (a closer must use the same character, at least as many).
    readonly marker: string;
    // The whole opening line, what a continuation reopens with.
    readonly opener: string;
}

// The fence still open after reading `text`, or undefined when every block in it is closed.
export const openFenceAfter = (text: string): OpenFence | undefined => {
    let open: OpenFence | undefined;
    for (const line of text.split("\n")) {
        const fence = FENCE.exec(line);
        const run = fence?.[1];
        if (fence === null || run === undefined) {
            continue;
        }
        if (open === undefined) {
            open = { marker: run, opener: line.trimStart() };
        } else if (run[0] === open.marker[0] && run.length >= open.marker.length && (fence[2] ?? "").trim() === "") {
            open = undefined;
        }
    }
    return open;
};

// Where a message ends: `at` is the index of the first character it leaves out, `skip` how many characters the break
// itself takes (a newline, a space), which belong to neither side.
interface Cut {
    readonly at: number;
    readonly skip: number;
}

// Where to cut `text` at or before `limit`: the last paragraph break past half the window, else the last line break or
// space past a third of it, else `limit` itself (never between the halves of a surrogate pair).
const cutPoint = (text: string, limit: number): Cut => {
    const window = text.slice(0, limit + 1);
    const paragraph = window.lastIndexOf("\n\n");
    if (paragraph > limit / 2) {
        return { at: paragraph, skip: 2 };
    }
    const line = window.lastIndexOf("\n");
    if (line > limit / 3) {
        return { at: line, skip: 1 };
    }
    const space = window.lastIndexOf(" ");
    if (space > limit / 3) {
        return { at: space, skip: 1 };
    }
    const code = text.charCodeAt(limit - 1);
    return { at: code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit, skip: 0 };
};

// One message cut from the front of a reply, and what is left after it.
interface Split {
    readonly head: string;
    readonly tail: string;
}

// The first message of `text` and what is left after it, the first at most `max` characters.
const splitOnce = (text: string, max: number): Split => {
    let cut = cutPoint(text, max);
    let open = openFenceAfter(text.slice(0, cut.at));
    if (open !== undefined) {
        // The closing line has to fit too: cut again short of it, then read the fence state at the new cut.
        cut = cutPoint(text, max - open.marker.length - 1);
        open = openFenceAfter(text.slice(0, cut.at));
    }
    const head = text.slice(0, cut.at);
    const tail = text.slice(cut.at + cut.skip);
    // A reopening line as long as a whole message could never make progress; cut it as plain text instead.
    if (open === undefined || open.opener.length + 1 >= max) {
        return { head, tail };
    }
    return { head: `${head}\n${open.marker}`, tail: `${open.opener}\n${tail}` };
};

// `text` as messages of at most `max` characters each, in order; one message when it already fits.
export const chunkMessage = (text: string, max: number): string[] => {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const { head, tail } = splitOnce(rest, max);
        if (head.length > 0) {
            chunks.push(head);
        }
        rest = tail;
    }
    if (rest.length > 0) {
        chunks.push(rest);
    }
    return chunks;
};

// A Markdown table's separator row: cells of dashes, each optionally colon-aligned.
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const cellsOf = (row: string): string[] => {
    const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|").replaceAll(/\*\*|__|`/g, ""));
};

// A table as aligned monospace columns, fenced, since chat clients (Discord, Slack) draw Markdown tables as raw pipes.
const tableAsCode = (rows: readonly string[]): string => {
    const cells = rows.map(cellsOf);
    const columns = Math.max(...cells.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_, column) => Math.max(...cells.map((row) => (row[column] ?? "").length)));
    const line = (row: readonly string[]): string =>
        widths
            .map((width, column) => (row[column] ?? "").padEnd(width))
            .join("  ")
            .trimEnd();
    const [header, ...body] = cells;
    return ["```", line(header ?? []), widths.map((width) => "-".repeat(Math.max(width, 1))).join("  "), ...body.map(line), "```"].join("\n");
};

// Whether a line can belong to a table's body: it has a cell border and is not blank.
const tableRow = (line: string | undefined): line is string => line !== undefined && line.includes("|") && line.trim() !== "";

// `text` with every Markdown table outside a code block redrawn as an aligned code block; everything else untouched.
export const tablesToCode = (text: string): string => {
    const lines = text.split("\n");
    const out: string[] = [];
    let inFence = false;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        const next = lines[index + 1];
        if (FENCE.test(line)) {
            inFence = !inFence;
        } else if (!inFence && line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next)) {
            const rows = [line];
            let cursor = index + 2;
            for (let row = lines[cursor]; tableRow(row); row = lines[cursor]) {
                rows.push(row);
                cursor += 1;
            }
            out.push(tableAsCode(rows));
            index = cursor;
            continue;
        }
        out.push(line);
        index += 1;
    }
    return out.join("\n");
};
