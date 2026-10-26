import { oneLine } from "@intentic/base/one-line";
import { markdownTable } from "@intentic/webq/markdown";
import type { Row } from "read-excel-file/node";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Spreadsheets: one markdown table per sheet, capped, with the cap announced. */

// read-excel-file is loaded inside derive() rather than here because every fileq run — every agent read of a png, every
// `fileq derive`, `fileq --version` — pays for a module this file imports at its top. The type import above is erased at
// compile time and costs nothing.
//
// What it reads is each cell's saved value, as a person sees the rendered sheet: a formula's last result, rich text and a
// hyperlink's label as their text. A cell whose saved value is an error (#REF!, #DIV/0!) reads as empty, by the library's
// own choice and with no option to keep it; `fileq check` reads those off the sheet XML itself (check/check-xlsx.ts).

const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS = 30;

type Cell = Row[number];

// A cell's value as text.
const cellText = (value: Cell): string => {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return String(value);
};

// A row with nothing in it: the reader pads gaps between rows into rows of empty cells, which a table would show as blank
// lines and the row cap would count.
const isBlank = (row: Row): boolean => row.every((cell) => cell === null || cell === "");

export const xlsxDeriver: Deriver = {
    name: "xlsx",
    // v2: read with read-excel-file (was exceljs), whose cells differ where a saved value is an error.
    version: 2,
    derive: async (absPath): Promise<DerivedDoc> => {
        const { default: readXlsxFile } = await import("read-excel-file/node");
        const sheets = await readXlsxFile(absPath);
        const notes: string[] = [];
        const sections: string[] = [];
        for (const { sheet: sheetName, data } of sheets) {
            const filled = data.filter((row) => !isBlank(row));
            const columnCap = filled.reduce((width, row) => Math.max(width, row.length), 0);
            const kept = filled.slice(0, MAX_ROWS_PER_SHEET).map((row) => row.slice(0, MAX_COLUMNS).map(cellText));
            if (filled.length > MAX_ROWS_PER_SHEET) {
                notes.push(`sheet "${sheetName}": showing ${MAX_ROWS_PER_SHEET} of ${filled.length} rows`);
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
