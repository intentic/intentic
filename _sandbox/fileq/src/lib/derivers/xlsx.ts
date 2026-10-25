import { oneLine } from "@intentic/base/one-line";
import { markdownTable } from "@intentic/webq/markdown";
import type { CellValue } from "read-excel-file/node";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Spreadsheets: one markdown table per sheet, capped, with the cap announced. */

// read-excel-file is loaded inside derive() rather than here because every fileq run — every agent
// read of a png, every `fileq derive`, `fileq --version` — pays for a module this file imports at its top. The type import
// above is erased at compile time and costs nothing.

const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS = 30;

// A cell's value as text.
const cellText = (value: CellValue): string => {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return String(value);
};

export const xlsxDeriver: Deriver = {
    name: "xlsx",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const { default: readXlsxFile } = await import("read-excel-file/node");
        const sheets = await readXlsxFile(absPath);
        const notes: string[] = [];
        const sections: string[] = [];
        for (const { sheet: sheetName, data } of sheets) {
            let columnCap = 0;
            const rows: string[][] = [];
            for (const row of data) {
                if (rows.length > MAX_ROWS_PER_SHEET) {
                    break;
                }
                columnCap = Math.max(columnCap, row.length);
                const values = row.slice(0, MAX_COLUMNS).map((cell) => cellText(cell as CellValue));
                rows.push(values);
            }
            const kept = rows.slice(0, MAX_ROWS_PER_SHEET);
            if (data.length > MAX_ROWS_PER_SHEET) {
                notes.push(`sheet "${sheetName}": showing ${MAX_ROWS_PER_SHEET} of ${data.length} rows`);
            }
            if (columnCap > MAX_COLUMNS) {
                notes.push(`sheet "${sheetName}": showing ${MAX_COLUMNS} of ${columnCap} columns`);
            }
            if (kept.length === 0) {
                sections.push(`## ${sheetName}\n\n(empty sheet)`);
                continue;
            }
            // Each cell as one line: a sheet's cell can hold line breaks and runs of spaces nobody reads as meaningful.
            sections.push(`## ${sheetName}\n\n${markdownTable(kept.map((row) => row.map((cell) => oneLine(cell))))}`);
        }
        return { markdown: sections.join("\n\n"), notes };
    },
};
