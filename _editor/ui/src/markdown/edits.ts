// Each formatting shortcut is a pure function from (text, selection) to (text, selection), applied the same way
// the surface applies a paste. Toggles rather than only wraps: pressing it again on an already-emphasised
// selection removes the markers instead of nesting them.

export interface TextEdit {
    readonly text: string;
    /** The selection to restore afterwards, as source offsets. Equal ends mean a caret. */
    readonly start: number;
    readonly end: number;
}

// How many of `char` run backward/forward from `at`, to tell `**` from `*`: a marker beside a selection doesn't
// count if it's part of a longer run of the same character.
const runBefore = (text: string, at: number, char: string): number => {
    let length = 0;
    while (at - length - 1 >= 0 && text[at - length - 1] === char) {
        length += 1;
    }
    return length;
};

const runAfter = (text: string, at: number, char: string): number => {
    let length = 0;
    while (at + length < text.length && text[at + length] === char) {
        length += 1;
    }
    return length;
};

/**
 * Puts `marker` around the selection, or removes it if already there. With nothing selected, empty markers are
 * inserted with the caret between them, so Ctrl+B then typing produces bold text.
 */
export const toggleWrap = (text: string, start: number, end: number, marker: string): TextEdit => {
    const width = marker.length;
    const char = marker[0] ?? ``;
    const selected = text.slice(start, end);

    // The selection is the marked-up run itself: `**bold**` with the asterisks inside it.
    if (selected.length >= width * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
        const inner = selected.slice(width, selected.length - width);
        return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
    }

    // Selection is the words with markers just outside (`**[bold]**`), only when the flanking run matches exactly.
    if (runBefore(text, start, char) === width && runAfter(text, end, char) === width) {
        return {
            text: text.slice(0, start - width) + selected + text.slice(end + width),
            start: start - width,
            end: end - width,
        };
    }

    return {
        text: text.slice(0, start) + marker + selected + marker + text.slice(end),
        start: start + width,
        end: end + width,
    };
};

/**
 * Turns the selection into a link, or wraps the caret in an empty one. Selected words become the link text, and
 * the selection lands in the empty target (the part not yet known); with nothing selected, the caret goes where
 * the words would.
 */
export const insertLink = (text: string, start: number, end: number): TextEdit => {
    const selected = text.slice(start, end);
    const next = `${text.slice(0, start)}[${selected}]()${text.slice(end)}`;
    // `[` + the words + `](`, which is where the target begins.
    const target = start + 1 + selected.length + 2;
    return selected === `` ? { text: next, start: start + 1, end: start + 1 } : { text: next, start: target, end: target };
};

// Indent step: two spaces, the least that nests a bullet under `- ` in CommonMark.
const STEP = `  `;

// Start offset of every line the selection touches; a caret at a line's very start excludes the line above.
const linesIn = (text: string, start: number, end: number): number[] => {
    const first = text.lastIndexOf(`\n`, Math.max(0, start - 1)) + 1;
    const starts: number[] = [];
    for (let at = first; at <= end;) {
        starts.push(at);
        const next = text.indexOf(`\n`, at);
        if (next === -1 || next >= end) {
            break;
        }
        at = next + 1;
    }
    return starts;
};

// Applying a per-line change to the lines a selection covers, keeping the selection over the same words.
const overLines = (text: string, start: number, end: number, change: (line: string) => string): TextEdit => {
    const starts = linesIn(text, start, end);
    let next = text;
    let shiftStart = 0;
    let shiftEnd = 0;
    // Back to front, so an earlier line's edit cannot move a later line's offset out from under this loop.
    for (const at of starts.toReversed()) {
        const lineEnd = next.indexOf(`\n`, at);
        const line = next.slice(at, lineEnd === -1 ? next.length : lineEnd);
        const changed = change(line);
        if (changed === line) {
            continue;
        }
        next = next.slice(0, at) + changed + next.slice(at + line.length);
        const delta = changed.length - line.length;
        shiftEnd += delta;
        if (at < start) {
            shiftStart += delta;
        }
    }
    return { text: next, start: Math.max(0, start + shiftStart), end: Math.max(0, end + shiftEnd) };
};

/** Indent every line the selection touches by one step. */
export const indentLines = (text: string, start: number, end: number): TextEdit =>
    overLines(text, start, end, (line) => (line === `` ? line : STEP + line));

/** Remove one step of indentation from every line the selection touches that has any. */
export const outdentLines = (text: string, start: number, end: number): TextEdit =>
    overLines(text, start, end, (line) => {
        if (line.startsWith(`\t`)) {
            return line.slice(1);
        }
        const spaces = /^ {1,2}/u.exec(line)?.[0] ?? ``;
        return line.slice(spaces.length);
    });

// Matches what opens a list item: indent, marker (`\d+[.)]` covers both ordered spellings), optional task box,
// and the trailing space, as named groups. The task box is part of the prefix, not the content, so continuing a
// checklist starts unticked.
const LIST_LINE = /^(?<indent>[ \t]*)(?<marker>[-*+]|\d+[.)])[ \t]+(?<task>\[[ xX]\][ \t]+)?(?<body>.*)$/u;

/** The line `offset` sits on, as source offsets. */
const lineAt = (text: string, offset: number): { start: number; end: number } => {
    const start = text.lastIndexOf(`\n`, Math.max(0, offset - 1)) + 1;
    const end = text.indexOf(`\n`, start);
    return { start, end: end === -1 ? text.length : end };
};

/** Whether an offset sits on a line that is a list item, which is where Tab means indentation rather than focus. */
export const onListLine = (text: string, offset: number): boolean => {
    const { start, end } = lineAt(text, offset);
    return LIST_LINE.test(text.slice(start, end));
};

// Enter on a list item opens the next one (numbered lists count up by one from the line above); on an empty item
// it ends the list instead, removing the empty marker. Returns undefined off a list item, or mid-item (a split,
// not a continuation).
const nextOpener = (groups: Record<string, string | undefined>): string => {
    const indent = groups[`indent`] ?? ``;
    const marker = groups[`marker`] ?? ``;
    const counted = /^\d+$/u.exec(marker.slice(0, -1))?.[0];
    const next = counted === undefined ? marker : `${Number(counted) + 1}${marker.slice(-1)}`;
    // A ticked box is not carried down: the next thing on the list has not been done yet.
    return `${indent}${next} ${groups[`task`] === undefined ? `` : `[ ] `}`;
};

export interface ListEnter {
    readonly edit: TextEdit;
    /** True when the item was empty (leaving the list); the caller must also open a block to place the caret. */
    readonly ended: boolean;
}

export const continueList = (text: string, offset: number): ListEnter | undefined => {
    const { start, end } = lineAt(text, offset);
    // Only from the end of the line: mid-item, Enter is the ordinary "new block" it is everywhere else.
    const groups = offset === end ? LIST_LINE.exec(text.slice(start, end))?.groups : undefined;
    if (groups === undefined) {
        return undefined;
    }
    // An empty item's marker is removed together with its trailing newline: leaving the newline creates a blank line
    // inside the list, which markdown reads as a loose list rather than an ended one, and the next text continues the
    // item above.
    if ((groups[`body`] ?? ``) === ``) {
        const cut = Math.min(end + 1, text.length);
        return { edit: { text: `${text.slice(0, start)}${text.slice(cut)}`, start, end: start }, ended: true };
    }
    const opener = nextOpener(groups);
    const caret = end + 1 + opener.length;
    return { edit: { text: `${text.slice(0, end)}\n${opener}${text.slice(end)}`, start: caret, end: caret }, ended: false };
};
