import ExcelJS from "exceljs";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Spreadsheets: one markdown table per sheet, capped, with the cap announced. A spreadsheet is the format
 * most likely to be data rather than prose, and an agent that needs all 40,000 rows should be reading the
 * xlsx programmatically, not through a markdown shadow — the shadow's job is to say what the file IS and
 * show enough of it to reason about. */

const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS = 30;

// A cell's value as text. exceljs surfaces formulas, rich text and hyperlinks as objects; each collapses to
// what a person looking at the rendered sheet would read.
const cellText = (value: ExcelJS.CellValue): string => {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "object") {
        if ("richText" in value) {
            return value.richText.map((run) => run.text).join("");
        }
        if ("text" in value) {
            return String(value.text);
        }
        if ("result" in value && value.result !== undefined) {
            return cellText(value.result as ExcelJS.CellValue);
        }
        if ("error" in value) {
            return String(value.error);
        }
        return "";
    }
    return String(value);
};

const tableRow = (cells: string[]): string => `| ${cells.map((cell) => cell.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim()).join(" | ")} |`;

export const xlsxDeriver: Deriver = {
    name: "xlsx",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(absPath);
        const notes: string[] = [];
        const sections: string[] = [];
        for (const sheet of workbook.worksheets) {
            const rows: string[][] = [];
            let columnCap = 0;
            sheet.eachRow({ includeEmpty: false }, (row) => {
                if (rows.length > MAX_ROWS_PER_SHEET) {
                    return; // counted past the cap so the note can say how many were left behind
                }
                // `row.values` is 1-based (index 0 is always empty); keep blanks so columns stay aligned.
                const values = (row.values as ExcelJS.CellValue[]).slice(1, MAX_COLUMNS + 1).map(cellText);
                columnCap = Math.max(columnCap, row.cellCount);
                rows.push(values);
            });
            const kept = rows.slice(0, MAX_ROWS_PER_SHEET);
            if (sheet.rowCount > MAX_ROWS_PER_SHEET) {
                notes.push(`sheet "${sheet.name}": showing ${MAX_ROWS_PER_SHEET} of ${sheet.rowCount} rows`);
            }
            if (columnCap > MAX_COLUMNS) {
                notes.push(`sheet "${sheet.name}": showing ${MAX_COLUMNS} of ${columnCap} columns`);
            }
            if (kept.length === 0) {
                sections.push(`## ${sheet.name}\n\n(empty sheet)`);
                continue;
            }
            const width = Math.max(...kept.map((row) => row.length));
            const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => "")];
            const [header, ...body] = kept.map(pad) as [string[], ...string[][]];
            const table = [tableRow(header), tableRow(header.map(() => "---")), ...body.map(tableRow)].join("\n");
            sections.push(`## ${sheet.name}\n\n${table}`);
        }
        return { markdown: sections.join("\n\n"), notes };
    },
};
