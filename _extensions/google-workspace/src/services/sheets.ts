import { readFile } from "node:fs/promises";
import { type Args, bool, flag, positional, required } from "../cli/args.js";
import { type Command, type CommandContext, type CommandGroup, printJson } from "../cli/command.js";
import { count, row } from "../cli/format.js";
import { parseCsv, toCsv } from "../google/csv.js";
import { call } from "../google/request.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

// Only the `values` half of the Sheets API, the grid, not `spreadsheets.batchUpdate` (formatting, charts, rules, frozen
// panes). Writes go in as `USER_ENTERED`, not `RAW`, so `=SUM(A1:A9)` becomes a formula and a date parses as one, as if
// typed by a person.

interface ValueRange {
    readonly range?: string;
    readonly values?: readonly (readonly string[])[];
}

// `--csv FILE`, `--json-values '[["a","b"]]'`, or `--values "a,b;c,d"` for a couple of inline cells.
const valuesOf = async (args: Args): Promise<string[][]> => {
    const csv = flag(args, "csv");
    if (csv !== undefined) {
        return parseCsv(await readFile(csv, "utf8"));
    }
    const json = flag(args, "json-values");
    if (json !== undefined) {
        const parsed = JSON.parse(json) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((entry) => Array.isArray(entry))) {
            throw new Error('--json-values must be an array of arrays, e.g. \'[["name","total"],["ana",7]]\'.');
        }
        return parsed.map((entry: unknown[]) => entry.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
    }
    const inline = flag(args, "values");
    if (inline !== undefined) {
        return inline.split(";").map((line) => line.split(","));
    }
    throw new Error("Pass the data as --csv FILE, --json-values '[[…]]' or --values \"a,b;c,d\".");
};

const create: Command = {
    name: "create",
    summary: "Make a spreadsheet",
    usage: 'gw sheets create --title "…"',
    writes: true,
    run: async (ctx) => {
        const made = await call<{ spreadsheetId: string; spreadsheetUrl?: string }>(ctx.session, {
            method: "POST",
            url: API,
            body: { properties: { title: required(ctx.args, "title") } },
        });
        ctx.out(row(made.spreadsheetId, made.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${made.spreadsheetId}/edit`));
    },
};

const tabs: Command = {
    name: "tabs",
    summary: "The sheets inside a spreadsheet, and how big each one is",
    usage: "gw sheets tabs <spreadsheetId>",
    run: async (ctx) => {
        const book = await call<{
            properties?: { title?: string };
            sheets?: { properties?: { title?: string; sheetId?: number; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
        }>(ctx.session, {
            url: `${API}/${encodeURIComponent(positional(ctx.args, 1, "A spreadsheet id"))}`,
            query: { fields: "properties.title, sheets.properties" },
        });
        if (ctx.json) {
            printJson(ctx, book);
            return;
        }
        ctx.out(book.properties?.title ?? "(untitled)");
        for (const sheet of book.sheets ?? []) {
            const grid = sheet.properties?.gridProperties;
            ctx.out(row(sheet.properties?.title ?? "?", `${grid?.rowCount ?? "?"}×${grid?.columnCount ?? "?"}`));
        }
    },
};

// Sheets has no "whole spreadsheet" range: a `read` with no `--range` asks the first tab's name and reads that whole.
const firstTab = async (ctx: CommandContext, id: string): Promise<string> => {
    const book = await call<{ sheets?: { properties?: { title?: string } }[] }>(ctx.session, {
        url: `${API}/${encodeURIComponent(id)}`,
        query: { fields: "sheets.properties.title" },
    });
    return book.sheets?.[0]?.properties?.title ?? "Sheet1";
};

const read: Command = {
    name: "read",
    summary: "Read a range as CSV",
    usage: "gw sheets read <spreadsheetId> [--range 'Sheet1!A1:D50']     (no range = the first sheet, whole)",
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A spreadsheet id");
        const target = flag(ctx.args, "range") ?? (await firstTab(ctx, id));
        const values = await call<ValueRange>(ctx.session, { url: `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(target)}` });
        if (ctx.json) {
            printJson(ctx, values);
            return;
        }
        ctx.out(toCsv(values.values ?? []));
        ctx.out(count((values.values ?? []).length, "rows"));
    },
};

const write: Command = {
    name: "write",
    summary: "Overwrite a range",
    usage: "gw sheets write <spreadsheetId> --range 'Sheet1!A1' --csv FILE | --json-values '[[…]]' | --values \"a,b;c,d\"",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A spreadsheet id");
        const range = required(ctx.args, "range");
        const values = await valuesOf(ctx.args);
        const done = await call<{ updatedCells?: number; updatedRange?: string }>(ctx.session, {
            method: "PUT",
            url: `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
            query: { valueInputOption: bool(ctx.args, "raw") ? "RAW" : "USER_ENTERED" },
            body: { values },
        });
        ctx.out(`wrote ${done.updatedCells ?? 0} cells into ${done.updatedRange ?? range}`);
    },
};

const append: Command = {
    name: "append",
    summary: "Add rows after the last one that has data",
    usage: "gw sheets append <spreadsheetId> [--range 'Sheet1'] --csv FILE | --json-values '[[…]]' | --values \"a,b\"",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A spreadsheet id");
        const range = flag(ctx.args, "range") ?? "Sheet1";
        const values = await valuesOf(ctx.args);
        const done = await call<{ updates?: { updatedRange?: string; updatedRows?: number } }>(ctx.session, {
            method: "POST",
            url: `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append`,
            query: { valueInputOption: bool(ctx.args, "raw") ? "RAW" : "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
            body: { values },
        });
        ctx.out(`added ${done.updates?.updatedRows ?? 0} rows at ${done.updates?.updatedRange ?? range}`);
    },
};

const clear: Command = {
    name: "clear",
    summary: "Empty a range, keeping the formatting",
    usage: "gw sheets clear <spreadsheetId> --range 'Sheet1!A2:D'",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A spreadsheet id");
        const range = required(ctx.args, "range");
        await call(ctx.session, { method: "POST", url: `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:clear` });
        ctx.out(`cleared ${range}`);
    },
};

export const sheetsGroup: CommandGroup = {
    name: "sheets",
    summary: "Sheets, read a range as CSV, write, append, clear",
    commands: [create, tabs, read, write, append, clear],
};
