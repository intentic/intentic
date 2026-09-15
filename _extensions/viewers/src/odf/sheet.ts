import { unzipSync } from "fflate";
import { attr, childElements, descendants, parseXml, textOf, type XmlElement } from "./xml-tree";

/* An .ods as sheets of values. Runs inside the spreadsheet worker, which has no DOM, so nothing here may reach for
   one. */

// A preview, not a spreadsheet application: past these a file is a database, and rendering it would hang the tab.
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 1024;

export interface OdsSheet {
    readonly name: string;
    readonly data: readonly (readonly unknown[])[];
}

const decoder = new TextDecoder();

/**
 * The package mimetype from the zip's first entry, which OpenDocument requires to be stored uncompressed and first.
 * Reading it costs 30 bytes, so an xlsx is recognised as "not ODF" without being decompressed at all.
 */
export const odfMimetype = (bytes: Uint8Array): string | undefined => {
    const header = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 128));
    if (bytes.byteLength < 38 || header.getUint32(0, true) !== 0x04034b50) {
        return undefined;
    }
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const size = header.getUint32(22, true);
    const name = decoder.decode(bytes.subarray(30, 30 + nameLength));
    // Compression method 0 is "stored": the mimetype is readable without inflating anything.
    if (name !== `mimetype` || header.getUint16(8, true) !== 0 || size > 128) {
        return undefined;
    }
    const start = 30 + nameLength + extraLength;
    return decoder.decode(bytes.subarray(start, start + size)).trim();
};

export const isOdfSpreadsheet = (bytes: Uint8Array): boolean =>
    (odfMimetype(bytes) ?? ``).startsWith(`application/vnd.oasis.opendocument.spreadsheet`);

// PT12H30M5S: an ODF duration, which is how a time-of-day cell stores its value.
const durationText = (value: string): string => {
    const match = /^-?P(?:\d+Y)?(?:\d+M)?(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
    if (match === null) {
        return value;
    }
    const pad = (part: string | undefined): string => (part ?? `0`).padStart(2, `0`);
    return `${pad(match[1])}:${pad(match[2])}:${pad(match[3]?.split(`.`)[0])}`;
};

const numberOf = (raw: string | undefined): number | undefined => {
    const value = Number(raw);
    return raw === undefined || raw === `` || !Number.isFinite(value) ? undefined : value;
};

const textOrNull = (shown: string): unknown => (shown === `` ? null : shown);

// A formatted cell (a percentage, a price) reads as the file displays it; a plain number stays a number, so the
// column still lines up on the right.
const CELL: Readonly<Record<string, (cell: XmlElement, shown: string) => unknown>> = {
    float: (cell, shown) => numberOf(attr(cell, `office:value`)) ?? textOrNull(shown),
    percentage: (cell, shown) => (shown === `` ? (numberOf(attr(cell, `office:value`)) ?? null) : shown),
    currency: (cell, shown) => (shown === `` ? (numberOf(attr(cell, `office:value`)) ?? null) : shown),
    boolean: (cell) => attr(cell, `office:boolean-value`) === `true`,
    date: (cell, shown) => {
        const date = new Date(attr(cell, `office:date-value`) ?? ``);
        return Number.isNaN(date.getTime()) ? textOrNull(shown) : date;
    },
    time: (cell, shown) => durationText(attr(cell, `office:time-value`) ?? shown),
};

const valueOf = (cell: XmlElement): unknown => {
    const shown = textOf(cell).trim();
    return CELL[attr(cell, `office:value-type`) ?? ``]?.(cell, shown) ?? textOrNull(shown);
};

const repeatOf = (element: XmlElement, name: string, limit: number): number => {
    const value = Number.parseInt(attr(element, name) ?? `1`, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, limit) : 1;
};

// Trailing padding: ODF fills every sheet out to its maximum width and height with repeated empty cells, so an empty
// run is only materialised once something non-empty follows it.
const cellsOf = (row: XmlElement): unknown[] => {
    const cells: unknown[] = [];
    let pending = 0;
    for (const child of childElements(row)) {
        if (child.tag !== `table:table-cell` && child.tag !== `table:covered-table-cell`) {
            continue;
        }
        const repeat = repeatOf(child, `table:number-columns-repeated`, MAX_COLUMNS);
        const value = child.tag === `table:covered-table-cell` ? null : valueOf(child);
        if (value === null || value === ``) {
            pending += repeat;
            continue;
        }
        for (let index = 0; index < Math.min(pending, MAX_COLUMNS - cells.length); index += 1) {
            cells.push(null);
        }
        pending = 0;
        for (let index = 0; index < Math.min(repeat, MAX_COLUMNS - cells.length); index += 1) {
            cells.push(value);
        }
    }
    return cells;
};

const ROW_GROUPS = new Set([`table:table-header-rows`, `table:table-rows`, `table:table-row-group`]);

// Rows of THIS sheet: a table nested inside a cell is content, not more rows, so the walk never descends into one.
const rowElements = (element: XmlElement, into: XmlElement[]): XmlElement[] => {
    for (const child of childElements(element)) {
        if (child.tag === `table:table-row`) {
            into.push(child);
            continue;
        }
        if (ROW_GROUPS.has(child.tag)) {
            rowElements(child, into);
        }
    }
    return into;
};

const rowsOf = (table: XmlElement): unknown[][] => {
    const rows: unknown[][] = [];
    let pending = 0;
    for (const row of rowElements(table, [])) {
        const repeat = repeatOf(row, `table:number-rows-repeated`, MAX_ROWS);
        const cells = cellsOf(row);
        if (cells.length === 0) {
            pending += repeat;
            continue;
        }
        for (let index = 0; index < Math.min(pending, MAX_ROWS - rows.length); index += 1) {
            rows.push([]);
        }
        pending = 0;
        for (let index = 0; index < Math.min(repeat, MAX_ROWS - rows.length); index += 1) {
            rows.push(cells);
        }
    }
    return rows;
};

/** Every sheet in an .ods, in the order the file lists them. */
export const readOdsBook = (bytes: Uint8Array): OdsSheet[] => {
    const zip = unzipSync(bytes, { filter: (file) => file.name === `content.xml` });
    const content = zip[`content.xml`];
    const root = content === undefined ? undefined : parseXml(decoder.decode(content));
    if (root === undefined) {
        return [];
    }
    const body = descendants(root, `office:spreadsheet`)[0];
    if (body === undefined) {
        return [];
    }
    return childElements(body)
        .filter((table) => table.tag === `table:table`)
        .map((table, index) => ({ name: attr(table, `table:name`) ?? `Sheet ${index + 1}`, data: rowsOf(table) }));
};
