// THE CSV EVERY PASSWORD MANAGER EXPORTS: RFC 4180 as browsers and managers actually write it. Quoted fields may hold
// commas, line breaks and doubled quotes; a line may end in CRLF or LF; the file may start with a byte-order mark. Pure,
// and it never logs a cell, since half of them are passwords.

/** The file's rows, each a list of cells, the header first. Blank lines are dropped. */
export const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    const source = text.startsWith("﻿") ? text.slice(1) : text;
    const endRow = (): void => {
        row.push(cell);
        cell = "";
        // A line with nothing on it is the trailing newline most exporters end with, or a gap between records.
        if (row.length > 1 || row[0] !== "") {
            rows.push(row);
        }
        row = [];
    };
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
            if (char === '"' && source[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            row.push(cell);
            cell = "";
        } else if (char === "\n") {
            endRow();
        } else if (char !== "\r") {
            cell += char;
        }
    }
    if (cell !== "" || row.length > 0) {
        endRow();
    }
    return rows;
};
