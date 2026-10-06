import { diffSequence, type Op } from "@intentic/ui/diff";

// Line-level diff rows for chat's inline tool cards, a lightweight render of a tool_call's structured diff.
// Monaco stays the full-screen reviewer; a diff editor per card would be too heavy. Common prefix/suffix trim
// plus the kit's LCS edit script over the middle keeps an ordinary Edit snippet cheap.

export interface DiffRow {
    readonly type: "context" | "add" | "del" | "skip";
    readonly text: string;
}

// Rendered row cap: a whole-file Write stays a bounded card (the full file is one click away).
const MAX_ROWS = 160;
// LCS cell budget; beyond it (two huge dissimilar sides), falls back to plain del-all/add-all.
const MAX_LCS_CELLS = 250_000;
// Context runs longer than this collapse to their edges around a skip row.
const CONTEXT_EDGE = 3;

const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
const del = (text: string): DiffRow => ({ type: "del", text });
const add = (text: string): DiffRow => ({ type: "add", text });
const context = (text: string): DiffRow => ({ type: "context", text });
const skip = (count: number): DiffRow => ({ type: "skip", text: `⋯ ${count} unchanged lines` });

const rowOf = (op: Op<string>): DiffRow => (op.kind === `same` ? context(op.after) : op.kind === `removed` ? del(op.item) : add(op.item));

// Interleaves the trimmed middle by longest common subsequence, under this card's own (smaller) budget: past it
// (two huge dissimilar sides), every old line is deleted and every new one added.
const lcsRows = (dels: string[], adds: string[]): DiffRow[] =>
    diffSequence(dels, adds, (left, right) => left === right, MAX_LCS_CELLS)?.map(rowOf) ?? [...dels.map(del), ...adds.map(add)];

// Collapses long unchanged runs to their edges so the changed lines stay in view.
const collapse = (rows: DiffRow[]): DiffRow[] => {
    const out: DiffRow[] = [];
    let run: DiffRow[] = [];
    const flush = (trailing: boolean): void => {
        // Leading/trailing runs keep only the edge touching a change; middle runs keep both edges.
        const head = out.length === 0 ? 0 : CONTEXT_EDGE;
        const tail = trailing ? 0 : CONTEXT_EDGE;
        if (run.length <= head + tail + 1) {
            out.push(...run);
        } else {
            out.push(...run.slice(0, head), skip(run.length - head - tail), ...run.slice(run.length - tail));
        }
        run = [];
    };
    for (const row of rows) {
        if (row.type === "context") {
            run.push(row);
        } else {
            flush(false);
            out.push(row);
        }
    }
    flush(true);
    return out;
};

const cap = (rows: DiffRow[]): DiffRow[] => (rows.length <= MAX_ROWS ? rows : [...rows.slice(0, MAX_ROWS), skip(rows.length - MAX_ROWS)]);

// Full add/del/context rows before collapse/cap: every changed line is present, so counts stay exact.
// collapse() only folds context, so display never drops a counted line.
const rawRows = (oldText: string | undefined, newText: string): DiffRow[] => {
    const oldLines = splitLines(oldText ?? "");
    const newLines = splitLines(newText);
    if (oldLines.length === 0) {
        return newLines.map(add);
    }
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
        start++;
    }
    let endOld = oldLines.length;
    let endNew = newLines.length;
    while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
        endOld--;
        endNew--;
    }
    return [
        ...oldLines.slice(0, start).map(context),
        ...lcsRows(oldLines.slice(start, endOld), newLines.slice(start, endNew)),
        ...oldLines.slice(endOld).map(context),
    ];
};

export const diffRows = (oldText: string | undefined, newText: string): DiffRow[] => cap(collapse(rawRows(oldText, newText)));

// Exact +additions/-deletions for the card header, counted from the uncollapsed, uncapped rows.
// Remembered by the two texts: the same edit's counts are asked for by its card's header, its icon and its group's
// summary, and again on every patch to any tool in the turn while a reply streams, and each ask ran a line diff.
const STATS_KEPT = 256;
const stats = new Map<string, Readonly<DiffStat>>();

export interface DiffStat {
    additions: number;
    deletions: number;
}

export const diffStat = (oldText: string | undefined, newText: string): DiffStat => {
    const key = `${oldText === undefined ? `\u0001` : `\u0002${oldText}`}\u0000${newText}`;
    const kept = stats.get(key);
    if (kept !== undefined) {
        return { ...kept };
    }
    let additions = 0;
    let deletions = 0;
    for (const row of rawRows(oldText, newText)) {
        if (row.type === "add") {
            additions++;
        } else if (row.type === "del") {
            deletions++;
        }
    }
    stats.set(key, { additions, deletions });
    if (stats.size > STATS_KEPT) {
        const oldest = stats.keys().next().value;
        if (oldest !== undefined) {
            stats.delete(oldest);
        }
    }
    return { additions, deletions };
};
