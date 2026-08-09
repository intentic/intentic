/* CSV BOTH WAYS, because a spreadsheet range is a grid and CSV is the only shape of grid that survives being
 * typed into a shell argument or read out of a file.
 *
 * Hand-rolled rather than depended on: this package ships as a deployed tree in the sandbox image, the whole
 * of what is needed is quoting and embedded newlines, and the alternative is a dependency in the image for
 * forty lines. RFC 4180 rules — a quote inside a quoted field is doubled, a field containing a comma, a quote
 * or a newline is quoted, and CRLF and LF are both accepted on the way in. */

export const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let started = false;
    const endField = (): void => {
        row.push(field);
        field = "";
    };
    const endRow = (): void => {
        endField();
        rows.push(row);
        row = [];
        started = false;
    };
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index += 1;
                    continue;
                }
                quoted = false;
                continue;
            }
            field += char;
            continue;
        }
        if (char === '"' && field === "") {
            quoted = true;
            started = true;
            continue;
        }
        if (char === ",") {
            endField();
            started = true;
            continue;
        }
        if (char === "\n") {
            endRow();
            continue;
        }
        if (char === "\r") {
            continue;
        }
        field += char;
        started = true;
    }
    // A trailing newline ends the last row rather than adding an empty one; anything else in flight is a row.
    if (started || field !== "" || row.length > 0) {
        endRow();
    }
    return rows;
};

const needsQuotes = (field: string): boolean => /[",\n\r]/.test(field);

export const toCsv = (rows: readonly (readonly unknown[])[]): string =>
    rows
        .map((row) =>
            row
                .map((cell) => {
                    const text = cell === undefined || cell === null ? "" : String(cell);
                    return needsQuotes(text) ? `"${text.replaceAll('"', '""')}"` : text;
                })
                .join(","),
        )
        .join("\n");
