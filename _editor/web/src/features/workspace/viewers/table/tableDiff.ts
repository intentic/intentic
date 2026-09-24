import { diffSequence, type Op } from "@intentic/ui/diff";

// Two versions of tabular data as one grid with the cells that moved marked: sheets matched by name, rows by a
// longest-common-subsequence over their cells, an edited row paired with what it became and compared cell by cell.
// Pure, so the view only draws. Rows come from fileq's rendering of a spreadsheet (one markdown table per `##` sheet)
// or from delimited text (csv/tsv), parsed here so both arrive as the same shape.

export interface Sheet {
    readonly name: string;
    // Row 0 is the header wherever the source has one; the diff treats it as a row, the view draws it as one.
    readonly rows: readonly (readonly string[])[];
}

export type CellKind = "same" | "changed" | "added" | "removed";

export interface CellDiff {
    readonly kind: CellKind;
    readonly before?: string;
    readonly after?: string;
}

export type RowKind = "same" | "changed" | "added" | "removed";

export interface RowDiff {
    readonly kind: RowKind;
    readonly cells: readonly CellDiff[];
    // 1-based row numbers in each version; absent on the side the row is not in.
    readonly beforeLine?: number;
    readonly afterLine?: number;
}

export type SheetKind = "same" | "changed" | "added" | "removed";

export interface SheetDiff {
    readonly name: string;
    readonly kind: SheetKind;
    readonly rows: readonly RowDiff[];
    // Widest row on either side, so the grid draws every column.
    readonly columns: number;
    readonly changedRows: number;
}

// Past this many rows on a side, the rest is dropped before diffing and the view says so; a spreadsheet's rendering
// is already capped far below it by fileq, this is for a large csv.
export const MAX_ROWS = 5_000;

// ---- Parsing ----

// A markdown table cell, with the escape fileq writes for a literal pipe undone.
const unescapeCell = (cell: string): string => cell.trim().replaceAll(`\\|`, `|`);

const tableRowCells = (line: string): string[] => {
    const inner = line.trim().replace(/^\|/, ``).replace(/\|$/, ``);
    // Split on pipes that are not escaped.
    return inner.split(/(?<!\\)\|/).map(unescapeCell);
};

const isSeparatorRow = (line: string): boolean => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** The sheets in fileq's rendering of a workbook: each `## name` section's markdown table, empty sheets included. */
export const sheetsOfMarkdown = (markdown: string): Sheet[] => {
    const sheets: Sheet[] = [];
    let name: string | undefined;
    let rows: string[][] = [];
    const flush = (): void => {
        if (name !== undefined) {
            sheets.push({ name, rows });
        }
        rows = [];
    };
    for (const line of markdown.replace(/\r\n/g, `\n`).split(`\n`)) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading !== null) {
            flush();
            name = heading[1]!;
            continue;
        }
        if (name === undefined || !line.trim().startsWith(`|`) || isSeparatorRow(line)) {
            continue;
        }
        rows.push(tableRowCells(line));
    }
    flush();
    return sheets;
};

const DELIMITERS = [`,`, `\t`, `;`, `|`] as const;

// The delimiter that appears most on the first line, outside quotes; a comma when nothing does.
const sniffDelimiter = (text: string): string => {
    const line = text.slice(0, text.indexOf(`\n`) === -1 ? undefined : text.indexOf(`\n`));
    let best: string = `,`;
    let bestCount = 0;
    for (const candidate of DELIMITERS) {
        let count = 0;
        let quoted = false;
        for (const char of line) {
            if (char === `"`) {
                quoted = !quoted;
            } else if (char === candidate && !quoted) {
                count++;
            }
        }
        if (count > bestCount) {
            best = candidate;
            bestCount = count;
        }
    }
    return best;
};

/** Delimited text (csv/tsv, quotes per RFC 4180) as one sheet named after the file. */
export const sheetOfDelimited = (text: string, name: string): Sheet => {
    const delimiter = sniffDelimiter(text);
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = ``;
    let quoted = false;
    const source = text.replace(/\r\n/g, `\n`);
    for (let index = 0; index < source.length; index++) {
        const char = source[index]!;
        if (quoted) {
            if (char === `"`) {
                if (source[index + 1] === `"`) {
                    cell += `"`;
                    index++;
                } else {
                    quoted = false;
                }
            } else {
                cell += char;
            }
            continue;
        }
        if (char === `"`) {
            quoted = true;
        } else if (char === delimiter) {
            row.push(cell);
            cell = ``;
        } else if (char === `\n`) {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = ``;
        } else {
            cell += char;
        }
    }
    if (cell !== `` || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return { name, rows: rows.filter((cells) => cells.some((value) => value !== ``)) };
};

// ---- Diffing ----

const rowKey = (row: readonly string[]): string => row.join(`\u0000`);

// Cells compared by position: a row that grew has added cells, one that shrank has removed ones.
const cellDiffs = (before: readonly string[], after: readonly string[]): CellDiff[] => {
    const width = Math.max(before.length, after.length);
    const cells: CellDiff[] = [];
    for (let index = 0; index < width; index++) {
        const from = before[index];
        const to = after[index];
        if (from === undefined) {
            cells.push({ kind: `added`, after: to ?? `` });
        } else if (to === undefined) {
            cells.push({ kind: `removed`, before: from });
        } else if (from === to) {
            cells.push({ kind: `same`, before: from, after: to });
        } else {
            cells.push({ kind: `changed`, before: from, after: to });
        }
    }
    return cells;
};

const whole = (kind: "same" | "added" | "removed", row: readonly string[], beforeLine: number | undefined, afterLine: number | undefined): RowDiff => ({
    kind,
    cells: row.map((value) => (kind === `added` ? { kind: `added`, after: value } : kind === `removed` ? { kind: `removed`, before: value } : { kind: `same`, before: value, after: value })),
    ...(beforeLine === undefined ? {} : { beforeLine }),
    ...(afterLine === undefined ? {} : { afterLine }),
});

// How alike two rows are: the share of positions holding the same cell, or -1 once it can no longer reach `floor`.
// Pairing needs a third to agree, so a row with one edited cell out of three still finds itself.
const similarity = (left: Int32Array, right: Int32Array, floor: number): number => {
    const width = Math.max(left.length, right.length);
    if (width === 0) {
        return 1;
    }
    const shared = Math.min(left.length, right.length);
    let reachable = shared;
    if (reachable / width < floor) {
        return -1;
    }
    let same = 0;
    for (let index = 0; index < shared; index++) {
        if (left[index] === right[index]) {
            same++;
        } else if (--reachable / width < floor) {
            return -1;
        }
    }
    return same / width;
};
const PAIR_THRESHOLD = 1 / 3;

interface Numbered {
    readonly row: readonly string[];
    readonly line: number;
    // Equal exactly when the rows' joined cells are, so the row table compares numbers, never strings.
    readonly key: number;
    // One id per cell, equal exactly when the cells' text is.
    readonly cells: Int32Array;
}

// A run of removed then added rows between two kept ones: each removed row is paired with the added row it most
// resembles, in order, and compared cell by cell; what pairs with nothing stands as removed or added whole.
const pairRun = (removed: readonly Numbered[], added: readonly Numbered[]): RowDiff[] => {
    const end = added.length;
    const taken = new Uint8Array(end);
    const pairs = new Map<number, number>();
    // The untaken added rows as a list in their order, so a row once paired is never scored again.
    const next = Int32Array.from({ length: end }, (_, index) => index + 1);
    const previous = Int32Array.from({ length: end }, (_, index) => index - 1);
    let first = 0;
    const take = (to: number): void => {
        taken[to] = 1;
        if (previous[to] === -1) {
            first = next[to]!;
        } else {
            next[previous[to]!] = next[to]!;
        }
        if (next[to]! < end) {
            previous[next[to]!] = previous[to]!;
        }
    };
    for (const [from, left] of removed.entries()) {
        let best = -1;
        let bestScore = PAIR_THRESHOLD;
        for (let to = first; to < end; to = next[to]!) {
            // A tie goes to the later row, so only a row that cannot even tie is cut short.
            const score = similarity(left.cells, added[to]!.cells, bestScore);
            if (score >= bestScore && score > 0) {
                best = to;
                bestScore = score;
            }
        }
        if (best !== -1) {
            take(best);
            pairs.set(from, best);
        }
    }
    // Emitted in the after side's order where paired, so the grid reads top to bottom as the new sheet does.
    const rows: RowDiff[] = [];
    let nextAdded = 0;
    const emitAddedBefore = (limit: number): void => {
        while (nextAdded < limit) {
            if (taken[nextAdded] === 0) {
                const entry = added[nextAdded]!;
                rows.push(whole(`added`, entry.row, undefined, entry.line));
            }
            nextAdded++;
        }
    };
    for (const [from, left] of removed.entries()) {
        const to = pairs.get(from);
        if (to === undefined) {
            rows.push(whole(`removed`, left.row, left.line, undefined));
            continue;
        }
        emitAddedBefore(to);
        const right = added[to]!;
        rows.push({ kind: `changed`, cells: cellDiffs(left.row, right.row), beforeLine: left.line, afterLine: right.line });
        nextAdded = Math.max(nextAdded, to + 1);
    }
    emitAddedBefore(added.length);
    return rows;
};

// Rows shared at both ends are matched without a table, so a sheet with rows appended costs nothing to diff.
const trimmed = (before: readonly Numbered[], after: readonly Numbered[]): { head: number; tail: number } => {
    let head = 0;
    while (head < before.length && head < after.length && before[head]!.key === after[head]!.key) {
        head++;
    }
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail]!.key === after[after.length - 1 - tail]!.key) {
        tail++;
    }
    return { head, tail };
};

const sameRows = (rows: readonly Numbered[], offset: number): RowDiff[] => rows.map((entry, index) => whole(`same`, entry.row, entry.line, offset + index + 1));

// Both sides of one sheet share the id tables, so an id means the same text on either side.
const numberer = (): ((rows: readonly (readonly string[])[]) => Numbered[]) => {
    const rowIds = new Map<string, number>();
    const cellIds = new Map<string, number>();
    const idOf = (ids: Map<string, number>, text: string): number => {
        let id = ids.get(text);
        if (id === undefined) {
            id = ids.size;
            ids.set(text, id);
        }
        return id;
    };
    return (rows) =>
        rows.slice(0, MAX_ROWS).map((row, index) => ({
            row,
            line: index + 1,
            key: idOf(rowIds, rowKey(row)),
            cells: Int32Array.from(row, (cell) => idOf(cellIds, cell)),
        }));
};

const diffRows = (beforeRows: readonly (readonly string[])[], afterRows: readonly (readonly string[])[]): RowDiff[] => {
    const numbered = numberer();
    const before = numbered(beforeRows);
    const after = numbered(afterRows);
    const { head, tail } = trimmed(before, after);
    const midBefore = before.slice(head, before.length - tail);
    const midAfter = after.slice(head, after.length - tail);
    const ops: Op<Numbered>[] | undefined = diffSequence(midBefore, midAfter, (left, right) => left.key === right.key);
    const middle: RowDiff[] = [];
    // A middle too large for the table reads as replaced whole, which is honest rather than slow.
    const script: Op<Numbered>[] = ops ?? [...midBefore.map((item): Op<Numbered> => ({ kind: `removed`, item })), ...midAfter.map((item): Op<Numbered> => ({ kind: `added`, item }))];
    let removed: Numbered[] = [];
    let added: Numbered[] = [];
    const flush = (): void => {
        middle.push(...pairRun(removed, added));
        removed = [];
        added = [];
    };
    let afterLine = head;
    for (const op of script) {
        if (op.kind === `same`) {
            flush();
            afterLine++;
            middle.push(whole(`same`, op.before.row, op.before.line, afterLine));
        } else if (op.kind === `removed`) {
            removed.push(op.item);
        } else {
            added.push(op.item);
        }
    }
    flush();
    return [...sameRows(before.slice(0, head), 0), ...middle, ...sameRows(before.slice(before.length - tail), after.length - tail)];
};

const width = (sheet: Sheet | undefined): number => Math.max(0, ...(sheet?.rows.map((row) => row.length) ?? []));

/** Sheets matched by name, in the before side's order with the after side's new sheets last; each row diffed inside. */
export const tableDiff = (before: readonly Sheet[], after: readonly Sheet[]): SheetDiff[] => {
    const afterByName = new Map(after.map((sheet) => [sheet.name, sheet]));
    const beforeNames = new Set(before.map((sheet) => sheet.name));
    const diffs: SheetDiff[] = [];
    for (const sheet of before) {
        const counterpart = afterByName.get(sheet.name);
        if (counterpart === undefined) {
            diffs.push({ name: sheet.name, kind: `removed`, rows: sheet.rows.slice(0, MAX_ROWS).map((row, index) => whole(`removed`, row, index + 1, undefined)), columns: width(sheet), changedRows: sheet.rows.length });
            continue;
        }
        const rows = diffRows(sheet.rows, counterpart.rows);
        const changedRows = rows.filter((row) => row.kind !== `same`).length;
        diffs.push({ name: sheet.name, kind: changedRows === 0 ? `same` : `changed`, rows, columns: Math.max(width(sheet), width(counterpart)), changedRows });
    }
    for (const sheet of after) {
        if (!beforeNames.has(sheet.name)) {
            diffs.push({ name: sheet.name, kind: `added`, rows: sheet.rows.slice(0, MAX_ROWS).map((row, index) => whole(`added`, row, undefined, index + 1)), columns: width(sheet), changedRows: sheet.rows.length });
        }
    }
    return diffs;
};

// ---- Folding ----

export type RowRun = { readonly kind: "row"; readonly row: RowDiff } | { readonly kind: "fold"; readonly count: number; readonly at: number };

const CONTEXT = 1;

const shown = (rows: readonly RowDiff[], from: number, to: number): RowRun[] => rows.slice(from, to).map((row) => ({ kind: `row`, row }));

// One unchanged run [from, to): context at each edge that touches a change, and a fold for the middle, which only
// earns its line when it hides more than the line would show. The header row (index 0) is always kept.
const foldRun = (rows: readonly RowDiff[], from: number, to: number): RowRun[] => {
    const lead = from === 0 ? 1 : CONTEXT;
    const tail = to === rows.length ? 0 : CONTEXT;
    const hidden = to - from - lead - tail;
    if (hidden <= 1) {
        return shown(rows, from, to);
    }
    return [...shown(rows, from, from + lead), { kind: `fold`, count: hidden, at: from + lead }, ...shown(rows, to - tail, to)];
};

/** Every changed row with a little unchanged context, long unchanged stretches folded into one line each. */
export const foldUnchangedRows = (rows: readonly RowDiff[]): RowRun[] => {
    if (!rows.some((row) => row.kind !== `same`)) {
        return shown(rows, 0, rows.length);
    }
    const runs: RowRun[] = [];
    let index = 0;
    while (index < rows.length) {
        let end = index;
        while (end < rows.length && rows[end]!.kind === `same`) {
            end++;
        }
        if (end === index) {
            runs.push({ kind: `row`, row: rows[index]! });
            index++;
        } else {
            runs.push(...foldRun(rows, index, end));
            index = end;
        }
    }
    return runs;
};
