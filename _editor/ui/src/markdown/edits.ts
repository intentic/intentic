/* THE EDITS BEHIND THE FORMATTING KEYS, as transformations of markdown source.
 *
 * Ctrl+B in this surface cannot mean what it means in a word processor: there is no "bold" to switch on, there
 * are two asterisks to put around something. So each shortcut is a pure function from (text, selection) to
 * (text, selection), and the surface applies it the same way it applies a paste, which keeps every path that
 * changes the document going through one place.
 *
 * TOGGLING, NOT JUST WRAPPING, because a shortcut that only ever adds is a shortcut you can press once. Pressing
 * it on something already emphasised takes the emphasis off, whether the user selected the word inside the
 * asterisks or the asterisks along with it. */

export interface TextEdit {
    readonly text: string;
    /** The selection to restore afterwards, as source offsets. Equal ends mean a caret. */
    readonly start: number;
    readonly end: number;
}

/* How many of `char` run backwards from `at`, and forwards from it. Used to tell `**` from `*`: the character
 * beside a selection is not this marker if it is part of a longer run of the same one. Without the distinction,
 * Ctrl+I on a **bold** word read the neighbouring asterisk as its own and took a single one off each side,
 * quietly turning bold into italic instead of adding italics to it. */
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
 * Put `marker` around the selection, or take it off if it is already there.
 *
 * With nothing selected the markers are inserted empty and the caret is left between them, so Ctrl+B then typing
 * writes bold text, which is what the reflex expects.
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

    // The selection is the words, and the markers are just outside it: `**[bold]**`. Only when the runs either
    // side are exactly this marker, so a wider one around it is added to rather than eaten into.
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
 * Turn the selection into a link, or wrap the caret in an empty one.
 *
 * The selected words become the link's TEXT and the selection lands in the empty target, because the thing you
 * do not have yet is the URL. With nothing selected, the caret goes where the words go instead.
 */
export const insertLink = (text: string, start: number, end: number): TextEdit => {
    const selected = text.slice(start, end);
    const next = `${text.slice(0, start)}[${selected}]()${text.slice(end)}`;
    // `[` + the words + `](`, which is where the target begins.
    const target = start + 1 + selected.length + 2;
    return selected === `` ? { text: next, start: start + 1, end: start + 1 } : { text: next, start: target, end: target };
};

/* ONE STEP OF INDENTATION, two spaces: the least that nests a bullet under `- ` in CommonMark, and what a
 * document written with four gets to in two presses rather than being reformatted to a convention it did not
 * choose. Outdent removes a step, or a single tab where the line was indented with one. */
const STEP = `  `;

// The start offset of every line the selection touches. A caret sitting at the very start of a line does not
// drag the line above into the edit.
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

/* WHAT OPENS A LIST ITEM: the indentation, the marker, an optional task box, and the space after them. Named
 * groups because three different callers want three different pieces of it, and positional indices into a
 * regex this shape are how the wrong piece gets used.
 *
 * `\d+[.)]` covers both ordered spellings CommonMark allows. The task box is part of the PREFIX rather than of
 * the content, because continuing a checklist has to produce an unticked box rather than a copy of the ticked
 * one above it. */
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

/* ENTER ON A LIST ITEM OPENS THE NEXT ONE, which is the affordance that lets a checklist be written without
 * reaching for the mouse, and the reason a story's acceptance criteria can be a plain markdown list rather
 * than a bespoke row editor with its own keyboard layer.
 *
 * ON AN EMPTY ITEM IT ENDS THE LIST INSTEAD. Pressing Enter twice is how every editor in the world says "I am
 * done listing things", and without it the only way out of a list is to type a character and delete it. The
 * empty marker is removed rather than left behind, so the file does not keep a bullet nobody wrote anything
 * against.
 *
 * AN ORDERED LIST COUNTS UP, and only by one from the line above: renumbering the whole list from here would
 * be an edit to lines the writer is not looking at, and CommonMark takes its numbering from the first item
 * anyway. A list written `1. 1. 1.` on purpose is left alone by the same rule — the number that follows `1`
 * under it is `2`, which is what the next press of Enter is asking for.
 *
 * Returns undefined when the caret is not on a list item, so the caller can let Enter mean what it usually
 * means. A caret in the MIDDLE of an item is a split, not a continuation, and is also left alone: markdown
 * has no way to say "half this item", and what the writer means there is a new paragraph. */
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
    /**
     * The item was empty, so the writer is leaving the list. The caller applies the edit and then opens a
     * block, which is the only thing that can put the caret somewhere that is not a list item: the empty line
     * a writer wants next does not exist in markdown until they type into it.
     */
    readonly ended: boolean;
}

export const continueList = (text: string, offset: number): ListEnter | undefined => {
    const { start, end } = lineAt(text, offset);
    // Only from the end of the line: mid-item, Enter is the ordinary "new block" it is everywhere else.
    const groups = offset === end ? LIST_LINE.exec(text.slice(start, end))?.groups : undefined;
    if (groups === undefined) {
        return undefined;
    }
    /* AN ITEM WITH NOTHING IN IT: the writer is leaving the list, and the marker goes with them — together
     * with THE NEWLINE THAT ENDS IT, which is the part that was wrong the first time. Removing the marker and
     * leaving its newline behind puts a blank line INSIDE the list, and markdown reads that as a loose list
     * rather than as the end of one: the block was still a list, the caret was still in it, and the next
     * sentence typed became a continuation of the item above instead of a paragraph after it (seen in a
     * browser, which is the only way that class of bug is ever seen). */
    if ((groups[`body`] ?? ``) === ``) {
        const cut = Math.min(end + 1, text.length);
        return { edit: { text: `${text.slice(0, start)}${text.slice(cut)}`, start, end: start }, ended: true };
    }
    const opener = nextOpener(groups);
    const caret = end + 1 + opener.length;
    return { edit: { text: `${text.slice(0, end)}\n${opener}${text.slice(end)}`, start: caret, end: caret }, ended: false };
};
