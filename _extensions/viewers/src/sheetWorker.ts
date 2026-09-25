import { serveWorkerCall } from "@intentic/extension-ui/worker";
import readXlsxFile from "read-excel-file/web-worker";
import { isOdfSpreadsheet, readOdsBook } from "./odf/sheet";
import { toRows } from "./sheetCells";
import type { SheetRows, SheetWorkerAnswer, SheetWorkerCommand } from "./sheetProtocol";

/* One workbook lives with one viewer worker, parsed once on `load` and served from memory after that. */
const sheets = new Map<string, SheetRows>();

// Which spreadsheet this is comes from the bytes, not from the file's name: a mislabelled .xlsx that is really an
// .ods still opens, and the sniff costs 30 bytes.
const parse = async (buffer: ArrayBuffer): Promise<readonly { readonly name: string; readonly data: readonly (readonly unknown[])[] }[]> => {
    const bytes = new Uint8Array(buffer);
    if (isOdfSpreadsheet(bytes)) {
        return readOdsBook(bytes);
    }
    return (await readXlsxFile(buffer)).map(({ sheet, data }) => ({ name: sheet, data }));
};

const load = async (buffer: ArrayBuffer): Promise<string[]> => {
    const parsed = await parse(buffer);
    sheets.clear();
    for (const { name, data } of parsed) {
        sheets.set(name, toRows(data));
    }
    return [...sheets.keys()];
};

serveWorkerCall(async (command: SheetWorkerCommand): Promise<SheetWorkerAnswer> => {
    if (command.type === `load`) {
        return { type: `loaded`, names: await load(command.buffer) };
    }
    const rows = sheets.get(command.name);
    if (rows === undefined) {
        throw new Error(`Sheet "${command.name}" does not exist.`);
    }
    return { type: `rendered`, rows };
});
