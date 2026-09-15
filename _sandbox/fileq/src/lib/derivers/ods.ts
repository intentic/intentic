import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { attributeOf, decodeEntities } from "../xml.js";

/* OpenDocument spreadsheets: one markdown table per sheet, the same shape xlsx derives to, so a reader cannot tell
   which program wrote the file. */

const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS = 30;

const TABLE = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g;
const ROW = /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
// The backreference keeps a covered cell's own closing tag straight; a merged-away cell is an empty one.
const CELL = /<table:(covered-table-cell|table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;

const repeatOf = (attributes: string, name: string, limit: number): number => {
    const value = Number.parseInt(attributeOf(attributes, name) ?? "1", 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, limit) : 1;
};

/** A cell as a person reading the sheet would: its displayed text, or its value when it displays nothing. */
const cellText = (attributes: string, inner: string): string => {
    const shown = decodeEntities(
        inner
            .replaceAll(/<text:s\b[^>]*\/>/g, " ")
            .replaceAll(/<text:tab\b[^>]*\/>/g, " ")
            .replaceAll(/<\/text:p>/g, " ")
            .replaceAll(/<[^>]+>/g, ""),
    )
        .replaceAll(/\s+/g, " ")
        .trim();
    return shown === "" ? (attributeOf(attributes, "office:value") ?? "") : shown;
};

const trimEnd = <T>(items: T[], empty: (item: T) => boolean): T[] => {
    let end = items.length;
    while (end > 0 && empty(items[end - 1] as T)) {
        end -= 1;
    }
    return items.slice(0, end);
};

const cellsOf = (xml: string): string[] => {
    const cells: string[] = [];
    for (const cell of xml.matchAll(CELL)) {
        const attributes = cell[2] ?? "";
        const text = cell[1] === "covered-table-cell" ? "" : cellText(attributes, cell[3] ?? "");
        for (let repeat = 0; repeat < repeatOf(attributes, "table:number-columns-repeated", MAX_COLUMNS); repeat += 1) {
            cells.push(text);
        }
    }
    return trimEnd(cells, (cell) => cell === "");
};

/** One `<table:table>`'s rows. Trailing empties are dropped: ODF pads every sheet out to its full width and height. */
const rowsOf = (xml: string): string[][] => {
    const rows: string[][] = [];
    for (const row of xml.matchAll(ROW)) {
        const cells = cellsOf(row[2] ?? "");
        for (let repeat = 0; repeat < repeatOf(row[1] ?? "", "table:number-rows-repeated", MAX_ROWS_PER_SHEET); repeat += 1) {
            rows.push(cells);
        }
    }
    return trimEnd(rows, (row) => row.length === 0);
};

const tableRow = (cells: string[]): string => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;

const sectionOf = (name: string, rows: string[][], notes: string[]): string => {
    if (rows.length === 0) {
        return `## ${name}\n\n(empty sheet)`;
    }
    const width = Math.min(MAX_COLUMNS, Math.max(...rows.map((row) => row.length)));
    if (Math.max(...rows.map((row) => row.length)) > MAX_COLUMNS) {
        notes.push(`sheet "${name}": showing ${MAX_COLUMNS} of ${Math.max(...rows.map((row) => row.length))} columns`);
    }
    if (rows.length > MAX_ROWS_PER_SHEET) {
        notes.push(`sheet "${name}": showing ${MAX_ROWS_PER_SHEET} of ${rows.length} rows`);
    }
    const kept = rows.slice(0, MAX_ROWS_PER_SHEET).map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
    const [header, ...body] = kept as [string[], ...string[][]];
    return `## ${name}\n\n${[tableRow(header), tableRow(header.map(() => "---")), ...body.map(tableRow)].join("\n")}`;
};

export const odsDeriver: Deriver = {
    name: "ods",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const zip = unzipSync(new Uint8Array(await readFile(absPath)), { filter: (file) => file.name === "content.xml" });
        const content = zip["content.xml"];
        if (content === undefined) {
            return { markdown: "", notes: ["no content.xml in this OpenDocument container"] };
        }
        const xml = new TextDecoder().decode(content);
        const notes: string[] = [];
        const sections: string[] = [];
        for (const table of xml.matchAll(TABLE)) {
            const name = attributeOf(table[1] ?? "", "table:name") ?? `Sheet ${sections.length + 1}`;
            sections.push(sectionOf(name, rowsOf(table[2] ?? ""), notes));
        }
        return { markdown: sections.join("\n\n"), notes: sections.length === 0 ? [...notes, "no sheets in this spreadsheet"] : notes };
    },
};
