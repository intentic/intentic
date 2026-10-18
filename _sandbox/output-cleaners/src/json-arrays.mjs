// Lossless JSON-array tables with RFC-4180 cells; no dependencies outside this package.
import { bodyBytes } from "./cleaner-shapes.mjs";

// Every present cell is JSON text inside RFC-4180 CSV, including strings: empty means missing, never null or "".
// Restrict schema names and cell sizes rather than invent escaping for the header or splitting an enormous cell.
const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const renderTable = (value) => {
    if (value.length < 5 || value.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
        return undefined;
    }
    const keys = [...new Set(value.flatMap(Object.keys))];
    if (
        keys.length === 0 ||
        keys.length > 40 ||
        keys.some((key) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) ||
        value.some((row) => Object.keys(row).length < keys.length * 0.8)
    ) {
        return undefined;
    }
    if (
        keys.some(
            (key) =>
                new Set(
                    value
                        .filter((row) => Object.hasOwn(row, key) && row[key] !== null)
                        .map((row) => (Array.isArray(row[key]) ? "array" : typeof row[key])),
                ).size > 1,
        )
    ) {
        return undefined;
    }
    const rows = value.map((row) => keys.map((key) => (Object.hasOwn(row, key) ? JSON.stringify(row[key]) : "")));
    if (rows.some((row) => row.some((cell) => cell.length > 2000))) {
        return undefined;
    }
    const table = `[${value.length}]{${keys.join(",")}}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
    if (table.length >= JSON.stringify(value).length) {
        return undefined;
    }
    return table;
};

export const compactJsonArrays = (lines, values, redactText) => {
    if (!/^\s*[{[]/.test(lines.find((line) => /\S/.test(line)) ?? "")) {
        return lines;
    }
    const source = lines.join("\n");
    // CSV moves field names away from their values. Leave credential-bearing JSON in its original shape so the
    // final redactor can still recognise named assignments, including secrets whose values have no issuer prefix.
    if (redactText(source, values) !== source) {
        return lines;
    }
    let parsed;
    try {
        parsed = JSON.parse(source, (_key, value) => {
            if (
                typeof value === "number" &&
                (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || Object.is(value, -0))
            ) {
                throw new Error("non-reversible number");
            }
            return value;
        });
    } catch {
        return lines;
    }
    let tables = 0;
    const render = (value) => {
        if (Array.isArray(value)) {
            const table = renderTable(value);
            if (table === undefined) {
                return JSON.stringify(value);
            }
            tables++;
            return table;
        }
        if (value !== null && typeof value === "object") {
            return `{${Object.entries(value)
                .map(([key, child]) => `${JSON.stringify(key)}:${render(child)}`)
                .join(",")}}`;
        }
        return JSON.stringify(value);
    };
    const result = render(parsed);
    return tables > 0 && result.length < bodyBytes(lines) ? result.split("\n") : lines;
};
