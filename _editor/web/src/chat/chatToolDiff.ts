/* Line-level diff rows for the chat's inline tool cards, a lightweight render of a tool_call's structured
 * diff content. Monaco stays the full-screen reviewer; mounting a diff editor per transcript card is far too
 * heavy. Common prefix/suffix trim + an LCS walk over the middle keeps the usual Edit snippet cheap. */

export interface DiffRow {
    readonly type: "context" | "add" | "del" | "skip";
    readonly text: string;
}

// Rendered row cap: a whole-file Write stays a bounded card (the full file is one click away).
const MAX_ROWS = 160;
// LCS cell budget; beyond it (two huge dissimilar sides) fall back to plain del-all/add-all.
const MAX_LCS_CELLS = 250_000;
// Context runs longer than this collapse to their edges around a skip row.
const CONTEXT_EDGE = 3;

const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
const del = (text: string): DiffRow => ({ type: "del", text });
const add = (text: string): DiffRow => ({ type: "add", text });
const context = (text: string): DiffRow => ({ type: "context", text });
const skip = (count: number): DiffRow => ({ type: "skip", text: `⋯ ${count} unchanged lines` });

// Interleave the trimmed middle by longest common subsequence (bottom-up table, then a walk).
const lcsRows = (dels: string[], adds: string[]): DiffRow[] => {
    if (dels.length * adds.length > MAX_LCS_CELLS) {
        return [...dels.map(del), ...adds.map(add)];
    }
    const width = adds.length + 1;
    const table = new Uint32Array((dels.length + 1) * width);
    for (let i = dels.length - 1; i >= 0; i--) {
        for (let j = adds.length - 1; j >= 0; j--) {
            table[i * width + j] =
                dels[i] === adds[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
        }
    }
    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < dels.length && j < adds.length) {
        if (dels[i] === adds[j]) {
            rows.push(context(dels[i]!));
            i++;
            j++;
        } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
            rows.push(del(dels[i]!));
            i++;
        } else {
            rows.push(add(adds[j]!));
            j++;
        }
    }
    while (i < dels.length) {
        rows.push(del(dels[i++]!));
    }
    while (j < adds.length) {
        rows.push(add(adds[j++]!));
    }
    return rows;
};

// Collapse long unchanged runs to their edges so the changed lines stay in view.
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

// The full add/del/context rows before display collapse + cap, every changed line is present, so the line
// counts are exact even for a whole-file Write or a diff the render caps. collapse() only folds context runs,
// never add/del, so applying it for display never drops a counted line.
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

// Exact +additions / −deletions for the card header, counted from the uncollapsed/uncapped rows.
export const diffStat = (oldText: string | undefined, newText: string): { additions: number; deletions: number } => {
    let additions = 0;
    let deletions = 0;
    for (const row of rawRows(oldText, newText)) {
        if (row.type === "add") {
            additions++;
        } else if (row.type === "del") {
            deletions++;
        }
    }
    return { additions, deletions };
};
