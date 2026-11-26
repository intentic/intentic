// Tables in a PDF's text layer: pdf.js hands a page's text over as items in drawing order, which for a table is often
// column by column or cell by cell, so joining them in that order loses which column a value sat in. This module puts
// the items back on the page by position, finds the regions whose rows share three or more columns, and renders each
// region as a markdown table where the drawing order first reached it. Every other item is joined exactly as before,
// so a page with no such region reads byte for byte as it did.
// The row-and-column heuristic is adapted from markitdown's word-position table detection
// (https://github.com/microsoft/markitdown, packages/markitdown/src/markitdown/converters/_pdf_converter.py, MIT, ../../../NOTICE,
// Copyright (c) Microsoft Corporation): rows grouped by y, a row with several column groups is a table row, a region is
// a run of them, and a region of long cells is prose. What differs: columns are found by projecting each region's
// cells onto the x axis (gutters are the x ranges no cell covers), so right-aligned and centred columns line up as
// well as left-aligned ones, and a table is cut out of the page rather than the whole page being redrawn.

import { markdownTable } from "@intentic/webq/markdown";

/** The fields of a pdf.js text item this module reads. */
export interface PositionedItem {
    readonly str: string;
    /** [a, b, c, d, e, f]: e and f are the baseline origin in page units, d the vertical scale (the font size). */
    readonly transform: readonly number[];
    readonly width: number;
    readonly height: number;
    readonly hasEOL: boolean;
}

// A gap of at least this many font sizes between two pieces of one row separates two cells. A word space is about a
// third of one, and a loose justified line rarely reaches two thirds.
const CELL_GAP_EM = 1;
// Within a cell, a gap wider than this many font sizes stands for a space the item text did not carry.
const SPACE_GAP_EM = 0.15;
// Two pieces whose baselines differ by less than this many font sizes sit on one row (a superscript included).
const SAME_ROW_EM = 0.5;
// A row whose font size differs from the region's by more than this ratio is not part of it (a heading, a total).
const SIZE_RATIO = 1.25;
// A single-cell row this close under the row above (in font sizes) and starting at a column continues that row's cell.
const CONTINUATION_EM = 2;
// Two table rows this close together (in font sizes) have no room for a line of their own between them: a line drawn
// there is an overlay (a footer, a watermark), not part of the reading order between them.
const SQUEEZED_EM = 1.6;
// A cell longer than this is prose; a region where more than LONG_CELL_SHARE of the cells are is a page of columns.
const LONG_CELL_CHARS = 40;
const LONG_CELL_SHARE = 0.3;
// A region is a table when at least this many rows have three or more cells and three columns recur in two rows.
const MIN_COLUMNS = 3;
const MIN_TABLE_ROWS = 2;
// A review copy's margin line numbers: at least this many bare numbers outside the text, counting up by one.
const MIN_LINE_NUMBERS = 5;
const LINE_NUMBER = /^\d{1,5}$/;
// A mark this short is drawn on its own baseline often enough (TeX's raised √, a dagger) that its row is the row of
// the text drawn just before it, when that is within a font size, rather than whichever baseline it happens to be nearer.
const MARK_CHARS = 2;
// A two-column page: a gutter in the middle third of the text that at most this share of rows cross, with at least
// MIN_PROSE_LINES lines of prose on each side.
const GUTTER_CROSSING_SHARE = 0.1;
const MIN_PROSE_LINES = 5;

interface Piece {
    readonly index: number;
    readonly text: string;
    readonly x0: number;
    readonly x1: number;
    readonly y: number;
    readonly size: number;
}

interface Segment {
    readonly text: string;
    readonly x0: number;
    readonly x1: number;
    /** The items (by index) the cell's text came from. */
    readonly items: readonly number[];
}

interface Row {
    readonly y: number;
    readonly size: number;
    readonly segments: Segment[];
}

interface Column {
    x0: number;
    x1: number;
}

/** One table found on a page: the markdown it renders as and the items (by index) it consumed. */
interface Table {
    readonly markdown: string;
    readonly items: readonly number[];
}

// An upright, unmirrored item with visible text and a size; rotated text (a margin note, an axis label) is no table's.
const pieceOf = (item: PositionedItem, index: number): Piece | undefined => {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
    const size = Math.abs(d) > 0 ? Math.abs(d) : item.height;
    if (item.str.trim() === "" || size <= 0 || a <= 0 || d <= 0 || Math.abs(b) > size * 1e-3 || Math.abs(c) > size * 1e-3) {
        return undefined;
    }
    return { index, text: item.str, x0: e, x1: e + Math.max(0, item.width), y: f, size };
};

// The pieces of one row, left to right, cut into cells wherever the gap reaches CELL_GAP_EM.
const segmentsOf = (pieces: readonly Piece[], size: number): Segment[] => {
    const segments: { text: string; x0: number; x1: number; items: number[] }[] = [];
    let current: (typeof segments)[number] | undefined;
    for (const piece of pieces) {
        const gap = current === undefined ? Number.POSITIVE_INFINITY : piece.x0 - current.x1;
        if (current === undefined || gap >= CELL_GAP_EM * size) {
            current = { text: piece.text, x0: piece.x0, x1: piece.x1, items: [piece.index] };
            segments.push(current);
            continue;
        }
        current.text += gap > SPACE_GAP_EM * size && !/\s$/.test(current.text) && !/^\s/.test(piece.text) ? ` ${piece.text}` : piece.text;
        current.x1 = Math.max(current.x1, piece.x1);
        current.items.push(piece.index);
    }
    return segments.map((segment) => ({ ...segment, text: segment.text.replaceAll(/\s+/g, " ").trim() }));
};

// Each short mark that rides on the piece drawn just before it, mapped to the piece whose row it joins.
const ridersOf = (pieces: readonly Piece[]): Map<Piece, Piece> => {
    const riders = new Map<Piece, Piece>();
    for (const [index, piece] of pieces.entries()) {
        const host = pieces[index - 1];
        if (
            host !== undefined &&
            piece.text.trim().length <= MARK_CHARS &&
            piece.x0 >= host.x0 &&
            piece.y !== host.y &&
            Math.abs(piece.y - host.y) <= Math.min(piece.size, host.size)
        ) {
            riders.set(piece, riders.get(host) ?? host);
        }
    }
    return riders;
};

/** The page's visible pieces as rows, top to bottom, each row's pieces left to right and grouped into cells. */
const rowsOf = (items: readonly PositionedItem[]): Row[] => {
    const drawn = items.flatMap((item, index) => pieceOf(item, index) ?? []);
    const riders = ridersOf(drawn);
    const groups: Piece[][] = [];
    const groupOf = new Map<Piece, Piece[]>();
    for (const piece of drawn.filter((each) => !riders.has(each)).toSorted((p, q) => q.y - p.y || p.x0 - q.x0)) {
        const group = groups.at(-1);
        const anchor = group?.[0];
        if (group !== undefined && anchor !== undefined && anchor.y - piece.y < SAME_ROW_EM * Math.max(anchor.size, piece.size)) {
            group.push(piece);
        } else {
            groups.push([piece]);
        }
        groupOf.set(piece, groups.at(-1) ?? []);
    }
    for (const [rider, host] of riders) {
        groupOf.get(host)?.push(rider);
    }
    return groups.map((group) => {
        const size = Math.max(...group.map((piece) => piece.size));
        return { y: group[0]?.y ?? 0, size, segments: segmentsOf(group.toSorted((p, q) => p.x0 - q.x0), size) };
    });
};

// Whether bare numbers read top to bottom count up the way line numbering does: rising, mostly by one.
const countsLines = (numbers: readonly Segment[]): boolean => {
    const values = numbers.map((segment) => Number(segment.text));
    const steps = values.slice(1).map((value, index) => value - (values[index] ?? 0));
    return steps.every((step) => step > 0) && steps.filter((step) => step === 1).length >= steps.length * 0.8;
};

/**
 * The rows without a review copy's margin line numbers (bare numbers counting up, set wholly left or right of every
 * other cell on the page), which would otherwise make a column of their own beside every line of prose. Their items
 * stay in the drawing order like any other text.
 */
const withoutLineNumbers = (rows: readonly Row[]): Row[] => {
    const cells = rows.flatMap((row) => row.segments);
    const words = cells.filter((cell) => !LINE_NUMBER.test(cell.text));
    if (words.length === 0) {
        return [...rows];
    }
    const left = Math.min(...words.map((cell) => cell.x0));
    const right = Math.max(...words.map((cell) => cell.x1));
    const margins = [
        cells.filter((cell) => LINE_NUMBER.test(cell.text) && cell.x1 < left),
        cells.filter((cell) => LINE_NUMBER.test(cell.text) && cell.x0 > right),
    ].filter((numbers) => numbers.length >= MIN_LINE_NUMBERS && countsLines(numbers));
    const dropped = new Set(margins.flat());
    return dropped.size === 0
        ? [...rows]
        : rows.map((row) => ({ ...row, segments: row.segments.filter((segment) => !dropped.has(segment)) })).filter((row) => row.segments.length > 0);
};

// The x ranges a set of cells covers, overlapping ranges merged: what is left between them is the gutters.
const projection = (spans: readonly { readonly x0: number; readonly x1: number }[]): Column[] => {
    const columns: Column[] = [];
    for (const span of spans.toSorted((s, t) => s.x0 - t.x0)) {
        const last = columns.at(-1);
        if (last !== undefined && span.x0 <= last.x1) {
            last.x1 = Math.max(last.x1, span.x1);
        } else {
            columns.push({ x0: span.x0, x1: span.x1 });
        }
    }
    return columns;
};

const overlaps = (column: Column, segment: Segment): boolean => segment.x0 < column.x1 && column.x0 < segment.x1;

// Columns of a region, from the rows with three or more cells. A row with fewer cells adds a column only where it
// fills a gutter: its cells are often headings spanning two columns ("Customer Information" over a label and a value),
// which would otherwise merge them.
const columnsOf = (rows: readonly Row[]): Column[] => {
    const columns = projection(rows.filter((row) => row.segments.length >= MIN_COLUMNS).flatMap((row) => row.segments));
    const strays = rows
        .filter((row) => row.segments.length < MIN_COLUMNS)
        .flatMap((row) => row.segments)
        .filter((segment) => !columns.some((column) => overlaps(column, segment)));
    return projection([...columns, ...strays]);
};

// The column a cell belongs to: the one its range overlaps most, else the nearest one starting at or before it.
const columnOf = (columns: readonly Column[], segment: Segment): number => {
    let best = 0;
    let bestOverlap = 0;
    for (const [index, column] of columns.entries()) {
        const overlap = Math.min(column.x1, segment.x1) - Math.max(column.x0, segment.x0);
        if (overlap > bestOverlap) {
            best = index;
            bestOverlap = overlap;
        }
    }
    if (bestOverlap > 0) {
        return best;
    }
    const before = columns.findLastIndex((column) => column.x0 <= segment.x0);
    return Math.max(0, before);
};

const startsAtColumn = (columns: readonly Column[], segment: Segment, size: number): boolean =>
    columns.some((column) => Math.abs(column.x0 - segment.x0) <= size);

interface Run {
    /** Rows with two or more cells: they define the columns. */
    readonly table: Row[];
    /** Every row of the run in page order, continuation rows included. */
    readonly rows: Row[];
}

// Whether a region of rows reads as a table rather than columns of prose or a two-field form.
const isTable = (run: Run, columns: readonly Column[]): boolean => {
    if (run.table.filter((row) => row.segments.length >= MIN_COLUMNS).length < MIN_TABLE_ROWS) {
        return false;
    }
    const rowsPerColumn = columns.map(() => new Set<Row>());
    for (const row of run.table) {
        for (const segment of row.segments) {
            rowsPerColumn[columnOf(columns, segment)]?.add(row);
        }
    }
    if (rowsPerColumn.filter((rows) => rows.size >= 2).length < MIN_COLUMNS) {
        return false;
    }
    const cells = run.rows.flatMap((row) => row.segments);
    const isLong = (cell: Segment): boolean => cell.text.length > LONG_CELL_CHARS;
    if (cells.filter(isLong).length > cells.length * LONG_CELL_SHARE) {
        return false;
    }
    // A column most of whose cells are long is a column of prose beside a table (a two-column page), not a cell of it.
    const perColumn = columns.map(() => ({ cells: 0, long: 0 }));
    for (const cell of cells) {
        const tally = perColumn[columnOf(columns, cell)];
        if (tally !== undefined) {
            tally.cells += 1;
            tally.long += isLong(cell) ? 1 : 0;
        }
    }
    return !perColumn.some((tally) => tally.long >= MIN_COLUMNS && tally.long * 2 >= tally.cells);
};

// The region as a markdown table, its first row the header (a PDF does not say which row is one), through the table
// writer fileq's other formats use, so a cell's pipe is escaped the same way.
const tableMarkdown = (rows: readonly Row[], columns: readonly Column[]): string =>
    markdownTable(
        rows.map((row) => {
            const cells = columns.map(() => "");
            for (const segment of row.segments) {
                const column = columnOf(columns, segment);
                cells[column] = cells[column] === "" ? segment.text : `${cells[column]} ${segment.text}`;
            }
            return cells;
        }),
    );

// A row the run cannot take as a table row: a continuation of the cell above it, an overlay squeezed between two table
// rows (left out of the run and left where the drawing order put it), or the end of the run.
const placeSingle = (run: Run, row: Row, next: Row | undefined): "continue" | "skip" | "end" => {
    const last = run.rows.at(-1);
    if (last === undefined) {
        return "end";
    }
    const lastTable = run.table.at(-1) ?? last;
    if (next !== undefined && next.segments.length >= 2 && lastTable.y - next.y <= SQUEEZED_EM * lastTable.size) {
        return "skip";
    }
    const segment = row.segments[0];
    const fits = segment !== undefined && last.y - row.y <= CONTINUATION_EM * last.size && startsAtColumn(columnsOf(run.table), segment, lastTable.size);
    return fits ? "continue" : "end";
};

const sizeBreaks = (run: Run, row: Row): boolean => {
    const last = run.table.at(-1);
    return last !== undefined && Math.max(last.size, row.size) / Math.min(last.size, row.size) > SIZE_RATIO;
};

// Runs of rows that may be tables, in page order. A run ends at a row that is neither a table row nor a continuation.
const runsOf = (rows: readonly Row[]): Run[] => {
    const runs: Run[] = [];
    let run: Run = { table: [], rows: [] };
    const close = (): void => {
        if (run.table.length > 0) {
            runs.push(run);
        }
        run = { table: [], rows: [] };
    };
    for (const [index, row] of rows.entries()) {
        if (row.segments.length >= 2) {
            if (sizeBreaks(run, row)) {
                close();
            }
            run.table.push(row);
            run.rows.push(row);
            continue;
        }
        const placement = placeSingle(run, row, rows[index + 1]);
        if (placement === "continue") {
            run.rows.push(row);
        } else if (placement === "end") {
            close();
        }
    }
    close();
    return runs;
};

// The x of a two-column page's gutter, or undefined for a page set in one column (or a form, which has no prose).
const gutterOf = (rows: readonly Row[]): number | undefined => {
    const cells = rows.flatMap((row) => row.segments);
    const long = cells.filter((cell) => cell.text.length > LONG_CELL_CHARS);
    if (long.length < 2 * MIN_PROSE_LINES) {
        return undefined;
    }
    const left = Math.min(...cells.map((cell) => cell.x0));
    const right = Math.max(...cells.map((cell) => cell.x1));
    const third = (right - left) / 3;
    // A gutter begins where a line of the left column ends, so those ends are the only places worth trying.
    const candidates = [...new Set(cells.map((cell) => Math.round(cell.x1) + 1))].filter((x) => x > left + third && x < right - third);
    const crossings = (x: number): number => rows.filter((row) => row.segments.some((segment) => segment.x0 < x && x < segment.x1)).length;
    const best = candidates.map((x) => ({ x, crossing: crossings(x) })).toSorted((a, b) => a.crossing - b.crossing)[0];
    if (best === undefined || best.crossing > rows.length * GUTTER_CROSSING_SHARE) {
        return undefined;
    }
    const sides = [long.filter((cell) => cell.x1 <= best.x).length, long.filter((cell) => cell.x0 >= best.x).length];
    return sides.every((count) => count >= MIN_PROSE_LINES) ? best.x : undefined;
};

// One side of a two-column page; a cell crossing the gutter (a full-width title or figure) is the left side's.
const sideOf = (rows: readonly Row[], gutter: number, side: "left" | "right"): Row[] =>
    rows
        .map((row) => ({ ...row, segments: row.segments.filter((segment) => (segment.x0 < gutter) === (side === "left")) }))
        .filter((row) => row.segments.length > 0);

const tablesIn = (rows: readonly Row[]): Table[] =>
    runsOf(rows).flatMap((run) => {
        const columns = columnsOf(run.table);
        if (!isTable(run, columns)) {
            return [];
        }
        return [{ markdown: tableMarkdown(run.rows, columns), items: run.rows.flatMap((row) => row.segments.flatMap((segment) => segment.items)) }];
    });

/**
 * The page's tables: each column-aligned region, rendered, with the items it is made of. A two-column page is read one
 * column at a time, so a table in one column takes no lines of the other as cells. A page none of whose rows has three
 * cells can hold no table, which settles a page of prose in one pass.
 */
const tablesOf = (items: readonly PositionedItem[]): Table[] => {
    const rows = withoutLineNumbers(rowsOf(items));
    if (!rows.some((row) => row.segments.length >= MIN_COLUMNS)) {
        return [];
    }
    const gutter = gutterOf(rows);
    return gutter === undefined ? tablesIn(rows) : [...tablesIn(sideOf(rows, gutter, "left")), ...tablesIn(sideOf(rows, gutter, "right"))];
};

// The table each item belongs to (-1 for none). A whitespace item between two items of one table belongs to it too, so
// the gaps pdf.js fills with spaces do not leave stray lines where the table was.
const ownersOf = (items: readonly PositionedItem[], tables: readonly Table[]): Int32Array => {
    const owner = new Int32Array(items.length).fill(-1);
    for (const [table, { items: members }] of tables.entries()) {
        for (const index of members) {
            owner[index] = table;
        }
    }
    let previous = -1;
    let gap: number[] = [];
    for (const [index, item] of items.entries()) {
        if (item.str.trim() === "" && owner[index] === -1) {
            gap.push(index);
            continue;
        }
        const current = owner[index] ?? -1;
        if (current !== -1 && current === previous) {
            for (const blank of gap) {
                owner[blank] = current;
            }
        }
        gap = [];
        previous = current;
    }
    return owner;
};

// Items joined as they always were: in drawing order, a line break where pdf.js saw one, runs of spaces folded.
const joinItems = (items: readonly PositionedItem[]): string =>
    items
        .map((item) => item.str + (item.hasEOL ? "\n" : ""))
        .join("")
        .replaceAll(/[ \t]+/g, " ")
        .trim();

/**
 * A page's text: its items in drawing order, except that each table region is rendered as a markdown table, set off by
 * blank lines, where the drawing order first reaches one of its items. A page with no table reads exactly as the plain
 * join of its items.
 */
export const pageText = (items: readonly PositionedItem[]): string => {
    const tables = tablesOf(items);
    if (tables.length === 0) {
        return joinItems(items);
    }
    const owner = ownersOf(items, tables);
    const blocks: string[] = [];
    let prose: PositionedItem[] = [];
    const emitted = new Set<number>();
    const flush = (): void => {
        // The items a table took leave their line breaks behind; one blank line marks where they were.
        const text = joinItems(prose).replaceAll(/\n(?:[ \t]*\n)+/g, "\n\n");
        if (text !== "") {
            blocks.push(text);
        }
        prose = [];
    };
    for (const [index, item] of items.entries()) {
        const table = owner[index] ?? -1;
        if (table === -1) {
            prose.push(item);
            continue;
        }
        if (!emitted.has(table)) {
            emitted.add(table);
            flush();
            blocks.push(tables[table]?.markdown ?? "");
        }
    }
    flush();
    return blocks.join("\n\n");
};
